import { createHash } from 'node:crypto';
import {
  claimEveCronOccurrence,
  completeEveCronOccurrence,
  eveCronWorkPayloadHash,
  markEveCronOccurrenceRunning,
  readScheduleState
} from './schedule.js';
import {
  bindEvecronExecution,
  recordEvecronExecutionEvent
} from './evecron-execution.js';
import {
  enqueueScheduleInput,
  listInputs,
  type InputEntry
} from './session/input.js';
import { sessionForConversation } from './session/recorder.js';
import { getSession, readEvents } from './session/store.js';
import {
  evecronExecutionEventSchema,
  type EvecronExecutionState,
  type EvecronTaskCompletionEvidence
} from '../shared/evecron-execution.js';
import type { EveCronOccurrence } from '../shared/schedule.js';
import { normalizedToolOutcome, type SessionEvent } from '../shared/session.js';

/**
 * Narrow bridge from the durable schedule core into the existing session/input outbox.
 *
 * This file does not decide when anything is due, open its own browser path, execute tools, or
 * interpret task prose. It admits one already-materialized Eve occurrence into a fresh schedule
 * chat, then turns existing outbox/session receipts into execution evidence.
 */

export interface EvecronRunAdmission {
  occurrence: EveCronOccurrence;
  input: InputEntry;
  execution: EvecronExecutionState;
}

export interface EvecronStartSync {
  occurrence: EveCronOccurrence;
  execution: EvecronExecutionState;
  input: InputEntry | null;
  started: boolean;
}

export interface CompleteEvecronRunInput {
  requestId: string;
  completedAt: number;
  evidence: EvecronTaskCompletionEvidence;
}

export interface CompleteEvecronRunFromSessionVerificationInput {
  sessionId: string;
  conversationId: string;
  verificationToolRef: string;
  resultToolRef?: string;
}

type ToolCallEvent = Extract<SessionEvent, { kind: 'tool_call' }>;

const NON_TASK_EVIDENCE_TOOLS = new Set([
  'agents',
  'chat_review_plan',
  'chat_review_complete',
  'schedule',
  'session',
  'session_finish',
  'update_plan',
  'work_context'
]);

async function occurrenceById(id: string): Promise<EveCronOccurrence> {
  const occurrence = (await readScheduleState()).occurrences.find(row => row.id === id);
  if (!occurrence) throw new Error('Scheduled occurrence not found');
  return occurrence;
}

function assertExecutableAuthority(occurrence: EveCronOccurrence): void {
  if (occurrence.work.target.kind !== 'installation-agent') {
    // Reusing an existing human chat would violate the schedule lane's ownership boundary.
    throw new Error('Session-target scheduled work needs a dedicated non-interactive runner');
  }
  if (eveCronWorkPayloadHash(occurrence.work) !== occurrence.work.authority.payloadHash) {
    throw new Error('Scheduled work authority does not match its executable payload');
  }
}

function completionEventId(occurrenceId: string, requestId: string): string {
  const digest = createHash('sha256').update(`${occurrenceId}\0${requestId}`, 'utf8').digest('hex');
  return `completion-verified:${digest}`;
}

function toolRefSeq(ref: string): number | null {
  const match = /^T([0-9A-Z]+)$/iu.exec(ref.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactEvidenceTool(
  events: readonly SessionEvent[],
  ref: string,
  anchorSeq: number,
  chatIds: ReadonlySet<string>
): ToolCallEvent {
  const seq = toolRefSeq(ref);
  if (seq === null) throw new Error('Schedule completion evidence must use an exact durable T… tool reference');
  const event = events.find((row): row is ToolCallEvent => row.seq === seq && row.kind === 'tool_call');
  if (!event) throw new Error(`Schedule completion evidence ${ref} is not a durable tool result in this session`);
  if (event.seq <= anchorSeq) throw new Error('Schedule completion evidence predates the scheduled task input');
  if (event.call.attributionMethod !== 'request_id' || !event.call.conversationId || !chatIds.has(event.call.conversationId)) {
    throw new Error('Schedule completion evidence is not exactly attributed to this scheduled session lineage');
  }
  if (normalizedToolOutcome(event.call) !== 'ok') throw new Error('Schedule completion evidence must be a successful durable tool result');
  if (NON_TASK_EVIDENCE_TOOLS.has(event.call.tool)) throw new Error(`${event.call.tool} is lifecycle/context metadata, not task completion evidence`);
  return event;
}

function evidenceRef(sessionId: string, event: ToolCallEvent): string {
  return `session:${sessionId}:tool:${event.call.callId}`;
}

/**
 * Admit one due Eve occurrence into the durable outbox.
 *
 * Claiming is reservation, not Start. The browser still must accept the exact fresh-chat input and
 * produce its native receipt before `syncEvecronOccurrenceStart()` may advance the occurrence.
 */
export async function admitEvecronOccurrence(occurrenceId: string, now = Date.now()): Promise<EvecronRunAdmission> {
  const occurrence = await occurrenceById(occurrenceId);
  assertExecutableAuthority(occurrence);
  if (occurrence.state !== 'scheduled') throw new Error('Only scheduled Eve work may enter the runner');
  if (occurrence.dueAt > now) throw new Error('Scheduled Eve work is not due yet');

  const execution = await bindEvecronExecution(occurrence);
  const claimed = await claimEveCronOccurrence(occurrence.id, occurrence.inputId, now);
  const input = await enqueueScheduleInput({
    id: claimed.inputId,
    occurrenceId: claimed.id,
    text: claimed.work.text,
    dueAt: claimed.dueAt,
    ...(claimed.work.automation ? { automation: claimed.work.automation } : {}),
    ...(claimed.work.objective ? { objective: claimed.work.objective } : {}),
    ...(claimed.work.projectId ? { projectId: claimed.work.projectId } : {}),
    ...(claimed.work.context ? { context: claimed.work.context } : {})
  });
  return { occurrence: claimed, input, execution };
}

/**
 * Convert an exact browser ACK for the schedule-owned fresh chat into Start evidence.
 *
 * A queued/claimed/browser-owned row is not enough. We require a durable `sent` outbox row with a
 * native message id, exact conversation id, delivery timestamp and a locally recorded session bound
 * to that same conversation. If recording has not materialized that session yet, this remains queued.
 */
export async function syncEvecronOccurrenceStart(occurrenceId: string): Promise<EvecronStartSync> {
  let occurrence = await occurrenceById(occurrenceId);
  assertExecutableAuthority(occurrence);
  let execution = await bindEvecronExecution(occurrence);
  if (occurrence.state !== 'scheduled') {
    return { occurrence, execution, input: null, started: occurrence.state === 'running' || occurrence.state === 'done' };
  }

  let input = (await listInputs()).find(row => row.id === occurrence.inputId && row.purpose === 'schedule' &&
    row.scheduleOccurrenceId === occurrence.id) ?? null;
  if (!input || input.state !== 'sent' || !input.messageId || !input.conversationId || !Number.isFinite(input.deliveredAt)) {
    return { occurrence, execution, input, started: false };
  }

  const sessionId = input.deliveredSessionId ?? await sessionForConversation(input.conversationId, occurrence.entryTitle);
  if (!sessionId) return { occurrence, execution, input, started: false };
  // Backfill the outbox's deliveredSessionId and canonical input history after the session exists.
  input = (await listInputs()).find(row => row.id === occurrence.inputId) ?? input;
  const session = await getSession(sessionId);
  if (!input.messageId || !input.conversationId || !Number.isFinite(input.deliveredAt) ||
      !session || session.conversationId !== input.conversationId ||
      (input.deliveredSessionId !== null && input.deliveredSessionId !== undefined && input.deliveredSessionId !== sessionId)) {
    return { occurrence, execution, input, started: false };
  }

  occurrence = await markEveCronOccurrenceRunning(occurrence.id, occurrence.inputId, {
    sessionId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    acceptedAt: input.deliveredAt!
  });
  execution = await bindEvecronExecution(occurrence);
  return { occurrence, execution, input, started: true };
}

/**
 * Finish one running occurrence only after task-specific proof is durable.
 *
 * The order is intentional: verification receipt -> schedule core completion -> user-facing Done
 * projection. A crash at either boundary is idempotently recoverable without treating final prose,
 * a worker sender-side finish, or elapsed time as task completion.
 */
export async function completeEvecronRun(
  occurrenceId: string,
  input: CompleteEvecronRunInput
): Promise<{ occurrence: EveCronOccurrence; execution: EvecronExecutionState }> {
  let occurrence = await occurrenceById(occurrenceId);
  assertExecutableAuthority(occurrence);
  let execution = await bindEvecronExecution(occurrence);
  if (occurrence.state === 'done') {
    if (execution.status !== 'done') throw new Error('Scheduled core is Done without prior durable task verification');
    return { occurrence, execution };
  }
  if (occurrence.state !== 'running' || !occurrence.delivery) throw new Error('Only running scheduled work may complete');
  if (!Number.isSafeInteger(input.completedAt) || input.completedAt < occurrence.delivery.acceptedAt) {
    throw new Error('Scheduled completion time is invalid');
  }

  const verified = evecronExecutionEventSchema.parse({
    eventId: completionEventId(occurrence.id, input.requestId),
    at: input.completedAt,
    binding: execution.binding,
    kind: 'completion_verified',
    evidence: input.evidence
  });
  const verification = await recordEvecronExecutionEvent(occurrence.id, verified);
  execution = verification.state;

  occurrence = await completeEveCronOccurrence(occurrence.id, {
    key: occurrence.receiptKey,
    sessionId: occurrence.delivery.sessionId,
    conversationId: occurrence.delivery.conversationId,
    requestId: input.requestId,
    completedAt: input.completedAt,
    result: 'done'
  });
  execution = await bindEvecronExecution(occurrence);
  return { occurrence, execution };
}

export async function completeEvecronRunFromSessionVerification(
  input: CompleteEvecronRunFromSessionVerificationInput,
  now = Date.now()
): Promise<{ occurrence: EveCronOccurrence; execution: EvecronExecutionState }> {
  if (!input.sessionId || !input.conversationId) throw new Error('Exact scheduled session identity is required');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Scheduled completion clock is invalid');

  const session = await getSession(input.sessionId);
  if (!session || session.conversationId !== input.conversationId) {
    throw new Error('Schedule completion caller is not the current conversation for this session');
  }
  const chatIds = new Set(session.chatIds);
  chatIds.add(input.conversationId);

  const state = await readScheduleState();
  const candidates = state.occurrences.filter((row) =>
    (row.state === 'running' || row.state === 'done') &&
    row.delivery?.sessionId === input.sessionId &&
    chatIds.has(row.delivery.conversationId)
  );
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? 'This session does not own one running scheduled occurrence'
      : 'Scheduled session lineage is ambiguous; refusing completion');
  }
  const occurrence = candidates[0]!;
  assertExecutableAuthority(occurrence);
  if (!occurrence.delivery) throw new Error('Running scheduled work is missing accepted delivery evidence');

  const scheduledInput = (await listInputs()).find((row) => row.id === occurrence.inputId);
  if (!scheduledInput || scheduledInput.purpose !== 'schedule' || scheduledInput.scheduleOccurrenceId !== occurrence.id ||
      !['sent', 'cancelled'].includes(scheduledInput.state) || scheduledInput.deliveredSessionId !== input.sessionId ||
      scheduledInput.conversationId !== occurrence.delivery.conversationId || scheduledInput.messageId !== occurrence.delivery.messageId) {
    throw new Error('Scheduled input delivery lineage is incomplete or no longer exact');
  }

  const events = await readEvents(input.sessionId, { kinds: ['user_message', 'tool_call'] });
  const anchors = events.filter((row) => row.kind === 'user_message' && row.inputId === occurrence.inputId &&
    row.inputDelivery === 'confirmed' && row.messageId === occurrence.delivery!.messageId);
  if (anchors.length !== 1) throw new Error('Exact durable scheduled input anchor is missing or ambiguous');
  const anchor = anchors[0]!;
  const verification = exactEvidenceTool(events, input.verificationToolRef, anchor.seq, chatIds);
  const result = exactEvidenceTool(events, input.resultToolRef ?? input.verificationToolRef, anchor.seq, chatIds);
  if (verification.seq < result.seq) throw new Error('Schedule verification must not predate the cited task result');

  const requestId = `schedule-verified:${verification.call.callId}:${result.call.callId}`;
  if (occurrence.state === 'done' && occurrence.completion?.requestId !== requestId) {
    throw new Error('Scheduled occurrence already completed from different verification evidence');
  }
  const completedAt = Math.max(now, occurrence.delivery.acceptedAt, verification.time, result.time);
  return completeEvecronRun(occurrence.id, {
    requestId,
    completedAt,
    evidence: {
      kind: 'verified-result',
      evidenceRef: evidenceRef(input.sessionId, verification),
      resultRef: evidenceRef(input.sessionId, result)
    }
  });
}
