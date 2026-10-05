/**
 * Timing trace for the provider-switch path (composer → preview → consent → send → enqueue).
 *
 * A switch that appears frozen must be attributable to one step from the log alone. Each
 * boundary logs `provider-switch timing trace=<id> step=<name> at=<ms since start> step_ms=<ms>`.
 * The trace rides on AsyncLocalStorage so deep helpers (canonical history, session open) can mark
 * themselves without new parameters; outside a traced call `mark()` does nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logInfo } from './logger.js';

interface Trace {
  id: string;
  startedAt: number;
  lastAt: number;
}

const store = new AsyncLocalStorage<Trace>();

/** Runs `work` with a trace; logs its start and end (or failure). */
export async function traceProviderSwitch<T>(id: string, origin: string, work: () => Promise<T>): Promise<T> {
  const trace: Trace = { id: id.slice(0, 8), startedAt: Date.now(), lastAt: Date.now() };
  return store.run(trace, async () => {
    markProviderSwitch(`${origin}:start`);
    try {
      const result = await work();
      markProviderSwitch(`${origin}:done`);
      return result;
    } catch (error) {
      markProviderSwitch(`${origin}:failed`, error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120));
      throw error;
    }
  });
}

/** Marks one completed step of the current traced call. No-op outside one. */
export function markProviderSwitch(step: string, detail?: string): void {
  const trace = store.getStore();
  if (!trace) return;
  const now = Date.now();
  logInfo(`provider-switch timing trace=${trace.id} step=${step} at=${now - trace.startedAt} step_ms=${now - trace.lastAt}${detail ? ` detail=${detail}` : ''}`);
  trace.lastAt = now;
}

/** A step measured by the renderer, logged under the same trace id. */
export function logRendererProviderSwitchMark(id: string, step: string, ms: number): void {
  logInfo(`provider-switch timing trace=${id.slice(0, 8)} step=renderer:${step} renderer_ms=${Math.max(0, Math.round(ms))}`);
}
