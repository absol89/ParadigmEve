import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  createEveCronEntry,
  eveCronWorkPayloadHash,
  materializeEveCronOccurrences,
  readScheduleState,
  resetScheduleForTests
} from '../src/main/schedule.js';
import {
  admitEvecronOccurrence,
  completeEvecronRun,
  completeEvecronRunFromSessionVerification,
  syncEvecronOccurrenceStart
} from '../src/main/evecron-runner.js';
import {
  acknowledgeBrowserInput,
  authorizeBrowserInput,
  claimBrowserInput,
  configureInputDelivery,
  enqueueInput,
  listInputs,
  pendingBrowserInputs,
  resetInputForTests
} from '../src/main/session/input.js';
import { scheduleDeliveryText } from '../src/main/session/input.js';
import { resetEvecronExecutionForTests } from '../src/main/evecron-execution.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import type { FrozenScheduleWork } from '../src/shared/schedule.js';
import type { ToolCallRecord } from '../src/shared/session.js';

let directory: string;

const CREATED = Date.parse('2026-09-18T00:00:00.000Z');
const DUE = Date.parse('2026-09-18T08:00:00.000Z');

function approvedWork(target: FrozenScheduleWork['target'] = { kind: 'installation-agent' }): FrozenScheduleWork {
  const executable = {
    target,
    text: 'Run the already-approved morning check.',
    automation: 'off' as const,
    context: {
      purpose: 'Use the shopping discussion to prepare today\'s already-approved morning brief.',
      desiredOutcome: 'A short today-only brief reflecting whether the user already acted.',
      constraints: ['Do not write the Expenses ledger from context-only data.'],
      requestedFormat: 'Wedding-invitation visual card.',
      sources: [{ sessionId: '2026-09-24-44847d07', conversationId: '6ab5284e-671c-83eb-b463-b458d34cc523' }],
      instructionRefs: ['%morningbrief'],
      contextRefs: ['#expenses']
    }
  };
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

async function occurrence(target: FrozenScheduleWork['target'] = { kind: 'installation-agent' }) {
  await createEveCronEntry({
    title: 'Morning check',
    state: 'enabled',
    trigger: { kind: 'once', localDate: '2026-09-18', localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: approvedWork(target)
  }, CREATED);
  const rows = await materializeEveCronOccurrences(CREATED, DUE + 60_000, CREATED + 1);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function acceptScheduleInput(id: string, conversationId = 'schedule-conversation-0001') {
  const claimed = await claimBrowserInput(id, `document-${id.slice(0, 8)}`, null, true);
  expect(claimed).toMatchObject({ id, purpose: 'schedule', sessionId: null, conversationId: null });
  expect(await authorizeBrowserInput(id, claimed!.owner!, null)).toBe(true);
  expect(await acknowledgeBrowserInput(id, claimed!.owner!, conversationId, `message-${id}`)).toBe(true);
}

const storedText = (text: string) => ({ text, chars: text.length, truncated: false as const });
const toolRef = (seq: number) => `T${seq.toString(36).toUpperCase()}`;
function toolCall(tool: string, conversationId: string, outcome: ToolCallRecord['outcome'] = 'ok'): ToolCallRecord {
  return {
    callId: randomUUID(),
    tool,
    attribution: 'request_id',
    requestId: `wfr-${randomUUID()}`,
    conversationId,
    attributionMethod: 'request_id',
    args: storedText('{}'),
    result: storedText('verified durable result'),
    outcome,
    durationMs: 10,
    summary: { title: `Ran ${tool}`, tone: outcome === 'ok' ? 'good' : 'bad', kind: 'run' }
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-evecron-runner-'));
  resetEvecronExecutionForTests();
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
  resetScheduleForTests();
  resetInputForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('admits due Eve work only into a fresh schedule lane and does not reserve the user composer', async () => {
  const row = await occurrence();
  const admitted = await admitEvecronOccurrence(row.id, DUE);

  expect(admitted.occurrence).toMatchObject({ id: row.id, state: 'scheduled', claimedAt: DUE });
  expect(admitted.execution).toMatchObject({ status: 'queued', startedAt: null });
  expect(admitted.input).toMatchObject({
    id: row.inputId,
    purpose: 'schedule',
    scheduleOccurrenceId: row.id,
    sessionId: null,
    conversationId: null,
    state: 'queued',
    transportIntent: 'browser'
  });
  expect(admitted.input.text).toBe(row.work.text);
  expect(admitted.input.scheduleContext).toEqual(row.work.context);
  const delivery = scheduleDeliveryText(admitted.input);
  expect(delivery).toContain('schedule with action="complete"');
  expect(delivery).toContain('Purpose: Use the shopping discussion');
  expect(delivery).toContain('Reusable instruction references: %morningbrief');
  expect(delivery).toContain('Data-only context references: #expenses');
  expect(delivery).toContain('#expenses alone never authorizes receipt filing or ledger writes');
  expect(delivery).toContain('Wedding-invitation visual card');
  expect(delivery).toContain('read the exact source session/conversation references above for relevant newer user messages');
  expect(delivery).toContain('If a referenced source is materially unavailable, say so rather than inventing what it contained.');
  expect(delivery).toContain('A one-time exception must not silently become a permanent recurring preference.');

  const user = await enqueueInput({
    id: randomUUID(),
    sessionId: null,
    text: 'This is my current interactive request.',
    mode: 'auto',
    dueAt: DUE,
    model: null,
    reasoningEffort: null
  });
  expect(user.state).toBe('queued');
  const pending = await pendingBrowserInputs();
  expect(pending.map(item => item.id)).toEqual(expect.arrayContaining([row.inputId, user.id]));
});

it('keeps claimed/browser-owned work out of Started until an exact native ACK has a recorded schedule session', async () => {
  const row = await occurrence();
  const admitted = await admitEvecronOccurrence(row.id, DUE);
  expect((await syncEvecronOccurrenceStart(row.id)).started).toBe(false);

  const claim = await claimBrowserInput(row.inputId, 'schedule-document', null, true);
  expect(claim).toMatchObject({ state: 'browser', purpose: 'schedule' });
  expect(await authorizeBrowserInput(row.inputId, 'schedule-document', null)).toBe(true);
  expect((await syncEvecronOccurrenceStart(row.id)).started).toBe(false);
  expect((await readScheduleState()).occurrences[0]?.state).toBe('scheduled');

  expect(await acknowledgeBrowserInput(row.inputId, 'schedule-document', 'schedule-conversation-0001', 'schedule-message-0001')).toBe(true);
  const started = await syncEvecronOccurrenceStart(row.id);
  expect(started.started).toBe(true);
  expect(started.occurrence).toMatchObject({
    state: 'running',
    delivery: {
      conversationId: 'schedule-conversation-0001',
      messageId: 'schedule-message-0001'
    }
  });
  expect(started.execution.status).toBe('running');
  expect(started.execution.receipts.filter(receipt => receipt.kind === 'started')).toHaveLength(1);
  expect(started.execution.receipts.find(receipt => receipt.kind === 'started')?.id).toBe(`${row.id}:started`);
  expect(started.input?.deliveredSessionId).toBe(started.occurrence.delivery?.sessionId);
  expect(admitted.execution.receipts.some(receipt => receipt.kind === 'started')).toBe(false);
});

it('persists task verification before core Done and suppresses duplicate Done after restart/retry', async () => {
  const row = await occurrence();
  await admitEvecronOccurrence(row.id, DUE);
  await acceptScheduleInput(row.inputId);
  const started = await syncEvecronOccurrenceStart(row.id);
  expect(started.occurrence.state).toBe('running');

  const completedAt = DUE + 30_000;
  const done = await completeEvecronRun(row.id, {
    requestId: 'verified-request-1',
    completedAt,
    evidence: { kind: 'verified-result', evidenceRef: 'test:postcondition:green', resultRef: 'result:morning-check' }
  });
  expect(done.occurrence.state).toBe('done');
  expect(done.execution.status).toBe('done');
  expect(done.execution.completionProof).toMatchObject({ task: { evidenceRef: 'test:postcondition:green' } });
  expect(done.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
  expect(done.execution.receipts.find(receipt => receipt.kind === 'done')?.id).toBe(`${row.id}:done`);

  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);

  const repeated = await completeEvecronRun(row.id, {
    requestId: 'verified-request-1',
    completedAt,
    evidence: { kind: 'verified-result', evidenceRef: 'test:postcondition:green', resultRef: 'result:morning-check' }
  });
  expect(repeated.occurrence.state).toBe('done');
  expect(repeated.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
});

it('completes the real schedule lane only from exact durable task-result and verification tool lineage', async () => {
  const row = await occurrence();
  await admitEvecronOccurrence(row.id, DUE);
  await acceptScheduleInput(row.inputId);
  const started = await syncEvecronOccurrenceStart(row.id);
  const delivery = started.occurrence.delivery!;

  const anchor = await appendEvent(delivery.sessionId, {
    time: delivery.acceptedAt,
    source: 'app',
    kind: 'user_message',
    messageId: delivery.messageId,
    inputId: row.inputId,
    inputDelivery: 'confirmed',
    authoredText: row.work.text,
    message: storedText(row.work.text)
  });
  expect(anchor.kind).toBe('user_message');

  const resultCall = toolCall('exec_command', delivery.conversationId);
  const resultEvent = await appendEvent(delivery.sessionId, {
    time: DUE + 2_000,
    source: 'mcp',
    kind: 'tool_call',
    turnId: 'schedule-turn-1',
    call: resultCall
  });
  const verificationCall = toolCall('read', delivery.conversationId);
  const verificationEvent = await appendEvent(delivery.sessionId, {
    time: DUE + 3_000,
    source: 'mcp',
    kind: 'tool_call',
    turnId: 'schedule-turn-1',
    call: verificationCall
  });

  const done = await completeEvecronRunFromSessionVerification({
    sessionId: delivery.sessionId,
    conversationId: delivery.conversationId,
    resultToolRef: toolRef(resultEvent.seq),
    verificationToolRef: toolRef(verificationEvent.seq)
  }, DUE + 4_000);
  expect(done.occurrence.state).toBe('done');
  expect(done.occurrence.completion?.requestId).toBe(`schedule-verified:${verificationCall.callId}:${resultCall.callId}`);
  expect(done.execution.completionProof?.task).toEqual({
    kind: 'verified-result',
    evidenceRef: `session:${delivery.sessionId}:tool:${verificationCall.callId}`,
    resultRef: `session:${delivery.sessionId}:tool:${resultCall.callId}`
  });
  expect(done.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);

  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetInputForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);

  const repeated = await completeEvecronRunFromSessionVerification({
    sessionId: delivery.sessionId,
    conversationId: delivery.conversationId,
    resultToolRef: toolRef(resultEvent.seq),
    verificationToolRef: toolRef(verificationEvent.seq)
  }, DUE + 5_000);
  expect(repeated.execution.receipts.filter(receipt => receipt.kind === 'done')).toHaveLength(1);
});

it('refuses lifecycle metadata, failed tools, and unrelated conversation evidence as schedule completion proof', async () => {
  const row = await occurrence();
  await admitEvecronOccurrence(row.id, DUE);
  await acceptScheduleInput(row.inputId);
  const started = await syncEvecronOccurrenceStart(row.id);
  const delivery = started.occurrence.delivery!;
  await appendEvent(delivery.sessionId, {
    time: delivery.acceptedAt,
    source: 'app',
    kind: 'user_message',
    messageId: delivery.messageId,
    inputId: row.inputId,
    inputDelivery: 'confirmed',
    authoredText: row.work.text,
    message: storedText(row.work.text)
  });

  for (const lifecycleTool of ['session', 'chat_review_plan']) {
    const lifecycle = await appendEvent(delivery.sessionId, {
      time: DUE + 2_000, source: 'mcp', kind: 'tool_call', call: toolCall(lifecycleTool, delivery.conversationId)
    });
    await expect(completeEvecronRunFromSessionVerification({
      sessionId: delivery.sessionId, conversationId: delivery.conversationId,
      verificationToolRef: toolRef(lifecycle.seq)
    }, DUE + 3_000)).rejects.toThrow(/not task completion evidence/i);
  }

  const failed = await appendEvent(delivery.sessionId, {
    time: DUE + 3_000, source: 'mcp', kind: 'tool_call', call: toolCall('exec_command', delivery.conversationId, 'process_exit_nonzero')
  });
  await expect(completeEvecronRunFromSessionVerification({
    sessionId: delivery.sessionId, conversationId: delivery.conversationId,
    verificationToolRef: toolRef(failed.seq)
  }, DUE + 4_000)).rejects.toThrow(/successful durable tool result/i);

  const foreign = await appendEvent(delivery.sessionId, {
    time: DUE + 4_000, source: 'mcp', kind: 'tool_call', call: toolCall('read', 'unrelated-conversation-0001')
  });
  await expect(completeEvecronRunFromSessionVerification({
    sessionId: delivery.sessionId, conversationId: delivery.conversationId,
    verificationToolRef: toolRef(foreign.seq)
  }, DUE + 5_000)).rejects.toThrow(/not exactly attributed/i);
  expect((await readScheduleState()).occurrences.find(item => item.id === row.id)?.state).toBe('running');
});

it('requires reviewed worker delivery evidence rather than worker sender-side finish', async () => {
  const row = await occurrence();
  await admitEvecronOccurrence(row.id, DUE);
  await acceptScheduleInput(row.inputId);
  const started = await syncEvecronOccurrenceStart(row.id);
  const deliveredAt = started.occurrence.delivery!.acceptedAt + 1_000;

  const done = await completeEvecronRun(row.id, {
    requestId: 'worker-reviewed-request',
    completedAt: deliveredAt + 2_000,
    evidence: {
      kind: 'worker-reviewed',
      workerId: 'worker-6',
      reportMessageId: 'worker-report-1',
      deliveredAt,
      reviewedAt: deliveredAt + 1_000,
      verificationRef: 'prime:verified-worker-result'
    }
  });
  expect(done.execution.completionProof?.task).toMatchObject({
    kind: 'worker-reviewed', reportMessageId: 'worker-report-1', verificationRef: 'prime:verified-worker-result'
  });
});

it('fails closed on session-target work instead of reusing an interactive chat', async () => {
  const row = await occurrence({ kind: 'session', sessionId: 'session-user-chat' });
  await expect(admitEvecronOccurrence(row.id, DUE)).rejects.toThrow(/dedicated non-interactive runner/i);
  const current = (await readScheduleState()).occurrences.find(item => item.id === row.id)!;
  expect(current).toMatchObject({ state: 'scheduled' });
  expect(current.claimedAt).toBeUndefined();
  expect((await listInputs()).some(input => input.scheduleOccurrenceId === row.id)).toBe(false);
});

it('is idempotent when admission is retried after the occurrence was claimed and queued', async () => {
  const row = await occurrence();
  const first = await admitEvecronOccurrence(row.id, DUE);
  const second = await admitEvecronOccurrence(row.id, DUE + 1);
  expect(second.occurrence.id).toBe(first.occurrence.id);
  expect(second.input).toEqual(first.input);
  expect((await listInputs()).filter(input => input.scheduleOccurrenceId === row.id)).toHaveLength(1);
});
