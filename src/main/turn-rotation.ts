/**
 * Fresh turns for long work. Ported from Chat On Steroids #1499/#1530 (#1402 upstream).
 *
 * Upstream measured it over a 24-hour run and on a second account: turns up to about 35 minutes
 * ended cleanly, turns that ran 37–64 minutes almost always broke (stream lost, "Message delivery
 * timed out", stalls), and every break then cost reloads and history limits. ParadigmEve saw the
 * same on 2026-10-15: Eve's Prime turn ran for hours after a Compact & Resume and its tab sat on
 * "Connection interrupted. Waiting for the complete answer".
 *
 * So once a turn has run `ui.rotateTurnMinutes` (default 30), the next attributed tool result files
 * one automatic continue for that turn. The Companion's existing direct-turn path stops the answer
 * and sends it as the next message, exactly what Stop and "continue" by hand did; the call in flight
 * keeps its result. Decided per attributed tool call, so it only happens right after a tool result.
 * One rotation per turn; a refused filing is tried again after a minute, a filed one the page did
 * not take after five, and a turn is left alone after two filings it did not take.
 */
export interface RotationDeps {
  now(): number;
  /** Minutes before a turn is rotated; 0 is off. */
  minutes(): number;
  /** When this exact turn started, or null when that is not known. */
  turnStartedAt(sessionId: string, turnId: string): Promise<number | null>;
  /** Files the automatic continue into exactly this running turn; null when the outbox refused. */
  file(sessionId: string, turnId: string, startedAt: number): Promise<unknown | null>;
  /** Durable app-owned filing evidence, independent of this process's retry cache. */
  history?(sessionId: string, turnId: string): Promise<{ filings: number; lastFiledAt: number } | null>;
  log(message: string): void;
}

/** The app's automatic continue. Plain on purpose: it only has to carry the work on. */
export const ROTATION_MESSAGE =
  'Continue the task from where you are. (ParadigmEve starts a fresh turn every so often so long work stays reliable; nothing else changed.)';

/** The one in-place Continue after ChatGPT broke off a live answer; see bridge confirmRepair. */
export const RECOVERY_CONTINUE_MESSAGE =
  'Continue the task from where you stopped. (ChatGPT interrupted your previous response; ParadigmEve stopped it without reloading the chat. Do not repeat work or tool actions you already completed.)';

const REFUSED_RETRY_MS = 60_000;
const UNTAKEN_RETRY_MS = 5 * 60_000;
export const MAX_FILED_PER_TURN = 2;
const attempts = new Map<string, { turnId: string; at: number; filed: boolean; filings: number; gaveUp?: boolean }>();
const inFlight = new Set<string>();

export async function considerTurnRotation(conversationId: string, sessionId: string, turnId: string, deps: RotationDeps): Promise<boolean> {
  const minutes = deps.minutes();
  if (!(minutes > 0) || inFlight.has(conversationId)) return false;
  inFlight.add(conversationId);
  try {
    const now = deps.now();
    const inMemory = attempts.get(conversationId);
    const history = await deps.history?.(sessionId, turnId);
    const last = history && history.filings > 0 ? {
      turnId,
      at: Math.max(history.lastFiledAt, inMemory?.turnId === turnId ? inMemory.at : 0),
      filed: true,
      filings: Math.max(history.filings, inMemory?.turnId === turnId ? inMemory.filings : 0),
      gaveUp: inMemory?.turnId === turnId ? inMemory.gaveUp : false
    } : inMemory;
    if (last?.turnId === turnId && (last.gaveUp || now - last.at < (last.filed ? UNTAKEN_RETRY_MS : REFUSED_RETRY_MS))) return false;
    if (last?.turnId === turnId && last.filings >= MAX_FILED_PER_TURN) {
      attempts.set(conversationId, { ...last, gaveUp: true });
      deps.log(`turn rotation: ${conversationId} — giving up on fresh turns for turn ${turnId}; the page did not take ${last.filings} automatic continues`);
      return false;
    }
    const startedAt = await deps.turnStartedAt(sessionId, turnId);
    if (startedAt === null || now - startedAt < minutes * 60_000) return false;
    const row = await deps.file(sessionId, turnId, startedAt);
    const filings = (last?.turnId === turnId ? last.filings : 0) + (row !== null ? 1 : 0);
    attempts.set(conversationId, { turnId, at: now, filed: row !== null, filings });
    if (attempts.size > 500) attempts.delete(attempts.keys().next().value!);
    if (row === null) return false;
    deps.log(`turn rotation: ${conversationId} has worked ${Math.round((now - startedAt) / 60_000)} minutes in turn ${turnId} — continuing in a fresh turn after this tool result`);
    return true;
  } finally {
    inFlight.delete(conversationId);
  }
}

/** Test seam: forgets every attempt. */
export function resetTurnRotationForTests(): void {
  attempts.clear();
  inFlight.clear();
}
