import { describe, expect, it } from 'vitest';
// @ts-ignore The maintainer scripts are intentionally plain ESM JavaScript.
import { diagnose } from '../scripts/eve-doctor.mjs';

const now = 10_000_000;
const base = () => ({
  sessions: [{ id: 's1', title: 'Prime', conversationId: 'chat-b', chatIds: ['chat-a', 'chat-b'], endedAt: null }],
  input: [] as any[],
  continuations: [] as any[],
  correlations: [] as any[],
  goalReplies: [] as any[],
  bridge: { commands: [] as any[] },
  identity: { conversationId: 'chat-b' },
  swarm: { currentAgentConversationId: 'chat-b' },
  running: null
});
const warnings = (state: ReturnType<typeof base>) =>
  diagnose(state, { now, stuckMs: 600_000 }).filter((f: any) => f.level === 'warn').map((f: any) => `${f.area}: ${f.message}`);

describe('eve-doctor', () => {
  it('reports nothing for a settled state', () => {
    const state = base();
    state.input.push({ id: 'i1', state: 'sent', sessionId: 's1', createdAt: 0 });
    state.continuations.push({ state: 'committed', sessionId: 's1', from: 'chat-a', to: 'chat-b', touchedAt: 0 });
    expect(warnings(state)).toEqual([]);
  });

  it('flags stuck rows, deleted sessions, open tickets and a split identity pointer', () => {
    const state = base();
    state.input.push({ id: 'old', state: 'browser', sessionId: 's1', mode: 'auto', createdAt: now - 900_000 });
    state.input.push({ id: 'fresh', state: 'queued', sessionId: 's1', mode: 'auto', createdAt: now - 1_000 });
    state.input.push({ id: 'orphan', state: 'queued', sessionId: 'gone', mode: 'auto', createdAt: now });
    state.continuations.push({ state: 'awaiting-summary', sessionId: 's1', from: 'chat-b', touchedAt: now - 120_000 });
    state.continuations.push({ state: 'committed', sessionId: 's1', from: 'chat-b', to: 'chat-z', touchedAt: 0 });
    state.swarm.currentAgentConversationId = 'chat-a';
    const found = warnings(state);
    expect(found).toHaveLength(5);
    expect(found[0]).toMatch(/^queue: row old stuck in "browser" for 15 min/);
    expect(found[1]).toMatch(/^sessions: input rows reference 1 deleted session\(s\): gone/);
    expect(found[2]).toMatch(/^compact: open ticket in "awaiting-summary"/);
    expect(found[3]).toMatch(/^compact: committed ticket moved session s1 to chat-z/);
    expect(found[4]).toMatch(/^identity: swarm.json points at chat-a/);
  });

  it('flags an identity pointer no session owns', () => {
    const state = base();
    state.identity = { conversationId: 'chat-x' };
    state.swarm.currentAgentConversationId = 'chat-x';
    expect(warnings(state)).toEqual(['identity: identity points at chat chat-x, which no session owns']);
  });
});
