import { onPlansChange } from './plans.js';
import { AUTO_COMPACTION_MAX_TURN_MS, getSession } from './session/store.js';
import { reconcileRequestPlanThreadSourceRecords } from './plan-source.js';
import {
  claimRequestTrailNotification,
  listRequestTrail,
  onRequestTrailChange,
  refreshRequestTrailPlanMilestones
} from './request-trail.js';
import type {
  DurableRequestCheckInSnapshot,
  DurableRequestCheckInSource,
  RequestCheckInClaim
} from './request-checkins.js';
import {
  requestTrailRevision,
  type RequestTrailEventRef,
  type RequestTrailRecord
} from '../shared/request-trail.js';

function requestRef(id: string): string { return `request:${id}`; }
function planRef(id: string): string { return `plan:${id}`; }
function threadRef(id: string): string { return `thread:${id}`; }

/** Stable exact session/event reference understood by request/result navigation adapters. */
function eventRef(ref: Pick<RequestTrailEventRef, 'sessionId' | 'eventSeq'>): string {
  return `source:${ref.sessionId}:${ref.eventSeq}`;
}

export function requestTrailSourceTarget(ref: string): { sessionId: string; eventSeq: number } | null {
  const match = /^source:([0-9a-z-]{8,64}):(\d+)$/i.exec(ref);
  if (!match) return null;
  const eventSeq = Number(match[2]);
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1 || eventSeq > 10_000_000) return null;
  return { sessionId: match[1]!, eventSeq };
}

export function requestTrailSourceSession(ref: string): string | null {
  return requestTrailSourceTarget(ref)?.sessionId ?? null;
}

function requestIdFromRef(ref: string): string | null {
  const match = /^request:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(ref);
  return match?.[1] ?? null;
}

function planState(record: RequestTrailRecord): 'none' | 'live' | 'ready_to_archive' | 'signed_off' {
  if (record.planId === null) return 'none';
  if (record.userPlanArchivedAt !== null) return 'signed_off';
  if (record.implementationCompletedAt !== null) return 'ready_to_archive';
  return 'live';
}

function base(record: RequestTrailRecord) {
  const evidence = [eventRef(record.origin)];
  if (record.needsUserRef) evidence.push(eventRef(record.needsUserRef));
  return {
    requestRef: requestRef(record.id),
    originalRequestRef: eventRef(record.origin),
    revision: requestTrailRevision(record),
    summary: record.summary,
    threadRef: record.threadId ? threadRef(record.threadId) : null,
    planSourceRef: record.threadId ? threadRef(record.threadId) : eventRef(record.origin),
    evidenceRefs: evidence,
    activityRef: record.eveActivityPlanIds.length === 1 ? planRef(record.eveActivityPlanIds[0]!) : null,
    activityState: record.eveActivityPlanIds.length > 0 && record.eveActivityClosedAt !== null ? 'complete' as const : 'open' as const,
    planRef: record.planId ? planRef(record.planId) : null,
    planState: planState(record),
    planSignoffRequired: record.planId !== null,
    userStoryRef: record.planId ? planRef(record.planId) : null,
    resultRef: record.resultRef ? eventRef(record.resultRef) : null,
    testRefs: record.testRefs.map(eventRef),
    startedAt: record.createdAt,
    lastCheckInAt: record.lastCheckInAt
  };
}

/**
 * Positive proof that a running request is being worked on right now, or null.
 *
 * Request Trail `running` is written once, at admission, from the Plan's checklist; nothing moves
 * it afterwards. On its own it therefore said "still working" forever about %plans chats that had
 * ended days earlier. The live fact belongs to the origin session: an open turn, in a session that
 * has not ended, whose recorded start is within ChatGPT's per-turn ceiling (an abandoned open turn
 * is not work), and only for the newest request from that session (a later request's turn is not
 * this one's). The ref names that exact turn, so a later turn is a fresh claim.
 */
async function liveRequestTurns(records: readonly RequestTrailRecord[], now = Date.now()): Promise<Map<string, string>> {
  const newest = new Map<string, RequestTrailRecord>();
  for (const record of records) {
    const held = newest.get(record.origin.sessionId);
    if (!held || record.createdAt > held.createdAt) newest.set(record.origin.sessionId, record);
  }
  const live = new Map<string, string>();
  for (const [sessionId, record] of newest) {
    if (record.state !== 'running') continue;
    const session = await getSession(sessionId).catch(() => null);
    const turnId = session?.activeTurnId;
    const started = session?.finishTurn?.turnId === turnId ? session?.finishTurn?.startedAt : undefined;
    if (!session || session.endedAt !== null || !turnId || started === undefined ||
        now - started > AUTO_COMPACTION_MAX_TURN_MS) continue;
    live.set(record.id, `${requestRef(record.id)}:turn:${sessionId}:${turnId}`);
  }
  return live;
}

function snapshot(record: RequestTrailRecord, liveTurn: string | null): DurableRequestCheckInSnapshot {
  const common = base(record);
  if (record.state === 'failed' || record.state === 'cancelled') {
    return {
      ...common,
      state: record.state,
      stateRef: `${requestRef(record.id)}:state:${record.state}:${record.stateChangedAt}`,
      outcome: record.state === 'failed' ? 'The request ended in a failed state.' : 'The request was cancelled.',
      feedbackPrompt: record.state === 'failed' ? 'Review the failure evidence or tell Eve how to proceed.' : 'Restart the request if you want this work resumed.',
      decisionRef: null
    };
  }

  // High-level signoff is deliberately structural: no result sentence, Needs-you prose or Eve
  // Activity closure can manufacture this state. Only the human Plan owner's archivedAt can.
  if (record.planId !== null && record.userPlanArchivedAt !== null) {
    return {
      ...common,
      state: 'signed_off',
      stateRef: `${planRef(record.planId)}:archived:${record.userPlanArchivedAt}`,
      outcome: 'The high-level Plan is archived and user signoff is recorded structurally.',
      feedbackPrompt: 'No further Plan signoff is required.',
      decisionRef: null
    };
  }

  if (record.state === 'needs_user') {
    const stateRef = eventRef(record.needsUserRef!);
    const readyForPlanReview = record.planId !== null && record.implementationCompletedAt !== null;
    return {
      ...common,
      state: 'needs_user',
      stateRef,
      needsUser: readyForPlanReview
        ? 'Implementation is complete and the Plan is ready to archive. Review it before signing off.'
        : 'This request needs your review or decision.',
      decisionRef: readyForPlanReview ? planRef(record.planId!) : stateRef
    };
  }

  if (record.implementationCompletedAt !== null) {
    if (record.planId !== null) {
      return {
        ...common,
        state: 'ready_for_review',
        stateRef: `${planRef(record.planId)}:ready:${record.implementationCompletedAt}`,
        outcome: 'Implementation is complete and the high-level Plan is ready to archive.',
        feedbackPrompt: 'Review the result and archive the Plan when you want to sign off.',
        decisionRef: planRef(record.planId)
      };
    }
    return {
      ...common,
      state: 'completed',
      stateRef: record.resultRef ? eventRef(record.resultRef) : `${requestRef(record.id)}:implementation:${record.implementationCompletedAt}`,
      outcome: 'Implementation is complete.',
      feedbackPrompt: 'Review the result or tell Eve what still needs changing.',
      decisionRef: null
    };
  }

  const latestTest = record.testRefs.at(-1);
  if (latestTest) {
    return {
      ...common,
      state: 'active',
      activeEvidenceRef: liveTurn,
      lastMeaningfulAt: record.updatedAt,
      progress: {
        eventRef: eventRef(latestTest),
        at: record.updatedAt,
        text: 'New validation/test evidence was recorded for this request.',
        meaningful: true
      }
    };
  }

  if (record.resultRef) {
    return {
      ...common,
      state: 'active',
      activeEvidenceRef: liveTurn,
      lastMeaningfulAt: record.updatedAt,
      progress: {
        eventRef: eventRef(record.resultRef),
        at: record.updatedAt,
        text: record.planId
          ? 'An implementation result is recorded; Plan review/signoff is still pending.'
          : 'An implementation result is recorded.',
        meaningful: true
      }
    };
  }

  if (record.eveActivityClosedAt !== null) {
    return {
      ...common,
      state: 'active',
      activeEvidenceRef: liveTurn,
      lastMeaningfulAt: record.eveActivityClosedAt,
      progress: {
        eventRef: `${requestRef(record.id)}:eve-activity-complete:${record.eveActivityClosedAt}`,
        at: record.eveActivityClosedAt,
        text: 'Eve activity is complete; the remaining Plan/review state is still open.',
        meaningful: true
      }
    };
  }

  if (record.state === 'running') {
    const runningRef = `${requestRef(record.id)}:state:running:${record.stateChangedAt}`;
    return {
      ...common,
      state: 'active',
      activeEvidenceRef: liveTurn,
      lastMeaningfulAt: record.stateChangedAt,
      progress: {
        eventRef: runningRef,
        at: record.stateChangedAt,
        text: 'Implementation work is active.',
        meaningful: true
      }
    };
  }

  if (record.state === 'planned' && record.planId !== null) {
    return {
      ...common,
      state: 'active',
      activeEvidenceRef: null,
      lastMeaningfulAt: record.stateChangedAt,
      progress: {
        eventRef: `${planRef(record.planId)}:linked`,
        at: record.stateChangedAt,
        text: 'The Plan/user story is linked and ready for implementation.',
        meaningful: true
      }
    };
  }

  return {
    ...common,
    state: 'active',
    activeEvidenceRef: null,
    lastMeaningfulAt: null,
    progress: null
  };
}

async function currentRecords(): Promise<RequestTrailRecord[]> {
  const records = await listRequestTrail();
  const current: RequestTrailRecord[] = [];
  for (const record of records) {
    const reconciled = await refreshRequestTrailPlanMilestones(record.id);
    current.push(reconciled);
  }
  await reconcileRequestPlanThreadSourceRecords(current);
  return current;
}

/** Production Request Trail -> check-in presentation adapter. */
export function createRequestTrailCheckInSource(options: { onError?: (error: Error) => void } = {}): DurableRequestCheckInSource {
  return {
    async listCheckInRequests(): Promise<readonly DurableRequestCheckInSnapshot[]> {
      const records = await currentRecords();
      const live = await liveRequestTurns(records);
      return records.map(record => snapshot(record, live.get(record.id) ?? null));
    },
    onCheckInRequestChange(listener: (ref: string) => void): () => void {
      const stopTrail = onRequestTrailChange(id => listener(requestRef(id)));
      const stopPlans = onPlansChange(() => {
        void currentRecords().catch(error => options.onError?.(error instanceof Error ? error : new Error(String(error))));
      });
      return () => { stopTrail(); stopPlans(); };
    },
    async claimCheckInNotification(claim: RequestCheckInClaim): Promise<boolean> {
      const id = requestIdFromRef(claim.requestRef);
      if (!id) return false;
      return claimRequestTrailNotification({
        requestId: id,
        expectedRevision: claim.expectedRevision,
        dedupeKey: claim.dedupeKey,
        kind: claim.kind,
        claimedAt: claim.claimedAt
      });
    }
  };
}
