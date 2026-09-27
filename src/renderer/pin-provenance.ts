import type { SessionSummary } from '../shared/session.js';

/**
 * Returns an authored message's conversation only while the session has one proven frontend.
 *
 * Message timeline rows retain durable session/event identity, but today they do not retain an
 * exact per-message conversation id. Once Compact & Resume has moved a session from A to B, the
 * session's current conversation B is therefore not proof that an older message came from B.
 * Fail closed instead of manufacturing a source link; the Pin still keeps its durable snapshot.
 */
export function authoredMessageConversationId(
  session: Pick<SessionSummary, 'conversationId' | 'chatIds'>
): string | null {
  if (!session.conversationId) return null;
  return session.chatIds.length === 1 && session.chatIds[0] === session.conversationId
    ? session.conversationId
    : null;
}
