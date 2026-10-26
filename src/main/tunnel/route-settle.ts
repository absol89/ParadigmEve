/**
 * The first existing-chat send after a new OpenAI tunnel client connects may still use the old
 * client's route. Delay only that browser delivery, never a new-chat send or an already-claimed
 * outbox entry. Learn the bound from exact page-request-to-local-ingress timing (#1788).
 */
import { wakeBrowserWork } from '../browser-wake.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logInfo } from '../logger.js';

export const ROUTE_SETTLE_MS = 35_000;
const MIN_HOLD_MS = 12_000;
const MAX_HOLD_MS = 90_000;
const LATE_GAP_MS = 60_000;
const FAST_GAP_MS = 30_000;
const FAST_STREAK = 3;
const MEASURE_WINDOW_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 10_000;
const STATE = 'route-hold';

let holdMs = ROUTE_SETTLE_MS;
let fastStreak = 0;
let settledAt = 0;
let timer: NodeJS.Timeout | null = null;
let epoch: { connectedAt: number; measured: boolean } | null = null;
let target: { conversationId: string; sentAt: number; sighted: { requestId: string; at: number } | null } | null = null;
const arrived = new Map<string, number>();

export function routeHoldMs(): number { return holdMs; }

/** Called once when a freshly spawned core tunnel-client first proves a connection. */
export function noteTunnelClientConnected(now = Date.now()): void {
  epoch = { connectedAt: now, measured: false };
  target = null;
  arrived.clear();
  const until = now + holdMs;
  if (until <= settledAt) return;
  settledAt = until;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; wakeBrowserWork(); }, holdMs);
  timer.unref?.();
}

export function tunnelRouteSettling(now = Date.now()): boolean { return now < settledAt; }
export function tunnelRouteSettlingUntil(now = Date.now()): number | null {
  return tunnelRouteSettling(now) ? settledAt : null;
}

const measurementOpen = (): boolean => !!epoch && !epoch.measured && !!target;

/** Only the first existing-chat message near this tunnel takeover can measure its route. */
export function noteRouteExistingChatSend(conversationId: string, now = Date.now()): void {
  if (!epoch || epoch.measured || target || !conversationId) return;
  if (now < epoch.connectedAt || now - epoch.connectedAt > MEASURE_WINDOW_MS) return;
  target = { conversationId, sentAt: now, sighted: null };
}

/** The exact page saw the request, independently of whether the tool reached this process. */
export function noteRouteRequestSighted(
  requestId: string, conversationId: string, now = Date.now(), createdAt: number | null = null
): void {
  if (!requestId || !measurementOpen() || target!.conversationId !== conversationId || target!.sighted) return;
  if (createdAt !== null && createdAt < target!.sentAt - CLOCK_SKEW_MS) return;
  const arrivedAt = arrived.get(requestId);
  if (arrivedAt !== undefined) learn(arrivedAt - now);
  else target!.sighted = { requestId, at: now };
}

/** A real inbound Core tool request crossed the local MCP boundary. */
export function noteRouteRequestArrived(requestId: string, now = Date.now()): void {
  if (!requestId || !measurementOpen()) return;
  const sighted = target!.sighted;
  if (sighted) {
    if (sighted.requestId === requestId) learn(now - sighted.at);
    return;
  }
  // A fast call may reach the app before the Companion reports the exact request id.
  if (arrived.size < 64) arrived.set(requestId, now);
}

function learn(gapMs: number): void {
  if (!epoch || epoch.measured) return;
  epoch.measured = true;
  target = null;
  arrived.clear();
  const previous = holdMs;
  if (gapMs >= LATE_GAP_MS) {
    holdMs = Math.min(MAX_HOLD_MS, Math.max(Math.round(holdMs * 1.5), holdMs + 15_000));
    fastStreak = 0;
  } else if (gapMs <= FAST_GAP_MS) {
    fastStreak += 1;
    if (fastStreak >= FAST_STREAK) {
      holdMs = Math.max(MIN_HOLD_MS, holdMs - 5_000);
      fastStreak = 0;
    }
  } else {
    fastStreak = 0;
  }
  logInfo(`route hold: exact existing-chat call arrived ${Math.max(0, Math.round(gapMs / 1000))} s after page sighting; hold ${previous / 1000} s -> ${holdMs / 1000} s`);
  writeDurableSoon(STATE, { version: 1, holdMs, fastStreak });
}

export async function restoreRouteHold(): Promise<void> {
  const saved = await readDurable<{ version?: unknown; holdMs?: unknown; fastStreak?: unknown }>(STATE);
  if (!saved || saved.version !== 1 || typeof saved.holdMs !== 'number' ||
      !Number.isInteger(saved.holdMs) || saved.holdMs < MIN_HOLD_MS || saved.holdMs > MAX_HOLD_MS) return;
  holdMs = saved.holdMs;
  fastStreak = typeof saved.fastStreak === 'number' && Number.isInteger(saved.fastStreak) &&
    saved.fastStreak >= 0 && saved.fastStreak < FAST_STREAK ? saved.fastStreak : 0;
}

export function resetRouteSettleForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  settledAt = 0;
  epoch = null;
  target = null;
  arrived.clear();
  holdMs = ROUTE_SETTLE_MS;
  fastStreak = 0;
}
