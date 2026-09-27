import { z } from 'zod';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { eveCronOccurrenceSchema, type EveCronOccurrence } from '../shared/schedule.js';
import {
  applyEvecronExecutionEvent as applyEvent,
  createEvecronExecutionState,
  evecronExecutionStateSchema,
  markEvecronReceiptShown,
  pendingEvecronReceipts as projectPendingReceipts,
  reconcileEvecronExecutionState,
  type EvecronExecutionEvent,
  type EvecronExecutionState,
  type EvecronReceipt
} from '../shared/evecron-execution.js';

/**
 * Durable progress/receipt state for schedule occurrences. It never claims, sends, starts, retries,
 * cancels or completes work; those actions stay with the schedule/session/worker owners.
 */

const STATE = 'evecron-execution';
const catalogSchema = z.object({
  version: z.literal(1),
  occurrences: z.array(evecronExecutionStateSchema).max(2_000)
}).strict().refine(value => new Set(value.occurrences.map(row => row.binding.occurrenceId)).size === value.occurrences.length, {
  message: 'Execution receipt occurrence ids must be unique'
});

let mutations: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutations.then(work, work);
  mutations = operation.catch(() => undefined);
  return operation;
}

async function readStates(): Promise<EvecronExecutionState[]> {
  const raw = await readDurableStrict<unknown>(STATE);
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Eve schedule execution receipts are invalid');
  return parsed.data.occurrences;
}

async function writeStates(occurrences: EvecronExecutionState[]): Promise<void> {
  await writeDurableNow(STATE, catalogSchema.parse({ version: 1, occurrences }));
}

function sameBinding(left: EvecronExecutionState, right: EvecronExecutionState): boolean {
  return JSON.stringify(left.binding) === JSON.stringify(right.binding) && left.planId === right.planId;
}

/** Bind exactly one schedule-core occurrence to its receipt ledger, idempotently across restart. */
export function bindEvecronExecution(rawOccurrence: EveCronOccurrence): Promise<EvecronExecutionState> {
  return serial(async () => {
    const occurrence = eveCronOccurrenceSchema.parse(rawOccurrence);
    const states = await readStates();
    const index = states.findIndex(row => row.binding.occurrenceId === occurrence.id);
    const prior = index >= 0 ? states[index]! : undefined;
    if (prior) {
      const candidate = occurrence.state === 'done' || occurrence.state === 'failed'
        ? prior
        : createEvecronExecutionState(occurrence);
      if (!sameBinding(prior, candidate)) throw new Error('Scheduled occurrence id already belongs to different receipt authority');
      const reconciled = reconcileEvecronExecutionState(prior, occurrence);
      if (JSON.stringify(reconciled) !== JSON.stringify(prior)) {
        const next = [...states];
        next[index] = reconciled;
        await writeStates(next);
      }
      return reconciled;
    }
    const candidate = createEvecronExecutionState(occurrence);
    await writeStates([...states, candidate]);
    return candidate;
  });
}

/** Persist one evidence-backed transition before any caller presents its receipt. */
export function recordEvecronExecutionEvent(
  occurrenceId: string,
  event: EvecronExecutionEvent
): Promise<{ state: EvecronExecutionState; receipt: EvecronReceipt | null; duplicate: boolean }> {
  return serial(async () => {
    const states = await readStates();
    const index = states.findIndex(row => row.binding.occurrenceId === occurrenceId);
    if (index < 0) throw new Error('Scheduled occurrence execution receipt state does not exist');
    const transition = applyEvent(states[index]!, event);
    if (!transition.duplicate) {
      const next = [...states];
      next[index] = transition.state;
      await writeStates(next);
    }
    return transition;
  });
}

/**
 * A receipt remains pending until the presentation owner confirms that exact id was shown. Restart
 * therefore re-presents a lost notification without minting a second Start/Done receipt.
 */
export function acknowledgeEvecronReceipt(
  occurrenceId: string,
  receiptId: string,
  shownAt = Date.now()
): Promise<EvecronExecutionState> {
  return serial(async () => {
    const states = await readStates();
    const index = states.findIndex(row => row.binding.occurrenceId === occurrenceId);
    if (index < 0) throw new Error('Scheduled occurrence execution receipt state does not exist');
    const nextState = markEvecronReceiptShown(states[index]!, receiptId, shownAt);
    const next = [...states];
    next[index] = nextState;
    await writeStates(next);
    return nextState;
  });
}

export async function listEvecronExecutions(): Promise<EvecronExecutionState[]> {
  return readStates();
}

export async function pendingEvecronReceipts(mode: 'quiet' | 'noisy' = 'quiet'): Promise<EvecronReceipt[]> {
  return projectPendingReceipts(await readStates(), mode);
}

/** Test seam only: durable receipt bytes stay on disk, matching an app-process restart. */
export function resetEvecronExecutionForTests(): void {
  mutations = Promise.resolve();
}
