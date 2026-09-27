import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ports = vi.hoisted(() => ({
  sessions: [] as any[],
  events: new Map<string, any[]>(),
  superseded: vi.fn(async (_conversationId?: string) => false),
  blocked: vi.fn((_conversationId?: string | null) => false),
  enqueue: vi.fn(async (input: any) => ({ ...input, state: 'queued', owner: null, createdAt: 1, conversationId: 'bound' })),
  markRecovery: vi.fn(async (id: string, recoveryTurnId: string) => ({
    id, recoveryTurnId, state: 'queued', owner: null, createdAt: 1, conversationId: 'bound'
  })),
  info: vi.fn(),
  warn: vi.fn()
}));

vi.mock('../src/main/session/store.js', () => ({
  indexedSessions: async () => ports.sessions,
  conversationWasSuperseded: ports.superseded,
  readRecentEvents: async (id: string, limit: number, options: { kinds?: string[]; before?: number } = {}) => {
    const matching = (ports.events.get(id) ?? [])
      .filter((event) => options.before === undefined || event.seq < options.before)
      .filter((event) => !options.kinds || options.kinds.includes(event.kind))
      .sort((left, right) => left.seq - right.seq);
    return matching.slice(Math.max(0, matching.length - limit));
  }
}));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: ports.enqueue, markRestartRecoveryInput: ports.markRecovery }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: ports.blocked }));
vi.mock('../src/main/logger.js', () => ({ logInfo: ports.info, logWarn: ports.warn }));

import {
  RECOVERY_AGENT_MEMORY,
  RECOVERY_AGENT_FILENAME,
  RECOVERY_RUN_FILENAME,
  beginRecoveryRun,
  latestRestartRecoveryCandidate,
  markRecoveryRunClean,
  queuePrimeRestartRecovery,
  queueRestartRecovery,
  restartRecoveryInputId,
  restartRecoveryRequested,
  syncRecoveryAgentMemory
} from '../src/main/session/recovery-memory.js';

const cleanup: string[] = [];
const origin = (kind: 'resume' | 'worker' | 'helper' | 'desktop') => ({ kind, fromSessionId: null, agentId: kind === 'worker' ? 'worker-1' : null, task: '' });
function session(id: string, updatedAt: number, options: Record<string, unknown> = {}) {
  return {
    id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`], startedAt: 1, updatedAt,
    endedAt: null, events: 3, userMessages: 1, toolCalls: 1, lastToolCallAt: 120, processExitNonzero: 0,
    toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: `turn-${id}`,
    agents: [], origin: null, ...options
  };
}

function eventsFor(row: any, ...events: any[]): void {
  ports.events.set(row.id, events);
}

function start(row: any, time = 100, seq = 10, turnId = row.activeTurnId): any {
  return { kind: 'turn_start', source: 'extension', seq, time, turnId };
}

function tool(row: any, seq = 11, options: Record<string, unknown> = {}): any {
  return {
    kind: 'tool_call', source: 'mcp', seq, time: 100 + seq, turnId: row.activeTurnId,
    call: {
      requestId: `request-${row.id}-${seq}`,
      conversationId: row.conversationId,
      attributionMethod: 'request_id',
      ...options
    }
  };
}

function openTurn(row: any, time = 100, seq = 10): void {
  eventsFor(row, start(row, time, seq), tool(row, seq + 1));
}

afterEach(async () => {
  ports.sessions = [];
  ports.events.clear();
  ports.superseded.mockReset().mockResolvedValue(false);
  ports.blocked.mockReset().mockReturnValue(false);
  ports.enqueue.mockReset().mockImplementation(async (input: any) => ({ ...input, state: 'queued', owner: null, createdAt: 1, conversationId: 'bound' }));
  ports.markRecovery.mockReset().mockImplementation(async (id: string, recoveryTurnId: string) => ({
    id, recoveryTurnId, state: 'queued', owner: null, createdAt: 1, conversationId: 'bound'
  }));
  ports.info.mockReset(); ports.warn.mockReset();
  await markRecoveryRunClean();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('restart recovery memory', () => {
  it('writes the same app-owned recovery context into roaming userData without a live ledger dependency', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paradigmeve-recovery-'));
    cleanup.push(dir);
    const file = await syncRecoveryAgentMemory(dir);
    expect(file).toBe(path.join(dir, RECOVERY_AGENT_FILENAME));
    expect(await fs.readFile(file, 'utf8')).toBe(RECOVERY_AGENT_MEMORY);
    await syncRecoveryAgentMemory(dir);
    expect(await fs.readFile(file, 'utf8')).toBe(RECOVERY_AGENT_MEMORY);
  });

  it('uses one stable UUID for one exact session/conversation/turn and a different one when identity changes', () => {
    const a = restartRecoveryInputId('session-aaaa', 'conversation-aaaa', 'turn-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(restartRecoveryInputId('session-aaaa', 'conversation-aaaa', 'turn-1')).toBe(a);
    expect(restartRecoveryInputId('session-aaaa', 'conversation-aaaa', 'turn-2')).not.toBe(a);
  });

  it('distinguishes ordinary launches from reboot/reinstall/crash recovery and clears crash evidence only on clean shutdown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paradigmeve-recovery-run-'));
    cleanup.push(dir);
    expect(restartRecoveryRequested(['ParadigmEve.exe'], false)).toBe(false);
    expect(restartRecoveryRequested(['ParadigmEve.exe', '--background'], false)).toBe(true);
    expect(restartRecoveryRequested(['ParadigmEve.exe', '--recover-companion-browser'], false)).toBe(true);
    expect(restartRecoveryRequested(['ParadigmEve.exe', '--updated'], false)).toBe(true);
    expect(restartRecoveryRequested(['ParadigmEve.exe'], true)).toBe(true);

    expect(await beginRecoveryRun(dir)).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, RECOVERY_RUN_FILENAME), 'utf8'))).toMatchObject({ version: 1 });
    // A second process lifetime would see the marker left by a crash before replacing it.
    expect(await beginRecoveryRun(dir)).toBe(true);
    await markRecoveryRunClean();
    await expect(fs.stat(path.join(dir, RECOVERY_RUN_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selects the newest proven open ordinary turn by its actual start instead of noisy summary recency', async () => {
    const blocked = session('blocked1', 900);
    const helper = session('helper11', 800, { origin: origin('helper') });
    const worker = session('worker11', 700, { origin: origin('worker') });
    const noisyOld = session('noisyold', 1000);
    const stale = session('stale111', 600);
    const eligible = session('eligible', 500);
    ports.sessions = [noisyOld, blocked, helper, worker, stale, eligible];
    openTurn(blocked, 600);
    openTurn(helper, 700);
    openTurn(worker, 800);
    openTurn(noisyOld, 200);
    eventsFor(stale, start(stale, 400, 10), tool(stale, 9));
    openTurn(eligible, 500);
    ports.blocked.mockImplementation((conversationId?: string | null) => conversationId === blocked.conversationId);
    const selected = await latestRestartRecoveryCandidate();
    expect(selected?.session.id).toBe('eligible');
    expect(selected?.turnId).toBe('turn-eligible');
  });

  it('skips superseded identity and requires the exact open turn to be the newest lifecycle boundary', async () => {
    const superseded = session('oldchat1', 900);
    const mismatch = session('mismatch', 800);
    const ended = session('ended111', 750);
    const eligible = session('eligible', 700);
    ports.sessions = [superseded, mismatch, ended, eligible];
    ports.superseded.mockImplementation(async (conversationId?: string) => conversationId === superseded.conversationId);
    openTurn(superseded, 400);
    eventsFor(mismatch, start(mismatch, 350, 10, 'different-turn'), tool(mismatch, 11));
    eventsFor(ended, start(ended, 300, 10), tool(ended, 11), {
      kind: 'turn_end', source: 'extension', seq: 12, time: 320, turnId: ended.activeTurnId, outcome: 'interrupted'
    });
    openTurn(eligible, 250);
    expect((await latestRestartRecoveryCandidate())?.session.id).toBe('eligible');
  });

  it('requires request-id conversation ownership and rejects conflicting turn attribution', async () => {
    const wrongConversation = session('wrongcon', 900);
    const unattributed = session('unattrib', 800);
    const wrongTurn = session('wrongtrn', 700);
    const missingTurn = session('missingt', 650);
    const eligible = session('eligible', 600);
    ports.sessions = [wrongConversation, unattributed, wrongTurn, missingTurn, eligible];
    eventsFor(wrongConversation, start(wrongConversation, 500), tool(wrongConversation, 11, { conversationId: 'someone-else' }));
    eventsFor(unattributed, start(unattributed, 450), tool(unattributed, 11, { requestId: null, conversationId: null, attributionMethod: 'unattributed' }));
    eventsFor(wrongTurn, start(wrongTurn, 400), { ...tool(wrongTurn, 11), turnId: 'other-turn' });
    const noTurn = tool(missingTurn, 11); delete noTurn.turnId;
    eventsFor(missingTurn, start(missingTurn, 350), noTurn);
    openTurn(eligible, 300);
    expect((await latestRestartRecoveryCandidate())?.session.id).toBe('eligible');
  });

  it('pages backward until it finds exact owned work after the current turn start', async () => {
    const active = session('session1', 900);
    const rows = [start(active, 100, 10), tool(active, 11)];
    for (let seq = 12; seq < 90; seq++) rows.push(tool(active, seq, {
      requestId: null, conversationId: null, attributionMethod: 'unattributed'
    }));
    eventsFor(active, ...rows);
    ports.sessions = [active];
    expect((await latestRestartRecoveryCandidate())?.session.id).toBe(active.id);
  });

  it('durably enqueues the recovery instruction before returning a browser target and retries byte-for-byte', async () => {
    const active = session('session1', 900);
    ports.sessions = [active];
    openTurn(active, 100);
    const first = await queueRestartRecovery();
    const second = await queueRestartRecovery();
    expect(first?.entry?.state).toBe('queued');
    expect(first?.inputId).toBe(second?.inputId);
    expect(first?.url).toBe(`https://chatgpt.com/c/${active.conversationId}`);
    expect(ports.enqueue).toHaveBeenCalledTimes(2);
    expect(ports.markRecovery).toHaveBeenCalledTimes(2);
    expect(ports.markRecovery).toHaveBeenNthCalledWith(1, first?.inputId, active.activeTurnId);
    expect(ports.markRecovery).toHaveBeenNthCalledWith(2, second?.inputId, active.activeTurnId);
    expect(first?.entry).toMatchObject({ recoveryTurnId: active.activeTurnId });
    expect(ports.enqueue.mock.calls[0]![0]).toEqual(ports.enqueue.mock.calls[1]![0]);
    expect(ports.enqueue.mock.calls[0]![0]).toMatchObject({
      id: first?.inputId, sessionId: active.id, mode: 'auto', dueAt: 100, model: null, reasoningEffort: null
    });
    expect(ports.enqueue.mock.calls[0]![0].text).toContain('Never stop, reload or restart a running ChatGPT turn');
  });

  it('keeps the exact chat target but grants no stop authority when durable enqueue fails', async () => {
    const active = session('session1', 900);
    ports.sessions = [active];
    openTurn(active, 100);
    ports.enqueue.mockRejectedValueOnce(new Error('disk full'));
    const plan = await queueRestartRecovery();
    expect(plan?.entry).toBeNull();
    expect(plan?.conversationId).toBe(active.conversationId);
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('could not queue'));
  });

  it('queues an immediate exact-Prime wake for its open turn without requiring prior local tool work', async () => {
    const prime = session('prime111', 900);
    ports.sessions = [prime];
    eventsFor(prime, start(prime, 123, 10));
    const plan = await queuePrimeRestartRecovery(prime.conversationId);
    expect(plan).toMatchObject({
      sessionId: prime.id,
      conversationId: prime.conversationId,
      turnId: prime.activeTurnId,
      exactPrime: true,
      url: `https://chatgpt.com/c/${prime.conversationId}`
    });
    expect(ports.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: plan?.inputId,
      sessionId: prime.id,
      mode: 'auto',
      dueAt: 123
    }));
    expect(ports.enqueue.mock.calls.at(-1)?.[0].text).toContain('durable installation identity proves this exact conversation is Eve');
    expect(ports.enqueue.mock.calls.at(-1)?.[0].text).toContain('do not wait for the periodic semantic heartbeat');
    expect(ports.markRecovery).toHaveBeenCalledWith(plan?.inputId, prime.activeTurnId);
  });

  it('wakes an idle exact agent directly and fails closed on duplicate local session ownership', async () => {
    const prime = session('prime222', 777, { activeTurnId: null });
    ports.sessions = [prime];
    const plan = await queuePrimeRestartRecovery(prime.conversationId);
    expect(plan).toMatchObject({ turnId: null, exactPrime: true, conversationId: prime.conversationId });
    expect(ports.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dueAt: 777, sessionId: prime.id }));
    expect(ports.markRecovery).not.toHaveBeenCalled();

    ports.enqueue.mockClear();
    ports.sessions = [prime, { ...prime, id: 'duplicate-prime-session' }];
    expect(await queuePrimeRestartRecovery(prime.conversationId)).toBeNull();
    expect(ports.enqueue).not.toHaveBeenCalled();
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('refused duplicate local sessions'));
  });
});
