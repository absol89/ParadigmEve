import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  claimEveCronOccurrence,
  createEveCronEntry,
  eveCronWorkPayloadHash,
  materializeEveCronOccurrences,
  readScheduleState,
  resetScheduleForTests
} from '../src/main/schedule.js';
import {
  runScheduleMaintenanceOnce,
  SCHEDULE_MAINTENANCE_INTERVAL_MS,
  SCHEDULE_MAINTENANCE_LOOKAHEAD_MS,
  SCHEDULE_MAINTENANCE_LOOKBACK_MS,
  startScheduleMaintenance
} from '../src/main/schedule-maintenance.js';
import {
  acknowledgeBrowserInput,
  authorizeBrowserInput,
  claimBrowserInput,
  configureInputDelivery,
  listInputs,
  noteBrowserInputsOffered,
  noteBrowserReady,
  resetInputForTests
} from '../src/main/session/input.js';
import { listEvecronExecutions, resetEvecronExecutionForTests } from '../src/main/evecron-execution.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import type { FrozenScheduleWork } from '../src/shared/schedule.js';

let directory = '';
const CREATED = Date.parse('2026-09-18T00:00:00.000Z');
const DUE = Date.parse('2026-09-18T08:00:00.000Z');

function approvedWork(target: FrozenScheduleWork['target'] = { kind: 'installation-agent' }): FrozenScheduleWork {
  const executable = { target, text: 'Run the already-authorized scheduled check.' };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorizedAt: CREATED,
      payloadHash: eveCronWorkPayloadHash(executable)
    },
    provenance: { planId: '11111111-1111-4111-8111-111111111111' }
  };
}

async function once(localDate: string, localTime: string, target: FrozenScheduleWork['target'] = { kind: 'installation-agent' }) {
  return createEveCronEntry({
    title: `${localDate} ${localTime}`,
    state: 'enabled',
    trigger: { kind: 'once', localDate, localTime, timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: approvedWork(target)
  }, CREATED);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-maintenance-'));
  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
  vi.spyOn(Date, 'now').mockReturnValue(DUE);
});

afterEach(async () => {
  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('materializes a bounded horizon and admits only due installation-agent work into the fresh schedule lane', async () => {
  const due = await once('2026-09-18', '10:00');
  const future = await once('2026-09-19', '10:00');
  const sessionTarget = await once('2026-09-18', '09:30', { kind: 'session', sessionId: 'session-user-chat' });

  const result = await runScheduleMaintenanceOnce({ now: () => DUE });
  expect(result.admitted).toHaveLength(1);
  expect(result.ignoredNonInstallation).toHaveLength(1);
  expect(result.failed).toEqual([]);

  const inputs = await listInputs();
  const occurrences = (await readScheduleState()).occurrences;
  const dueOccurrence = occurrences.find(row => row.entryId === due.id)!;
  const futureOccurrence = occurrences.find(row => row.entryId === future.id)!;
  const sessionOccurrence = occurrences.find(row => row.entryId === sessionTarget.id)!;
  const admitted = inputs.find(row => row.scheduleOccurrenceId && result.admitted.includes(row.scheduleOccurrenceId));
  expect(admitted).toMatchObject({
    purpose: 'schedule',
    sessionId: null,
    conversationId: null,
    state: 'queued',
    transportIntent: 'browser'
  });
  expect(result.ignoredNonInstallation).toContain(sessionOccurrence.id);
  expect(inputs.some(row => row.scheduleOccurrenceId === sessionOccurrence.id)).toBe(false);
  expect(inputs.some(row => row.scheduleOccurrenceId === futureOccurrence.id)).toBe(false);
  expect(inputs.some(row => row.scheduleOccurrenceId === dueOccurrence.id)).toBe(true);
});

it('is restart-idempotent and never admits a second outbox row for the same stable occurrence', async () => {
  await once('2026-09-18', '10:00');
  const first = await runScheduleMaintenanceOnce({ now: () => DUE });
  expect(first.admitted).toHaveLength(1);
  const firstInput = (await listInputs()).find(row => row.purpose === 'schedule')!;

  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);

  const second = await runScheduleMaintenanceOnce({ now: () => DUE });
  expect(second.admitted).toEqual([]);
  expect(second.alreadyAdmitted).toEqual(first.admitted);
  const rows = (await listInputs()).filter(row => row.purpose === 'schedule');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(firstInput.id);
});

it('heals a crash between occurrence claim and outbox commit without minting new authority', async () => {
  await once('2026-09-18', '10:00');
  const [row] = await materializeEveCronOccurrences(CREATED, DUE + 1, CREATED + 1);
  expect(row).toBeDefined();
  await claimEveCronOccurrence(row!.id, row!.inputId, DUE - 1);
  expect((await listInputs()).some(input => input.id === row!.inputId)).toBe(false);

  const result = await runScheduleMaintenanceOnce({ now: () => DUE });
  expect(result.admitted).toEqual([row!.id]);
  expect((await listInputs()).filter(input => input.id === row!.inputId)).toHaveLength(1);
});

describe('settling an admitted occurrence from its outbox row', () => {
  const at = (time: number) => vi.spyOn(Date, 'now').mockReturnValue(time);
  async function admitted() {
    await once('2026-09-18', '10:00');
    const result = await runScheduleMaintenanceOnce({ now: () => DUE });
    expect(result.admitted).toHaveLength(1);
    const input = (await listInputs()).find(row => row.purpose === 'schedule')!;
    return { occurrenceId: result.admitted[0]!, inputId: input.id };
  }
  async function ledgers(occurrenceId: string) {
    const occurrence = (await readScheduleState()).occurrences.find(row => row.id === occurrenceId)!;
    const rows = (await listInputs()).filter(row => row.scheduleOccurrenceId === occurrenceId);
    const execution = (await listEvecronExecutions()).find(row => row.binding.occurrenceId === occurrenceId)!;
    return { occurrence, rows, execution };
  }

  it('fails an occurrence whose fresh-chat input the browser never picked up, in all three ledgers (c29)', async () => {
    const { occurrenceId, inputId } = await admitted();
    noteBrowserReady(DUE);
    noteBrowserInputsOffered([inputId], DUE);
    at(DUE + 61_000);
    expect((await listInputs()).find(row => row.id === inputId)).toMatchObject({
      state: 'failed', error: 'Not sent: the browser did not pick up this message within 60 seconds.'
    });

    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 61_000 });
    expect(tick.admitted).toEqual([]);
    expect(tick.deliveryFailed).toEqual([{ occurrenceId, error: expect.stringMatching(/^Not started: Not sent: the browser did not pick up/) }]);
    const after = await ledgers(occurrenceId);
    expect(after.occurrence).toMatchObject({ state: 'failed', failure: { kind: 'delivery', failedAt: DUE + 61_000 } });
    expect(after.occurrence.failure?.error).toContain('It was not sent and will not be retried automatically.');
    expect(after.rows).toHaveLength(1);
    expect(after.execution).toMatchObject({ status: 'failed', startedAt: null, completedAt: DUE + 61_000,
      terminalFailure: { code: 'delivery' } });
    expect(after.execution.receipts.map(row => row.kind)).toEqual(['queued', 'failed']);
  });

  it('is idempotent across duplicate, concurrent and post-restart maintenance ticks after a failure', async () => {
    const { occurrenceId, inputId } = await admitted();
    noteBrowserReady(DUE);
    noteBrowserInputsOffered([inputId], DUE);
    at(DUE + 61_000);
    const [first, second] = await Promise.all([
      runScheduleMaintenanceOnce({ now: () => DUE + 61_000 }),
      runScheduleMaintenanceOnce({ now: () => DUE + 61_000 })
    ]);
    expect([...first.deliveryFailed, ...second.deliveryFailed].length).toBeGreaterThanOrEqual(1);
    const settled = await ledgers(occurrenceId);

    resetEvecronExecutionForTests();
    resetScheduleForTests();
    resetInputForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    initDurableStore(directory);
    initSessionStore(directory);
    const restarted = await runScheduleMaintenanceOnce({ now: () => DUE + 120_000 });
    expect(restarted).toMatchObject({ admitted: [], deliveryFailed: [], started: [], failed: [] });
    const after = await ledgers(occurrenceId);
    expect(after.occurrence).toEqual(settled.occurrence);
    expect(after.execution).toEqual(settled.execution);
    expect(after.rows).toHaveLength(1);
    expect(after.execution.receipts.filter(row => row.kind === 'failed')).toHaveLength(1);
  });

  it('fails an occurrence whose browser never connected', async () => {
    const { occurrenceId } = await admitted();
    at(DUE + 5 * 60_000);
    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 5 * 60_000 });
    expect(tick.deliveryFailed[0]?.error).toMatch(/^Not started: Not sent: the browser did not connect within 5 minutes\./);
    expect((await ledgers(occurrenceId)).occurrence.state).toBe('failed');
  });

  it('fails without resending when a claimed input was never authorized to Send', async () => {
    const { occurrenceId, inputId } = await admitted();
    expect(await claimBrowserInput(inputId, 'schedule-document', null, true)).toMatchObject({ state: 'browser' });
    at(DUE + 61_000);
    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 61_000 });
    expect(tick.deliveryFailed[0]?.error).toMatch(/^Not started: /);
    const after = await ledgers(occurrenceId);
    expect(after.rows).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(after.rows[0]?.sendAuthorizedAt).toBeUndefined();
  });

  it('marks delivery uncertain, never resent, when Send was authorized but the ACK was lost', async () => {
    const { occurrenceId, inputId } = await admitted();
    await claimBrowserInput(inputId, 'schedule-document', null, true);
    expect(await authorizeBrowserInput(inputId, 'schedule-document', null)).toBe(true);
    at(DUE + 46_000);
    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 46_000 });
    expect(tick.deliveryFailed[0]?.error).toMatch(/^Delivery uncertain: .*may have reached ChatGPT; it will not be resent\.$/);
    const after = await ledgers(occurrenceId);
    expect(after.occurrence.state).toBe('failed');
    expect(after.rows).toHaveLength(1);
    expect(after.execution.status).toBe('failed');
  });

  it('starts an ACKed occurrence whose start write never happened, once', async () => {
    await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
    configureInputDelivery({ applyAutomation: async () => undefined, changed: () => undefined });
    const { occurrenceId, inputId } = await admitted();
    await claimBrowserInput(inputId, 'schedule-document', null, true);
    await authorizeBrowserInput(inputId, 'schedule-document', null);
    // The bridge's own start sync after this ACK is what failed: only the outbox moved.
    expect(await acknowledgeBrowserInput(inputId, 'schedule-document', 'schedule-conversation-0001', 'schedule-message-0001')).toBe(true);
    expect((await ledgers(occurrenceId)).occurrence.state).toBe('scheduled');

    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 2_000 });
    expect(tick.started).toEqual([occurrenceId]);
    const after = await ledgers(occurrenceId);
    expect(after.occurrence).toMatchObject({ state: 'running', delivery: { messageId: 'schedule-message-0001' } });
    expect(after.execution.receipts.filter(row => row.kind === 'started')).toHaveLength(1);
    const again = await runScheduleMaintenanceOnce({ now: () => DUE + 3_000 });
    expect(again).toMatchObject({ started: [], deliveryFailed: [], admitted: [] });
  });

  it('leaves a queued input that is still within its pickup window waiting', async () => {
    const { occurrenceId, inputId } = await admitted();
    noteBrowserReady(DUE);
    noteBrowserInputsOffered([inputId], DUE);
    at(DUE + 30_000);
    const tick = await runScheduleMaintenanceOnce({ now: () => DUE + 30_000 });
    expect(tick).toMatchObject({ alreadyAdmitted: [occurrenceId], started: [], deliveryFailed: [], failed: [] });
    const after = await ledgers(occurrenceId);
    expect(after.occurrence.state).toBe('scheduled');
    expect(after.execution.status).toBe('queued');
  });
});

it('uses the documented lookback/lookahead bounds and never admits future work early', async () => {
  const materialize = vi.fn(async () => []);
  const admit = vi.fn(async () => undefined);
  const inputs = vi.fn(async () => []);
  await runScheduleMaintenanceOnce({
    deps: { now: () => DUE, materialize, admit, inputs }
  });
  expect(materialize).toHaveBeenCalledExactlyOnceWith(
    DUE - SCHEDULE_MAINTENANCE_LOOKBACK_MS,
    DUE + SCHEDULE_MAINTENANCE_LOOKAHEAD_MS,
    DUE
  );
  expect(admit).not.toHaveBeenCalled();
});

it('runs one pass at a time, schedules a bounded cadence, and cleanly drains on stop', async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const materialize = vi.fn()
    .mockImplementationOnce(async () => { await firstGate; return []; })
    .mockResolvedValue([]);
  const inputs = vi.fn(async () => []);
  const admit = vi.fn(async () => undefined);
  const timers: Array<{ callback: () => void; delay: number; handle: { unref: ReturnType<typeof vi.fn> } }> = [];
  const cleared: unknown[] = [];
  let runs = 0;
  let resolveRun!: () => void;
  let runObserved = new Promise<void>(resolve => { resolveRun = resolve; });

  const stop = startScheduleMaintenance({
    deps: { now: () => DUE, materialize, inputs, admit },
    setTimer: (callback, delay) => {
      const handle = { unref: vi.fn() };
      timers.push({ callback, delay, handle });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: handle => { cleared.push(handle); },
    onRun: () => { runs += 1; resolveRun(); }
  });

  expect(materialize).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(0);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  releaseFirst();
  await stopping;
  expect(stopped).toBe(true);
  expect(timers).toHaveLength(0);

  // A fresh owner demonstrates the periodic branch without overlapping the in-flight pass above.
  runs = 0;
  runObserved = new Promise<void>(resolve => { resolveRun = resolve; });
  const stopPeriodic = startScheduleMaintenance({
    deps: { now: () => DUE, materialize: async () => [], inputs, admit },
    setTimer: (callback, delay) => {
      const handle = { unref: vi.fn() };
      timers.push({ callback, delay, handle });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: handle => { cleared.push(handle); },
    onRun: () => { runs += 1; resolveRun(); }
  });
  await runObserved;
  await Promise.resolve();
  expect(runs).toBe(1);
  expect(timers.at(-1)?.delay).toBe(SCHEDULE_MAINTENANCE_INTERVAL_MS);
  expect(timers.at(-1)?.handle.unref).toHaveBeenCalledOnce();
  await stopPeriodic();
  expect(cleared).toContain(timers.at(-1)?.handle);
});
