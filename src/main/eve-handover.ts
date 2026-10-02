/**
 * Explicit user request: make this chat the installation's Eve/Eva (the Prime).
 *
 * The recorded owner can be deleted or locked behind a usage limit, and then no chat can hand the
 * role over; users used to dig the thread id out of AppData and patch it by hand. The user asks
 * the agent in a fresh, working, non-Prime chat instead, and this moves the identity and the
 * worker family with it. The old chat takes no part and approves nothing.
 *
 * Ownership is still never inferred: the destination is the exact conversation the call proved,
 * and the move is refused for workers, helpers, blocked or superseded chats, for a chat that
 * already leads another worker family, and while the old Prime is demonstrably mid-work.
 */

import { assignAgentConversation, currentAgentConversationId, revertAgentConversation } from './agent-identity.js';
import { movePrimeOnUserRequest, persistCriticalSwarmNow, retiredWorkerForConversation } from './agents.js';
import { logInfo, logWarn } from './logger.js';
import { isChatBlocked } from './session/blocked-chats.js';
import { conversationWasSuperseded, indexedSessions } from './session/store.js';

/** An open turn this recent means the old Prime is working in a live tab; leave it alone. */
export const OLD_PRIME_ACTIVE_MS = 5 * 60_000;

export type EveMoveResult =
  | { ok: true; changed: boolean; from: string | null; to: string; movedWorkerFamily: boolean; workers: number }
  | { ok: false; code: string; message: string };

let tail: Promise<unknown> = Promise.resolve();

function refuse(code: string, message: string): EveMoveResult {
  return { ok: false, code, message };
}

export function moveEveToConversation(toConversationId: string): Promise<EveMoveResult> {
  const run = tail.then(() => move(toConversationId), () => move(toConversationId));
  tail = run.catch(() => undefined);
  return run;
}

async function move(to: string): Promise<EveMoveResult> {
  const from = currentAgentConversationId();
  if (from === to) return { ok: true, changed: false, from, to, movedWorkerFamily: false, workers: 0 };

  const sessions = await indexedSessions();
  const destination = sessions.filter(row => row.conversationId === to);
  if (destination.length !== 1) {
    return refuse('DESTINATION_NOT_RECORDED', 'This chat has no single local session yet, so it cannot become the Prime. Send one ordinary message in it, then ask again.');
  }
  const kind = destination[0]!.origin?.kind;
  if (kind === 'worker' || kind === 'helper' || retiredWorkerForConversation(to)) {
    return refuse('DESTINATION_IS_WORKER', 'Workers and helpers cannot become the Prime. Ask from an ordinary chat.');
  }
  if (isChatBlocked(to) || await conversationWasSuperseded(to)) {
    return refuse('DESTINATION_UNAVAILABLE', 'This chat is blocked or was replaced by a newer one, so it cannot become the Prime.');
  }
  // Protect a live old Prime: moving it from under a turn that is genuinely running would strand
  // that turn's tool results. A gone or limit-locked chat has no fresh activity, so it passes.
  const previous = from ? sessions.find(row => row.conversationId === from) : undefined;
  if (previous?.activeTurnId && Date.now() - previous.updatedAt < OLD_PRIME_ACTIVE_MS) {
    return refuse('OLD_PRIME_ACTIVE', 'The current Prime chat is working right now. Stop it or wait until it has been quiet for five minutes, then ask again.');
  }

  const swarm = movePrimeOnUserRequest(from, to);
  if (swarm.status === 'refused') return refuse('WORKER_FAMILY_REFUSED', `The worker family could not move: ${swarm.reason}.`);
  const movedFamily = swarm.status === 'moved';

  const undoSwarm = (): void => {
    if (swarm.status === 'moved') movePrimeOnUserRequest(to, swarm.from);
  };
  let identityChanged = false;
  try {
    const replaced = await assignAgentConversation(to);
    if (replaced === undefined) throw new Error('invalid conversation id');
    identityChanged = true;
    if (movedFamily && !(await persistCriticalSwarmNow())) throw new Error('the worker family could not be saved');
  } catch (error) {
    undoSwarm();
    if (identityChanged) await revertAgentConversation(to, from).catch(() => undefined);
    logWarn(`eve move to ${to} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    return refuse('PERSIST_FAILED', `Nothing was changed: ${error instanceof Error ? error.message : String(error)}. Try again.`);
  }
  logInfo(`eve move: identity and ${movedFamily ? `${swarm.status === 'moved' ? swarm.workers : 0} worker(s)` : 'no worker family'} moved from ${from ?? 'no recorded owner'} to ${to}`);
  return { ok: true, changed: true, from, to, movedWorkerFamily: movedFamily, workers: swarm.status === 'moved' ? swarm.workers : 0 };
}
