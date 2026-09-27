/**
 * Presentation owner for long-running request check-ins.
 *
 * This module deliberately owns no request lifecycle or persistence. A future durable request
 * trail supplies exact snapshots and atomically claims each notification before the external
 * side effect. That keeps restart dedupe with the request authority instead of creating a second
 * task ledger here.
 */

export const REQUEST_CHECK_IN_MIN_SILENCE_MS = 60_000;
export const REQUEST_CHECK_IN_MAX_SILENCE_MS = 60 * 60_000;
export const REQUEST_CHECK_IN_DEFAULT_SILENCE_MS = 15 * 60_000;

const MAX_REQUEST_SUMMARY = 160;
const MAX_MESSAGE = 320;

export type RequestCheckInKind = 'progress' | 'silence' | 'needs_user' | 'terminal';
export type RequestTerminalState = 'ready_for_review' | 'signed_off' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type EveActivityState = 'open' | 'complete';
export type PlanReviewState = 'none' | 'live' | 'ready_to_archive' | 'signed_off';

interface RequestCheckInBase {
  /** Opaque exact durable request id/link. Never derived from prose. */
  requestRef: string;
  /** Exact originating user-message locator when the durable source can provide one. */
  originalRequestRef?: string;
  /** Opaque request-trail revision used by the authority to reject stale claims. */
  revision: string;
  /** Short user-facing description supplied by the durable request owner. */
  summary: string;
  /** Exact discussion %thread for this request, when one exists. */
  threadRef: string | null;
  /** Primary Plan source link; production prefers the owning Thread over historical chat. */
  planSourceRef?: string | null;
  /** Exact durable evidence refs that support the current request lifecycle. */
  evidenceRefs: readonly string[];
  /** Exact Eve Activity item when the durable request owner has one. */
  activityRef?: string | null;
  /** Activity closure is an evidence-backed source fact; this adapter never infers it. */
  activityState?: EveActivityState;
  /** Exact first-class Plan id/link when this request has one. */
  planRef: string | null;
  /** Durable Plan lifecycle state; checking the final item does not imply signoff. */
  planState?: PlanReviewState;
  /** High-level Plans require an explicit user signoff before the lifecycle is approved. */
  planSignoffRequired?: boolean;
  /** Exact user-story/spec artifact when the request lifecycle has one. */
  userStoryRef: string | null;
  /** Exact current result id/link when the request trail has materialized one. */
  resultRef: string | null;
  /** Exact test/validation result refs already recorded for the implementation result. */
  testRefs: readonly string[];
  startedAt: number;
  /** Last check-in claim durably accepted by the request owner, across app restarts. */
  lastCheckInAt: number | null;
}

export interface RequestProgressEvidence {
  /** Stable durable event id. */
  eventRef: string;
  at: number;
  text: string;
  /** Only an authority-marked milestone may become an event-driven check-in. */
  meaningful: boolean;
}

export interface ActiveRequestCheckInSnapshot extends RequestCheckInBase {
  state: 'active';
  /** Positive durable proof that work is currently active. Null means no "still working" claim. */
  activeEvidenceRef: string | null;
  /** Latest meaningful user-facing progress boundary, not merely any internal activity. */
  lastMeaningfulAt: number | null;
  progress: RequestProgressEvidence | null;
}

export interface NeedsUserRequestCheckInSnapshot extends RequestCheckInBase {
  state: 'needs_user';
  /** Exact durable Needs-you state id/link. */
  stateRef: string;
  needsUser: string;
  /** Exact decision/signoff item the user is being asked to resolve. */
  decisionRef: string | null;
}

export interface TerminalRequestCheckInSnapshot extends RequestCheckInBase {
  state: RequestTerminalState;
  /** Exact durable terminal state id/link. */
  stateRef: string;
  /** Concrete outcome recorded by the request owner. */
  outcome: string;
  /** What Eve wants the user to react to; supplied by the request owner, never invented here. */
  feedbackPrompt: string;
  /** Exact review/signoff decision item, when the outcome still needs the user's acceptance. */
  decisionRef: string | null;
}

export type DurableRequestCheckInSnapshot =
  | ActiveRequestCheckInSnapshot
  | NeedsUserRequestCheckInSnapshot
  | TerminalRequestCheckInSnapshot;

export interface RequestCheckInClaim {
  requestRef: string;
  expectedRevision: string;
  dedupeKey: string;
  kind: RequestCheckInKind;
  claimedAt: number;
}

export interface DurableRequestCheckInSource {
  /** Current durable snapshots; callers must not synthesize activity from elapsed time. */
  listCheckInRequests(): Promise<readonly DurableRequestCheckInSnapshot[]>;
  /** Fires only after the request owner has durably published a changed snapshot. */
  onCheckInRequestChange(listener: (requestRef: string) => void): () => void;
  /**
   * Atomically claim one notification against the expected request revision before delivery.
   * The durable request trail owns dedupe across process restarts and advances `lastCheckInAt`
   * as part of the same accepted claim. False means duplicate/stale.
   */
  claimCheckInNotification(claim: RequestCheckInClaim): Promise<boolean>;
}

export interface RequestCheckInLinks {
  originalRequest: string;
  requestThread: string | null;
  evidence: readonly string[];
  eveActivity: string | null;
  plan: string | null;
  planSource: string | null;
  userStory: string | null;
  implementationResult: string | null;
  tests: readonly string[];
  decision: string | null;
  currentState: string;
}

export interface RequestCheckInNotification {
  kind: RequestCheckInKind;
  requestSummary: string;
  title: string;
  body: string;
  links: RequestCheckInLinks;
}

export interface RequestCheckInNotifier {
  (notification: RequestCheckInNotification): void | Promise<void>;
}

export interface RequestCheckInClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: RequestCheckInClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer)
};

function boundedText(value: string, max: number): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function validSnapshot(snapshot: DurableRequestCheckInSnapshot): boolean {
  return !!snapshot.requestRef && !!snapshot.revision && Number.isFinite(snapshot.startedAt) && !!boundedText(snapshot.summary, MAX_REQUEST_SUMMARY);
}

function exactRefs(refs: readonly string[]): readonly string[] {
  return refs.filter(ref => !!ref).slice(0, 12);
}

function links(snapshot: DurableRequestCheckInSnapshot, stateRef: string): RequestCheckInLinks {
  const originalRequest = snapshot.originalRequestRef || snapshot.requestRef;
  return {
    originalRequest,
    requestThread: snapshot.threadRef || null,
    evidence: exactRefs(snapshot.evidenceRefs),
    eveActivity: snapshot.activityRef || null,
    plan: snapshot.planRef || null,
    planSource: snapshot.planSourceRef || snapshot.threadRef || originalRequest,
    userStory: snapshot.userStoryRef || null,
    implementationResult: snapshot.resultRef || null,
    tests: exactRefs(snapshot.testRefs),
    decision: snapshot.state === 'active' ? null : snapshot.decisionRef || null,
    currentState: stateRef
  };
}

function terminalTitle(snapshot: TerminalRequestCheckInSnapshot, requestSummary: string): string {
  if (snapshot.state === 'ready_for_review') {
    if (snapshot.activityState === 'complete' && snapshot.planState === 'ready_to_archive') return `Implementation complete · Ready for review · ${requestSummary}`;
    if (snapshot.activityState === 'complete') return `Eve activity complete · Ready for review · ${requestSummary}`;
    return `Ready for review · ${requestSummary}`;
  }
  if (snapshot.state === 'signed_off' && snapshot.planState === 'signed_off') return `Signed off · ${requestSummary}`;
  if (snapshot.state === 'completed') return `Completed · ${requestSummary}`;
  if (snapshot.state === 'failed') return `Failed · ${requestSummary}`;
  if (snapshot.state === 'blocked') return `Blocked · ${requestSummary}`;
  return `Stopped · ${requestSummary}`;
}

function terminalPlanStatus(snapshot: TerminalRequestCheckInSnapshot): string {
  if (!snapshot.planRef || snapshot.planState === 'none') return '';
  if (snapshot.planState === 'signed_off') return 'Plan signed off.';
  if (snapshot.planState === 'ready_to_archive') {
    return snapshot.planSignoffRequired
      ? 'Plan is ready to archive and is still awaiting your signoff.'
      : 'Plan is ready to archive.';
  }
  if (snapshot.planSignoffRequired === true) return 'Plan is awaiting your signoff.';
  if (!snapshot.planState) return '';
  return 'Plan remains live.';
}

function eventCandidate(snapshot: DurableRequestCheckInSnapshot): { dedupeKey: string; notification: RequestCheckInNotification } | null {
  if (!validSnapshot(snapshot)) return null;
  const requestSummary = boundedText(snapshot.summary, MAX_REQUEST_SUMMARY);
  if (snapshot.state === 'active') {
    const progress = snapshot.progress;
    if (!progress?.meaningful || !progress.eventRef || !Number.isFinite(progress.at) || !boundedText(progress.text, MAX_MESSAGE)) return null;
    return {
      dedupeKey: `progress:${progress.eventRef}`,
      notification: {
        kind: 'progress', requestSummary,
        title: `Progress · ${requestSummary}`,
        body: boundedText(progress.text, MAX_MESSAGE),
        links: links(snapshot, progress.eventRef)
      }
    };
  }
  if (snapshot.state === 'needs_user') {
    const message = boundedText(snapshot.needsUser, MAX_MESSAGE);
    if (!snapshot.stateRef || !message) return null;
    return {
      dedupeKey: `needs_user:${snapshot.stateRef}`,
      notification: {
        kind: 'needs_user', requestSummary,
        title: `Needs you · ${requestSummary}`,
        body: message,
        links: links(snapshot, snapshot.stateRef)
      }
    };
  }
  const outcome = boundedText(snapshot.outcome, 180);
  const feedback = boundedText(snapshot.feedbackPrompt, 110);
  if (!snapshot.stateRef || !outcome || !feedback) return null;
  // A generic terminal result, passing tests, or an archive-ready Plan must never manufacture
  // user approval. `signed_off` is a high-level Plan state: require the exact Plan reference and
  // the durable Plan authority's structural archived projection, never prose or a missing Plan.
  if (snapshot.state === 'signed_off' &&
      (!snapshot.planRef || snapshot.planState !== 'signed_off' || snapshot.planSignoffRequired !== true)) return null;
  const activity = snapshot.activityState === 'complete' ? 'Eve activity complete.' : '';
  const plan = terminalPlanStatus(snapshot);
  const prefix = [activity, plan, outcome].filter(Boolean).join(' ');
  return {
    dedupeKey: `terminal:${snapshot.state}:${snapshot.stateRef}`,
    notification: {
      kind: 'terminal', requestSummary,
      title: terminalTitle(snapshot, requestSummary),
      body: `${prefix} ${snapshot.state === 'ready_for_review' || (snapshot.planSignoffRequired === true && snapshot.planState !== 'signed_off') ? 'Decision needed' : 'Feedback wanted'}: ${feedback}`,
      links: links(snapshot, snapshot.stateRef)
    }
  };
}

function fallbackAnchor(snapshot: ActiveRequestCheckInSnapshot): number {
  return Math.max(snapshot.startedAt, snapshot.lastMeaningfulAt ?? snapshot.startedAt, snapshot.lastCheckInAt ?? snapshot.startedAt);
}

function fallbackBucket(snapshot: ActiveRequestCheckInSnapshot, now: number, silenceMs: number): number | null {
  if (!snapshot.activeEvidenceRef) return null;
  const elapsed = now - fallbackAnchor(snapshot);
  return elapsed >= silenceMs ? Math.floor(elapsed / silenceMs) : null;
}

function silenceCandidate(snapshot: ActiveRequestCheckInSnapshot, now: number, silenceMs: number): { dedupeKey: string; notification: RequestCheckInNotification } | null {
  if (!validSnapshot(snapshot) || !snapshot.activeEvidenceRef) return null;
  const bucket = fallbackBucket(snapshot, now, silenceMs);
  if (bucket === null) return null;
  const requestSummary = boundedText(snapshot.summary, MAX_REQUEST_SUMMARY);
  return {
    dedupeKey: `silence:${fallbackAnchor(snapshot)}:${bucket}:${snapshot.activeEvidenceRef}`,
    notification: {
      kind: 'silence', requestSummary,
      title: `Still working · ${requestSummary}`,
      body: 'No new milestone yet. The durable request trail still shows active work.',
      links: links(snapshot, snapshot.activeEvidenceRef)
    }
  };
}

/**
 * Event-first request check-ins with one bounded fallback timer.
 *
 * Startup intentionally scans current durable state: already-claimed events are rejected by the
 * source, while an event that happened while the app was down can still be surfaced once.
 */
export function createRequestCheckInOwner(options: {
  source: DurableRequestCheckInSource;
  notify: RequestCheckInNotifier;
  silenceMs?: number;
  clock?: RequestCheckInClock;
}): { start(): void; stop(): void; refresh(): Promise<void> } {
  const source = options.source;
  const notify = options.notify;
  const clock = options.clock ?? systemClock;
  const silenceMs = Math.max(REQUEST_CHECK_IN_MIN_SILENCE_MS,
    Math.min(REQUEST_CHECK_IN_MAX_SILENCE_MS, options.silenceMs ?? REQUEST_CHECK_IN_DEFAULT_SILENCE_MS));
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scan = Promise.resolve();

  const clearTimer = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  const claimAndNotify = async (snapshot: DurableRequestCheckInSnapshot, candidate: { dedupeKey: string; notification: RequestCheckInNotification }): Promise<boolean> => {
    const claimedAt = clock.now();
    const claimed = await source.claimCheckInNotification({
      requestRef: snapshot.requestRef,
      expectedRevision: snapshot.revision,
      dedupeKey: candidate.dedupeKey,
      kind: candidate.notification.kind,
      claimedAt
    });
    if (!claimed || stopped) return false;
    // Claim precedes the external notification side effect. An exception is intentionally not
    // replayed because delivery may be ambiguous once the notifier was invoked.
    await notify(candidate.notification);
    return true;
  };

  const scanNow = async (): Promise<void> => {
    if (stopped) return;
    clearTimer();
    const snapshots = await source.listCheckInRequests();
    if (stopped) return;
    const now = clock.now();
    const eventDelivered = new Set<string>();
    for (const snapshot of snapshots) {
      const event = eventCandidate(snapshot);
      if (event && await claimAndNotify(snapshot, event)) eventDelivered.add(snapshot.requestRef);
    }
    for (const snapshot of snapshots) {
      if (snapshot.state !== 'active' || eventDelivered.has(snapshot.requestRef)) continue;
      const fallback = silenceCandidate(snapshot, now, silenceMs);
      if (fallback) await claimAndNotify(snapshot, fallback);
    }
    if (stopped) return;
    let nextAt: number | null = null;
    for (const snapshot of snapshots) {
      if (snapshot.state !== 'active' || !snapshot.activeEvidenceRef) continue;
      const anchor = fallbackAnchor(snapshot);
      const elapsed = Math.max(0, now - anchor);
      const bucket = Math.floor(elapsed / silenceMs);
      const due = elapsed < silenceMs ? anchor + silenceMs : anchor + (bucket + 1) * silenceMs;
      nextAt = nextAt === null ? due : Math.min(nextAt, due);
    }
    if (nextAt !== null) {
      const delay = Math.max(1, Math.min(REQUEST_CHECK_IN_MAX_SILENCE_MS, nextAt - clock.now()));
      timer = clock.setTimeout(() => {
        timer = null;
        // Timer delivery is background maintenance. Keep a failed source read visible to the next
        // explicit refresh without creating an unhandled rejection after shutdown/test teardown.
        void queueScan().catch(() => undefined);
      }, delay);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }
  };

  const queueScan = (): Promise<void> => {
    scan = scan.catch(() => undefined).then(scanNow);
    return scan;
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      unsubscribe = source.onCheckInRequestChange(() => { void queueScan().catch(() => undefined); });
      void queueScan().catch(() => undefined);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;
    },
    refresh: queueScan
  };
}
