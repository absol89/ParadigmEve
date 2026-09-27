import { z } from 'zod';
import {
  eveCronOccurrenceSchema,
  scheduleCompletionReceiptSchema,
  type EveCronOccurrence,
  type ScheduleCompletionReceipt
} from './schedule.js';

/**
 * Evidence-backed execution receipts for Eve's schedule.
 *
 * This module is deliberately not a scheduler or an executor. The schedule core owns recurrence,
 * durable occurrences and executable authority. Existing session/worker/local executors own the
 * side effects. This layer only records what their positive evidence proves and whether that fact
 * should become a user-facing receipt.
 */

export const EVECRON_EXECUTION_STATUSES = [
  'queued',
  'running',
  'needs_user',
  'retrying',
  'stopping',
  'skipped',
  'stopped',
  'failed',
  'done'
] as const;

export const EVECRON_RECEIPT_KINDS = [
  'queued',
  'started',
  'progress',
  'needs_user',
  'retrying',
  'stopping',
  'skipped',
  'stopped',
  'failed',
  'done'
] as const;

const timestampSchema = z.number().int().nonnegative();
const uuidSchema = z.string().uuid();
const opaqueIdSchema = z.string().min(1).max(256);
const evidenceRefSchema = z.string().min(1).max(320);
const payloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a SHA-256 payload hash');

/** Exact schedule-core identity frozen into every evidence event. */
export const evecronExecutionBindingSchema = z.object({
  occurrenceId: uuidSchema,
  entryId: uuidSchema,
  entryVersion: timestampSchema,
  inputId: uuidSchema,
  receiptKey: z.string().min(16).max(180),
  authorityPayloadHash: payloadHashSchema
}).strict();

export type EvecronExecutionBinding = z.infer<typeof evecronExecutionBindingSchema>;

export function evecronExecutionBindingFromOccurrence(raw: EveCronOccurrence): EvecronExecutionBinding {
  const occurrence = eveCronOccurrenceSchema.parse(raw);
  return evecronExecutionBindingSchema.parse({
    occurrenceId: occurrence.id,
    entryId: occurrence.entryId,
    entryVersion: occurrence.entryVersion,
    inputId: occurrence.inputId,
    receiptKey: occurrence.receiptKey,
    authorityPayloadHash: occurrence.work.authority.payloadHash
  });
}

const startEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('schedule-delivery-accepted'),
    inputId: uuidSchema,
    sessionId: z.string().min(8).max(64),
    conversationId: z.string().min(8).max(256),
    messageId: z.string().min(1).max(256),
    acceptedAt: timestampSchema,
    /** Existing user chat activity is never a start lane for a scheduled occurrence. */
    lane: z.literal('schedule-session')
  }).strict(),
  z.object({
    kind: z.literal('worker-activated'),
    workerId: opaqueIdSchema,
    conversationId: z.string().min(8).max(256),
    runId: opaqueIdSchema.optional(),
    activatedAt: timestampSchema,
    lane: z.literal('worker')
  }).strict(),
  z.object({
    kind: z.literal('local-handler-entered'),
    operationId: opaqueIdSchema,
    enteredAt: timestampSchema,
    lane: z.literal('local-handler')
  }).strict()
]);

export type EvecronStartEvidence = z.infer<typeof startEvidenceSchema>;

const taskCompletionEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('verified-result'),
    evidenceRef: evidenceRefSchema,
    resultRef: evidenceRefSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal('worker-reviewed'),
    workerId: opaqueIdSchema,
    reportMessageId: opaqueIdSchema,
    deliveredAt: timestampSchema,
    reviewedAt: timestampSchema,
    verificationRef: evidenceRefSchema,
    resultRef: evidenceRefSchema.optional()
  }).strict().refine(value => value.reviewedAt >= value.deliveredAt, {
    message: 'Worker completion review cannot precede delivery proof'
  })
]);

export type EvecronTaskCompletionEvidence = z.infer<typeof taskCompletionEvidenceSchema>;

const failureEvidenceSchema = z.object({
  evidenceRef: evidenceRefSchema,
  code: z.string().trim().min(1).max(120).optional()
}).strict();

const progressUnitsSchema = z.object({
  completed: z.number().finite().nonnegative(),
  total: z.number().finite().positive()
}).strict().refine(value => value.completed <= value.total, {
  message: 'Completed progress cannot exceed the known total'
});

const eventBase = {
  eventId: opaqueIdSchema,
  at: timestampSchema,
  binding: evecronExecutionBindingSchema
};

export const evecronExecutionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...eventBase,
    kind: z.literal('start'),
    evidence: startEvidenceSchema
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('progress'),
    evidenceRef: evidenceRefSchema,
    summary: z.string().trim().min(1).max(500),
    meaningfulMilestone: z.boolean().default(false),
    units: progressUnitsSchema.optional()
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('needs_user'),
    requestRef: evidenceRefSchema,
    need: z.enum(['approval', 'information']),
    summary: z.string().trim().min(1).max(500)
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('retrying'),
    failure: failureEvidenceSchema,
    retryAt: timestampSchema,
    summary: z.string().trim().min(1).max(500).optional()
  }).strict().refine(value => value.retryAt >= value.at, {
    message: 'Retry time cannot precede the failure'
  }),
  z.object({
    ...eventBase,
    kind: z.literal('request_stop'),
    requestRef: evidenceRefSchema
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('stopped'),
    evidence: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cancel-confirmed'), evidenceRef: evidenceRefSchema }).strict(),
      z.object({ kind: z.literal('cancelled-before-start'), evidenceRef: evidenceRefSchema }).strict()
    ]),
    summary: z.string().trim().min(1).max(500).optional()
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('skipped'),
    reasonRef: evidenceRefSchema,
    summary: z.string().trim().min(1).max(500).optional()
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('failed'),
    failure: failureEvidenceSchema,
    summary: z.string().trim().min(1).max(500).optional()
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('completion_verified'),
    /** Durable task-specific proof recorded before the schedule core publishes Done. */
    evidence: taskCompletionEvidenceSchema
  }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('done'),
    /** Core completion proves exact occurrence/session lineage, not task correctness by itself. */
    coreCompletion: scheduleCompletionReceiptSchema,
    summary: z.string().trim().min(1).max(500).optional()
  }).strict()
]);

export type EvecronExecutionEvent = z.infer<typeof evecronExecutionEventSchema>;
export type EvecronExecutionStatus = (typeof EVECRON_EXECUTION_STATUSES)[number];
export type EvecronReceiptKind = (typeof EVECRON_RECEIPT_KINDS)[number];

export const evecronReceiptSchema = z.object({
  id: z.string().min(1).max(460),
  occurrenceId: uuidSchema,
  entryId: uuidSchema,
  sourceEventId: opaqueIdSchema,
  kind: z.enum(EVECRON_RECEIPT_KINDS),
  at: timestampSchema,
  label: z.string().min(1).max(80),
  detail: z.string().min(1).max(500).optional(),
  evidenceRef: evidenceRefSchema.optional(),
  /** Quiet is the default. False means keep it in activity/noisy view without interrupting. */
  notifyInQuiet: z.boolean(),
  shownAt: timestampSchema.nullable(),
  links: z.object({
    entryId: uuidSchema,
    occurrenceId: uuidSchema,
    planId: uuidSchema.optional(),
    resultRef: evidenceRefSchema.optional()
  }).strict()
}).strict();

export type EvecronReceipt = z.infer<typeof evecronReceiptSchema>;

const appliedEventSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(['start', 'progress', 'needs_user', 'retrying', 'request_stop', 'stopped', 'skipped', 'failed', 'completion_verified', 'done'])
}).strict();

const completionProofSchema = z.object({
  core: scheduleCompletionReceiptSchema,
  task: taskCompletionEvidenceSchema
}).strict();

export const evecronExecutionStateSchema = z.object({
  version: z.literal(1),
  binding: evecronExecutionBindingSchema,
  planId: uuidSchema.optional(),
  status: z.enum(EVECRON_EXECUTION_STATUSES),
  queuedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  attempt: z.number().int().nonnegative(),
  startedBy: startEvidenceSchema.nullable(),
  verifiedCompletion: taskCompletionEvidenceSchema.nullable(),
  completionProof: completionProofSchema.nullable(),
  terminalFailure: failureEvidenceSchema.nullable(),
  lastProgressAt: timestampSchema.nullable(),
  lastQuietReceiptAt: timestampSchema.nullable(),
  appliedEvents: z.array(appliedEventSchema).max(512),
  receipts: z.array(evecronReceiptSchema).max(512)
}).strict();

export type EvecronExecutionState = z.infer<typeof evecronExecutionStateSchema>;

const QUIET_PROGRESS_MS = 30 * 60_000;

const receiptLabel: Record<EvecronReceiptKind, string> = {
  queued: 'Waiting to start',
  started: 'Started',
  progress: 'Progress',
  needs_user: 'Needs you',
  retrying: 'Trying again',
  stopping: 'Stopping',
  skipped: 'Skipped',
  stopped: 'Stopped',
  failed: 'Failed',
  done: 'Done'
};

function sameBinding(left: EvecronExecutionBinding, right: EvecronExecutionBinding): boolean {
  return left.occurrenceId === right.occurrenceId && left.entryId === right.entryId &&
    left.entryVersion === right.entryVersion && left.inputId === right.inputId &&
    left.receiptKey === right.receiptKey && left.authorityPayloadHash === right.authorityPayloadHash;
}

function receipt(
  state: EvecronExecutionState,
  sourceEventId: string,
  kind: EvecronReceiptKind,
  at: number,
  notifyInQuiet: boolean,
  options: { detail?: string; evidenceRef?: string; resultRef?: string } = {}
): EvecronReceipt {
  const singleton = kind === 'queued' || kind === 'started' || kind === 'skipped' ||
    kind === 'stopped' || kind === 'failed' || kind === 'done';
  return evecronReceiptSchema.parse({
    // Singleton lifecycle facts keep the same user-visible receipt identity even when restart
    // recovery observes the core transition before the ordinary callback reaches this ledger.
    id: `${state.binding.occurrenceId}:${singleton ? kind : sourceEventId}`,
    occurrenceId: state.binding.occurrenceId,
    entryId: state.binding.entryId,
    sourceEventId,
    kind,
    at,
    label: receiptLabel[kind],
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
    notifyInQuiet,
    shownAt: null,
    links: {
      entryId: state.binding.entryId,
      occurrenceId: state.binding.occurrenceId,
      ...(state.planId ? { planId: state.planId } : {}),
      ...(options.resultRef ? { resultRef: options.resultRef } : {})
    }
  });
}

function startedAt(evidence: EvecronStartEvidence): number {
  if (evidence.kind === 'schedule-delivery-accepted') return evidence.acceptedAt;
  if (evidence.kind === 'worker-activated') return evidence.activatedAt;
  return evidence.enteredAt;
}

/**
 * Bind receipt state to an occurrence already materialized by the schedule core. Terminal Done/
 * Failed rows are intentionally not reconstructed from prose-level history: the stronger receipt
 * evidence must have been recorded before the terminal transition.
 */
export function createEvecronExecutionState(raw: EveCronOccurrence): EvecronExecutionState {
  const occurrence = eveCronOccurrenceSchema.parse(raw);
  const binding = evecronExecutionBindingFromOccurrence(occurrence);
  const planId = occurrence.work.provenance?.planId;
  const base: EvecronExecutionState = {
    version: 1,
    binding,
    ...(planId ? { planId } : {}),
    status: 'queued',
    queuedAt: occurrence.createdAt,
    startedAt: null,
    completedAt: null,
    attempt: 0,
    startedBy: null,
    verifiedCompletion: null,
    completionProof: null,
    terminalFailure: null,
    lastProgressAt: null,
    lastQuietReceiptAt: null,
    appliedEvents: [],
    receipts: []
  };

  if (occurrence.state === 'done' || occurrence.state === 'failed') {
    throw new Error('Terminal scheduled work cannot be backfilled as a verified execution receipt');
  }
  if (occurrence.state === 'skipped') {
    const detail = occurrence.skipNote ?? occurrence.skipReason ?? 'Skipped';
    return evecronExecutionStateSchema.parse({
      ...base,
      status: 'skipped',
      completedAt: occurrence.updatedAt,
      receipts: [receipt(base, 'core-skipped', 'skipped', occurrence.updatedAt, true, { detail })]
    });
  }

  const queuedReceipt = receipt(base, 'queued', 'queued', occurrence.createdAt, false);
  if (occurrence.state === 'scheduled') {
    return evecronExecutionStateSchema.parse({ ...base, receipts: [queuedReceipt] });
  }
  if (!occurrence.delivery) throw new Error('Running scheduled work is missing accepted delivery evidence');
  const proof: EvecronStartEvidence = {
    kind: 'schedule-delivery-accepted',
    inputId: occurrence.inputId,
    ...occurrence.delivery,
    lane: 'schedule-session'
  };
  const running = { ...base, status: 'running' as const, startedAt: occurrence.delivery.acceptedAt, attempt: 1, startedBy: proof };
  return evecronExecutionStateSchema.parse({
    ...running,
    lastQuietReceiptAt: occurrence.delivery.acceptedAt,
    receipts: [queuedReceipt, receipt(running, 'core-started', 'started', occurrence.delivery.acceptedAt, true)]
  });
}

/**
 * Reconcile receipt state from the schedule core after a restart without inventing semantic proof.
 * A core Done remains invisible as Done until task-specific verification was durably recorded here.
 */
export function reconcileEvecronExecutionState(
  rawState: EvecronExecutionState,
  rawOccurrence: EveCronOccurrence
): EvecronExecutionState {
  const state = evecronExecutionStateSchema.parse(rawState);
  const occurrence = eveCronOccurrenceSchema.parse(rawOccurrence);
  const binding = evecronExecutionBindingFromOccurrence(occurrence);
  if (!sameBinding(state.binding, binding)) throw new Error('Schedule occurrence no longer matches its execution receipt authority');

  if (occurrence.state === 'running' && state.startedAt === null) {
    if (!occurrence.delivery) throw new Error('Running scheduled work is missing accepted delivery evidence');
    const proof: EvecronStartEvidence = {
      kind: 'schedule-delivery-accepted', inputId: occurrence.inputId, ...occurrence.delivery, lane: 'schedule-session'
    };
    const recovered = { ...state, status: 'running' as const, startedAt: occurrence.delivery.acceptedAt, attempt: 1, startedBy: proof };
    const startReceipt = receipt(recovered, 'core-started', 'started', occurrence.delivery.acceptedAt, true);
    return evecronExecutionStateSchema.parse({
      ...recovered,
      lastQuietReceiptAt: occurrence.delivery.acceptedAt,
      receipts: state.receipts.some(row => row.kind === 'started') ? state.receipts : [...state.receipts, startReceipt]
    });
  }

  if (occurrence.state === 'skipped' && state.startedAt === null && state.status !== 'skipped') {
    const skipReceipt = receipt(state, 'core-skipped', 'skipped', occurrence.updatedAt, true, {
      detail: occurrence.skipNote ?? occurrence.skipReason ?? 'Skipped'
    });
    return evecronExecutionStateSchema.parse({
      ...state,
      status: 'skipped',
      completedAt: occurrence.updatedAt,
      lastQuietReceiptAt: occurrence.updatedAt,
      receipts: [...state.receipts, skipReceipt]
    });
  }

  if (occurrence.state === 'done' && state.status !== 'done') {
    if (!occurrence.completion || occurrence.completion.result !== 'done' || !state.verifiedCompletion) return state;
    assertCoreCompletionBelongs(state, occurrence.completion);
    const doneReceipt = receipt(state, 'core-done', 'done', occurrence.completion.completedAt, true, {
      evidenceRef: completionEvidenceRef(state.verifiedCompletion),
      resultRef: completionResultRef(state.verifiedCompletion)
    });
    return evecronExecutionStateSchema.parse({
      ...state,
      status: 'done',
      completedAt: occurrence.completion.completedAt,
      completionProof: { core: occurrence.completion, task: state.verifiedCompletion },
      lastQuietReceiptAt: occurrence.completion.completedAt,
      receipts: state.receipts.some(row => row.kind === 'done') ? state.receipts : [...state.receipts, doneReceipt]
    });
  }

  return state;
}

export interface EvecronExecutionTransition {
  state: EvecronExecutionState;
  receipt: EvecronReceipt | null;
  duplicate: boolean;
}

function withEvent(
  event: EvecronExecutionEvent,
  next: EvecronExecutionState,
  nextReceipt: EvecronReceipt | null
): EvecronExecutionTransition {
  const candidate = evecronExecutionStateSchema.parse({
    ...next,
    appliedEvents: [...next.appliedEvents, { id: event.eventId, kind: event.kind }],
    receipts: nextReceipt ? [...next.receipts, nextReceipt] : next.receipts,
    lastQuietReceiptAt: nextReceipt?.notifyInQuiet ? nextReceipt.at : next.lastQuietReceiptAt
  });
  return { state: candidate, receipt: nextReceipt, duplicate: false };
}

function completionResultRef(evidence: EvecronTaskCompletionEvidence): string | undefined {
  return evidence.resultRef;
}

function completionEvidenceRef(evidence: EvecronTaskCompletionEvidence): string {
  return evidence.kind === 'worker-reviewed' ? evidence.verificationRef : evidence.evidenceRef;
}

function assertCoreCompletionBelongs(
  state: EvecronExecutionState,
  completion: ScheduleCompletionReceipt
): void {
  if (completion.key !== state.binding.receiptKey || completion.result !== 'done') {
    throw new Error('Scheduled Done receipt does not match the exact occurrence completion');
  }
  if (state.startedBy?.kind === 'schedule-delivery-accepted' &&
      (completion.sessionId !== state.startedBy.sessionId || completion.conversationId !== state.startedBy.conversationId)) {
    throw new Error('Scheduled Done receipt does not match the execution owner');
  }
}

/** Apply one app-owned execution fact. No transition here schedules or starts work by itself. */
export function applyEvecronExecutionEvent(
  rawState: EvecronExecutionState,
  rawEvent: EvecronExecutionEvent
): EvecronExecutionTransition {
  const state = evecronExecutionStateSchema.parse(rawState);
  const event = evecronExecutionEventSchema.parse(rawEvent);
  if (!sameBinding(state.binding, event.binding)) throw new Error('Execution evidence belongs to a different scheduled occurrence or authority version');

  const prior = state.appliedEvents.find(row => row.id === event.eventId);
  if (prior) {
    if (prior.kind !== event.kind) throw new Error('Execution event id was reused for a different fact');
    return { state, receipt: state.receipts.find(row => row.sourceEventId === event.eventId) ?? null, duplicate: true };
  }
  if (state.appliedEvents.length >= 512 || state.receipts.length >= 512) throw new Error('Execution receipt history is full');

  switch (event.kind) {
    case 'start': {
      if (state.status === 'running' && state.startedBy && JSON.stringify(state.startedBy) === JSON.stringify(event.evidence)) {
        return { state, receipt: state.receipts.find(row => row.kind === 'started') ?? null, duplicate: true };
      }
      if (!['queued', 'needs_user', 'retrying'].includes(state.status)) throw new Error(`Cannot start scheduled work from ${state.status}`);
      if (event.evidence.kind === 'schedule-delivery-accepted' && event.evidence.inputId !== state.binding.inputId) {
        throw new Error('Accepted delivery belongs to a different scheduled input');
      }
      const firstStart = state.startedAt === null;
      const at = startedAt(event.evidence);
      const next = {
        ...state,
        status: 'running' as const,
        startedAt: state.startedAt ?? at,
        attempt: state.attempt + 1,
        startedBy: state.startedBy ?? event.evidence
      };
      return withEvent(event, next, firstStart ? receipt(state, event.eventId, 'started', at, true) : null);
    }
    case 'progress': {
      if (state.status !== 'running') throw new Error(`Cannot record scheduled progress from ${state.status}`);
      const notifyInQuiet = event.meaningfulMilestone || state.lastQuietReceiptAt === null || event.at - state.lastQuietReceiptAt >= QUIET_PROGRESS_MS;
      const units = event.units ? ` (${event.units.completed} of ${event.units.total})` : '';
      const next = { ...state, lastProgressAt: event.at };
      return withEvent(event, next, receipt(state, event.eventId, 'progress', event.at, notifyInQuiet, {
        detail: `${event.summary}${units}`,
        evidenceRef: event.evidenceRef
      }));
    }
    case 'needs_user': {
      if (!['queued', 'running', 'retrying'].includes(state.status)) throw new Error(`Cannot request user input from ${state.status}`);
      const next = { ...state, status: 'needs_user' as const };
      return withEvent(event, next, receipt(state, event.eventId, 'needs_user', event.at, true, {
        detail: event.summary,
        evidenceRef: event.requestRef
      }));
    }
    case 'retrying': {
      if (state.status !== 'running') throw new Error(`Cannot retry scheduled work from ${state.status}`);
      const next = { ...state, status: 'retrying' as const };
      return withEvent(event, next, receipt(state, event.eventId, 'retrying', event.at,
        event.retryAt - event.at >= QUIET_PROGRESS_MS,
        { detail: event.summary, evidenceRef: event.failure.evidenceRef }));
    }
    case 'request_stop': {
      if (!['running', 'retrying', 'needs_user'].includes(state.status)) throw new Error(`Cannot stop scheduled work from ${state.status}`);
      const next = { ...state, status: 'stopping' as const };
      return withEvent(event, next, receipt(state, event.eventId, 'stopping', event.at, false, { evidenceRef: event.requestRef }));
    }
    case 'stopped': {
      const neverStarted = state.startedAt === null;
      if (neverStarted) {
        if (!['queued', 'needs_user'].includes(state.status) || event.evidence.kind !== 'cancelled-before-start') {
          throw new Error('Unstarted scheduled work requires cancellation-before-start evidence');
        }
      } else if (state.status !== 'stopping' || event.evidence.kind !== 'cancel-confirmed') {
        throw new Error('Running scheduled work is Stopped only after cancellation is confirmed');
      }
      const next = { ...state, status: 'stopped' as const, completedAt: event.at };
      return withEvent(event, next, receipt(state, event.eventId, 'stopped', event.at, true, {
        detail: event.summary,
        evidenceRef: event.evidence.evidenceRef
      }));
    }
    case 'skipped': {
      if (state.startedAt !== null || !['queued', 'needs_user'].includes(state.status)) throw new Error('Only unstarted scheduled work can be skipped');
      const next = { ...state, status: 'skipped' as const, completedAt: event.at };
      return withEvent(event, next, receipt(state, event.eventId, 'skipped', event.at, true, {
        detail: event.summary,
        evidenceRef: event.reasonRef
      }));
    }
    case 'failed': {
      if (!['running', 'retrying', 'needs_user', 'stopping'].includes(state.status)) throw new Error(`Cannot fail scheduled work from ${state.status}`);
      const next = { ...state, status: 'failed' as const, completedAt: event.at, terminalFailure: event.failure };
      return withEvent(event, next, receipt(state, event.eventId, 'failed', event.at, true, {
        detail: event.summary,
        evidenceRef: event.failure.evidenceRef
      }));
    }
    case 'completion_verified': {
      if (state.status !== 'running') throw new Error(`Cannot verify scheduled completion from ${state.status}`);
      const next = { ...state, verifiedCompletion: event.evidence };
      return withEvent(event, next, null);
    }
    case 'done': {
      if (state.status !== 'running') throw new Error(`Cannot complete scheduled work from ${state.status}`);
      assertCoreCompletionBelongs(state, event.coreCompletion);
      if (!state.verifiedCompletion) throw new Error('Scheduled Done needs durable task-specific completion evidence first');
      const next = {
        ...state,
        status: 'done' as const,
        completedAt: event.at,
        completionProof: { core: event.coreCompletion, task: state.verifiedCompletion }
      };
      return withEvent(event, next, receipt(state, event.eventId, 'done', event.at, true, {
        detail: event.summary,
        evidenceRef: completionEvidenceRef(state.verifiedCompletion),
        resultRef: completionResultRef(state.verifiedCompletion)
      }));
    }
  }
}

export function pendingEvecronReceipts(
  states: readonly EvecronExecutionState[],
  mode: 'quiet' | 'noisy' = 'quiet'
): EvecronReceipt[] {
  return states
    .flatMap(state => evecronExecutionStateSchema.parse(state).receipts)
    .filter(row => row.shownAt === null && (mode === 'noisy' || row.notifyInQuiet))
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}

export function markEvecronReceiptShown(
  rawState: EvecronExecutionState,
  receiptId: string,
  shownAt: number
): EvecronExecutionState {
  const state = evecronExecutionStateSchema.parse(rawState);
  const at = timestampSchema.parse(shownAt);
  let found = false;
  const receipts = state.receipts.map(row => {
    if (row.id !== receiptId) return row;
    found = true;
    return row.shownAt === null ? { ...row, shownAt: at } : row;
  });
  if (!found) throw new Error('Execution receipt does not exist');
  return evecronExecutionStateSchema.parse({ ...state, receipts });
}
