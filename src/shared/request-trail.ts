import { z } from 'zod';

/** Durable lifecycle of one user-authored request Eve accepted for longer-running work. */
export const REQUEST_TRAIL_STATES = [
  'accepted',
  'planned',
  'running',
  'needs_user',
  'failed',
  'cancelled'
] as const;

export const REQUEST_TRAIL_CHECK_IN_KINDS = ['progress', 'silence', 'needs_user', 'terminal'] as const;

/** Session events that may be retained as an exact result/Needs-you locator. */
export const REQUEST_TRAIL_EVENT_KINDS = [
  'user_message',
  'assistant_message',
  'progress',
  'page_tool',
  'turn_start',
  'turn_end',
  'chat_error',
  'tool_call',
  'note',
  'agent_message',
  'handoff'
] as const;

const timestamp = z.number().finite().int().nonnegative();
const sessionId = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const conversationId = z.string().min(8).max(256).regex(/^[0-9a-z-]+$/i).nullable();
const sourceId = z.string().min(1).max(256);
const uuid = z.string().uuid();

/**
 * Exact source of the user's request. `eventSeq` is the canonical first sequence of that
 * user_message, not a nearby turn or a prose search result. Optional website ids are locators and
 * consistency checks only; session + canonical event sequence owns identity.
 */
export const requestTrailOriginSchema = z.object({
  sessionId,
  conversationId,
  eventSeq: z.number().int().min(1).max(10_000_000),
  messageId: sourceId.optional(),
  turnId: sourceId.optional()
}).strict();

/** Exact durable session-event locator for a result or a Needs-you handoff. */
export const requestTrailEventRefSchema = z.object({
  sessionId,
  conversationId,
  eventSeq: z.number().int().min(1).max(10_000_000),
  kind: z.enum(REQUEST_TRAIL_EVENT_KINDS),
  messageId: sourceId.optional(),
  turnId: sourceId.optional(),
  callId: sourceId.optional()
}).strict();

/**
 * Stable broker-status pointer. Worker state itself is deliberately not copied here because it
 * would become a second authority; runId + workerId resolves status from the worker owner.
 */
export const requestTrailWorkerRefSchema = z.object({
  runId: uuid,
  workerId: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  conversationId: conversationId.optional()
}).strict();

const workerRefsSchema = z.array(requestTrailWorkerRefSchema).max(32)
  .refine(refs => new Set(refs.map(ref => `${ref.runId}:${ref.workerId}`)).size === refs.length,
    'Worker status refs must be unique');

export const requestTrailStateSchema = z.enum(REQUEST_TRAIL_STATES);

const planIdsSchema = z.array(uuid).max(32)
  .refine(ids => new Set(ids).size === ids.length, 'Eve Activity Plan ids must be unique');

const notificationClaimSchema = z.object({
  dedupeKey: z.string().min(1).max(512),
  kind: z.enum(REQUEST_TRAIL_CHECK_IN_KINDS),
  claimedAt: timestamp,
  /** Request revision the presentation owner proved current before this claim was committed. */
  sourceRevision: z.number().int().positive()
}).strict();

const eventRefsSchema = z.array(requestTrailEventRefSchema).max(32)
  .refine(refs => new Set(refs.map(ref => `${ref.sessionId}:${ref.eventSeq}:${ref.kind}`)).size === refs.length,
    'Request Trail event references must be unique');

export const requestTrailRecordSchema = z.object({
  id: uuid,
  origin: requestTrailOriginSchema,
  /** Display snapshot only. It never establishes request identity or execution authority. */
  summary: z.string().trim().min(1).max(1_000),
  state: requestTrailStateSchema,
  /** High-level user Plan. Its archive is user signoff and must never be inferred from result prose. */
  planId: uuid.nullable(),
  /** Eve-owned Activity Plans. Their archive may close Eve Activity without signing off planId. */
  eveActivityPlanIds: planIdsSchema,
  workers: workerRefsSchema,
  resultRef: requestTrailEventRefSchema.nullable(),
  /** Exact validation/test evidence for the current implementation result. */
  testRefs: eventRefsSchema.default([]),
  needsUserRef: requestTrailEventRefSchema.nullable(),
  /** User-facing Thread id; storage elsewhere may still use the legacy Quilt type name. */
  threadId: uuid.nullable(),
  /** User-facing wider Quilt ids; storage elsewhere may still call these collection ids. */
  quiltIds: z.array(uuid).max(50).refine(ids => new Set(ids).size === ids.length, 'Quilt ids must be unique'),
  createdAt: timestamp,
  updatedAt: timestamp,
  stateChangedAt: timestamp,
  /** Monotonic durable record revision used to reject stale presentation claims. */
  revision: z.number().int().positive().default(1),
  /** Latest durably accepted check-in claim, independent from notification delivery success. */
  lastCheckInAt: timestamp.nullable().default(null),
  /**
   * Durable at-most-once claim ledger. Never evict old keys: dropping one would make a restart
   * capable of replaying a notification already handed to an external notifier.
   */
  notificationClaims: z.array(notificationClaimSchema).max(2_048).default([]),
  /** Implementation/result completion, distinct from both Eve Activity closure and user signoff. */
  implementationCompletedAt: timestamp.nullable().default(null),
  /** Eve-owned Activity closure, normally projected from archived Eve Activity Plans. */
  eveActivityClosedAt: timestamp.nullable().default(null),
  /** Explicit high-level user Plan archive/signoff. Only structural Plan archive may set this. */
  userPlanArchivedAt: timestamp.nullable().default(null),
  /** Only failed/cancelled are terminal request-flow states. Implementation completion is orthogonal. */
  terminalAt: timestamp.nullable()
}).strict()
  .refine(row => row.updatedAt >= row.createdAt && row.stateChangedAt >= row.createdAt && row.stateChangedAt <= row.updatedAt,
    'Request trail timestamps are invalid')
  .refine(row => {
    const terminal = row.state === 'failed' || row.state === 'cancelled';
    return terminal ? row.terminalAt !== null && row.terminalAt >= row.stateChangedAt : row.terminalAt === null;
  }, 'Request trail terminal timestamp is invalid')
  .refine(row => row.state !== 'needs_user' || row.needsUserRef !== null,
    'Needs-user requests require an exact session-event reference')
  .refine(row => row.userPlanArchivedAt === null || row.planId !== null,
    'User Plan archive/signoff requires a linked high-level Plan')
  .refine(row => row.eveActivityClosedAt === null || row.eveActivityPlanIds.length > 0,
    'Eve Activity closure requires linked Eve Activity Plan evidence')
  .refine(row => row.userPlanArchivedAt === null || row.implementationCompletedAt !== null,
    'A user-signed-off Plan must already have an implementation result')
  .refine(row => new Set(row.notificationClaims.map(claim => claim.dedupeKey)).size === row.notificationClaims.length,
    'Request notification claim keys must be unique')
  .refine(row => row.notificationClaims.every(claim => claim.sourceRevision <= row.revision),
    'Request notification claim revision is invalid');

export const requestTrailCatalogSchema = z.object({
  version: z.literal(1),
  requests: z.array(requestTrailRecordSchema).max(5_000)
}).strict()
  .refine(value => new Set(value.requests.map(row => row.id)).size === value.requests.length,
    'Request trail ids must be unique')
  .refine(value => new Set(value.requests.map(row => requestTrailOriginKey(row.origin))).size === value.requests.length,
    'Originating user requests must be unique');

export const requestTrailCreateSchema = z.object({
  origin: requestTrailOriginSchema,
  summary: z.string().trim().min(1).max(1_000),
  state: requestTrailStateSchema.optional().default('accepted'),
  planId: uuid.nullable().optional().default(null),
  eveActivityPlanIds: planIdsSchema.optional().default([]),
  workers: workerRefsSchema.optional().default([]),
  resultRef: requestTrailEventRefSchema.nullable().optional().default(null),
  testRefs: eventRefsSchema.optional().default([]),
  needsUserRef: requestTrailEventRefSchema.nullable().optional().default(null),
  threadId: uuid.nullable().optional().default(null),
  quiltIds: z.array(uuid).max(50).refine(ids => new Set(ids).size === ids.length, 'Quilt ids must be unique').optional().default([])
}).strict().refine(value => value.state !== 'needs_user' || value.needsUserRef !== null,
  'Needs-user requests require an exact session-event reference');

export const requestTrailPatchSchema = z.object({
  summary: z.string().trim().min(1).max(1_000).optional(),
  state: requestTrailStateSchema.optional(),
  planId: uuid.nullable().optional(),
  eveActivityPlanIds: planIdsSchema.optional(),
  workers: workerRefsSchema.optional(),
  resultRef: requestTrailEventRefSchema.nullable().optional(),
  testRefs: eventRefsSchema.optional(),
  needsUserRef: requestTrailEventRefSchema.nullable().optional(),
  threadId: uuid.nullable().optional(),
  quiltIds: z.array(uuid).max(50).refine(ids => new Set(ids).size === ids.length, 'Quilt ids must be unique').optional()
}).strict().refine(value => Object.values(value).some(field => field !== undefined), 'Request trail update is empty');

export type RequestTrailState = z.infer<typeof requestTrailStateSchema>;
export type RequestTrailOrigin = z.infer<typeof requestTrailOriginSchema>;
export type RequestTrailEventRef = z.infer<typeof requestTrailEventRefSchema>;
export type RequestTrailWorkerRef = z.infer<typeof requestTrailWorkerRefSchema>;
export type RequestTrailRecord = z.infer<typeof requestTrailRecordSchema>;
export type RequestTrailCreate = z.input<typeof requestTrailCreateSchema>;
export type RequestTrailPatch = z.input<typeof requestTrailPatchSchema>;
export type RequestTrailCheckInKind = typeof REQUEST_TRAIL_CHECK_IN_KINDS[number];

export type RequestTrailMilestoneStates = {
  implementation: 'pending' | 'complete';
  eveActivity: 'open' | 'closed';
  userPlanSignoff: 'none' | 'pending' | 'archived';
};

/** Presentation projection only; the timestamps/Plan owner remain the durable facts. */
export function requestTrailMilestoneStates(record: Pick<RequestTrailRecord,
  'planId' | 'implementationCompletedAt' | 'eveActivityClosedAt' | 'userPlanArchivedAt'>): RequestTrailMilestoneStates {
  return {
    implementation: record.implementationCompletedAt === null ? 'pending' : 'complete',
    eveActivity: record.eveActivityClosedAt === null ? 'open' : 'closed',
    userPlanSignoff: record.planId === null ? 'none' : record.userPlanArchivedAt === null ? 'pending' : 'archived'
  };
}

/** The canonical originating-request key. Summary/prose and browser ids never participate. */
export function requestTrailOriginKey(origin: Pick<RequestTrailOrigin, 'sessionId' | 'eventSeq'>): string {
  return `${origin.sessionId}:${origin.eventSeq}`;
}

/** Opaque revision consumed by the check-in presentation adapter. */
export function requestTrailRevision(record: Pick<RequestTrailRecord, 'id' | 'revision'>): string {
  return `request:${record.id}:rev:${record.revision}`;
}
