/**
 * Read-only projection of an exact live page's provider tool-approval card.
 * ChatGPT alone owns the decision. A collapsed card is still waiting; missing
 * polls are not evidence that the human answered it.
 */
import { debugReliabilityEvent } from './reliability-debug-events.js';
export const APPROVAL_FRESH_MS = 75_000;
export const APPROVAL_NOTICE_GRACE_MS = 30_000;
export const APPROVAL_WAITING_TEXT = 'Waiting for your approval in ChatGPT — open this conversation and answer its tool approval card.';
export const APPROVAL_CLEARED_TEXT = 'The ChatGPT tool approval card is no longer pending.';
export const DELEGATED_APPROVAL_TEXT = 'A delegated worker is waiting on a ChatGPT provider approval card. Eve cannot move or approve that provider card; review the worker conversation if required. The original call has not been replayed.';

export interface ApprovalWaitDeps {
  record(sessionId: string, progressId: string, text: string, anchor?: { seq: number; time: number }): Promise<{ seq: number; time: number } | null>;
  notify(sessionId: string, progressId: string, conversationId: string): void;
  log(message: string): void;
  /** Exact broker-owned Prime session; null for Prime, human chats, or ambiguous ownership. */
  primeSessionFor?(conversationId: string): string | null;
}

interface Wait {
  since: number;
  seenAt: number;
  notified: boolean;
  progressId: string;
  sessionId: string | null;
  row: Promise<{ seq: number; time: number } | null> | null;
  primeSessionId: string | null;
  primeRow: Promise<{ seq: number; time: number } | null> | null;
}
const waits = new Map<string, Wait>();
const focusRequests = new Map<string, number>();
const FOCUS_REQUEST_MS = 30_000;
let nativeNotifier: ((sessionId: string, progressId: string, conversationId: string) => void) | null = null;
export function setApprovalNotifier(notifier: typeof nativeNotifier): void { nativeNotifier = notifier; }
export function notifyApprovalWaiting(sessionId: string, progressId: string, conversationId: string): void {
  try { nativeNotifier?.(sessionId, progressId, conversationId); } catch { /* The in-app row remains visible. */ }
}

/** A real click, not a worker or poll, requests selection of the exact existing approval page. */
export function requestApprovalTabFocus(conversationId: string, now = Date.now()): boolean {
  if (!approvalCardWaiting(conversationId, now)) return false;
  focusRequests.set(conversationId, now + FOCUS_REQUEST_MS);
  return true;
}

/** Offered once only to a page reporting that its own approval card is still visible. */
export function takeApprovalTabFocus(conversationId: string, pageReportsApproval: boolean, now = Date.now()): boolean {
  const until = focusRequests.get(conversationId);
  if (until === undefined) return false;
  if (now > until) { focusRequests.delete(conversationId); return false; }
  if (!pageReportsApproval || !approvalCardWaiting(conversationId, now)) return false;
  focusRequests.delete(conversationId);
  return true;
}

export function approvalCardWaiting(conversationId: string, now = Date.now()): boolean {
  const entry = waits.get(conversationId);
  return !!entry && now - entry.seenAt < APPROVAL_FRESH_MS;
}

export async function noteApprovalCard(
  conversationId: string, waiting: boolean, sessionId: string | null,
  deps: ApprovalWaitDeps, now = Date.now()
): Promise<void> {
  let entry = waits.get(conversationId);
  if (entry && (!waiting || now - entry.seenAt >= APPROVAL_FRESH_MS)) {
    waits.delete(conversationId);
    focusRequests.delete(conversationId);
    deps.log(`approval: ${conversationId} ${waiting ? 'observation expired' : 'explicitly cleared'}`);
    debugReliabilityEvent(waiting ? 'approval-observation-expired' : 'approval-cleared', {
      owner: conversationId, elapsedMs: now - entry.since,
      warning: waiting
    });
    if (!waiting && entry.sessionId) {
      const anchor = await entry.row;
      if (anchor) await deps.record(entry.sessionId, entry.progressId, APPROVAL_CLEARED_TEXT, anchor).catch(() => null);
    }
    if (!waiting && entry.primeSessionId && entry.primeRow) {
      const anchor = await entry.primeRow;
      if (anchor) await deps.record(entry.primeSessionId, entry.progressId, APPROVAL_CLEARED_TEXT, anchor).catch(() => null);
    }
    entry = undefined;
  }
  if (!waiting) return;
  if (!entry) {
    entry = { since: now, seenAt: now, notified: false,
      progressId: `provider-approval:${conversationId}:${now}`, sessionId: null, row: null,
      primeSessionId: null, primeRow: null };
    waits.set(conversationId, entry);
    deps.log(`approval: ${conversationId} awaiting human ChatGPT tool decision`);
    debugReliabilityEvent('approval-pending', { owner: conversationId });
  }
  entry.seenAt = now;
  if (sessionId && !entry.sessionId) {
    entry.sessionId = sessionId;
    entry.row = deps.record(sessionId, entry.progressId, APPROVAL_WAITING_TEXT).catch(() => null);
  }
  if (!entry.primeSessionId) {
    const primeSessionId = deps.primeSessionFor?.(conversationId) ?? null;
    if (primeSessionId && primeSessionId !== sessionId) {
      entry.primeSessionId = primeSessionId;
      entry.primeRow = deps.record(primeSessionId, entry.progressId, DELEGATED_APPROVAL_TEXT).catch(() => null);
    }
  }
  if (entry.sessionId && !entry.notified && now - entry.since >= APPROVAL_NOTICE_GRACE_MS) {
    entry.notified = true;
    deps.notify(entry.primeSessionId ?? entry.sessionId, entry.progressId, conversationId);
  }
}

export function resetApprovalWaits(): void { waits.clear(); focusRequests.clear(); }
