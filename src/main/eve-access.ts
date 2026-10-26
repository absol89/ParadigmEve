import { currentAgentConversationId } from './agent-identity.js';
import { isWorkerConversation, retiredWorkerForConversation } from './agents.js';
import { getConfig } from './config.js';
import { isGoalDecisionChat } from './goal.js';
import { currentCall, type CallCaller } from './mcp/call-context.js';
import { inboundToolEvidence } from './mcp/inbound.js';

/** User-facing account-wide Eve access. Exact caller identity remains preferable when available. */
export function otherChatEveAccessEnabled(): boolean {
  return getConfig().eveAuthority?.allowOtherChats !== false;
}

/** Explicit unattributed-call opt-in selects the durable installation owner, never tab recency. */
export function unattributedPrimeForCurrentCall(caller: CallCaller | undefined = currentCall()?.caller): string | null {
  if (getConfig().multiAgent.allowUnattributedCalls !== true || !inboundToolEvidence() ||
      !caller?.requestId || caller.localPrincipal ||
      (caller.conversationId && caller.attributionSource !== 'installation_prime')) return null;
  return currentAgentConversationId();
}

/**
 * The installation Eve conversation whose authority this external connector call may borrow.
 *
 * The MCP route token authenticates the connector installation; ChatGPT's request id proves this
 * is a model-issued connector call rather than ParadigmEve's own self-test/probe. Phone and other
 * devices may have no Companion page evidence, so conversation/session identity is deliberately
 * not required in this opt-out mode.
 */
export function sharedEveOwnerForCurrentCall(): string | null {
  if (!otherChatEveAccessEnabled() || !inboundToolEvidence()) return null;
  const call = currentCall();
  if (!call?.caller.requestId || call.caller.localPrincipal) return null;
  const conversationId = call.caller.conversationId;
  if (conversationId && (
    isGoalDecisionChat(conversationId) ||
    isWorkerConversation(conversationId) ||
    retiredWorkerForConversation(conversationId)
  )) return null;
  return currentAgentConversationId();
}

/** Exact Eve owner, or a connector-authenticated call the user chose to trust account-wide. */
export function currentCallMayUseEveAuthority(): boolean {
  const owner = currentAgentConversationId();
  if (!owner) return false;
  const caller = currentCall()?.caller;
  return caller?.conversationId === owner || sharedEveOwnerForCurrentCall() === owner;
}
