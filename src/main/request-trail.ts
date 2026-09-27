import { randomUUID } from 'node:crypto';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { getSession, readEvents } from './session/store.js';
import { listPlans } from './plans.js';
import type { SessionEvent } from '../shared/session.js';
import {
  requestTrailCatalogSchema,
  requestTrailCreateSchema,
  requestTrailEventRefSchema,
  requestTrailOriginKey,
  requestTrailPatchSchema,
  requestTrailRevision,
  type RequestTrailCheckInKind,
  type RequestTrailCreate,
  type RequestTrailEventRef,
  type RequestTrailOrigin,
  type RequestTrailPatch,
  type RequestTrailRecord
} from '../shared/request-trail.js';

const REQUEST_TRAIL_STATE = 'request-trail';
let mutations: Promise<unknown> = Promise.resolve();
const changeListeners = new Set<(requestId: string) => void>();

function queueMutation<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutations.then(work);
  mutations = operation.catch(() => undefined);
  return operation;
}

async function readRecords(): Promise<RequestTrailRecord[]> {
  const raw = await readDurableStrict<unknown>(REQUEST_TRAIL_STATE);
  if (raw === null) return [];
  const parsed = requestTrailCatalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Request trail is invalid');
  return parsed.data.requests;
}

async function writeRecords(requests: RequestTrailRecord[], changedRequestId: string): Promise<void> {
  await writeDurableNow(REQUEST_TRAIL_STATE, { version: 1, requests });
  for (const listener of changeListeners) listener(changedRequestId);
}

function eventAnchor(event: SessionEvent): number {
  if ('origin' in event && typeof event.origin === 'number') return event.origin;
  return event.seq;
}

function eventMessageId(event: SessionEvent): string | undefined {
  return 'messageId' in event && typeof event.messageId === 'string' ? event.messageId : undefined;
}

function eventCallId(event: SessionEvent): string | undefined {
  return event.kind === 'tool_call' ? event.call.callId : undefined;
}

async function exactEvent(ref: RequestTrailEventRef): Promise<SessionEvent> {
  const parsed = requestTrailEventRefSchema.parse(ref);
  const session = await getSession(parsed.sessionId);
  if (!session) throw new Error('Request trail event session was not found');
  if (parsed.conversationId !== null && !session.chatIds.includes(parsed.conversationId)) {
    throw new Error('Request trail event conversation does not belong to its session');
  }
  const events = await readEvents(parsed.sessionId, { from: parsed.eventSeq, kinds: [parsed.kind] });
  const event = events.find(candidate => eventAnchor(candidate) === parsed.eventSeq);
  if (!event || event.kind !== parsed.kind) throw new Error('Request trail event reference does not match an exact recorded event');
  if (parsed.messageId !== undefined && eventMessageId(event) !== parsed.messageId) {
    throw new Error('Request trail event message id does not match');
  }
  if (parsed.turnId !== undefined && event.turnId !== parsed.turnId) {
    throw new Error('Request trail event turn id does not match');
  }
  if (parsed.callId !== undefined && eventCallId(event) !== parsed.callId) {
    throw new Error('Request trail event call id does not match');
  }
  return event;
}

async function exactOrigin(origin: RequestTrailOrigin): Promise<RequestTrailOrigin> {
  const ref: RequestTrailEventRef = {
    sessionId: origin.sessionId,
    conversationId: origin.conversationId,
    eventSeq: origin.eventSeq,
    kind: 'user_message',
    ...(origin.messageId ? { messageId: origin.messageId } : {}),
    ...(origin.turnId ? { turnId: origin.turnId } : {})
  };
  const event = await exactEvent(ref);
  if (event.kind !== 'user_message') throw new Error('Request trail origin must be a user message');
  return {
    ...origin,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {})
  };
}

function sameOptionalIdentity(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function compatibleOrigin(existing: RequestTrailOrigin, candidate: RequestTrailOrigin): boolean {
  return existing.sessionId === candidate.sessionId && existing.eventSeq === candidate.eventSeq &&
    (existing.conversationId === null || candidate.conversationId === null || existing.conversationId === candidate.conversationId) &&
    sameOptionalIdentity(existing.messageId, candidate.messageId) &&
    sameOptionalIdentity(existing.turnId, candidate.turnId);
}

async function validateOptionalRef(ref: RequestTrailEventRef | null | undefined): Promise<void> {
  if (ref) await exactEvent(ref);
}

function requestTimestamp(now: number, prior: number): number {
  return Math.max(now, prior);
}

function sameEventRef(left: RequestTrailEventRef | null, right: RequestTrailEventRef | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId &&
    left.eventSeq === right.eventSeq &&
    left.kind === right.kind &&
    left.messageId === right.messageId &&
    left.turnId === right.turnId &&
    left.callId === right.callId;
}

/**
 * Accepts one exact user request into the durable trail. Repeating the same exact origin returns
 * the already-published record unchanged, so a retry cannot duplicate work or rewrite its summary.
 */
export function ensureRequestTrail(input: RequestTrailCreate): Promise<RequestTrailRecord> {
  return queueMutation(async () => {
    const parsed = requestTrailCreateSchema.parse(input);
    const records = await readRecords();
    const key = requestTrailOriginKey(parsed.origin);
    const existing = records.find(row => requestTrailOriginKey(row.origin) === key);
    if (existing) {
      if (!compatibleOrigin(existing.origin, parsed.origin)) {
        throw new Error('Request trail origin conflicts with the existing exact request');
      }
      return existing;
    }
    if (records.length >= 5_000) throw new Error('Request trail limit reached');
    const origin = await exactOrigin(parsed.origin);
    await validateOptionalRef(parsed.resultRef);
    for (const ref of parsed.testRefs) await exactEvent(ref);
    await validateOptionalRef(parsed.needsUserRef);
    const now = Date.now();
    const terminal = parsed.state === 'failed' || parsed.state === 'cancelled';
    const record: RequestTrailRecord = {
      id: randomUUID(),
      origin,
      summary: parsed.summary,
      state: parsed.state,
      planId: parsed.planId,
      eveActivityPlanIds: parsed.eveActivityPlanIds,
      workers: parsed.workers,
      resultRef: parsed.resultRef,
      testRefs: parsed.testRefs,
      needsUserRef: parsed.needsUserRef,
      threadId: parsed.threadId,
      quiltIds: parsed.quiltIds,
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
      revision: 1,
      lastCheckInAt: null,
      notificationClaims: [],
      implementationCompletedAt: null,
      eveActivityClosedAt: null,
      userPlanArchivedAt: null,
      terminalAt: terminal ? now : null
    };
    const checked = requestTrailCatalogSchema.parse({ version: 1, requests: [...records, record] });
    await writeRecords(checked.requests, record.id);
    return checked.requests.at(-1)!;
  });
}

/** Explicitly updates links/state on one durable work item; no prose or neighboring state is scanned. */
export function updateRequestTrail(id: string, patch: RequestTrailPatch): Promise<RequestTrailRecord> {
  return queueMutation(async () => {
    const requestId = requestTrailCatalogSchema.shape.requests.element.shape.id.parse(id);
    const parsed = requestTrailPatchSchema.parse(patch);
    const records = await readRecords();
    const index = records.findIndex(row => row.id === requestId);
    if (index < 0) throw new Error('Request trail item not found');
    await validateOptionalRef(parsed.resultRef);
    if (parsed.testRefs) for (const ref of parsed.testRefs) await exactEvent(ref);
    await validateOptionalRef(parsed.needsUserRef);
    const held = records[index]!;
    const now = requestTimestamp(Date.now(), held.updatedAt);
    const state = parsed.state ?? held.state;
    const needsUserRef = parsed.needsUserRef === undefined ? held.needsUserRef : parsed.needsUserRef;
    const planChanged = parsed.planId !== undefined && parsed.planId !== held.planId;
    const activityPlansChanged = parsed.eveActivityPlanIds !== undefined &&
      (parsed.eveActivityPlanIds.length !== held.eveActivityPlanIds.length ||
        parsed.eveActivityPlanIds.some((planId, index) => planId !== held.eveActivityPlanIds[index]));
    if (
      held.planId === null &&
      held.implementationCompletedAt !== null &&
      parsed.resultRef !== undefined &&
      !sameEventRef(held.resultRef, parsed.resultRef)
    ) {
      throw new Error('Completed implementation result evidence cannot be replaced');
    }
    if (parsed.state === 'needs_user' && held.state !== 'needs_user' && parsed.needsUserRef === undefined) {
      throw new Error('Entering needs-user state requires an exact session-event reference');
    }
    if (state === 'needs_user' && needsUserRef === null) {
      throw new Error('Needs-user requests require an exact session-event reference');
    }
    const stateChanged = state !== held.state;
    const terminal = state === 'failed' || state === 'cancelled';
    const updated: RequestTrailRecord = {
      ...held,
      ...parsed,
      state,
      needsUserRef,
      ...(planChanged ? { implementationCompletedAt: null, userPlanArchivedAt: null } : {}),
      ...(activityPlansChanged ? { eveActivityClosedAt: null } : {}),
      updatedAt: now,
      stateChangedAt: stateChanged ? now : held.stateChangedAt,
      revision: held.revision + 1,
      terminalAt: terminal ? (stateChanged || held.terminalAt === null ? now : held.terminalAt) : null
    };
    const next = [...records];
    next[index] = updated;
    const checked = requestTrailCatalogSchema.parse({ version: 1, requests: next });
    await writeRecords(checked.requests, requestId);
    return checked.requests[index]!;
  });
}

/**
 * Marks a non-Plan request's implementation result complete from one exact recorded result event.
 * A linked high-level Plan must use its structural Ready-to-archive/archive state instead, so a
 * final assistant sentence can never bypass the user's checklist or manufacture signoff.
 */
export function completeRequestImplementationFromResult(id: string, resultRef: RequestTrailEventRef): Promise<RequestTrailRecord> {
  return queueMutation(async () => {
    const requestId = requestTrailCatalogSchema.shape.requests.element.shape.id.parse(id);
    const records = await readRecords();
    const index = records.findIndex(row => row.id === requestId);
    if (index < 0) throw new Error('Request trail item not found');
    const held = records[index]!;
    if (held.planId !== null) throw new Error('Linked Plan owns implementation completion; refresh structural Plan state instead');
    const event = await exactEvent(resultRef);
    const completedAt = event.time;
    const now = requestTimestamp(Date.now(), held.updatedAt);
    const updated: RequestTrailRecord = {
      ...held,
      resultRef,
      implementationCompletedAt: held.implementationCompletedAt ?? completedAt,
      updatedAt: now,
      revision: held.revision + 1
    };
    const next = [...records];
    next[index] = updated;
    const checked = requestTrailCatalogSchema.parse({ version: 1, requests: next });
    await writeRecords(checked.requests, requestId);
    return checked.requests[index]!;
  });
}

/**
 * Reconciles only structural Plan facts into Request Trail milestones.
 *
 * - High-level `planId` must be a human Plan. Ready-to-archive means implementation complete;
 *   only `archivedAt` means the user signed off.
 * - `eveActivityPlanIds` must be Eve Activity Plans. Ready-to-archive is not closure; all linked
 *   Activity Plans must actually be archived before Eve Activity becomes closed here.
 *
 * This function never archives a Plan and never changes the request's needs-user/active state.
 */
export function refreshRequestTrailPlanMilestones(id: string): Promise<RequestTrailRecord> {
  return queueMutation(async () => {
    const requestId = requestTrailCatalogSchema.shape.requests.element.shape.id.parse(id);
    const records = await readRecords();
    const index = records.findIndex(row => row.id === requestId);
    if (index < 0) throw new Error('Request trail item not found');
    const held = records[index]!;
    if (held.planId === null && held.eveActivityPlanIds.length === 0) return held;

    const library = await listPlans();
    const plans = [...library.live, ...library.done];
    let implementationCompletedAt = held.implementationCompletedAt;
    let userPlanArchivedAt = held.userPlanArchivedAt;
    let eveActivityClosedAt = held.eveActivityClosedAt;

    if (held.planId !== null) {
      const plan = plans.find(row => row.id === held.planId);
      if (!plan) throw new Error('Linked high-level Plan was not found');
      if (plan.audience !== 'human') throw new Error('Linked high-level Plan must be user-owned');
      if (plan.archivedAt !== null) {
        userPlanArchivedAt ??= plan.archivedAt;
        implementationCompletedAt ??= plan.archivedAt;
      } else if (plan.readyToArchive) {
        implementationCompletedAt ??= plan.updatedAt;
      } else {
        // Before user signoff, reopening a completed Plan (for example by adding a new unfinished
        // checklist item) reopens implementation too. A historical final checkbox is not current
        // completion authority.
        implementationCompletedAt = null;
        userPlanArchivedAt = null;
      }
    }

    if (held.eveActivityPlanIds.length > 0 && eveActivityClosedAt === null) {
      const activity = held.eveActivityPlanIds.map(planId => {
        const plan = plans.find(row => row.id === planId);
        if (!plan) throw new Error('Linked Eve Activity Plan was not found');
        if (plan.audience !== 'eve') throw new Error('Linked Eve Activity Plan must be Eve-owned');
        return plan;
      });
      if (activity.every(plan => plan.archivedAt !== null)) {
        eveActivityClosedAt = Math.max(...activity.map(plan => plan.archivedAt!));
      }
    }

    if (
      implementationCompletedAt === held.implementationCompletedAt &&
      userPlanArchivedAt === held.userPlanArchivedAt &&
      eveActivityClosedAt === held.eveActivityClosedAt
    ) return held;

    const now = requestTimestamp(Date.now(), held.updatedAt);
    const updated: RequestTrailRecord = {
      ...held,
      implementationCompletedAt,
      userPlanArchivedAt,
      eveActivityClosedAt,
      updatedAt: now,
      revision: held.revision + 1
    };
    const next = [...records];
    next[index] = updated;
    const checked = requestTrailCatalogSchema.parse({ version: 1, requests: next });
    await writeRecords(checked.requests, requestId);
    return checked.requests[index]!;
  });
}

/**
 * Atomically claims one presentation event against the exact Request Trail revision.
 * The durable claim lands before any external notifier is called, so restart/ambiguous delivery
 * can never turn one accepted event into a second notification.
 */
export function claimRequestTrailNotification(input: {
  requestId: string;
  expectedRevision: string;
  dedupeKey: string;
  kind: RequestTrailCheckInKind;
  claimedAt: number;
}): Promise<boolean> {
  return queueMutation(async () => {
    const requestId = requestTrailCatalogSchema.shape.requests.element.shape.id.parse(input.requestId);
    if (!input.dedupeKey || input.dedupeKey.length > 512) throw new Error('Request notification dedupe key is invalid');
    if (!Number.isSafeInteger(input.claimedAt) || input.claimedAt < 0) throw new Error('Request notification claim time is invalid');
    const records = await readRecords();
    const index = records.findIndex(row => row.id === requestId);
    if (index < 0) return false;
    const held = records[index]!;
    if (requestTrailRevision(held) !== input.expectedRevision) return false;
    if (held.notificationClaims.some(claim => claim.dedupeKey === input.dedupeKey)) return false;
    if (held.notificationClaims.length >= 2_048) throw new Error('Request notification claim ledger limit reached');
    const updated: RequestTrailRecord = {
      ...held,
      lastCheckInAt: input.claimedAt,
      notificationClaims: [...held.notificationClaims, {
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        claimedAt: input.claimedAt,
        sourceRevision: held.revision
      }],
      updatedAt: requestTimestamp(Date.now(), held.updatedAt),
      revision: held.revision + 1
    };
    const next = [...records];
    next[index] = updated;
    const checked = requestTrailCatalogSchema.parse({ version: 1, requests: next });
    await writeRecords(checked.requests, requestId);
    return true;
  });
}

export async function requestTrailById(id: string): Promise<RequestTrailRecord | null> {
  const parsed = requestTrailCatalogSchema.shape.requests.element.shape.id.parse(id);
  return (await readRecords()).find(row => row.id === parsed) ?? null;
}

export async function requestTrailByOrigin(origin: RequestTrailOrigin): Promise<RequestTrailRecord | null> {
  const parsed = requestTrailCreateSchema.shape.origin.parse(origin);
  const key = requestTrailOriginKey(parsed);
  return (await readRecords()).find(row => requestTrailOriginKey(row.origin) === key) ?? null;
}

export async function listRequestTrail(): Promise<RequestTrailRecord[]> {
  return readRecords();
}

export function onRequestTrailChange(listener: (requestId: string) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Test seam only; persistence remains in durable.ts. */
export function resetRequestTrailForTests(): void {
  mutations = Promise.resolve();
  changeListeners.clear();
}
