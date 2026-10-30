/**
 * Ollama worker model transport.
 *
 * This is intentionally separate from Goal/Loop's custom provider. They may point at the same
 * HTTP server, but a successful inference request there is only one prerequisite for this
 * agent runtime; it does not make the Ollama backend executable or ready by itself.
 */

import type {
  LocalAgentCompletion,
  LocalAgentExecutionPrincipal,
  LocalAgentMessage,
  LocalAgentModelRequest,
  LocalAgentModelRuntime,
  LocalAgentRuntimePrerequisites,
  LocalAgentTool,
  LocalAgentToolCall
} from './local-agent-runtime.js';
import { localAgentRuntimePrerequisites } from './local-agent-runtime.js';
import type { AgentRuntimeSettings } from '../shared/agent-backends.js';
import { ollamaHeaders } from './ollama-client.js';
import { logInfo, logWarn } from './logger.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Execution readiness from app-owned prerequisites only. Deliberately performs no network
 * probe: `/models` or `/chat/completions` reachability cannot prove broker/tool-loop readiness.
 */
export function ollamaAgentRuntimePrerequisites(input: {
  settings: AgentRuntimeSettings['ollama'];
  principal?: LocalAgentExecutionPrincipal | null;
  tools?: readonly LocalAgentTool[] | null;
}): LocalAgentRuntimePrerequisites {
  return localAgentRuntimePrerequisites({
    backend: 'ollama',
    principal: input.principal,
    endpoint: input.settings.endpoint,
    model: input.settings.model,
    tools: input.tools
  });
}

function openAiMessage(message: LocalAgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      }))
    };
  }
  return { role: message.role, content: message.content };
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseArguments(raw: unknown): unknown {
  // Ollama's native API sends arguments as an object; the OpenAI-compatible one as JSON text.
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new Error('OLLAMA_PROTOCOL_ERROR: tool arguments were not JSON text');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('OLLAMA_PROTOCOL_ERROR: tool arguments were invalid JSON');
  }
}

/** Ollama's native message shape: text content, base64 images beside it, object tool arguments. */
function nativeMessage(message: LocalAgentMessage): Record<string, unknown> {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_name: message.name };
  const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
  const content = parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n');
  const images = parts.flatMap((part) => part.type === 'image_url' ? [part.image_url.url.replace(/^data:[^,]*;base64,/, '')] : []);
  return {
    role: message.role,
    content,
    ...(images.length ? { images } : {}),
    ...(message.role === 'assistant' && message.toolCalls?.length
      ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments ?? {} } })) }
      : {})
  };
}

/** Context windows Ollama is asked for. Few, so a growing chat reloads the model rarely. */
const NATIVE_CONTEXT_STEPS = [8_192, 16_384, 32_768, 65_536, 131_072];
/** Room left for the reply on top of the prompt. */
const NATIVE_REPLY_TOKENS = 4_096;
/** Largest window per model this process asked for: never shrink it, or Ollama reloads the model. */
const nativeContextByModel = new Map<string, number>();
const nativeMaxContextByModel = new Map<string, Promise<number | null>>();

async function modelMaxContext(fetchImpl: typeof fetch, base: string, model: string, headers: Record<string, string>): Promise<number | null> {
  const key = `${base}\n${model}`;
  let found = nativeMaxContextByModel.get(key);
  if (!found) {
    found = fetchImpl(`${base}/api/show`, { method: 'POST', redirect: 'error', headers, body: JSON.stringify({ model }) })
      .then(async (response) => {
        if (!response.ok) return null;
        const info = (JSON.parse(await boundedText(response)) as { model_info?: Record<string, unknown> }).model_info ?? {};
        const length = Object.entries(info).find(([name, value]) => name.endsWith('.context_length') && typeof value === 'number')?.[1];
        return typeof length === 'number' && length > 0 ? length : null;
      })
      .catch(() => null);
    nativeMaxContextByModel.set(key, found);
  }
  return found;
}

/**
 * The window to ask for. Ollama's default is often 4k tokens per request, and its OpenAI-compatible
 * endpoint can neither be told otherwise nor reports the cut: it silently keeps only the tail of a
 * longer prompt, which drops the system prompt, any activated Thread and most tool schemas.
 * Tokens are estimated at three characters each, which overestimates for English and JSON.
 */
async function nativeContext(fetchImpl: typeof fetch, base: string, model: string, headers: Record<string, string>, body: string): Promise<number> {
  const wanted = Math.ceil(body.length / 3) + NATIVE_REPLY_TOKENS;
  const max = await modelMaxContext(fetchImpl, base, model, headers);
  const step = NATIVE_CONTEXT_STEPS.find((size) => size >= wanted) ?? NATIVE_CONTEXT_STEPS.at(-1)!;
  const chosen = Math.max(nativeContextByModel.get(model) ?? 0, max ? Math.min(step, max) : step);
  nativeContextByModel.set(model, chosen);
  return chosen;
}

/** Test seam only. */
export function resetOllamaNativeContextForTests(): void {
  nativeContextByModel.clear();
  nativeMaxContextByModel.clear();
}

async function parsedResponse(response: Response, label: string): Promise<unknown> {
  const raw = await boundedText(response);
  if (!response.ok) {
    const detail = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
    throw new Error(`${label}_HTTP_ERROR: ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error('OLLAMA_PROTOCOL_ERROR: response was not valid JSON');
  }
}

function completionFrom(payload: unknown): LocalAgentCompletion {
  if (!payload || typeof payload !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: response was not an object');
  // OpenAI-compatible routers (OpenRouter) can report a provider failure inside a 200 response.
  const failure = (payload as { error?: { message?: unknown; code?: unknown } }).error;
  if (failure && typeof failure === 'object') {
    const message = typeof failure.message === 'string' ? failure.message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) : 'provider error';
    throw new Error(`PROVIDER_ERROR${failure.code !== undefined ? ` ${String(failure.code).slice(0, 20)}` : ''}: ${message}`);
  }
  // Ollama's native API answers with one message; OpenAI-compatible APIs with choices.
  const native = (payload as { message?: unknown }).message;
  const choices = (payload as { choices?: unknown }).choices;
  if (native === undefined && (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object')) {
    throw new Error('OLLAMA_PROTOCOL_ERROR: response had no completion choice');
  }
  const message = native ?? (choices as Array<{ message?: unknown }>)[0]!.message;
  if (!message || typeof message !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: response had no assistant message');
  const row = message as { content?: unknown; tool_calls?: unknown };
  if (Array.isArray(row.tool_calls) && row.tool_calls.length) {
    const calls: LocalAgentToolCall[] = row.tool_calls.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: malformed tool call');
      const tool = entry as { id?: unknown; function?: unknown };
      const fn = tool.function;
      if (!fn || typeof fn !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: malformed tool function');
      const named = fn as { name?: unknown; arguments?: unknown };
      if (typeof named.name !== 'string' || !named.name) throw new Error('OLLAMA_PROTOCOL_ERROR: tool name missing');
      return {
        id: typeof tool.id === 'string' && tool.id ? tool.id : `ollama-call-${index + 1}`,
        name: named.name,
        arguments: parseArguments(named.arguments)
      };
    });
    return { type: 'tool_calls', content: typeof row.content === 'string' ? row.content : '', calls };
  }
  if (typeof row.content !== 'string') throw new Error('OLLAMA_PROTOCOL_ERROR: assistant content missing');
  return { type: 'final', content: row.content };
}

/**
 * OpenAI-compatible chat transport used by the dedicated Ollama worker runtime, and by Ollama and
 * OpenRouter chats with their own headers. No Goal vendor fields are sent. Tool authority remains
 * in runLocalAgent().
 */
export function createOllamaAgentModelRuntime(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: {
    headers?: (endpoint: string) => Promise<Record<string, string>>;
    label?: string;
    /**
     * Talk to the Ollama daemon on this computer through its native `/api/chat`, with a context
     * window sized to the request. The endpoint stays the daemon's OpenAI-compatible `…/v1`.
     */
    native?: boolean;
  } = {}
): LocalAgentModelRuntime {
  const headersFor = options.headers ?? ollamaHeaders;
  const label = options.label ?? 'OLLAMA';
  return {
    async complete(request: LocalAgentModelRequest): Promise<LocalAgentCompletion> {
      const trimmed = request.endpoint.replace(/\/+$/, '');
      if (options.native && trimmed.endsWith('/v1')) {
        const base = trimmed.slice(0, -'/v1'.length);
        const headers = await headersFor(request.endpoint);
        const unsized = {
          model: request.model,
          stream: false,
          messages: request.messages.map(nativeMessage),
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
            }))
          } : {})
        };
        const numCtx = await nativeContext(fetchImpl, base, request.model, headers, JSON.stringify(unsized));
        const payload = await parsedResponse(await fetchImpl(`${base}/api/chat`, {
          method: 'POST',
          redirect: 'error',
          headers,
          body: JSON.stringify({ ...unsized, options: { num_ctx: numCtx } }),
          signal: request.signal
        }), label);
        const promptTokens = (payload as { prompt_eval_count?: unknown } | null)?.prompt_eval_count;
        if (typeof promptTokens === 'number') {
          const line = `ollama ${request.model}: prompt ${promptTokens} of num_ctx ${numCtx} tokens`;
          // Ollama reports the prompt it evaluated, so a cut shows as a count at the window's edge.
          if (promptTokens >= numCtx - 16) logWarn(`${line}; Ollama may have cut the oldest part of the prompt`);
          else logInfo(line);
        }
        return completionFrom(payload);
      }
      const response = await fetchImpl(`${request.endpoint}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: await headersFor(request.endpoint),
        body: JSON.stringify({
          model: request.model,
          stream: false,
          messages: request.messages.map(openAiMessage),
          // A model without tool support is asked plainly; an empty tools array can make a router refuse it.
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
            }))
          } : {})
        }),
        signal: request.signal
      });
      const raw = await boundedText(response);
      if (!response.ok) {
        const detail = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
        throw new Error(`${label}_HTTP_ERROR: ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error('OLLAMA_PROTOCOL_ERROR: response was not valid JSON');
      }
      return completionFrom(payload);
    }
  };
}
