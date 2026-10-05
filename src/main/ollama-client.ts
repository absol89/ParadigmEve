/**
 * One Ollama provider client shared by chat and workers.
 *
 * The local daemon is the default transport: `http://127.0.0.1:11434/v1` already serves cloud
 * models (`<model>:cloud`) once the user ran `ollama signin`, so no key is needed there. Direct
 * Ollama Cloud (`https://ollama.com/v1`) is the optional second transport and uses the API key
 * from secure storage. The key is sent only over HTTPS and never crosses into the renderer.
 *
 * Model ids are passed through untouched. Nothing here knows model families, so a newly
 * published Ollama model works without an app update.
 */

import { getConfig } from './config.js';
import { getSecret } from './secrets.js';
import { normalizeLocalAgentEndpoint } from './local-agent-runtime.js';
import { OLLAMA_LOCAL_ENDPOINT } from '../shared/agent-backends.js';

const MAX_LIST_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

/** The configured endpoint, or the local daemon when the setting is blank. Null when invalid. */
export function resolveOllamaEndpoint(raw: string = getConfig().agentRuntime.ollama.endpoint): string | null {
  return normalizeLocalAgentEndpoint(raw.trim() || OLLAMA_LOCAL_ENDPOINT);
}

/** Ollama's native API lives beside the OpenAI-compatible `/v1` prefix. */
function nativeBase(endpoint: string): string {
  return endpoint.replace(/\/v1$/, '');
}

export async function ollamaHeaders(endpoint: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.startsWith('https://')) {
    const key = (await getSecret('ollamaApiKey'))?.trim();
    if (key) headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function requireEndpoint(endpoint = resolveOllamaEndpoint()): string {
  if (!endpoint) {
    throw new Error('OLLAMA_ENDPOINT_INVALID: the Ollama endpoint must be HTTPS, or HTTP on loopback.');
  }
  return endpoint;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
  const text = await response.text();
  if (text.length > limit) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
  return text ? JSON.parse(text) : null;
}

function httpError(status: number, body: string): Error {
  const detail = body.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  if (status === 401 || status === 403) {
    return new Error(`OLLAMA_UNAUTHORIZED: ${status}. Sign the local daemon in with \`ollama signin\`, or store an Ollama API key for https://ollama.com.`);
  }
  return new Error(`OLLAMA_HTTP_ERROR: ${status}${detail ? `: ${detail}` : ''}`);
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface OllamaModelChoice {
  id: string;
}

/** The provider's live model list. Exact ids, newest-first order as the provider returns it. */
export async function listOllamaModels(fetchImpl: typeof fetch = globalThis.fetch): Promise<OllamaModelChoice[]> {
  const endpoint = requireEndpoint();
  const response = await fetchImpl(`${endpoint}/models`, {
    method: 'GET',
    redirect: 'error',
    headers: await ollamaHeaders(endpoint),
    signal: timeoutSignal()
  });
  if (!response.ok) throw httpError(response.status, await response.text().catch(() => ''));
  const payload = await boundedJson(response, MAX_LIST_BYTES) as { data?: unknown };
  if (!Array.isArray(payload?.data)) throw new Error('OLLAMA_PROTOCOL_ERROR: model list had no data array');
  const ids = new Set<string>();
  for (const row of payload.data) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id === 'string' && id.trim() && id.length <= 160) ids.add(id.trim());
  }
  return [...ids].map((id) => ({ id }));
}

/**
 * What the provider says this exact model can do (`vision`, `tools`, ...), or null when the
 * provider does not answer. Null means unknown, not "no capabilities".
 */
export async function ollamaModelCapabilities(
  model: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string[] | null> {
  const endpoint = requireEndpoint();
  try {
    const response = await fetchImpl(`${nativeBase(endpoint)}/api/show`, {
      method: 'POST',
      redirect: 'error',
      headers: await ollamaHeaders(endpoint),
      body: JSON.stringify({ model }),
      signal: timeoutSignal()
    });
    if (!response.ok) return null;
    const payload = await boundedJson(response, MAX_LIST_BYTES * 4) as { capabilities?: unknown };
    return Array.isArray(payload?.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === 'string')
      : null;
  } catch {
    return null;
  }
}

/** OpenAI-compatible chat content: plain text, or text and image parts for vision models. */
export type OllamaChatContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: OllamaChatContent;
}

/**
 * Streams one chat completion. `onText` receives the whole reply so far after each delta.
 * Resolves with the final text; rejects on HTTP/protocol errors or abort.
 */
export async function streamOllamaChat(input: {
  model: string;
  messages: readonly OllamaChatMessage[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const endpoint = requireEndpoint();
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${endpoint}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: await ollamaHeaders(endpoint),
    body: JSON.stringify({ model: input.model, stream: true, messages: input.messages }),
    signal: input.signal
  });
  if (!response.ok) throw httpError(response.status, await response.text().catch(() => ''));
  if (!response.body) throw new Error('OLLAMA_PROTOCOL_ERROR: response had no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let bytes = 0;
  let reply = '';
  const consume = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;
    let chunk: { choices?: Array<{ delta?: { content?: unknown } }>; error?: { message?: unknown } };
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error('OLLAMA_PROTOCOL_ERROR: stream chunk was not JSON');
    }
    if (chunk.error) {
      throw new Error(`OLLAMA_STREAM_ERROR: ${typeof chunk.error.message === 'string' ? chunk.error.message.slice(0, 240) : 'unknown error'}`);
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      reply += delta;
      input.onText?.(reply);
    }
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (consume(line)) return reply;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) consume(buffered);
    return reply;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
