import http from 'node:http';
import { Readable } from 'node:stream';

/**
 * `fetch` for a model server on plain HTTP (Ollama's daemon, llama.cpp's server), built on Node's
 * own HTTP client.
 *
 * The global fetch (undici) gives up when response headers take longer than 300 seconds, and
 * Ollama sends its headers only with the first generated token. A long prompt on a slow GPU spends
 * longer than that evaluating, so the turn died as "fetch failed" while Ollama logged a 500 at
 * exactly five minutes (a 27K-token EVE-Al prompt on Nanbeige, 2026-10-31). Node's HTTP client has
 * no such limit: the turn's own AbortSignal still ends a request the user stops.
 *
 * Anything other than plain HTTP with a string body goes to the global fetch unchanged.
 */
export const localModelFetch: typeof fetch = async (input, init = {}) => {
  if (input instanceof Request) return globalThis.fetch(input, init);
  const url = new URL(String(input));
  const body = init.body;
  if (url.protocol !== 'http:' || (body != null && typeof body !== 'string')) return globalThis.fetch(input, init);
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const method = (init.method ?? 'GET').toUpperCase();
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(url, { method, headers: Object.fromEntries(new Headers(init.headers)), signal }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && init.redirect === 'error') {
        response.resume();
        reject(new TypeError('fetch failed', { cause: new Error(`unexpected redirect (${status})`) }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of ([] as string[]).concat(value ?? [])) headers.append(name, item);
      }
      const empty = method === 'HEAD' || status === 204 || status === 304;
      if (empty) response.resume();
      try {
        resolve(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
          status, statusText: response.statusMessage ?? '', headers
        }));
      } catch (error) {
        response.destroy();
        reject(new TypeError('fetch failed', { cause: error }));
      }
    });
    request.on('error', (error) => reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: error })));
    request.end(body ?? undefined);
  });
};
