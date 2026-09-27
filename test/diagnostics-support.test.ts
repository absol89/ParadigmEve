import { expect, it } from 'vitest';
import { recentOperationalErrorSummary, supportLifecycleChecks } from '../src/main/diagnostics-support.js';
import type { AgentInfo, SessionSummary } from '../src/shared/session.js';

const NOW = 10_000;

function worker(id: string, conversationId: string, state: AgentInfo['state']): AgentInfo {
  return {
    id, role: 'worker', label: id, task: 'private task text', reasoningEffort: null, model: null, state,
    createdAt: 1, activatedAt: 1, finishedAt: null, result: null, pending: 0, awaitingAck: 0, delivered: 0,
    conversationId, detachedAt: state === 'detached' ? 5_000 : null, lastSeenAt: 5_000, revivable: false,
    sleptAt: null, contextTokens: 0
  };
}

function session(id: string, conversationId: string, agentId: string, activeTurnId: string | null): SessionSummary {
  return {
    id, title: 'private session title', conversationId, chatIds: [conversationId], startedAt: 1, updatedAt: 1,
    endedAt: null, events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0,
    toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0, lastHandoffId: null,
    lastHandoffAt: null, lastTurnOutcome: null, activeTurnId, agents: [agentId],
    origin: { kind: 'worker', fromSessionId: 'prime-session', agentId, task: 'private task text' }
  };
}

it('reports working, waiting and stale worker sessions from exact ownership plus open-turn state', () => {
  const agents = [worker('worker-1', 'c-working', 'active'), worker('worker-2', 'c-waiting', 'active'), worker('worker-3', 'c-detached', 'detached')];
  const sessions = [
    session('s-working', 'c-working', 'worker-1', 'turn-1'),
    session('s-waiting', 'c-waiting', 'worker-2', null),
    session('s-detached', 'c-detached', 'worker-3', 'turn-3'),
    session('s-stale', 'c-stale', 'worker-4', 'turn-4')
  ];
  const checks = supportLifecycleChecks(sessions, agents, NOW, [...agents.map((agent) => agent.state), 'sleeping', 'finished']);
  expect(checks[0]?.detail).toBe('2 working · 1 waiting · 1 sleeping · 1 stale/unattributed · 1 terminal.');
  expect(checks[1]?.detail).toContain('1 detached (oldest 5s ago)');
});

it('summarizes recent operational errors without copying their paths, secrets or message text', () => {
  const summary = recentOperationalErrorSummary([
    { time: 8_000, level: 'warn', message: 'bridge: failed reading C:\\private\\notes.txt with SECRET-CONTENT' },
    { time: 9_000, level: 'error', message: 'multi-agent: private task result contained APIKEY-123' },
    { time: 9_500, level: 'info', message: 'ignored info' }
  ], NOW);
  expect(summary).toContain('Companion bridge ×1');
  expect(summary).toContain('multi-agent ×1');
  expect(summary).not.toContain('private');
  expect(summary).not.toContain('notes.txt');
  expect(summary).not.toContain('APIKEY');
  expect(summary).not.toContain('SECRET-CONTENT');
});
