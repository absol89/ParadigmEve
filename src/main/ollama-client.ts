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

/** The public Ollama Cloud catalog. Listing it needs no key; using its models does. */
export const OLLAMA_CLOUD_CATALOG = 'https://ollama.com/api/tags';

export interface OllamaModelChoice {
  /** The exact id to send for this endpoint. */
  id: string;
  /** Runs on Ollama's servers (a cloud model), even when reached through the local app. */
  cloud: boolean;
  /** Already on this computer (a pulled model or cloud stub). False for a cloud catalog entry. */
  installed: boolean;
  /** The model declares image input. Unknown when absent. */
  vision?: boolean;
}

/** Ids this process has seen marked as cloud by the provider itself (`remote_host`, catalog). */
const knownCloud = new Set<string>();
/** Whether the provider marked this exact model id as a cloud model in a listing. */
export function knownCloudModel(id: string): boolean {
  return knownCloud.has(id);
}

/**
 * The local app's name for a cloud catalog model: `kimi-k3` → `kimi-k3:cloud`,
 * `mistral-large-3:675b` → `mistral-large-3:675b-cloud` (Ollama's own convention).
 */
export function localCloudName(catalogName: string): string {
  return catalogName.includes(':') ? `${catalogName}-cloud` : `${catalogName}:cloud`;
}

interface TagsModel { name?: unknown; remote_host?: unknown; remote_model?: unknown; capabilities?: unknown }

async function tags(url: string, endpoint: string, fetchImpl: typeof fetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TagsModel[]> {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: await ollamaHeaders(endpoint),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw httpError(response.status, await response.text().catch(() => ''));
  const payload = await boundedJson(response, MAX_LIST_BYTES * 4) as { models?: unknown };
  if (!Array.isArray(payload?.models)) throw new Error('OLLAMA_PROTOCOL_ERROR: model list had no models array');
  return payload.models as TagsModel[];
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

/**
 * Every model the user can pick, local and cloud.
 *
 * The local app's OpenAI-compatible `/v1/models` lists only pulled models, so cloud models the
 * user never pulled were invisible. Read the native `/api/tags` instead (it marks cloud stubs with
 * `remote_host` and declares capabilities) and add the public Ollama Cloud catalog under the local
 * app's cloud names; picking one pulls its tiny stub on first use. A direct HTTPS endpoint such as
 * ollama.com is all cloud. Falls back to `/v1/models` when `/api/tags` is unavailable.
 */
export async function listOllamaModels(fetchImpl: typeof fetch = globalThis.fetch): Promise<OllamaModelChoice[]> {
  const endpoint = requireEndpoint();
  const remote = endpoint.startsWith('https://');
  let installed: TagsModel[];
  try {
    installed = await tags(`${nativeBase(endpoint)}/api/tags`, endpoint, fetchImpl);
  } catch (error) {
    if ((error as Error).message.startsWith('OLLAMA_UNAUTHORIZED')) throw error;
    return (await listOpenAiModels(endpoint, fetchImpl)).map((id) => ({ id, cloud: remote || isCloudName(id), installed: true }));
  }
  const out: OllamaModelChoice[] = [];
  const seen = new Set<string>();
  const remoteModels = new Set<string>();
  for (const row of installed) {
    if (!validId(row.name) || seen.has(row.name)) continue;
    seen.add(row.name);
    const cloud = remote || typeof row.remote_host === 'string' || isCloudName(row.name);
    if (typeof row.remote_model === 'string') remoteModels.add(row.remote_model);
    const capabilities = Array.isArray(row.capabilities) ? row.capabilities : null;
    out.push({ id: row.name, cloud, installed: true, ...(capabilities ? { vision: capabilities.includes('vision') } : {}) });
  }
  if (!remote) {
    try {
      for (const row of await tags(OLLAMA_CLOUD_CATALOG, OLLAMA_CLOUD_CATALOG, fetchImpl, 10_000)) {
        if (!validId(row.name) || remoteModels.has(row.name)) continue;
        const id = localCloudName(row.name);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, cloud: true, installed: false });
      }
    } catch {
      // The catalog is a convenience: offline or blocked, the installed models still list.
    }
  }
  for (const choice of out) if (choice.cloud) knownCloud.add(choice.id);
  return out;
}

function isCloudName(id: string): boolean {
  return /(?:^|[:-])cloud$/i.test(id.trim());
}

async function listOpenAiModels(endpoint: string, fetchImpl: typeof fetch): Promise<string[]> {
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
    if (validId(id)) ids.add(id.trim());
  }
  return [...ids];
}

/**
 * Makes a cloud model usable through the local app: a model picked from the cloud catalog is
 * pulled once (only a small stub; the model runs on Ollama's servers). Local models and direct
 * HTTPS endpoints need nothing. Never pulls a local (on-device) model, which can be gigabytes.
 */
export async function ensureOllamaModel(model: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
  const endpoint = requireEndpoint();
  if (endpoint.startsWith('https://') || !(isCloudName(model) || knownCloud.has(model))) return;
  const present = await tags(`${nativeBase(endpoint)}/api/tags`, endpoint, fetchImpl).catch(() => null);
  // An unreadable list proves nothing either way: send the turn and let a real error speak.
  if (!present || present.some((row) => row.name === model)) return;
  const response = await fetchImpl(`${nativeBase(endpoint)}/api/pull`, {
    method: 'POST',
    redirect: 'error',
    headers: await ollamaHeaders(endpoint),
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw httpError(response.status, await response.text().catch(() => ''));
  await response.text().catch(() => '');
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
