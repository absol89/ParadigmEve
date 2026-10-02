/**
 * Durable owner of this installation's one human-facing agent conversation.
 *
 * The worker broker may keep many active/parked run families. None of those families is the
 * product identity. This file owns the one exact ChatGPT conversation that carries the configured
 * installation name (Eve, Eva, etc.), or null when ownership is intentionally unknown.
 *
 * Ownership is never inferred from titles, recency, visible tabs or arbitrary history. A fresh
 * chat can claim it only after the browser reports ChatGPT's exact conversation id, and Compact &
 * Resume moves it only across the already-authorised durable continuation commit.
 */

import { writeDurableNow } from './durable.js';

export const AGENT_IDENTITY_STATE = 'agent-identity';

export interface AgentIdentitySnapshot {
  version: 1;
  conversationId: string | null;
}

const CONVERSATION_ID = /^[0-9a-z-]{8,256}$/i;

let currentConversationId: string | null = null;
const listeners = new Set<() => void>();
let mutationTail: Promise<void> = Promise.resolve();

/**
 * Serializes the predicate and durable write for every identity mutation.
 *
 * The conversation id is a compare-and-set fence, so checking it before an awaited durable write
 * would let two concurrent transitions both publish stale decisions. Keep the whole mutation in
 * one queue instead. Callers still get their own result/rejection while later mutations continue.
 */
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(fn, fn);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

function parseSnapshot(value: unknown): AgentIdentitySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Object.prototype.hasOwnProperty.call(row, 'conversationId')) return null;
  if (row.conversationId !== null && !validConversationId(row.conversationId)) return null;
  if (Object.keys(row).some((key) => key !== 'version' && key !== 'conversationId')) return null;
  return { version: 1, conversationId: row.conversationId as string | null };
}

function changed(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* observer only */ }
  }
}

export function onAgentIdentityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentAgentConversationId(): string | null {
  return currentConversationId;
}

export function snapshotAgentIdentity(): AgentIdentitySnapshot {
  return { version: 1, conversationId: currentConversationId };
}

/**
 * Restores the dedicated identity file. On the first build that owns this file, one exact legacy
 * broker selection may be migrated. A malformed existing snapshot fails closed and never falls
 * back to broker history.
 */
export function restoreAgentIdentity(
  saved: unknown,
  legacyExactConversationId: string | null = null
): { persist: boolean; migrated: boolean } {
  const parsed = parseSnapshot(saved);
  if (parsed) {
    currentConversationId = parsed.conversationId;
    return { persist: false, migrated: false };
  }

  if (saved === null && validConversationId(legacyExactConversationId)) {
    currentConversationId = legacyExactConversationId;
    return { persist: true, migrated: true };
  }

  currentConversationId = null;
  // Missing state must become an explicit null snapshot so a later broker family cannot silently
  // acquire Eve merely because no worker-independent owner file existed yet.
  return { persist: saved === null, migrated: false };
}

async function commit(next: string | null): Promise<void> {
  await writeDurableNow(AGENT_IDENTITY_STATE, { version: 1, conversationId: next } satisfies AgentIdentitySnapshot);
  if (currentConversationId === next) return;
  currentConversationId = next;
  changed();
}

/**
 * Claims Eve/Eva for a fresh user-started chat only after ChatGPT has supplied its exact id.
 * Existing ownership always wins; this is not a takeover API.
 */
export async function claimAgentConversation(conversationId: string): Promise<boolean> {
  if (!validConversationId(conversationId)) return false;
  return mutate(async () => {
    if (currentConversationId === conversationId) return true;
    if (currentConversationId !== null) return false;
    await commit(conversationId);
    return true;
  });
}

/** Moves the one product identity across an already-proven exact continuation. */
export async function transferAgentConversation(fromConversationId: string, toConversationId: string): Promise<boolean> {
  if (!validConversationId(fromConversationId) || !validConversationId(toConversationId) || fromConversationId === toConversationId) return false;
  return mutate(async () => {
    if (currentConversationId === toConversationId) return true;
    if (currentConversationId !== fromConversationId) return true; // unrelated/null identity: no adoption
    await commit(toConversationId);
    return true;
  });
}

/**
 * Strict compare-and-set replacement for one explicit user-started fresh chat.
 *
 * Unlike continuation transfer, an unrelated/null current owner is a refusal rather than an
 * idempotent no-op: a late fresh-chat ACK must never adopt Eve after some newer transition won.
 */
export async function replaceAgentConversation(
  expectedConversationId: string,
  toConversationId: string
): Promise<boolean> {
  if (!validConversationId(expectedConversationId) || !validConversationId(toConversationId) || expectedConversationId === toConversationId) return false;
  return mutate(async () => {
    if (currentConversationId === toConversationId) return true;
    if (currentConversationId !== expectedConversationId) return false;
    await commit(toConversationId);
    return true;
  });
}

/**
 * Explicit user-requested move of the identity to this exact conversation.
 *
 * Unlike every other transition this does not need the previous owner to exist or cooperate: the
 * owner may be deleted or locked behind a usage limit, which is exactly when the user asks. Returns
 * the owner it replaced (null when there was none), or undefined for an invalid id.
 */
export async function assignAgentConversation(toConversationId: string): Promise<string | null | undefined> {
  if (!validConversationId(toConversationId)) return undefined;
  return mutate(async () => {
    const previous = currentConversationId;
    if (previous !== toConversationId) await commit(toConversationId);
    return previous;
  });
}

/** Undoes {@link assignAgentConversation} while this conversation still holds the identity. */
export async function revertAgentConversation(toConversationId: string, previous: string | null): Promise<void> {
  await mutate(async () => {
    if (currentConversationId === toConversationId) await commit(previous);
  });
}

/** Clears only the exact current owner. Historical chats remain untouched. */
export async function clearAgentConversation(conversationId: string): Promise<boolean> {
  if (!validConversationId(conversationId)) return false;
  return mutate(async () => {
    if (currentConversationId !== conversationId) return false;
    await commit(null);
    return true;
  });
}

/** Test seam only. */
export function resetAgentIdentityForTests(): void {
  currentConversationId = null;
  listeners.clear();
  mutationTail = Promise.resolve();
}
