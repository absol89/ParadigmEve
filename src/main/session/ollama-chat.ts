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
import { createLlamaCppAgentModelRuntime, LLAMACPP_ENDPOINT, listLlamaCppModels } from '../llamacpp-client.js';
import { createOllamaAgentModelRuntime } from '../ollama-agent-runtime.js';
import { OPENROUTER_API_BASE, createOpenRouterAgentModelRuntime, openRouterKey, openRouterModelInfo } from '../openrouter-client.js';
import { issueLocalAgentExecutionPrincipal, revokeLocalAgentExecutionPrincipal, runLocalAgent, type LocalAgentMessage } from '../local-agent-runtime.js';
import { localChatCoreTools } from '../local-chat-tools.js';
import type { ToolContext } from '../mcp/kernel.js';
import { archivedTurns, ollamaConversation, ProviderCapabilityError, providerRoute } from './provider-history.js';
import { OLLAMA_CONVERSATION_PREFIX, OLLAMA_TURN_PREFIX, type ChatProvider, type StoredText } from '../../shared/session.js';
import { skillCatalogInstructions } from '../skills.js';
import { injectPinsContext } from '../pins-context.js';
import { expandLocalOpeningContext } from './prompt.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';
import { ensureEvealRunDirectory } from '../eveal-path.js';
import type { Root } from '../../shared/types.js';

const OWNER = 'ollama-local';
const MAX_REPLY_INLINE = 256_000;
const SYSTEM_PROMPT_BASE =
  'You are answering one turn of a conversation the user keeps in ParadigmEve. Earlier assistant ' +
  'messages may have been written by ChatGPT or by other models; treat them as this conversation\'s own history. ';

const evealRunRoots = new Map<string, Root>();

function chatToolContext(sessionId?: string): ToolContext {
  const config = getConfig();
  const evealRoot = sessionId ? evealRunRoots.get(sessionId) : null;
  return {
    roots: evealRoot ? [...config.roots, evealRoot] : config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    sessionTools: config.sessions.record,
    agentTools: config.multiAgent.enabled,
    exposedFinishTool: false
  };
}

async function chatSystemPrompt(direct: boolean, skillsAvailable: boolean): Promise<string> {
  const config = getConfig();
  const base = SYSTEM_PROMPT_BASE + (direct
    ? 'Use the available ParadigmEve tools whenever they are useful. Tool results are authoritative; never invent a result. Answer the newest user message when the requested work is complete.'
    : 'You do not have direct filesystem/computer tools. When the request needs tool execution, use delegate_worker and wait for its result. Do not pretend you performed delegated work yourself.');
  if (!skillsAvailable) return base;
  const catalog = await skillCatalogInstructions({ platform: process.platform, capabilities: effectiveCapabilities(config) }).catch(() => '');
  return catalog ? `${base}\n\n${catalog}` : base;
}

/** The Thread context each local chat's opening message activated, so later turns keep the same one. */
const openings = new Map<string, string>();

/**
 * What the opening message's `%Thread` / `#Quilt` references activate, as ChatGPT gets it in its
 * opening message. Local chats are rebuilt from the archive every turn and long ones are trimmed
 * from the oldest message, so the context rides in the system prompt instead of the first turn.
 */
async function openingContext(sessionId: string, entry: InputEntry, route: ReturnType<typeof providerRoute>, toolNames: readonly string[]): Promise<string> {
  const cached = openings.get(sessionId);
  if (cached !== undefined) return cached;
  const opening = (await archivedTurns(sessionId)).find((turn) => turn.role === 'user');
  if (!opening?.text.trim()) return '';
  const isOpening = opening.inputId === entry.id;
  let activated: string;
  try {
    activated = await injectPinsContext(opening.text, { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity },
      isOpening && entry.contextQuiltId ? { quiltId: entry.contextQuiltId } : {});
  } catch (error) {
    logWarn(`session ${sessionId}: opening Thread context unavailable: ${(error as Error).message}`);
    return '';
  }
  let expanded = activated === opening.text ? '' : await expandLocalOpeningContext(activated, {
    inline: true,
    fileTools: toolNames.includes('read'),
    nativePath: route === 'ollama-local' || route === 'llamacpp-local'
  });
  if (expanded.includes('# EVE-Al suite') && (route === 'ollama-local' || route === 'llamacpp-local')) {
    const session = await getSession(sessionId);
    const run = session ? await ensureEvealRunDirectory(sessionId, session.startedAt) : null;
    if (run) {
      evealRunRoots.set(sessionId, run.root);
      expanded += [
        '',
        '# This EVE-Al run output',
        `ParadigmEve already created this session's unique output folder: ${run.virtual}`,
        `Native path: ${run.native}`,
        'Use that exact folder for every run artifact. Do not ask the user to create, choose or confirm another output path.',
        'When EVEAL.md links to a relative suite path such as `tasks/pitfalls.md`, read it relative to `/paradigmeve-eveal`.'
      ].join('\n');
    }
  }
  const context = activated === opening.text ? '' : [
    '# Context ParadigmEve activated when this chat opened',
    'The opening message referenced a Thread or Quilt. ParadigmEve\'s context for it follows and ends with that opening message. Follow it for this chat; the newest user message stays authoritative.',
    expanded
  ].join('\n\n');
  // A chat started from a Thread in the app carries that Thread only on its first input; keep what it activated.
  if (isOpening || !entry.contextQuiltId) openings.set(sessionId, context);
  return context;
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
  const provider: ChatProvider = { id: entry.provider === 'openrouter' ? 'openrouter' : entry.provider === 'llamacpp' ? 'llamacpp' : 'ollama', model: entry.model };
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

const providerName = (provider: ChatProvider): string => provider.id === 'openrouter' ? 'OpenRouter' : provider.id === 'llamacpp' ? 'llama.cpp' : 'Ollama';

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
    } else if (provider.id === 'llamacpp') {
      const available = await listLlamaCppModels();
      if (!available.some((row) => row.id === provider.model)) {
        throw new ProviderCapabilityError('This model is not loaded in llama.cpp. Start llama-server with the GGUF, refresh the model picker, and select its advertised id.');
      }
      // Text-only until the local server proves an image-capable model/transport.
      vision = false;
    } else {
      await ensureOllamaModel(provider.model);
      const capabilities = await ollamaModelCapabilities(provider.model);
      vision = capabilities ? capabilities.includes('vision') : null;
    }
    const direct = provider.id === 'llamacpp' || settings.chatDirectTools !== false;
    const backend = provider.id === 'llamacpp' ? 'llamacpp' as const : 'ollama' as const;
    const principal = issueLocalAgentExecutionPrincipal({ backend, runId: `chat:${sessionId}`, agentId: turnId });
    const endpoint = provider.id === 'openrouter' ? OPENROUTER_API_BASE
      : provider.id === 'llamacpp' ? LLAMACPP_ENDPOINT : resolveOllamaEndpoint(settings.endpoint) ?? settings.endpoint;
    try {
      const tools = !toolsSupported ? [] : await localChatCoreTools({
        getContext: () => chatToolContext(sessionId),
        getRelativeReadRoot: () => evealRunRoots.has(sessionId) ? '/paradigmeve-eveal' : null,
        principal,
        sessionId,
        conversationId: (await getSession(sessionId))?.conversationId ?? null,
        route: providerRoute(provider, endpoint),
        mode: direct ? 'direct' : 'delegate'
      });
      const opening = await openingContext(sessionId, entry, providerRoute(provider, endpoint), tools.map((tool) => tool.name));
      const threads = [...opening.matchAll(/^# Eve Thread prompt · (.{1,60})$/gmu)].map((match) => match[1]).slice(0, 8);
      logInfo(`session ${sessionId}: ${providerName(provider)} opening context ${threads.length ? `activates ${threads.join(', ')}` : 'activates no Thread'} (${opening.length} chars, ${tools.length} tools)`);
      const system = await chatSystemPrompt(direct, toolsSupported);
      const messages = await ollamaConversation(sessionId, vision, opening ? `${system}\n\n${opening}` : system);
      const result = await runLocalAgent({
        backend,
        principal,
        endpoint,
        model: provider.model,
        system: '',
        task: '',
        initialMessages: messages as LocalAgentMessage[],
        tools,
        // The daemon on this computer gets its native API, the only one that takes a context window.
        runtime: provider.id === 'llamacpp' ? createLlamaCppAgentModelRuntime()
          : routerKey ? createOpenRouterAgentModelRuntime(routerKey)
          : createOllamaAgentModelRuntime(globalThis.fetch, { native: providerRoute(provider, endpoint) === 'ollama-local' }),
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
  openings.clear();
  evealRunRoots.clear();
  changed = () => undefined;
}
