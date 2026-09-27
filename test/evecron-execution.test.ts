import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  claimEveCronOccurrence,
  completeEveCronOccurrence,
  createEveCronEntry,
  eveCronWorkPayloadHash,
  markEveCronOccurrenceRunning,
  materializeEveCronOccurrences,
  resetScheduleForTests
} from '../src/main/schedule.js';
import {
  acknowledgeEvecronReceipt,
  bindEvecronExecution,
  listEvecronExecutions,
  pendingEvecronReceipts,
  recordEvecronExecutionEvent,
  resetEvecronExecutionForTests
} from '../src/main/evecron-execution.js';
import {
  evecronExecutionEventSchema,
  type EvecronExecutionEvent,
  type EvecronExecutionState
} from '../src/shared/evecron-execution.js';
import type { EveCronOccurrence, FrozenScheduleWork } from '../src/shared/schedule.js';

let directory: string;

const NOW = Date.parse('2026-09-18T00:00:00.000Z');
const DUE = Date.parse('2026-09-18T08:00:00.000Z');

function approvedWork(): FrozenScheduleWork {
  const executable = { target: { kind: 'installation-agent' as const }, text: 'Run the bounded morning check.' };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorizedAt: NOW,
      payloadHash: eveCronWorkPayloadHash(executable)
    },
    provenance: { planId: '11111111-1111-4111-8111-111111111111' }
  };
}

async function occurrence(options: { paused?: boolean } = {}): Promise<EveCronOccurrence> {
  await createEveCronEntry({
    title: 'Morning check',
    state: options.paused ? 'paused' : 'enabled',
    trigger: { kind: 'once', localDate: '2026-09-18', localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: approvedWork()
  }, NOW);
  const rows = await materializeEveCronOccurrences(NOW, DUE + 60_000, NOW + 1);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function executionEvent(
  state: EvecronExecutionState,
  eventId: string,
  at: number,
  value: Record<string, unknown>
): EvecronExecutionEvent {
  return evecronExecutionEventSchema.parse({ ...value, eventId, at, binding: state.binding });
}

async function startThroughCore(raw: EveCronOccurrence, state: EvecronExecutionState, acceptedAt = NOW + 5_000) {
  const claimed = await claimEveCronOccurrence(raw.id, raw.inputId, acceptedAt - 1);
  expect(claimed.state).toBe('scheduled');
  const delivery = {
    sessionId: 'schedule-session-0001',
    conversationId: 'schedule-conversation-0001',
    messageId: 'schedule-message-0001',
    acceptedAt
  };
  const running = await markEveCronOccurrenceRunning(raw.id, raw.inputId, delivery);
  const started = await recordEvecronExecutionEvent(raw.id, executionEvent(state, `start-${raw.id}`, acceptedAt, {
    kind: 'start',
    evidence: { kind: 'schedule-delivery-accepted', inputId: raw.inputId, ...delivery, lane: 'schedule-session' }
  }));
  return { running, started, delivery };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-evecron-receipts-'));
  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetDurableForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetEvecronExecutionForTests();
  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('keeps scheduled and claimed work out of Started until positive execution evidence arrives', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  expect(state.status).toBe('queued');
  expect(state.startedAt).toBeNull();
  expect(await pendingEvecronReceipts('quiet')).toEqual([]);
  expect((await pendingEvecronReceipts('noisy')).map(row => row.label)).toEqual(['Waiting to start']);

  const claimed = await claimEveCronOccurrence(raw.id, raw.inputId, NOW + 2_000);
  expect(claimed.state).toBe('scheduled');
  expect((await listEvecronExecutions())[0]).toMatchObject({ status: 'queued', startedAt: null });

  expect(evecronExecutionEventSchema.safeParse({
    eventId: 'interactive-chat-is-not-schedule-start',
    at: NOW + 3_000,
    binding: state.binding,
    kind: 'start',
    evidence: {
      kind: 'schedule-delivery-accepted',
      inputId: raw.inputId,
      sessionId: 'session-user-chat',
      conversationId: 'conversation-user-chat',
      messageId: 'message-user-chat',
      acceptedAt: NOW + 3_000,
      lane: 'interactive-chat'
    }
  }).success).toBe(false);

  const { started } = await startThroughCore(raw, state);
  expect(started.state).toMatchObject({ status: 'running', attempt: 1, startedAt: NOW + 5_000 });
  expect(started.receipt).toMatchObject({ kind: 'started', label: 'Started', notifyInQuiet: true });
  expect(started.receipt?.id).toBe(`${raw.id}:started`);
});

it('recovers a core-confirmed Start after a crash with the same singleton receipt id', async () => {
  const raw = await occurrence();
  const queued = await bindEvecronExecution(raw);
  await claimEveCronOccurrence(raw.id, raw.inputId, NOW + 4_000);
  const delivery = {
    sessionId: 'schedule-session-0001',
    conversationId: 'schedule-conversation-0001',
    messageId: 'schedule-message-0001',
    acceptedAt: NOW + 5_000
  };
  const running = await markEveCronOccurrenceRunning(raw.id, raw.inputId, delivery);

  resetEvecronExecutionForTests();
  const recovered = await bindEvecronExecution(running);
  const receipt = recovered.receipts.find(row => row.kind === 'started');
  expect(receipt?.id).toBe(`${raw.id}:started`);
  expect(recovered.status).toBe('running');

  const lateCallback = await recordEvecronExecutionEvent(raw.id, executionEvent(recovered, 'late-start-callback', NOW + 5_100, {
    kind: 'start',
    evidence: { kind: 'schedule-delivery-accepted', inputId: raw.inputId, ...delivery, lane: 'schedule-session' }
  }));
  expect(lateCallback.duplicate).toBe(true);
  expect(lateCallback.receipt?.id).toBe(`${raw.id}:started`);
  expect(lateCallback.state.receipts.filter(row => row.kind === 'started')).toHaveLength(1);
  expect(queued.binding).toEqual(recovered.binding);
});

it('replays one stable unshown Start receipt after restart and suppresses it after exact presentation ACK', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { started } = await startThroughCore(raw, state);
  const receipt = started.receipt!;

  expect((await pendingEvecronReceipts()).map(row => row.id)).toContain(receipt.id);
  resetEvecronExecutionForTests();
  expect((await pendingEvecronReceipts()).map(row => row.id)).toContain(receipt.id);

  const replay = await recordEvecronExecutionEvent(raw.id, executionEvent(state, `start-${raw.id}`, NOW + 5_000, {
    kind: 'start',
    evidence: {
      kind: 'schedule-delivery-accepted',
      inputId: raw.inputId,
      sessionId: 'schedule-session-0001',
      conversationId: 'schedule-conversation-0001',
      messageId: 'schedule-message-0001',
      acceptedAt: NOW + 5_000,
      lane: 'schedule-session'
    }
  }));
  expect(replay).toMatchObject({ duplicate: true, receipt: { id: receipt.id } });
  expect(replay.state.receipts.filter(row => row.kind === 'started')).toHaveLength(1);

  await acknowledgeEvecronReceipt(raw.id, receipt.id, NOW + 6_000);
  resetEvecronExecutionForTests();
  expect((await pendingEvecronReceipts()).map(row => row.id)).not.toContain(receipt.id);
});

it('requires task-specific evidence in addition to the schedule core completion before user-visible Done', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { running, delivery, started } = await startThroughCore(raw, state);
  const coreCompletion = {
    key: running.receiptKey,
    sessionId: delivery.sessionId,
    conversationId: delivery.conversationId,
    requestId: 'semantic-completion-1',
    completedAt: NOW + 8_000,
    result: 'done' as const
  };

  expect(evecronExecutionEventSchema.safeParse({
    eventId: 'assistant-final-is-not-task-evidence',
    at: NOW + 7_000,
    binding: state.binding,
    kind: 'completion_verified',
    evidence: { kind: 'assistant-final', messageId: 'final-prose' }
  }).success).toBe(false);
  expect(evecronExecutionEventSchema.safeParse({
    eventId: 'worker-send-is-not-delivery-review',
    at: NOW + 7_000,
    binding: state.binding,
    kind: 'completion_verified',
    evidence: { kind: 'worker-reviewed', workerId: 'worker-6', reportMessageId: 'report-1' }
  }).success).toBe(false);

  await expect(recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'done-before-verification', NOW + 7_500, {
    kind: 'done', coreCompletion
  }))).rejects.toThrow(/task-specific completion evidence/i);

  const verified = await recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'verified-completion', NOW + 7_600, {
    kind: 'completion_verified',
    evidence: {
      kind: 'worker-reviewed',
      workerId: 'worker-6',
      reportMessageId: 'report-1',
      deliveredAt: NOW + 7_100,
      reviewedAt: NOW + 7_500,
      verificationRef: 'repo:test:focused-green',
      resultRef: 'result:morning-check'
    }
  }));
  expect(verified.state.status).toBe('running');
  expect(verified.state.verifiedCompletion).not.toBeNull();
  expect(verified.receipt).toBeNull();

  const coreDone = await completeEveCronOccurrence(raw.id, coreCompletion);
  resetEvecronExecutionForTests();
  const done = await bindEvecronExecution(coreDone);
  expect(done.status).toBe('done');
  expect(done.completionProof).not.toBeNull();
  const doneReceipt = done.receipts.find(row => row.kind === 'done');
  expect(doneReceipt).toMatchObject({
    kind: 'done',
    label: 'Done',
    evidenceRef: 'repo:test:focused-green',
    links: {
      entryId: raw.entryId,
      occurrenceId: raw.id,
      planId: '11111111-1111-4111-8111-111111111111',
      resultRef: 'result:morning-check'
    }
  });
  expect(doneReceipt?.id).toBe(`${raw.id}:done`);
  resetEvecronExecutionForTests();
  const repeated = await bindEvecronExecution(coreDone);
  expect(repeated.receipts.filter(row => row.kind === 'done')).toHaveLength(1);
});

it('does not invent Done after restart when the core completed without durable task verification', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { running, delivery } = await startThroughCore(raw, state);
  const coreDone = await completeEveCronOccurrence(raw.id, {
    key: running.receiptKey,
    sessionId: delivery.sessionId,
    conversationId: delivery.conversationId,
    requestId: 'semantic-only-completion',
    completedAt: NOW + 8_000,
    result: 'done'
  });

  resetEvecronExecutionForTests();
  const recovered = await bindEvecronExecution(coreDone);
  expect(recovered.status).toBe('running');
  expect(recovered.verifiedCompletion).toBeNull();
  expect(recovered.receipts.some(row => row.kind === 'done')).toBe(false);
});

it('records Needs you before start without manufacturing a Start, then resumes the same occurrence', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const blocked = await recordEvecronExecutionEvent(raw.id, executionEvent(state, 'needs-approval', NOW + 2_000, {
    kind: 'needs_user',
    requestRef: 'approval:external-publish',
    need: 'approval',
    summary: 'Approve publishing before Eve sends anything externally.'
  }));
  expect(blocked.state).toMatchObject({ status: 'needs_user', startedAt: null, attempt: 0 });
  expect(blocked.receipt).toMatchObject({ kind: 'needs_user', label: 'Needs you', notifyInQuiet: true });
  expect(blocked.state.receipts.some(row => row.kind === 'started')).toBe(false);

  const { started } = await startThroughCore(raw, blocked.state, NOW + 4_000);
  expect(started.state).toMatchObject({ status: 'running', attempt: 1, startedAt: NOW + 4_000 });
  expect(started.receipt?.kind).toBe('started');
});

it('keeps retry attempts under one occurrence and never emits a second Started receipt', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { started } = await startThroughCore(raw, state);
  const retrying = await recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'temporary-failure', NOW + 7_000, {
    kind: 'retrying',
    failure: { evidenceRef: 'network:temporary-503', code: 'HTTP_503' },
    retryAt: NOW + 67_000,
    summary: 'The service is temporarily unavailable.'
  }));
  expect(retrying.state.status).toBe('retrying');
  expect(retrying.receipt).toMatchObject({ kind: 'retrying', label: 'Trying again', notifyInQuiet: false });

  const secondAttempt = await recordEvecronExecutionEvent(raw.id, executionEvent(retrying.state, 'worker-retry-start', NOW + 67_000, {
    kind: 'start',
    evidence: {
      kind: 'worker-activated',
      workerId: 'worker-6',
      conversationId: 'worker-conversation-0001',
      runId: 'run-1',
      activatedAt: NOW + 67_000,
      lane: 'worker'
    }
  }));
  expect(secondAttempt.state).toMatchObject({ status: 'running', attempt: 2, startedAt: NOW + 5_000 });
  expect(secondAttempt.receipt).toBeNull();
  expect(secondAttempt.state.receipts.filter(row => row.kind === 'started')).toHaveLength(1);
});

it('throttles routine long-running progress in quiet mode while preserving milestones and exact evidence refs', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { started } = await startThroughCore(raw, state);
  const routine = await recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'progress-early', NOW + 10 * 60_000, {
    kind: 'progress',
    evidenceRef: 'check:2',
    summary: 'Two checks finished',
    meaningfulMilestone: false,
    units: { completed: 2, total: 5 }
  }));
  expect(routine.receipt).toMatchObject({ kind: 'progress', notifyInQuiet: false, evidenceRef: 'check:2' });

  const timed = await recordEvecronExecutionEvent(raw.id, executionEvent(routine.state, 'progress-late', NOW + 31 * 60_000, {
    kind: 'progress',
    evidenceRef: 'check:3',
    summary: 'Three checks finished',
    meaningfulMilestone: false,
    units: { completed: 3, total: 5 }
  }));
  expect(timed.receipt?.notifyInQuiet).toBe(true);

  const milestone = await recordEvecronExecutionEvent(raw.id, executionEvent(timed.state, 'progress-milestone', NOW + 32 * 60_000, {
    kind: 'progress', evidenceRef: 'check:4', summary: 'All platform checks passed', meaningfulMilestone: true
  }));
  expect(milestone.receipt?.notifyInQuiet).toBe(true);
});

it('distinguishes Skipped, Stopping and Stopped without inventing completion', async () => {
  const paused = await occurrence({ paused: true });
  const skipped = await bindEvecronExecution(paused);
  expect(skipped.status).toBe('skipped');
  expect(skipped.startedAt).toBeNull();
  expect(skipped.receipts.map(row => row.kind)).toEqual(['skipped']);

  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-evecron-receipts-'));
  resetEvecronExecutionForTests();
  initDurableStore(directory);

  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { started } = await startThroughCore(raw, state);
  const stopping = await recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'stop-request', NOW + 7_000, {
    kind: 'request_stop', requestRef: 'user:stop-click'
  }));
  expect(stopping.state.status).toBe('stopping');
  expect(stopping.receipt).toMatchObject({ kind: 'stopping', label: 'Stopping', notifyInQuiet: false });
  expect(stopping.state.receipts.some(row => row.kind === 'stopped')).toBe(false);

  const stopped = await recordEvecronExecutionEvent(raw.id, executionEvent(stopping.state, 'stop-confirmed', NOW + 8_000, {
    kind: 'stopped',
    evidence: { kind: 'cancel-confirmed', evidenceRef: 'executor:cancel-confirmed' },
    summary: 'Stopped safely.'
  }));
  expect(stopped.state.status).toBe('stopped');
  expect(stopped.receipt).toMatchObject({ kind: 'stopped', label: 'Stopped', evidenceRef: 'executor:cancel-confirmed' });
});

it('fails closed on stale authority bindings and never lets a late Done overwrite Failed', async () => {
  const raw = await occurrence();
  const state = await bindEvecronExecution(raw);
  const { started, running, delivery } = await startThroughCore(raw, state);

  await expect(recordEvecronExecutionEvent(raw.id, {
    ...executionEvent(started.state, 'wrong-authority-progress', NOW + 6_000, {
      kind: 'progress', evidenceRef: 'progress:one', summary: 'Wrong revision', meaningfulMilestone: true
    }),
    binding: { ...state.binding, authorityPayloadHash: 'f'.repeat(64) }
  })).rejects.toThrow(/different scheduled occurrence or authority version/i);

  const failed = await recordEvecronExecutionEvent(raw.id, executionEvent(started.state, 'terminal-failure', NOW + 7_000, {
    kind: 'failed',
    failure: { evidenceRef: 'tool:error:permission', code: 'PERMISSION_DENIED' },
    summary: 'The required permission is unavailable.'
  }));
  expect(failed.state.status).toBe('failed');
  expect(failed.receipt).toMatchObject({ kind: 'failed', label: 'Failed', notifyInQuiet: true });

  const completion = {
    key: running.receiptKey,
    sessionId: delivery.sessionId,
    conversationId: delivery.conversationId,
    requestId: 'late-completion',
    completedAt: NOW + 8_000,
    result: 'done' as const
  };
  await expect(recordEvecronExecutionEvent(raw.id, executionEvent(failed.state, 'late-done', NOW + 8_000, {
    kind: 'done',
    coreCompletion: completion
  }))).rejects.toThrow(/from failed/i);
});
