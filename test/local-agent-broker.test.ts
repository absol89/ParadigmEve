import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig } = await import('../src/main/config.js');
const {
  activateWorkerExecutionPrincipal,
  agentForCaller,
  finishAgent,
  issueWorkerExecutionPrincipal,
  resetAgentsForTests,
  restoreSwarm,
  snapshotSwarm,
  spawn
} = await import('../src/main/agents.js');
const { localAgentExecutionPrincipalIssued } = await import('../src/main/local-agent-runtime.js');
const { localAgentCoreTools, resetLocalAgentToolAdapterForTests } = await import('../src/main/local-agent-tools.js');
const { lastToolCallAt, onMcpToolCallSeen, resetToolClock } = await import('../src/main/mcp/kernel.js');
const { ollamaAgentRuntimePrerequisites } = await import('../src/main/ollama-agent-runtime.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { initSessionStore, listSessions, readEvents, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { flushRecorder, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetWorkspaces, setWorkspaceFor } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir = '';

beforeAll(async () => {
  dir = await makeTempDir('eve-local-agent-broker-');
  initConfigPath(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  resetAgentsForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetWorkspaces();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetAgentsForTests();
  resetRecorderForTests();
  resetLocalAgentToolAdapterForTests();
  resetToolClock();
  resetWorkspaces();
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: true },
    multiAgent: { ...base.multiAgent, enabled: true }
  });
});

afterEach(async () => {
  await flushRecorder();
});

function restoreAsOllamaWorker(): { runId: string } {
  const started = spawn({ caller: { conversationId: 'prime-local' }, workers: [{ task: 'local work' }] });
  const snapshot = structuredClone(snapshotSwarm()!);
  const savedRun = snapshot.activeRuns?.find((run) => run.runId === started.runId);
  const worker = savedRun?.agents.find((row) => row.info.id === 'worker-1');
  if (!worker) throw new Error('worker snapshot missing');
  worker.backend = 'ollama';
  resetAgentsForTests();
  restoreSwarm(snapshot);
  return { runId: started.runId };
}

describe('broker-owned local worker principal', () => {
  it('issues only for the exact local worker, activates it, and rotates stale process authority', () => {
    const { runId } = restoreAsOllamaWorker();
    const first = issueWorkerExecutionPrincipal(runId, 'worker-1');
    expect(first).toMatchObject({ kind: 'local-agent', backend: 'ollama', runId, agentId: 'worker-1' });
    expect(issueWorkerExecutionPrincipal(runId, 'worker-9')).toBeNull();
    expect(agentForCaller({ localPrincipal: first })).toBeNull();
    expect(activateWorkerExecutionPrincipal(first!)).toBe(true);
    expect(agentForCaller({ localPrincipal: first })).toBe('worker-1');

    const second = issueWorkerExecutionPrincipal(runId, 'worker-1')!;
    expect(second.runtimeId).not.toBe(first!.runtimeId);
    expect(agentForCaller({ localPrincipal: first })).toBeNull();
    expect(agentForCaller({ localPrincipal: second })).toBe('worker-1');
    expect(agentForCaller({ localPrincipal: { ...second, runId: 'other-run' } })).toBeNull();

    expect(finishAgent({ localPrincipal: second }, 'done').info.state).toBe('sleeping');
    expect(localAgentExecutionPrincipalIssued(second)).toBe(false);
    expect(agentForCaller({ localPrincipal: second })).toBeNull();
  });
});

describe('authorized local Core adapter', () => {
  it('does not publish connector first-tool evidence for a valid local worker call', async () => {
    const { runId } = restoreAsOllamaWorker();
    const principal = issueWorkerExecutionPrincipal(runId, 'worker-1')!;
    expect(activateWorkerExecutionPrincipal(principal)).toBe(true);

    const approved = path.join(dir, 'local-core-evidence');
    await fs.mkdir(approved, { recursive: true });
    await fs.writeFile(path.join(approved, 'note.txt'), 'LOCAL ONLY\n', 'utf8');
    setWorkspaceFor(`agent:${runId}:worker-1`, { virtual: '/workspace', real: approved });
    const ctx = {
      roots: [{ name: 'workspace', path: approved }],
      caps: { ...DEFAULT_CAPABILITIES, read: true, search: true, command: false },
      readOnly: false,
      sessionTools: false,
      agentTools: false,
      exposedFinishTool: false
    };
    const read = localAgentCoreTools(() => ctx, principal).find((row) => row.name === 'read');
    expect(read).toBeDefined();

    const seen = vi.fn();
    const off = onMcpToolCallSeen(seen);
    try {
      const result = await read!.invoke({ paths: ['note.txt'] }, principal);
      expect(result).toMatchObject({ isError: false });
      expect(lastToolCallAt()).toBeNull();
      expect(lastToolCallAt('core')).toBeNull();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('reuses live Core permissions, run-scoped workspace resolution and normal recording', async () => {
    const { runId } = restoreAsOllamaWorker();
    const principal = issueWorkerExecutionPrincipal(runId, 'worker-1')!;
    expect(activateWorkerExecutionPrincipal(principal)).toBe(true);

    const approved = path.join(dir, 'local-core');
    await fs.mkdir(approved, { recursive: true });
    await fs.writeFile(path.join(approved, 'note.txt'), 'LOCAL CORE OK\n', 'utf8');
    setWorkspaceFor(`agent:${runId}:worker-1`, { virtual: '/workspace', real: approved });

    const ctx = {
      roots: [{ name: 'workspace', path: approved }],
      caps: { ...DEFAULT_CAPABILITIES, read: true, search: true, command: false },
      readOnly: false,
      sessionTools: false,
      agentTools: false,
      exposedFinishTool: false
    };
    const tools = localAgentCoreTools(() => ctx, principal);
    const read = tools.find((row) => row.name === 'read');
    expect(read).toBeDefined();
    expect(tools.some((row) => row.name === 'exec_command')).toBe(false);

    const result = await read!.invoke({ paths: ['note.txt'] }, principal);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('LOCAL CORE OK');
    await flushRecorder();

    const session = (await listSessions()).find((row) => row.title === 'worker-1 · Ollama');
    expect(session).toBeDefined();
    const event = (await readEvents(session!.id, { kinds: ['tool_call'] }))[0];
    expect(event).toMatchObject({ kind: 'tool_call', agent: 'worker-1' });
    if (!event || event.kind !== 'tool_call') throw new Error('local tool call was not recorded');
    expect(event.call).toMatchObject({ tool: 'read', attribution: 'agent', conversationId: null });

    ctx.caps.read = false;
    ctx.caps.browse = false;
    ctx.caps.metadata = false;
    const denied = await read!.invoke({ paths: ['note.txt'] }, principal);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('TOOL_DISABLED');
  });
});

describe('durable Ollama worker settings and readiness fence', () => {
  it('migrates empty settings, round-trips explicit endpoint/model, and never uses reachability as readiness', async () => {
    const configPath = path.join(dir, 'config.json');
    const current = getConfig();
    const legacy = { ...current } as Record<string, unknown>;
    delete legacy.agentRuntime;
    await fs.writeFile(configPath, JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).agentRuntime.ollama).toEqual({ endpoint: '', model: '' });

    const configured = getConfig();
    await saveConfig({
      ...configured,
      agentRuntime: { ollama: { endpoint: 'http://localhost:11434/v1', model: 'qwen3:8b' } }
    });
    expect((await loadConfig()).agentRuntime.ollama).toEqual({
      endpoint: 'http://localhost:11434/v1', model: 'qwen3:8b'
    });
    expect(ollamaAgentRuntimePrerequisites({
      settings: getConfig().agentRuntime.ollama,
      principal: null,
      tools: []
    })).toMatchObject({ ready: false, reason: 'principal-not-issued' });
  });
});
