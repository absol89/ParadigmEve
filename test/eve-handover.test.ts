import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessions: Array<Record<string, unknown>> = [];
const swarm = { move: vi.fn(), persist: vi.fn(async () => true) };

vi.mock('../src/main/durable.js', () => ({ writeDurableNow: vi.fn(async () => undefined) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: (id: string) => id === 'blocked-chat-1' }));
vi.mock('../src/main/session/store.js', () => ({
  indexedSessions: async () => sessions,
  conversationWasSuperseded: async (id: string) => id === 'superseded-chat'
}));
vi.mock('../src/main/agents.js', () => ({
  movePrimeOnUserRequest: (...args: unknown[]) => swarm.move(...args),
  persistCriticalSwarmNow: () => swarm.persist(),
  retiredWorkerForConversation: () => null
}));

const { moveEveToConversation, OLD_PRIME_ACTIVE_MS } = await import('../src/main/eve-handover.js');
const identity = await import('../src/main/agent-identity.js');

const OLD = 'old-eve-chat-1';
const NEW = 'new-eve-chat-1';
const row = (conversationId: string, extra: Record<string, unknown> = {}) => ({ id: `s-${conversationId}`, conversationId, updatedAt: 0, ...extra });

beforeEach(async () => {
  identity.resetAgentIdentityForTests();
  sessions.length = 0;
  swarm.move.mockReset().mockReturnValue({ status: 'none' });
  swarm.persist.mockReset().mockResolvedValue(true);
  await identity.claimAgentConversation(OLD);
});

describe('moving Eve to this chat on request', () => {
  it('moves the identity and worker family even though the old chat no longer exists', async () => {
    sessions.push(row(NEW));
    swarm.move.mockReturnValue({ status: 'moved', from: OLD, workers: 3, active: false });
    const result = await moveEveToConversation(NEW);
    expect(result).toEqual({ ok: true, changed: true, from: OLD, to: NEW, movedWorkerFamily: true, workers: 3 });
    expect(identity.currentAgentConversationId()).toBe(NEW);
    expect(swarm.persist).toHaveBeenCalled();
  });

  it('works when the old owner was already cleared', async () => {
    await identity.clearAgentConversation(OLD);
    sessions.push(row(NEW));
    const result = await moveEveToConversation(NEW);
    expect(result).toMatchObject({ ok: true, changed: true, from: null, movedWorkerFamily: false });
    expect(identity.currentAgentConversationId()).toBe(NEW);
  });

  it('is idempotent for the current owner', async () => {
    sessions.push(row(OLD));
    expect(await moveEveToConversation(OLD)).toMatchObject({ ok: true, changed: false });
    expect(swarm.move).not.toHaveBeenCalled();
  });

  it.each([
    ['a worker chat', { origin: { kind: 'worker' } }, 'DESTINATION_IS_WORKER'],
    ['a helper chat', { origin: { kind: 'helper' } }, 'DESTINATION_IS_WORKER']
  ])('refuses %s', async (_label, extra, code) => {
    sessions.push(row(NEW, extra));
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: false, code });
    expect(identity.currentAgentConversationId()).toBe(OLD);
  });

  it('refuses a chat with no local session, a blocked chat and a superseded chat', async () => {
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: false, code: 'DESTINATION_NOT_RECORDED' });
    sessions.push(row('blocked-chat-1'), row('superseded-chat'));
    expect(await moveEveToConversation('blocked-chat-1')).toMatchObject({ ok: false, code: 'DESTINATION_UNAVAILABLE' });
    expect(await moveEveToConversation('superseded-chat')).toMatchObject({ ok: false, code: 'DESTINATION_UNAVAILABLE' });
    expect(identity.currentAgentConversationId()).toBe(OLD);
  });

  it('protects an old Prime that is working right now but not a stale open turn', async () => {
    sessions.push(row(NEW), row(OLD, { activeTurnId: 't1', updatedAt: Date.now() - 1000 }));
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: false, code: 'OLD_PRIME_ACTIVE' });
    expect(identity.currentAgentConversationId()).toBe(OLD);
    sessions.splice(0, sessions.length, row(NEW), row(OLD, { activeTurnId: 't1', updatedAt: Date.now() - OLD_PRIME_ACTIVE_MS - 1000 }));
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: true, changed: true });
  });

  it('leaves everything unchanged when the worker family cannot move', async () => {
    sessions.push(row(NEW));
    swarm.move.mockReturnValue({ status: 'refused', reason: 'this chat already belongs to another worker family' });
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: false, code: 'WORKER_FAMILY_REFUSED' });
    expect(identity.currentAgentConversationId()).toBe(OLD);
  });

  it('rolls both back when the worker family cannot be saved', async () => {
    sessions.push(row(NEW));
    swarm.move.mockReturnValue({ status: 'moved', from: OLD, workers: 1, active: true });
    swarm.persist.mockResolvedValue(false);
    expect(await moveEveToConversation(NEW)).toMatchObject({ ok: false, code: 'PERSIST_FAILED' });
    expect(identity.currentAgentConversationId()).toBe(OLD);
    expect(swarm.move).toHaveBeenLastCalledWith(NEW, OLD);
  });
});
