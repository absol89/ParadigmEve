/**
 * Restart context for an agent that was doing real local work when ParadigmEve exited.
 *
 * The Markdown copy in userData is deliberately informational. Delivery authority stays in the
 * existing durable session-input outbox: one deterministic input id represents one exact
 * session/conversation/turn across every process restart, so a crash between enqueue and wake
 * cannot manufacture a second recovery message.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../../shared/session.js';
import { DEFAULT_CORE_CONNECTOR_NAME } from '../../shared/types.js';
import { logInfo, logWarn } from '../logger.js';
import { getConfig } from '../config.js';
import { isChatBlocked } from './blocked-chats.js';
import { enqueueInput, markRestartRecoveryInput, type InputEntry } from './input.js';
import { conversationWasSuperseded, indexedSessions, readRecentEvents } from './store.js';

export const RECOVERY_AGENT_FILENAME = 'RECOVERY.md';
export const RECOVERY_RUN_FILENAME = 'RECOVERY-RUNNING.json';

let recoveryRunFile: string | null = null;
let recoveryRunWrite: Promise<void> | null = null;
let recoveryRunClosing = false;

/**
 * Kept short enough to place in one ordinary ChatGPT message. The same bytes are also written
 * to userData so a restarted/local agent can inspect the policy without relying on chat memory.
 */
export const RECOVERY_AGENT_MEMORY = `# ParadigmEve recovery memory

ParadigmEve may restart while a ChatGPT coding turn is still alive. Recover from durable identity and repository state, not from whichever browser tab happens to be visible.

- Read the selected project's root AGENTS.md before changing the project. Inspect Git status, HEAD/recent commits, durable session history and any still-running process before deciding work is idle. Preserve unrelated dirty work and existing rollback commits.
- The dedicated ParadigmEve browser profile is the app-owned ChatGPT/Companion surface. chrome://extensions/ is only for an explicit Companion install/update/reload. Never wait there as if it were a recovery destination. After extension work, return to the exact ChatGPT conversation that owns the unfinished session. Ctrl+Shift+T can restore Extensions merely because it was the last closed tab; that is not proof recovery succeeded.
- If Chrome shows an Aw, Snap! renderer-crash page (including STATUS_ACCESS_VIOLATION), exit/close that page. Do not wait on it or loop Reload; resume the exact owed ChatGPT conversation from durable recovery state instead.
- Use exact local session, ChatGPT conversation and turn identities. Do not guess the active job from a sidebar title, visible tab, timestamp proximity or similar text.
- Ordinary clean app launches are not recovery authority. A restart prompt is owed only after an unclean prior process, Windows/login background recovery, or an explicit reinstall/update recovery launch.
- Never stop, reload or restart a running ChatGPT turn merely to make room for a distress/recovery message. First commit that recovery instruction to ParadigmEve's durable outbox for the exact session/conversation/turn. If that commit fails or identity changes, do not stop the turn.
- Once a recovery instruction is durable, its one outbox receipt owns delivery. It may join a later exact tool result, or move to browser delivery after the current Companion proves that exact interrupted turn has stayed provider-idle through its settle window (or after positive terminal evidence). Do not type or enqueue a second copy because the first one is not yet visible.
- A stop is a separate action and needs its own current live proof/authorization. Persisted activeTurnId alone after restart is not proof that ChatGPT is still generating.
- Resume the unfinished user task from the strongest durable evidence available. Do not declare completion until the relevant checks actually pass, and do not wait indefinitely on a silent command/process when its state can be inspected safely.`;

interface RestartRecoveryCandidate {
  session: SessionSummary;
  conversationId: string;
  turnId: string;
  turnStartedAt: number;
}

export interface RestartRecoveryPlan {
  sessionId: string;
  conversationId: string;
  turnId: string | null;
  inputId: string;
  url: string;
  entry: InputEntry | null;
  /** True only when restored swarm ownership proved this exact conversation is Prime. */
  exactPrime: boolean;
}

/**
 * Marks this primary app lifetime as running and reports whether the previous lifetime failed to
 * clear the same marker. The single-instance lock is acquired before this is called, so marker
 * existence is process-crash evidence rather than another live ParadigmEve process.
 *
 * `markRecoveryRunClean()` may race an early quit while this write is still in flight. The second
 * removal after the write is what prevents that race from manufacturing a false crash on the next
 * launch.
 */
export async function beginRecoveryRun(userDataDir: string): Promise<boolean> {
  const filename = path.join(userDataDir, RECOVERY_RUN_FILENAME);
  recoveryRunFile = filename;
  recoveryRunClosing = false;
  let previousRunUnclean = false;
  try {
    await fs.stat(filename);
    previousRunUnclean = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const write = (async () => {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(filename, JSON.stringify({ version: 1, startedAt: Date.now(), pid: process.pid }), 'utf8');
    if (recoveryRunClosing) await fs.rm(filename, { force: true });
  })();
  recoveryRunWrite = write;
  try {
    await write;
  } finally {
    if (recoveryRunWrite === write) recoveryRunWrite = null;
  }
  return previousRunUnclean;
}

/** Clear crash evidence only after the app's accepted work and durable state have flushed. */
export async function markRecoveryRunClean(): Promise<void> {
  recoveryRunClosing = true;
  const pending = recoveryRunWrite;
  if (pending) await pending.catch(() => undefined);
  const filename = recoveryRunFile;
  if (!filename) return;
  await fs.rm(filename, { force: true });
  if (recoveryRunFile === filename) recoveryRunFile = null;
}

/** Pure startup gate: ordinary foreground launches never create restart-recovery input. */
export function restartRecoveryRequested(argv: readonly string[], previousRunUnclean: boolean): boolean {
  return previousRunUnclean || argv.includes('--background') || argv.includes('--recover-companion-browser') || argv.includes('--updated');
}

/** Stable RFC-4122-shaped idempotence key for one exact interrupted turn. */
export function restartRecoveryInputId(sessionId: string, conversationId: string, turnId: string): string {
  const bytes = createHash('sha256')
    .update('ParadigmEve restart recovery v1\0')
    .update(sessionId).update('\0')
    .update(conversationId).update('\0')
    .update(turnId)
    .digest()
    .subarray(0, 16);
  // Version 5 / RFC variant bits make z.string().uuid() accept the deterministic digest.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * App-owned, human-readable context copy. This file is not a ledger and never authorizes a send,
 * stop or browser action; rewriting it at startup therefore cannot race a durable operation.
 */
export async function syncRecoveryAgentMemory(userDataDir: string): Promise<string> {
  const filename = path.join(userDataDir, RECOVERY_AGENT_FILENAME);
  try {
    if (await fs.readFile(filename, 'utf8') === RECOVERY_AGENT_MEMORY) return filename;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(filename, RECOVERY_AGENT_MEMORY, 'utf8');
  return filename;
}

/**
 * Exact request-id placement after the current start is the durable ownership proof. Sequence is
 * the ordering authority; timestamps can legitimately describe when a long call began rather than
 * when its record finally landed. Page through tool rows so unrelated later calls cannot hide the
 * one exact call that proves this turn owns local work.
 */
async function hasOwnedToolWorkAfterStart(
  sessionId: string,
  conversationId: string,
  turnId: string,
  startSeq: number
): Promise<boolean> {
  let before: number | undefined;
  for (;;) {
    const page = await readRecentEvents(sessionId, 64, {
      kinds: ['tool_call'],
      ...(before === undefined ? {} : { before })
    });
    if (page.length === 0) return false;
    let oldest = Number.MAX_SAFE_INTEGER;
    for (const event of page) {
      oldest = Math.min(oldest, event.seq);
      if (event.seq <= startSeq || event.kind !== 'tool_call') continue;
      if (
        event.call.requestId &&
        event.call.attributionMethod === 'request_id' &&
        event.call.conversationId === conversationId &&
        event.turnId === turnId
      ) {
        return true;
      }
    }
    if (oldest <= startSeq || oldest === Number.MAX_SAFE_INTEGER || (before !== undefined && oldest >= before)) return false;
    before = oldest;
  }
}

/**
 * Recovery is deliberately narrower than "most recent chat". An open durable turn must also
 * prove that this exact turn already used a local tool. That is the app's evidence that it owes
 * unfinished local work rather than an arbitrary old/personal ChatGPT conversation.
 */
export async function latestRestartRecoveryCandidate(): Promise<RestartRecoveryCandidate | null> {
  let newest: RestartRecoveryCandidate | null = null;
  for (const session of await indexedSessions()) {
    const conversationId = session.conversationId;
    const turnId = session.activeTurnId ?? null;
    if (!conversationId || !turnId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper') continue;
    if (isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) continue;
    const [start] = await readRecentEvents(session.id, 1, { kinds: ['turn_start', 'turn_end'] });
    if (start?.kind !== 'turn_start' || start.turnId !== turnId) continue;
    if (!(await hasOwnedToolWorkAfterStart(session.id, conversationId, turnId, start.seq))) continue;
    const candidate = { session, conversationId, turnId, turnStartedAt: start.time };
    if (
      !newest ||
      candidate.turnStartedAt > newest.turnStartedAt ||
      (candidate.turnStartedAt === newest.turnStartedAt && candidate.session.updatedAt > newest.session.updatedAt) ||
      (candidate.turnStartedAt === newest.turnStartedAt && candidate.session.updatedAt === newest.session.updatedAt && candidate.session.id > newest.session.id)
    ) {
      newest = candidate;
    }
  }
  return newest;
}

export function restartRecoveryPrompt(candidate: Pick<RestartRecoveryCandidate, 'session' | 'conversationId' | 'turnId'>): string {
  return `[[PARADIGMEVE-RESTART-RECOVERY:v1]]\n\nParadigmEve restarted while this exact conversation still had an unfinished locally active turn. Resume the existing user task in this chat; do not ask the user to restate it and do not infer a different task from another visible tab.\n\n${RECOVERY_AGENT_MEMORY}\n\nRecovery target: local session ${candidate.session.id}, conversation ${candidate.conversationId}, interrupted turn ${candidate.turnId}. Inspect the durable session/repository state now and continue the unfinished work.`;
}

/**
 * Commit recovery text before any browser/UI recovery action. This function intentionally has no
 * Stop dependency: if enqueue fails, callers still know the exact chat to reopen but have zero
 * authority to stop its turn. The deterministic id makes a repeated process restart idempotent.
 */
export async function queueRestartRecovery(): Promise<RestartRecoveryPlan | null> {
  const candidate = await latestRestartRecoveryCandidate();
  if (!candidate) return null;
  const inputId = restartRecoveryInputId(candidate.session.id, candidate.conversationId, candidate.turnId);
  const plan: RestartRecoveryPlan = {
    sessionId: candidate.session.id,
    conversationId: candidate.conversationId,
    turnId: candidate.turnId,
    inputId,
    url: `https://chatgpt.com/c/${encodeURIComponent(candidate.conversationId)}`,
    entry: null,
    exactPrime: false
  };
  try {
    // turnStartedAt is deterministic, unlike Date.now(), so retrying the same id after a crash
    // is byte-for-byte the same enqueue operation and exercises the outbox's idempotence check.
    const queued = await enqueueInput({
      id: inputId,
      sessionId: candidate.session.id,
      text: restartRecoveryPrompt(candidate),
      mode: 'auto',
      dueAt: candidate.turnStartedAt,
      model: null,
      reasoningEffort: null
    });
    // The marker is deliberately stamped by an internal API after ordinary input validation,
    // so renderer/MCP callers cannot opt themselves into restart-only browser admission. If an
    // older build already queued this deterministic id, the stamp upgrades that same row rather
    // than creating a second instruction.
    plan.entry = await markRestartRecoveryInput(queued.id, candidate.turnId);
    logInfo(`restart recovery queued for session ${candidate.session.id}`);
  } catch (error) {
    // No stop/reload follows this failure. Opening the exact chat is still useful, but delivery
    // remains owned by whatever durable input already occupies the session.
    logWarn(`restart recovery could not queue its durable instruction: ${error instanceof Error ? error.message : String(error)}`);
  }
  return plan;
}

/**
 * Queue one immediate restart wake for the exact durable Eve/Eva conversation selected by the
 * dedicated installation identity owner.
 *
 * Unlike {@link latestRestartRecoveryCandidate}, this path does not pick a conversation by
 * recency. The caller already proved one exact agent conversation from durable ownership, and this
 * function accepts only the one local session whose current conversation is that exact id.
 * Duplicate/missing local ownership fails closed rather than choosing a likely session.
 *
 * An open owner turn receives the same internal restart-turn marker used by ordinary interrupted
 * work, so the Companion may deliver only after the exact replacement document is stably idle and
 * no local tool call is still running. An idle owner needs no exception and is ordinary browser
 * input. In neither case do we Stop or replace the current turn.
 */
export async function queuePrimeRestartRecovery(conversationId: string): Promise<RestartRecoveryPlan | null> {
  if (!conversationId) return null;
  const matches: SessionSummary[] = [];
  for (const session of await indexedSessions()) {
    if (session.conversationId !== conversationId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper') continue;
    if (isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) continue;
    matches.push(session);
  }
  if (matches.length !== 1) {
    if (matches.length > 1) logWarn(`restart recovery refused duplicate local sessions for exact agent conversation ${conversationId}`);
    return null;
  }

  const session = matches[0]!;
  const activeTurnId = session.activeTurnId ?? null;
  let dueAt = session.updatedAt;
  if (activeTurnId) {
    const [boundary] = await readRecentEvents(session.id, 1, { kinds: ['turn_start', 'turn_end'] });
    if (boundary?.kind !== 'turn_start' || boundary.turnId !== activeTurnId) {
      logWarn(`restart recovery refused stale active-turn metadata for exact agent session ${session.id}`);
      return null;
    }
    dueAt = boundary.time;
  }

  const identityEpoch = activeTurnId ?? `agent-idle:${session.updatedAt}`;
  const inputId = restartRecoveryInputId(session.id, conversationId, identityEpoch);
  const plan: RestartRecoveryPlan = {
    sessionId: session.id,
    conversationId,
    turnId: activeTurnId,
    inputId,
    url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    entry: null,
    exactPrime: true
  };
  const turnContext = activeTurnId
    ? ` Local session ${session.id} still records interrupted/open turn ${activeTurnId}; do not Stop it merely to deliver this wake.`
    : ` Local session ${session.id} was idle at restart.`;
  const agentName = getConfig().mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME;
  const text = `[[PARADIGMEVE-AGENT-RESTART-WAKE:v1]]\n\nParadigmEve restarted and durable installation identity proves this exact conversation is ${agentName}.${turnContext} Resume coordination from this ${agentName} conversation now. Inspect durable session/repository/worker state, continue still-valid work, and do not wait for the periodic semantic heartbeat to rediscover it. Do not infer another owner from titles, recency, visible tabs or similar text.`;
  try {
    const queued = await enqueueInput({
      id: inputId,
      sessionId: session.id,
      text,
      mode: 'auto',
      dueAt,
      model: null,
      reasoningEffort: null
    });
    plan.entry = activeTurnId ? await markRestartRecoveryInput(queued.id, activeTurnId) : queued;
    logInfo(`restart recovery queued immediate ${agentName} wake for session ${session.id}`);
  } catch (error) {
    // Browser recovery may still reopen the exact proven owner. Never invent a second input when
    // another durable outbox row already owns this session or persistence failed.
    logWarn(`restart recovery could not queue immediate ${agentName} wake: ${error instanceof Error ? error.message : String(error)}`);
  }
  return plan;
}
