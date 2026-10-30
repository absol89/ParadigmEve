/**
 * Separate, loopback-only llama.cpp server. It does not change Ollama settings, credentials,
 * model catalogue or worker selection. The server owns model loading and sampling parameters;
 * Eve selects the exact model id advertised by its OpenAI-compatible /v1/models endpoint.
 */
import { createOllamaAgentModelRuntime } from './ollama-agent-runtime.js';
import type { LocalAgentModelRuntime } from './local-agent-runtime.js';

export const LLAMACPP_ENDPOINT = 'http://127.0.0.1:8080/v1';
const MAX_MODELS_BYTES = 256_000;

export function llamaCppHeaders(): Promise<Record<string, string>> {
  return Promise.resolve({ 'content-type': 'application/json' });
}

export async function listLlamaCppModels(fetchImpl: typeof fetch = globalThis.fetch): Promise<Array<{ id: string }>> {
  let response: Response;
  try {
    response = await fetchImpl(`${LLAMACPP_ENDPOINT}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(4_000)
    });
  } catch {
    throw new Error('llama.cpp is not running on 127.0.0.1:8080. Start llama-server with --host 127.0.0.1 --port 8080.');
  }
  if (!response.ok) throw new Error(`llama.cpp model discovery failed (HTTP ${response.status})`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_MODELS_BYTES) throw new Error('llama.cpp model list is too large');
  const body = await response.text();
  if (body.length > MAX_MODELS_BYTES) throw new Error('llama.cpp model list is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('llama.cpp returned an invalid model list'); }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('llama.cpp did not return an OpenAI-compatible model list');
  const ids = data.flatMap((row: unknown) => {
    const id = (row as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.trim() && id.length <= 160 ? [{ id }] : [];
  });
  return [...new Map(ids.map((row) => [row.id, row])).values()];
}

/** Use the existing audited tool-loop parser, without Ollama native APIs or Ollama credentials. */
export function createLlamaCppAgentModelRuntime(fetchImpl: typeof fetch = globalThis.fetch): LocalAgentModelRuntime {
  const transport = createOllamaAgentModelRuntime(fetchImpl, {
    label: 'LLAMACPP',
    headers: llamaCppHeaders
  });
  return {
    async complete(request) {
      // Unlike Ollama's native /api/chat, the OpenAI-compatible API cannot grow the server's
      // context at request time. Fail clearly instead of silently sliding away early history,
      // activated Threads or the tool schemas. The tinkerer changes --ctx-size on the server.
      const response = await fetchImpl('http://127.0.0.1:8080/props', {
        redirect: 'error', signal: request.signal
      });
      if (!response.ok) throw new Error('LLAMACPP_CONTEXT_UNAVAILABLE: cannot confirm server context size');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_MODELS_BYTES) throw new Error('LLAMACPP_CONTEXT_UNAVAILABLE: oversized server props');
      const raw = await response.text();
      if (raw.length > MAX_MODELS_BYTES) throw new Error('LLAMACPP_CONTEXT_UNAVAILABLE: oversized server props');
      let props: { default_generation_settings?: { n_ctx?: unknown } } | null;
      try { props = JSON.parse(raw); } catch { throw new Error('LLAMACPP_CONTEXT_UNAVAILABLE: invalid server props'); }
      const context = props?.default_generation_settings?.n_ctx;
      if (typeof context !== 'number' || !Number.isInteger(context) || context < 256) {
        throw new Error('LLAMACPP_CONTEXT_UNAVAILABLE: server did not report its context size');
      }
      const estimated = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 3) + 1024;
      if (estimated > context) {
        throw new Error('LLAMACPP_CONTEXT_TOO_SMALL: this chat and its tools may exceed the server context (' +
          estimated + ' estimated tokens vs ' + context + '). Increase -Context in the llama.cpp launcher or use a shorter chat.');
      }
      return transport.complete(request);
    }
  };
}
