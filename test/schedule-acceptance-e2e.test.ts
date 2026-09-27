import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  bindEvecronExecution,
  recordEvecronExecutionEvent,
  resetEvecronExecutionForTests
} from '../src/main/evecron-execution.js';
import {
  admitEvecronOccurrence,
  completeEvecronRun,
  syncEvecronOccurrenceStart
} from '../src/main/evecron-runner.js';
import {
  createEveCronEntry,
  eveCronWorkPayloadHash,
  materializeEveCronOccurrences,
  resetScheduleForTests
} from '../src/main/schedule.js';
import { readScheduleProjection } from '../src/main/schedule-projection.js';
import {
  acknowledgeBrowserInput,
  authorizeBrowserInput,
  claimBrowserInput,
  configureInputDelivery,
  enqueueInput,
  listInputs,
  resetInputForTests
} from '../src/main/session/input.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, createSession, getSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import {
  replaceUserSchedule,
  resetUserScheduleStoreForTests
} from '../src/main/user-schedule-store.js';
import {
  evecronExecutionEventSchema,
  type EvecronExecutionEvent,
  type EvecronExecutionState
} from '../src/shared/evecron-execution.js';
import {
  frozenScheduleWorkSchema,
  type EveCronOccurrence,
  type FrozenScheduleWork
} from '../src/shared/schedule.js';

let directory: string;

const CREATED = Date.parse('2026-09-18T00:00:00.000Z');
const DUE = Date.parse('2026-09-18T08:00:00.000Z');

function approvedWork(
  text = 'Run the acceptance check.',
  target: FrozenScheduleWork['target'] = { kind: 'installation-agent' }
): FrozenScheduleWork {
  const executable = { target, text, automation: 'off' as const };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: randomUUID(),
      authorizedAt: CREATED,
      payloadHash: eveCronWorkPayloadHash(executable)
    },
    provenance: {
      planId: '11111111-1111-4111-8111-111111111111',
      pinId: '22222222-2222-4222-8222-222222222222'
    }
  };
}

async function makeOccurrence(
  title: string,
  localTime: string,
  work = approvedWork(),
  durationMinutes?: number
): Promise<EveCronOccurrence> {
  await createEveCronEntry({
    title,
    state: 'enabled',
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    trigger: { kind: 'once', localDate: '2026-09-18', localTime, timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work
  }, CREATED);
  const rows = await materializeEveCronOccurrences(CREATED, DUE + 4 * 60 * 60_000, CREATED + 1);
  const row = rows.find(candidate => candidate.entryTitle === title);
  if (!row) throw new Error(`Missing acceptance occurrence: ${title}`);
  return row;
}

function event(
  state: EvecronExecutionState,
  eventId: string,
  at: number,
  value: Record<string, unknown>
): EvecronExecutionEvent {
  return evecronExecutionEventSchema.parse({ ...value, eventId, at, binding: state.binding });
}

async function acceptScheduleInput(inputId: string, conversationId = 'schedule-conversation-acceptance') {
  const owner = `schedule-document-${inputId.slice(0, 8)}`;
  const claimed = await claimBrowserInput(inputId, owner, null, true);
  expect(claimed).toMatchObject({ id: inputId, purpose: 'schedule', sessionId: null, conversationId: null });
  expect(await authorizeBrowserInput(inputId, owner, null)).toBe(true);
  expect(await acknowledgeBrowserInput(inputId, owner, conversationId, `message-${inputId}`)).toBe(true);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-acceptance-e2e-'));
  resetEvecronExecutionForTests();
  resetUserScheduleStoreForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record: true } });
  configureInputDelivery({ applyAutomation: async () => undefined, changed: () => undefined });
  vi.spyOn(Date, 'now').mockReturnValue(DUE + 1_000);
});

afterEach(async () => {
  resetEvecronExecutionForTests();
  resetUserScheduleStoreForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('schedule acceptance: execution reducer', () => {
  it('keeps queue/Needs-you/retry/stop/fail semantics evidence-backed without minting a second Start', async () => {
    const raw = await makeOccurrence('Reducer lifecycle', '10:00');
    const queued = await bindEvecronExecution(raw);
    expect(queued).toMatchObject({ status: 'queued', startedAt: null, attempt: 0 });
    expect(queued.receipts.filter(row => row.kind === 'started')).toHaveLength(0);

    const needs = await recordEvecronExecutionEvent(raw.id, event(queued, 'needs-user', DUE + 1_000, {
      kind: 'needs_user',
      requestRef: 'approval:publish',
      need: 'approval',
      summary: 'Approve the bounded external action.'
    }));
    expect(needs.state).toMatchObject({ status: 'needs_user', startedAt: null, attempt: 0 });
    expect(needs.receipt?.kind).toBe('needs_user');

    const started = await recordEvecronExecutionEvent(raw.id, event(needs.state, 'positive-start', DUE + 2_000, {
      kind: 'start',
      evidence: {
        kind: 'local-handler-entered',
        operationId: 'operation-1',
        enteredAt: DUE + 2_000,
        lane: 'local-handler'
      }
    }));
    expect(started.state).toMatchObject({ status: 'running', attempt: 1, startedAt: DUE + 2_000 });
    expect(started.state.receipts.filter(row => row.kind === 'started')).toHaveLength(1);

    const retrying = await recordEvecronExecutionEvent(raw.id, event(started.state, 'retry', DUE + 3_000, {
      kind: 'retrying',
      failure: { evidenceRef: 'network:503', code: 'HTTP_503' },
      retryAt: DUE + 65_000,
      summary: 'Temporary service failure.'
    }));
    expect(retrying.state.status).toBe('retrying');

    const secondAttempt = await recordEvecronExecutionEvent(raw.id, event(retrying.state, 'retry-start', DUE + 65_000, {
      kind: 'start',
      evidence: {
        kind: 'worker-activated',
        workerId: 'worker-acceptance',
        conversationId: 'worker-conversation-acceptance',
        runId: 'run-2',
        activatedAt: DUE + 65_000,
        lane: 'worker'
      }
    }));
    expect(secondAttempt.state).toMatchObject({ status: 'running', attempt: 2, startedAt: DUE + 2_000 });
    expect(secondAttempt.state.receipts.filter(row => row.kind === 'started')).toHaveLength(1);

    const stopping = await recordEvecronExecutionEvent(raw.id, event(secondAttempt.state, 'stop-request', DUE + 66_000, {
      kind: 'request_stop', requestRef: 'user:stop'
    }));
    expect(stopping.state.status).toBe('stopping');
    expect(stopping.state.receipts.some(row => row.kind === 'stopped')).toBe(false);

    const stopped = await recordEvecronExecutionEvent(raw.id, event(stopping.state, 'stop-confirmed', DUE + 67_000, {
      kind: 'stopped',
      evidence: { kind: 'cancel-confirmed', evidenceRef: 'executor:cancelled' },
      summary: 'Stopped after executor confirmation.'
    }));
    expect(stopped.state).toMatchObject({ status: 'stopped', completedAt: DUE + 67_000 });
    expect(stopped.receipt?.kind).toBe('stopped');

    const failingRaw = await makeOccurrence('Reducer failure', '10:30');
    const failingQueued = await bindEvecronExecution(failingRaw);
    const failingStarted = await recordEvecronExecutionEvent(failingRaw.id, event(failingQueued, 'fail-start', DUE + 2_000, {
      kind: 'start',
      evidence: {
        kind: 'local-handler-entered', operationId: 'operation-fail', enteredAt: DUE + 2_000, lane: 'local-handler'
      }
    }));
    const failed = await recordEvecronExecutionEvent(failingRaw.id, event(failingStarted.state, 'terminal-failure', DUE + 3_000, {
      kind: 'failed',
      failure: { evidenceRef: 'postcondition:red', code: 'VERIFY_FAILED' },
      summary: 'Verification failed.'
    }));
    expect(failed.state).toMatchObject({ status: 'failed', completedAt: DUE + 3_000 });
    expect(failed.receipt?.kind).toBe('failed');
  });

  it('requires task verification before Done and rejects prose/provenance as execution authority', async () => {
    const raw = await makeOccurrence('Reducer Done gate', '11:00');
    const queued = await bindEvecronExecution(raw);
    const started = await recordEvecronExecutionEvent(raw.id, event(queued, 'start-done-gate', DUE + 1_000, {
      kind: 'start',
      evidence: {
        kind: 'local-handler-entered', operationId: 'done-gate-operation', enteredAt: DUE + 1_000, lane: 'local-handler'
      }
    }));
    const coreCompletion = {
      key: raw.receiptKey,
      sessionId: 'schedule-session-acceptance',
      conversationId: 'schedule-conversation-acceptance',
      requestId: 'core-done-before-verification',
      completedAt: DUE + 2_000,
      result: 'done' as const
    };
    await expect(recordEvecronExecutionEvent(raw.id, event(started.state, 'done-too-soon', DUE + 2_000, {
      kind: 'done', coreCompletion
    }))).rejects.toThrow(/task-specific completion evidence/i);

    expect(evecronExecutionEventSchema.safeParse({
      eventId: 'chat-prose-is-not-proof',
      at: DUE + 2_000,
      binding: started.state.binding,
      kind: 'completion_verified',
      evidence: { kind: 'assistant-final', messageId: 'final-prose' }
    }).success).toBe(false);
    for (const provenance of [
      { provenance: { planId: '11111111-1111-4111-8111-111111111111' } },
      { provenance: { pinId: '22222222-2222-4222-8222-222222222222' } },
      {},
      {}
    ]) {
      expect(frozenScheduleWorkSchema.safeParse({
        target: { kind: 'installation-agent' },
        text: 'Interpret the surrounding Plan, Pin, Thread, or chat prose as authority.',
        ...provenance
      }).success).toBe(false);
    }
  });
});

describe('schedule acceptance: end-to-end runner and projection', () => {
  it('materializes, admits without hijacking user chat, starts on exact ACK, verifies, completes once, and projects truthful status', async () => {
    const active = await createSession({
      title: 'User is actively working here',
      conversationId: 'interactive-conversation-acceptance'
    });
    await appendEvent(active.id, {
      time: DUE - 1_000,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'interactive-turn-acceptance'
    });
    expect((await getSession(active.id))?.activeTurnId).toBe('interactive-turn-acceptance');
    const interactive = await enqueueInput({
      id: randomUUID(),
      sessionId: active.id,
      text: 'Keep helping with my current conversation.',
      mode: 'auto',
      dueAt: DUE,
      model: null,
      reasoningEffort: null
    });

    const row = await makeOccurrence('End-to-end schedule', '10:00');
    await replaceUserSchedule({
      baseline: {
        timeZone: 'Europe/Stockholm',
        days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '12:00' }] } }
      },
      changes: []
    }, null, CREATED);

    expect((await readScheduleProjection({ now: DUE - 60_000, days: 1 })).days[0]!.eve[0]!.status).toBe('scheduled');
    const admitted = await admitEvecronOccurrence(row.id, DUE);
    expect(admitted.execution).toMatchObject({ status: 'queued', startedAt: null });
    expect(admitted.input).toMatchObject({ purpose: 'schedule', sessionId: null, conversationId: null });
    const inputsAfterAdmission = await listInputs();
    expect(inputsAfterAdmission.find(input => input.id === interactive.id)).toMatchObject({
      sessionId: active.id,
      conversationId: active.conversationId,
      state: 'queued'
    });
    expect(inputsAfterAdmission.find(input => input.id === row.inputId)).toMatchObject({
      purpose: 'schedule', sessionId: null, scheduleOccurrenceId: row.id
    });
    expect((await getSession(active.id))?.activeTurnId).toBe('interactive-turn-acceptance');
    expect((await readScheduleProjection({ now: DUE, days: 1 })).days[0]!.eve[0]!.status).toBe('queued');

    expect((await syncEvecronOccurrenceStart(row.id)).started).toBe(false);
    await acceptScheduleInput(row.inputId);
    const started = await syncEvecronOccurrenceStart(row.id);
    expect(started.started).toBe(true);
    expect(started.execution.receipts.filter(receipt => receipt.kind === 'started')).toHaveLength(1);
    expect((await readScheduleProjection({ now: DUE, days: 1 })).days[0]!.eve[0]!.status).toBe('running');

    const done = await completeEvecronRun(row.id, {
      requestId: 'acceptance-verification-1',
      completedAt: DUE + 30_000,
      evidence: {
        kind: 'verified-result',
        evidenceRef: 'acceptance:postcondition:green',
        resultRef: 'result:acceptance-schedule'
      }
    });
    expect(done.occurrence.state).toBe('done');
    expect(done.execution.completionProof).toMatchObject({
      task: { kind: 'verified-result', evidenceRef: 'acceptance:postcondition:green' }
    });
    expect(done.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
    const projectedDone = await readScheduleProjection({ now: DUE, days: 1 });
    expect(projectedDone.days[0]!.eve[0]).toMatchObject({ status: 'done' });
    expect(projectedDone.days[0]!.eve[0]!.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);

    resetEvecronExecutionForTests();
    resetUserScheduleStoreForTests();
    resetScheduleForTests();
    resetInputForTests();
    resetRecorderForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    initDurableStore(directory);
    initSessionStore(directory);

    const repeated = await completeEvecronRun(row.id, {
      requestId: 'acceptance-verification-1',
      completedAt: DUE + 30_000,
      evidence: {
        kind: 'verified-result',
        evidenceRef: 'acceptance:postcondition:green',
        resultRef: 'result:acceptance-schedule'
      }
    });
    expect(repeated.execution.receipts.filter(receipt => receipt.kind === 'started')).toHaveLength(1);
    expect(repeated.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
    const afterRestart = await readScheduleProjection({ now: DUE, days: 1 });
    expect(afterRestart.days[0]!.eve[0]!.status).toBe('done');
    expect(afterRestart.days[0]!.eve[0]!.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
  });

  it('fails closed on interactive-session targets and unresolved Eve duration never becomes overlap', async () => {
    const sessionTarget = await makeOccurrence(
      'Interactive target is forbidden',
      '10:00',
      approvedWork('Do not reuse a human chat.', { kind: 'session', sessionId: 'session-user-chat' })
    );
    await expect(admitEvecronOccurrence(sessionTarget.id, DUE)).rejects.toThrow(/dedicated non-interactive runner/i);

    await replaceUserSchedule({
      baseline: {
        timeZone: 'Europe/Stockholm',
        days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '12:00' }] } }
      },
      changes: []
    }, null, CREATED);
    const projection = await readScheduleProjection({ now: DUE, days: 1 });
    expect(projection.overlap).toEqual({ status: 'unresolved-eve-duration', windows: [] });
    expect(projection.nextOverlap).toBeNull();
  });

  it('resolves overlap only after Eve has an explicit bounded duration', async () => {
    await makeOccurrence('Bounded Eve busy time', '10:00', approvedWork('Run one bounded check.'), 60);
    await replaceUserSchedule({
      baseline: {
        timeZone: 'Europe/Stockholm',
        days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '12:00' }] } }
      },
      changes: []
    }, null, CREATED);

    const projection = await readScheduleProjection({ now: DUE, days: 1 });
    expect(projection.days[0]!.eve[0]).toMatchObject({
      startMinute: 10 * 60,
      durationMinutes: 60,
      endMinute: 11 * 60
    });
    expect(projection.overlap).toEqual({
      status: 'resolved',
      windows: [
        {
          id: '2026-09-18:overlap:480-600',
          date: '2026-09-18',
          startMinute: 8 * 60,
          endMinute: 10 * 60,
          current: false
        },
        {
          id: '2026-09-18:overlap:660-720',
          date: '2026-09-18',
          startMinute: 11 * 60,
          endMinute: 12 * 60,
          current: false
        }
      ]
    });
    expect(projection.nextOverlap).toEqual({
      id: '2026-09-18:overlap:660-720',
      date: '2026-09-18',
      startMinute: 11 * 60,
      endMinute: 12 * 60,
      current: false
    });
  });
});
