import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { localModelFetch } from '../src/main/local-model-fetch.js';

// A stand-in for Ollama's daemon: NDJSON that arrives in pieces, an endpoint that never answers,
// and a redirect.
let base = '';
const server = http.createServer((req, res) => {
  if (req.url === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-echo': JSON.parse(body).model });
      res.write('{"message":{"content":"Hel"},"done":false}\n');
      setTimeout(() => res.end('{"message":{"content":"lo"},"done":true}\n'), 20);
    });
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/api/chat' }).end();
  } else if (req.url === '/empty') {
    res.writeHead(204).end();
  } else if (req.url !== '/hang') {
    res.writeHead(404).end('missing');
  }
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

it('posts a string body and streams the reply like fetch', async () => {
  const response = await localModelFetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nanbeige' })
  });
  expect(response.ok).toBe(true);
  expect(response.headers.get('x-echo')).toBe('nanbeige');
  expect((await response.text()).trim().split('\n').map((line) => JSON.parse(line).message.content).join('')).toBe('Hello');
});

it('reports status codes and empty bodies like fetch', async () => {
  const missing = await localModelFetch(`${base}/nothing`);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe('missing');
  const empty = await localModelFetch(`${base}/empty`);
  expect(empty.status).toBe(204);
  expect(empty.body).toBeNull();
});

it('refuses a redirect when the caller asks for redirect: error', async () => {
  await expect(localModelFetch(`${base}/redirect`, { redirect: 'error' })).rejects.toThrow('fetch failed');
});

it('ends a request that never answers when the turn is stopped', async () => {
  const controller = new AbortController();
  const pending = localModelFetch(`${base}/hang`, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('stopped by the user')), 30);
  await expect(pending).rejects.toThrow('stopped by the user');
  await expect(localModelFetch(`${base}/hang`, { signal: AbortSignal.abort(new Error('already stopped')) })).rejects.toThrow('already stopped');
});

it('leaves https and non-string bodies to the global fetch', async () => {
  const stub = vi.fn(async () => new Response('remote'));
  vi.stubGlobal('fetch', stub);
  try {
    await localModelFetch('https://openrouter.example/api/v1/chat/completions', { method: 'POST', body: '{}' });
    await localModelFetch(`${base}/api/chat`, { method: 'POST', body: new Uint8Array([1]) });
    expect(stub).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
