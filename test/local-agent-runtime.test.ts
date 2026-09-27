import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentBackendExecutionStatus } from '../src/shared/agent-backends.js';
import {
  issueLocalAgentExecutionPrincipal,
  localAgentExecutionPrincipalIssued,
  localAgentRuntimePrerequisites,
  normalizeLocalAgentEndpoint,
  resetLocalAgentRuntimeForTests,
  revokeLocalAgentExecutionPrincipal,
  runLocalAgent,
  type LocalAgentModelRuntime,
  type LocalAgentTool
} from '../src/main/local-agent-runtime.js';
import { createOllamaAgentModelRuntime } from '../src/main/ollama-agent-runtime.js';

afterEach(() => resetLocalAgentRuntimeForTests());

const tool = (invoke: LocalAgentTool['invoke'] = async () => ({ content: 'ok' })): LocalAgentTool => ({
  name: 'read',
  description: 'Read one approved file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  invoke
});

describe('local agent execution principal', () => {
  it('is app-issued, backend-bound and revocable', () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'run-a', agentId: 'worker-1' });
    expect(localAgentExecutionPrincipalIssued(principal)).toBe(true);
    expect(localAgentExecutionPrincipalIssued({ ...principal, runId: 'run-b' })).toBe(false);
    expect(localAgentExecutionPrincipalIssued({ ...principal, agentId: 'worker-2' })).toBe(false);
    expect(localAgentRuntimePrerequisites({
      backend: 'custom', principal, endpoint: 'https://llm.example/v1', model: 'x', tools: [tool()]
    })).toMatchObject({ ready: false, reason: 'principal-backend-mismatch' });
    revokeLocalAgentExecutionPrincipal(principal);
    expect(localAgentExecutionPrincipalIssued(principal)).toBe(false);
  });

  it('fails closed on missing principal, endpoint, model or tool authority', () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'run-a', agentId: 'worker-1' });
    expect(localAgentRuntimePrerequisites({ backend: 'ollama', endpoint: 'http://localhost:11434/v1', model: 'qwen', tools: [tool()] }))
      .toMatchObject({ ready: false, reason: 'principal-not-issued' });
    expect(localAgentRuntimePrerequisites({ backend: 'ollama', principal, endpoint: '', model: 'qwen', tools: [tool()] }))
      .toMatchObject({ ready: false, reason: 'endpoint-missing' });
    expect(localAgentRuntimePrerequisites({ backend: 'ollama', principal, endpoint: 'http://localhost:11434/v1', model: '', tools: [tool()] }))
      .toMatchObject({ ready: false, reason: 'model-missing' });
    expect(localAgentRuntimePrerequisites({ backend: 'ollama', principal, endpoint: 'http://localhost:11434/v1', model: 'qwen', tools: [] }))
      .toMatchObject({ ready: false, reason: 'tools-unavailable' });
  });

  it('allows only loopback HTTP or HTTPS endpoint bases', () => {
    expect(normalizeLocalAgentEndpoint('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    expect(normalizeLocalAgentEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeLocalAgentEndpoint('https://gpu.example/v1')).toBe('https://gpu.example/v1');
    for (const bad of [
      '', 'not-a-url', 'http://gpu.example/v1', 'https://user:pass@gpu.example/v1',
      'https://gpu.example/v1?route=x', 'https://gpu.example/v1#frag'
    ]) expect(normalizeLocalAgentEndpoint(bad), bad).toBeNull();
  });
});

describe('local agent tool loop', () => {
  it('keeps the principal out of model input and uses it only for app-owned tool invocation', async () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'run-a', agentId: 'worker-1' });
    const invoke = vi.fn(async (_args: unknown, seen: unknown) => ({ content: seen === principal ? 'file text' : 'wrong principal' }));
    const complete = vi.fn<LocalAgentModelRuntime['complete']>()
      .mockResolvedValueOnce({ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', arguments: { path: '/project/a.ts' } }] })
      .mockResolvedValueOnce({ type: 'final', content: 'Implemented and verified.' });

    const result = await runLocalAgent({
      backend: 'ollama', principal, endpoint: 'http://localhost:11434/v1', model: 'deepseek-r1:8b',
      system: 'You are a bounded worker.', task: 'Inspect a.ts', tools: [tool(invoke)], runtime: { complete }
    });

    expect(result).toEqual({ final: 'Implemented and verified.', turns: 2, toolCalls: 1 });
    expect(invoke).toHaveBeenCalledWith({ path: '/project/a.ts' }, principal);
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('principal');
    expect(complete.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      role: 'tool', toolCallId: 'call-1', content: 'file text', isError: false
    });
  });

  it('never guesses an unknown tool and returns the refusal to the model', async () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'run-a', agentId: 'worker-1' });
    const invoke = vi.fn(async () => ({ content: 'should not run' }));
    const complete = vi.fn<LocalAgentModelRuntime['complete']>()
      .mockResolvedValueOnce({ type: 'tool_calls', calls: [{ id: 'call-x', name: 'shell_everything', arguments: {} }] })
      .mockResolvedValueOnce({ type: 'final', content: 'Blocked safely.' });
    await runLocalAgent({
      backend: 'ollama', principal, endpoint: 'http://localhost:11434/v1', model: 'qwen3',
      system: 'bounded', task: 'work', tools: [tool(invoke)], runtime: { complete }
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(complete.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({ role: 'tool', isError: true });
    expect((complete.mock.calls[1]?.[0].messages.at(-1) as { content?: string })?.content).toMatch(/UNKNOWN_TOOL/);
  });

  it('refuses to call the model at all when prerequisites are absent', async () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'run-a', agentId: 'worker-1' });
    const complete = vi.fn<LocalAgentModelRuntime['complete']>();
    await expect(runLocalAgent({
      backend: 'ollama', principal, endpoint: 'http://localhost:11434/v1', model: '', system: 'x', task: 'y',
      tools: [tool()], runtime: { complete }
    })).rejects.toThrow(/model-missing/);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('Ollama agent model transport', () => {
  it('sends a dedicated tool-capable request without Goal/OpenRouter vendor fields', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return Response.json({ choices: [{ message: { content: '', tool_calls: [{
        id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"/a"}' }
      }] } }] });
    });
    const runtime = createOllamaAgentModelRuntime(fetch as typeof globalThis.fetch);
    const result = await runtime.complete({
      endpoint: 'http://localhost:11434/v1', model: 'qwen3',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }]
    });
    expect(result).toEqual({ type: 'tool_calls', content: '', calls: [{ id: 't1', name: 'read', arguments: { path: '/a' } }] });
    expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(String(requests[0]?.init.body));
    expect(body).toMatchObject({ model: 'qwen3', stream: false });
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'read' } });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('plugins');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('parses final text and fails closed on malformed tool arguments', async () => {
    const finalRuntime = createOllamaAgentModelRuntime((async () =>
      Response.json({ choices: [{ message: { content: 'done' } }] })) as typeof globalThis.fetch);
    await expect(finalRuntime.complete({ endpoint: 'http://localhost:11434/v1', model: 'qwen3', messages: [], tools: [] }))
      .resolves.toEqual({ type: 'final', content: 'done' });

    const badRuntime = createOllamaAgentModelRuntime((async () =>
      Response.json({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'read', arguments: '{' } }] } }] })) as typeof globalThis.fetch);
    await expect(badRuntime.complete({ endpoint: 'http://localhost:11434/v1', model: 'qwen3', messages: [], tools: [] }))
      .rejects.toThrow(/tool arguments were invalid JSON/);
  });

  it('does not promote transport reachability to agent backend readiness', () => {
    expect(agentBackendExecutionStatus('ollama', 'debug')).toMatchObject({
      support: 'unsupported', readiness: 'unavailable', reason: 'ollama-agent-runtime-unavailable'
    });
  });
});
