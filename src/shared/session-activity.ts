import { CHAT_ACTIVE_MS, type SessionSummary } from './session.js';

/**
 * How long after its session start or last exact attributed tool call a chat still reads as
 * working.
 *
 * Prime owns the run for its whole life, so its agent state alone would light this badge
 * permanently and say nothing. An open turn was the gate instead, which is exact but too
 * narrow: when a page loses its answer stream the recorder has no open turn, while the model
 * behind it goes on calling tools for minutes. That is a chat very much at work, shown as idle
 * — and the moment a user most wants to see that it is still going.
 *
 * The bridge's recovery window is deliberately the shorter of the two, and the authorities remain
 * separate: this derives display state from the durable session summary; the bridge derives a
 * browser action from exact observations and attributed calls. The label outliving the reload
 * window is the point — a chat being reloaded on the app's instruction is mid-repair, and the
 * badge going dark first is what made that reload look like it came out of nowhere.
 */
/**
 * Pro uses the bridge's live ten-minute activity deadline.
 * Other sessions and exact calls stay active for three minutes unless a later turn end finished
 * them — the model's final answer, or the turn ending any other way, the user's stop included.
 * A refused call in a blocked chat still counts as the call it was: the badge is how the user
 * sees that something is still trying, and it goes dark the moment the turn is stopped.
 */
export function recentChatActivity(summary: SessionSummary, now = Date.now()): boolean {
  if (summary.activityExpiresAt !== undefined) {
    return summary.activityExpiresAt !== null && now < summary.activityExpiresAt;
  }
  const lastActivityAt = Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
  const finishedAt = Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0);
  return lastActivityAt > finishedAt && now - lastActivityAt < CHAT_ACTIVE_MS;
}

/**
 * A worker whose newest call was its own finish report has stopped working, whatever the swarm
 * currently says or fails to say: the run parks the moment its last worker stops, and a parked
 * run has no agent view for the list to read.
 */
export function workerReportedFinish(summary: SessionSummary): boolean {
  return (
    summary.origin?.kind === 'worker' &&
    typeof summary.lastFinishReportAt === 'number' &&
    summary.lastFinishReportAt >= (summary.lastToolCallAt ?? 0)
  );
}

/** Reload-generated turn boundaries are not activity authority; session start, calls and finals are. */
export function sessionWorking(summary: SessionSummary, now = Date.now()): boolean {
  return summary.endedAt === null && !workerReportedFinish(summary) && recentChatActivity(summary, now);
}
