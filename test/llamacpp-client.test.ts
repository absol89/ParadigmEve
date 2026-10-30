import { expect, it, vi } from 'vitest';
import { createLlamaCppAgentModelRuntime, listLlamaCppModels, llamaCppHeaders, LLAMACPP_ENDPOINT } from '../src/main/llamacpp-client.js';

const request = {
  endpoint: LLAMACPP_ENDPOINT,
  model: 'lfm3-q4',
  messages: [{ role: 'user' as const, content: 'Hi' }],
  tools: []
};

it('discovers only the live llama.cpp model ids without using the Ollama catalogue', async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (resource) => {
    seen.push(String(resource));
    return Response.json({ data: [{ id: 'lfm3-q4' }, { id: 'lfm3-q4' }, { id: '' }, { id: 19 }] });
  };
  expect(await listLlamaCppModels(fetcher)).toEqual([{ id: 'lfm3-q4' }]);
  expect(seen).toEqual(['http://127.0.0.1:8080/v1/models']);
  expect(await llamaCppHeaders()).toEqual({ 'content-type': 'application/json' });
});

it('refuses a context too small for the entire chat and tools before any inference', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (resource) => {
    urls.push(String(resource));
    return Response.json({ default_generation_settings: { n_ctx: 256 } });
  };
  const runtime = createLlamaCppAgentModelRuntime(fetcher);
  await expect(runtime.complete({ ...request, messages: [{ role: 'user', content: 'x'.repeat(2400) }] }))
    .rejects.toThrow(/LLAMACPP_CONTEXT_TOO_SMALL/);
  expect(urls).toEqual(['http://127.0.0.1:8080/props']);
});

it('uses only the configured loopback OpenAI endpoint and no Ollama key or native API', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = vi.fn(async (resource, init) => {
    const url = String(resource);
    seen.push({ url, init });
    if (url.endsWith('/props')) return Response.json({ default_generation_settings: { n_ctx: 8192 } });
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const runtime = createLlamaCppAgentModelRuntime(fetcher);
  expect(await runtime.complete(request)).toEqual({ type: 'final', content: 'OK' });
  expect(seen.map(row => row.url)).toEqual([
    'http://127.0.0.1:8080/props', 'http://127.0.0.1:8080/v1/chat/completions'
  ]);
  expect((seen[1]!.init?.headers as Record<string, string>).authorization).toBeUndefined();
  expect(JSON.parse(String(seen[1]!.init?.body)).model).toBe('lfm3-q4');
});
