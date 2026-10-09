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
  type InputEntry
} from './input.js';
import { appendEvent, createSession, findSessionByConversation, getSession, listAllSessions, setSessionLocalOnly, upsertMessageEvent } from './store.js';
import { assignSessionProject } from '../projects.js';
import { userTitle } from './title.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { ensureOllamaModel, ollamaModelCapabilities, resolveOllamaEndpoint } from '../ollama-client.js';
import { createOllamaAgentModelRuntime } from '../ollama-agent-runtime.js';
import { OPENROUTER_API_BASE, createOpenRouterAgentModelRuntime, openRouterKey, openRouterModelInfo } from '../openrouter-client.js';
import { issueLocalAgentExecutionPrincipal, revokeLocalAgentExecutionPrincipal, runLocalAgent, type LocalAgentMessage } from '../local-agent-runtime.js';
import { localChatCoreTools } from '../local-chat-tools.js';
import type { ToolContext } from '../mcp/kernel.js';
import { ollamaConversation, ProviderCapabilityError } from './provider-history.js';
import { OLLAMA_CONVERSATION_PREFIX, OLLAMA_TURN_PREFIX, type ChatProvider, type StoredText } from '../../shared/session.js';

const OWNER = 'ollama-local';
const MAX_REPLY_INLINE = 256_000;
const SYSTEM_PROMPT_BASE =
  'You are answering one turn of a conversation the user keeps in ParadigmEve. Earlier assistant ' +
  'messages may have been written by ChatGPT or by other models; treat them as this conversation\'s own history. ';

function chatToolContext(): ToolContext {
  const config = getConfig();
  return {
    roots: config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    sessionTools: config.sessions.record,
    agentTools: config.multiAgent.enabled,
    exposedFinishTool: false
  };
}

function chatSystemPrompt(direct: boolean): string {
  return SYSTEM_PROMPT_BASE + (direct
    ? 'Use the available ParadigmEve tools whenever they are useful. Tool results are authoritative; never invent a result. Answer the newest user message when the requested work is complete.'
    : 'You do not have direct filesystem/computer tools. When the request needs tool execution, use delegate_worker and wait for its result. Do not pretend you performed delegated work yourself.');
}

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
  const provider: ChatProvider = { id: entry.provider === 'openrouter' ? 'openrouter' : 'ollama', model: entry.model };
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

const providerName = (provider: ChatProvider): string => provider.id === 'openrouter' ? 'OpenRouter' : 'Ollama';

async function answer(sessionId: string, entry: InputEntry, provider: ChatProvider): Promise<void> {
  const turnId = `${OLLAMA_TURN_PREFIX}${entry.id}`;
  const controller = new AbortController();
  active.set(sessionId, { turnId, controller });
  const startedAt = Date.now();
  const messageId = `ollama-reply:${entry.id}`;
  let reply = '';
  let written = '';
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
    return pending;
  };
  try {
    await appendEvent(sessionId, { time: startedAt, source: 'app', kind: 'turn_start', turnId, detail: `${providerName(provider)} · ${provider.model}` });
    changed();
    const settings = getConfig().agentRuntime.ollama;
    // OpenRouter: the key Settings stores for Goal, its catalog for image and tool support.
    const routerKey = provider.id === 'openrouter' ? (await openRouterKey())?.trim() || null : null;
    if (provider.id === 'openrouter' && !routerKey) {
      throw new ProviderCapabilityError('OpenRouter needs an API key. Add it in Settings → Agents & automation → API provider, then send again.');
    }
    let vision: boolean | null;
    let toolsSupported = true;
    if (provider.id === 'openrouter') {
      const info = await openRouterModelInfo(provider.model);
      vision = info ? info.vision : null;
      toolsSupported = info ? info.tools : true;
    } else {
      await ensureOllamaModel(provider.model);
      const capabilities = await ollamaModelCapabilities(provider.model);
      vision = capabilities ? capabilities.includes('vision') : null;
    }
    const direct = settings.chatDirectTools !== false;
    const messages = await ollamaConversation(sessionId, vision, chatSystemPrompt(direct));
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: `chat:${sessionId}`, agentId: turnId });
    try {
      const tools = !toolsSupported ? [] : await localChatCoreTools({
        getContext: chatToolContext,
        principal,
        sessionId,
        conversationId: (await getSession(sessionId))?.conversationId ?? null,
        mode: direct ? 'direct' : 'delegate'
      });
      const result = await runLocalAgent({
        backend: 'ollama',
        principal,
        endpoint: provider.id === 'openrouter' ? OPENROUTER_API_BASE : resolveOllamaEndpoint(settings.endpoint) ?? settings.endpoint,
        model: provider.model,
        system: '',
        task: '',
        initialMessages: messages as LocalAgentMessage[],
        tools,
        runtime: routerKey ? createOpenRouterAgentModelRuntime(routerKey) : createOllamaAgentModelRuntime(),
        signal: controller.signal,
        allowNoTools: true
      });
      reply = result.final;
      logInfo(`session ${sessionId}: ${providerName(provider)} ${provider.model} local-agent turn used ${result.toolCalls} tool call(s)`);
    } finally {
      revokeLocalAgentExecutionPrincipal(principal);
    }
    if (!reply.trim()) throw new Error(`${provider.model} returned an empty reply.`);
    await write('final');
    await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome: 'completed' });
    logInfo(`session ${sessionId}: ${providerName(provider)} ${provider.model} answered input ${entry.id} in ${Date.now() - startedAt} ms`);
  } catch (error) {
    const stopped = controller.signal.aborted;
    if (reply && reply !== written) await write(stopped ? 'streaming' : 'final');
    else await pending;
    if (!stopped) {
      const reason = error instanceof ProviderCapabilityError ? error.message : `${providerName(provider)} (${provider.model}) failed: ${(error as Error).message}`;
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
  try {
    for (const session of await listAllSessions()) {
      if (!session.activeTurnId?.startsWith(OLLAMA_TURN_PREFIX) || active.has(session.id)) continue;
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
