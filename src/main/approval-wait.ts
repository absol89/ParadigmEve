/**
 * Read-only projection of an exact live page's provider tool-approval card.
 * ChatGPT alone owns the decision. A collapsed card is still waiting; missing
 * polls are not evidence that the human answered it.
 */
export const APPROVAL_FRESH_MS = 75_000;
export const APPROVAL_NOTICE_GRACE_MS = 30_000;
export const APPROVAL_WAITING_TEXT = 'Waiting for your approval in ChatGPT — open this conversation and answer its tool approval card.';
export const APPROVAL_CLEARED_TEXT = 'The ChatGPT tool approval card is no longer pending.';

export interface ApprovalWaitDeps {
  record(sessionId: string, progressId: string, text: string, anchor?: { seq: number; time: number }): Promise<{ seq: number; time: number } | null>;
  notify(sessionId: string, progressId: string): void;
  log(message: string): void;
}

interface Wait {
  since: number;
  seenAt: number;
  notified: boolean;
  progressId: string;
  sessionId: string | null;
  row: Promise<{ seq: number; time: number } | null> | null;
}
const waits = new Map<string, Wait>();
let nativeNotifier: ((sessionId: string, progressId: string) => void) | null = null;
export function setApprovalNotifier(notifier: typeof nativeNotifier): void { nativeNotifier = notifier; }
export function notifyApprovalWaiting(sessionId: string, progressId: string): void {
  try { nativeNotifier?.(sessionId, progressId); } catch { /* The in-app row remains visible. */ }
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
    deps.log(`approval: ${conversationId} ${waiting ? 'observation expired' : 'explicitly cleared'}`);
    if (!waiting && entry.sessionId) {
      const anchor = await entry.row;
      if (anchor) await deps.record(entry.sessionId, entry.progressId, APPROVAL_CLEARED_TEXT, anchor).catch(() => null);
    }
    entry = undefined;
  }
  if (!waiting) return;
  if (!entry) {
    entry = { since: now, seenAt: now, notified: false,
      progressId: `provider-approval:${conversationId}:${now}`, sessionId: null, row: null };
    waits.set(conversationId, entry);
    deps.log(`approval: ${conversationId} awaiting human ChatGPT tool decision`);
  }
  entry.seenAt = now;
  if (sessionId && !entry.sessionId) {
    entry.sessionId = sessionId;
    entry.row = deps.record(sessionId, entry.progressId, APPROVAL_WAITING_TEXT).catch(() => null);
  }
  if (entry.sessionId && !entry.notified && now - entry.since >= APPROVAL_NOTICE_GRACE_MS) {
    entry.notified = true;
    deps.notify(entry.sessionId, entry.progressId);
  }
}

export function resetApprovalWaits(): void { waits.clear(); }
