/**
 * Ollama turns for the desktop chat.
 *
 * The composer and outbox stay the single intake: an Ollama turn is an ordinary durable outbox
 * row tagged `provider: 'ollama'`. After it is accepted this driver claims it (the browser and
 * tool transports never do), records the user message through the same receipt path a ChatGPT
 * send uses, and streams the reply into the same session archive. Only the inference transport
 * differs; message ids, attachments, history and the archive are the chat's, not the provider's.
 *
 * A chat that starts here gets a local conversation id (`ollama-…`). It is never opened in a
 * browser; the chat's first ChatGPT turn binds a real ChatGPT conversation to the same session.
 */

import { randomUUID } from 'node:crypto';
import {
  acknowledgeBrowserInput,
  claimLocalInput,
  failBrowserInput,
  isLocalProviderInput,
  listInputs,
  pendingLocalInputs,
  setLocalTurnProbe,
  type InputEntry
} from './input.js';
import { appendEvent, createSession, findSessionByConversation, getSession, listAllSessions, setSessionLocalOnly, upsertMessageEvent } from './store.js';
import { assignSessionProject } from '../projects.js';
import { userTitle } from './title.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { ensureOllamaModel, ollamaModelCapabilities, streamOllamaChat } from '../ollama-client.js';
import { ollamaConversation, ProviderCapabilityError } from './provider-history.js';
import { OLLAMA_CONVERSATION_PREFIX, type ChatProvider, type StoredText } from '../../shared/session.js';

const OWNER = 'ollama-local';
const TURN_PREFIX = 'ollama-turn:';
const MAX_REPLY_INLINE = 256_000;
const STREAM_WRITE_MS = 300;

const SYSTEM_PROMPT =
  'You are answering one turn of a conversation the user keeps in ParadigmEve. Earlier assistant ' +
  'messages may have been written by ChatGPT or by other models; treat them as this conversation\'s ' +
  'own history. Answer the newest user message. You have no tools in this chat.';

interface LocalTurn { turnId: string; controller: AbortController }
const active = new Map<string, LocalTurn>();
/** One queue per chat (fresh chats queue by input id): turns in one chat never overlap. */
const chains = new Map<string, Promise<unknown>>();
let changed: () => void = () => undefined;


/** The running Ollama turn in this session, if any. */
export function localTurnFor(sessionId: string): string | null {
  return active.get(sessionId)?.turnId ?? null;
}

/** Stops exactly this running Ollama turn. The partial reply stays in the archive. */
export function stopLocalTurn(sessionId: string, turnId: string): boolean {
  const turn = active.get(sessionId);
  if (!turn || turn.turnId !== turnId) return false;
  turn.controller.abort(new Error('stopped'));
  return true;
}

function stored(text: string): StoredText {
  if (text.length <= MAX_REPLY_INLINE) return { text, truncated: false, chars: text.length };
  return { text: `${text.slice(0, MAX_REPLY_INLINE)}\n…[${text.length - MAX_REPLY_INLINE} more characters not stored]`, truncated: true, chars: text.length };
}

async function sessionFor(entry: InputEntry, conversationId: string, provider: ChatProvider): Promise<string> {
  if (entry.sessionId) return entry.sessionId;
  const existing = await findSessionByConversation(conversationId, { requireUnique: true });
  if (existing) return existing.id;
  const created = await createSession({
    conversationId,
    title: userTitle(entry.text, entry.text),
    titleSource: 'fallback',
    origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' },
    provider
  });
  if (entry.projectId) await assignSessionProject(created.id, entry.projectId);
  if (entry.localOnly) await setSessionLocalOnly(created.id, true);
  return created.id;
}

/** Claims, records and answers one accepted Ollama row. Rows are handled one at a time. */
export function deliverLocalInput(entry: InputEntry): Promise<void> {
  const key = entry.sessionId ?? entry.id;
  const next = (chains.get(key) ?? Promise.resolve()).then(() => run(entry));
  const settled = next.catch(() => undefined);
  chains.set(key, settled);
  void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return next;
}

async function run(entry: InputEntry): Promise<void> {
  if (!isLocalProviderInput(entry) || !entry.model) return;
  const provider: ChatProvider = { id: 'ollama', model: entry.model };
  if (!getConfig().sessions.record) {
    // Without the archive there is no history to give the model, and no place for its reply.
    await claimAndFail(entry, 'Ollama chats need session recording. Turn recording on in Settings and send again.');
    return;
  }
  const owner = entry.sessionId ? await getSession(entry.sessionId) : null;
  if (entry.sessionId && !owner?.conversationId) {
    await claimAndFail(entry, 'This chat has no conversation to continue. Start a new chat.');
    return;
  }
  const conversationId = owner?.conversationId ??
    (entry.state === 'browser' && entry.owner === OWNER && entry.conversationId ? entry.conversationId : `${OLLAMA_CONVERSATION_PREFIX}${randomUUID()}`);
  const claimed = await claimLocalInput(entry.id, OWNER, conversationId);
  if (!claimed) return;

  let sessionId: string;
  try {
    sessionId = await sessionFor(claimed, conversationId, provider);
    const messageId = `ollama-user:${claimed.id}`;
    if (!await acknowledgeBrowserInput(claimed.id, OWNER, conversationId, messageId)) {
      throw new Error('The message could not be recorded in this chat.');
    }
  } catch (error) {
    await failBrowserInput(claimed.id, OWNER, (error as Error).message);
    changed();
    return;
  }
  changed();
  await answer(sessionId, claimed, provider);
}

async function claimAndFail(entry: InputEntry, reason: string): Promise<void> {
  const conversationId = entry.conversationId ?? `${OLLAMA_CONVERSATION_PREFIX}${randomUUID()}`;
  if (await claimLocalInput(entry.id, OWNER, conversationId)) await failBrowserInput(entry.id, OWNER, reason);
  changed();
}

async function answer(sessionId: string, entry: InputEntry, provider: ChatProvider): Promise<void> {
  const turnId = `${TURN_PREFIX}${entry.id}`;
  const controller = new AbortController();
  active.set(sessionId, { turnId, controller });
  const startedAt = Date.now();
  const messageId = `ollama-reply:${entry.id}`;
  let reply = '';
  let written = '';
  let lastWrite = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const write = (state: 'streaming' | 'final') => {
    const text = reply;
    pending = pending.then(() => upsertMessageEvent(sessionId, {
      time: startedAt,
      source: 'app',
      kind: 'assistant_message',
      turnId,
      messageId,
      provider,
      message: stored(text),
      state,
      final: state === 'final'
    })).catch((error: Error) => logWarn(`session ${sessionId}: Ollama reply write failed: ${error.message}`));
    written = text;
    lastWrite = Date.now();
    return pending;
  };
  try {
    await appendEvent(sessionId, { time: startedAt, source: 'app', kind: 'turn_start', turnId, detail: `Ollama · ${provider.model}` });
    changed();
    await ensureOllamaModel(provider.model);
    const capabilities = await ollamaModelCapabilities(provider.model);
    const vision = capabilities ? capabilities.includes('vision') : null;
    const messages = await ollamaConversation(sessionId, vision, SYSTEM_PROMPT);
    reply = await streamOllamaChat({
      model: provider.model,
      messages,
      signal: controller.signal,
      onText: (text) => {
        reply = text;
        if (Date.now() - lastWrite >= STREAM_WRITE_MS) void write('streaming');
      }
    });
    if (!reply.trim()) throw new Error(`${provider.model} returned an empty reply.`);
    await write('final');
    await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome: 'completed' });
    logInfo(`session ${sessionId}: Ollama ${provider.model} answered input ${entry.id} in ${Date.now() - startedAt} ms`);
  } catch (error) {
    const stopped = controller.signal.aborted;
    if (reply && reply !== written) await write(stopped ? 'streaming' : 'final');
    else await pending;
    if (!stopped) {
      const reason = error instanceof ProviderCapabilityError ? error.message : `Ollama (${provider.model}) failed: ${(error as Error).message}`;
      await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'chat_error', message: { text: reason, truncated: false, chars: reason.length } })
        .catch(() => undefined);
      logWarn(`session ${sessionId}: ${reason}`);
    }
    await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome: stopped ? 'stopped' : 'failed' })
      .catch(() => undefined);
  } finally {
    if (active.get(sessionId)?.controller === controller) active.delete(sessionId);
    changed();
  }
}

/**
 * Starts the driver. Replays accepted rows that were owed a turn before a restart, and closes
 * any Ollama turn a restart interrupted (its in-process stream cannot be resumed).
 */
export async function startOllamaChatDriver(onChange: () => void): Promise<void> {
  changed = onChange;
  setLocalTurnProbe((sessionId) => active.has(sessionId));
  try {
    for (const session of await listAllSessions()) {
      if (!session.activeTurnId?.startsWith(TURN_PREFIX) || active.has(session.id)) continue;
      const note = 'ParadigmEve restarted while Ollama was answering. The partial reply is kept; send again to continue.';
      await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'chat_error', message: { text: note, truncated: false, chars: note.length } });
      await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_end', turnId: session.activeTurnId, outcome: 'interrupted' });
    }
  } catch (error) {
    logWarn(`Ollama chat: could not close interrupted turns: ${(error as Error).message}`);
  }
  for (const entry of await pendingLocalInputs()) void deliverLocalInput(entry);
}

/** For callers that only have an id (the IPC send path returns the accepted row). */
export async function deliverLocalInputById(id: string): Promise<void> {
  const entry = (await listInputs()).find((row) => row.id === id);
  if (entry) await deliverLocalInput(entry);
}

/** Test seam. */
export function resetOllamaChatForTests(): void {
  for (const turn of active.values()) turn.controller.abort();
  active.clear();
  chains.clear();
  changed = () => undefined;
}
