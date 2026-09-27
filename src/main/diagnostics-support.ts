import type { AgentInfo, SessionSummary } from '../shared/session.js';
import type { Check, LogEntry } from '../shared/types.js';

function supportAge(at: number | null, now: number): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function operationalComponent(message: string): string {
  const lower = message.toLowerCase();
  if (lower.startsWith('multi-agent:')) return 'multi-agent';
  if (lower.startsWith('bridge:')) return 'Companion bridge';
  if (lower.startsWith('guided setup')) return 'setup';
  if (lower.startsWith('self-test')) return 'self-test';
  if (lower.includes('tunnel')) return 'tunnel';
  if (lower.includes('connection')) return 'connection';
  return 'other';
}

/**
 * Support-only error summary. It deliberately discards message text: log lines can mention a
 * user's path, command or file-derived text even after credential redaction. Component, level
 * and time are enough to correlate a support report with the local Activity log without copying
 * private content into the diagnostic payload.
 */
export function recentOperationalErrorSummary(entries: readonly LogEntry[], now = Date.now()): string {
  const recent = entries.filter((entry) => entry.level === 'warn' || entry.level === 'error').slice(-20);
  if (recent.length === 0) return 'none';
  const groups = new Map<string, number>();
  for (const entry of recent) {
    const key = operationalComponent(entry.message);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const latest = recent[recent.length - 1]!;
  return `${[...groups.entries()].map(([name, count]) => `${name} ×${count}`).join(', ')}; latest ${supportAge(latest.time, now)}`;
}

function exactWorker(summary: SessionSummary, agents: readonly AgentInfo[]): AgentInfo | null {
  if (summary.origin?.kind !== 'worker' || !summary.conversationId) return null;
  return agents.find((agent) =>
    agent.role === 'worker' &&
    agent.id === summary.origin?.agentId &&
    agent.conversationId === summary.conversationId
  ) ?? null;
}

/** Compact, content-free worker lifecycle lines for the local Health panel. */
export function supportLifecycleChecks(
  sessions: readonly SessionSummary[],
  agents: readonly AgentInfo[],
  now = Date.now(),
  allWorkerStates: readonly AgentInfo['state'][] = agents.filter((agent) => agent.role === 'worker').map((agent) => agent.state)
): Check[] {
  const workerSessions = sessions.filter((session) => session.origin?.kind === 'worker');
  const liveWorkers = agents.filter((agent) => agent.role === 'worker');
  const working = liveWorkers.filter((agent) => {
    if (agent.state !== 'active' && agent.state !== 'detached') return false;
    const summary = workerSessions.find((session) => exactWorker(session, [agent]));
    return summary?.activeTurnId !== undefined ? summary.activeTurnId !== null : false;
  }).length;
  const waiting = liveWorkers.filter((agent) => {
    if (agent.state === 'invited' || agent.state === 'waking') return true;
    if (agent.state !== 'active' && agent.state !== 'detached') return false;
    const summary = workerSessions.find((session) => exactWorker(session, [agent]));
    return summary?.activeTurnId === undefined || summary.activeTurnId === null;
  }).length;
  const stale = workerSessions.filter((session) =>
    session.endedAt === null &&
    session.activeTurnId !== null &&
    session.activeTurnId !== undefined &&
    exactWorker(session, agents) === null
  ).length;
  const sleeping = allWorkerStates.filter((state) => state === 'sleeping').length;
  const terminal = allWorkerStates.filter((state) => state === 'finished' || state === 'failed').length;
  const detached = liveWorkers.filter((agent) => agent.state === 'detached').length;
  const waking = liveWorkers.filter((agent) => agent.state === 'waking').length;
  const oldestDetached = liveWorkers
    .filter((agent) => agent.state === 'detached' && agent.detachedAt !== null)
    .reduce<number | null>((oldest, agent) => oldest === null ? agent.detachedAt : Math.min(oldest, agent.detachedAt!), null);

  return [
    {
      name: 'Worker lifecycle', status: 'skipped', ok: null,
      detail: `${working} working · ${waiting} waiting · ${sleeping} sleeping · ${stale} stale/unattributed · ${terminal} terminal.`
    },
    {
      name: 'Worker recovery', status: 'skipped', ok: null,
      detail: `${detached} detached${oldestDetached === null ? '' : ` (oldest ${supportAge(oldestDetached, now)})`} · ${waking} waking.`
    }
  ];
}

export { supportAge };
