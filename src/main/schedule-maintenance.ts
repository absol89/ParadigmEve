import { admitEvecronOccurrence } from './evecron-runner.js';
import { materializeEveCronOccurrences } from './schedule.js';
import { listInputs, type InputEntry } from './session/input.js';
import type { EveCronOccurrence } from '../shared/schedule.js';

export const SCHEDULE_MAINTENANCE_INTERVAL_MS = 60_000;
export const SCHEDULE_MAINTENANCE_LOOKBACK_MS = 24 * 60 * 60_000;
export const SCHEDULE_MAINTENANCE_LOOKAHEAD_MS = 7 * 24 * 60 * 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ScheduleMaintenanceRunResult {
  materialized: number;
  due: number;
  admitted: string[];
  alreadyAdmitted: string[];
  ignoredNonInstallation: string[];
  failed: Array<{ occurrenceId: string; error: string }>;
}

interface ScheduleMaintenanceDeps {
  now: () => number;
  materialize: (fromAt: number, throughAt: number, now: number) => Promise<EveCronOccurrence[]>;
  inputs: () => Promise<InputEntry[]>;
  admit: (occurrenceId: string, now: number) => Promise<unknown>;
}

export interface ScheduleMaintenanceOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onRun?: (result: ScheduleMaintenanceRunResult) => void;
  onError?: (error: Error) => void;
  /** Tests may replace the durable seams; production callers should leave this unset. */
  deps?: Partial<ScheduleMaintenanceDeps>;
}

function dependencies(options: ScheduleMaintenanceOptions): ScheduleMaintenanceDeps {
  return {
    now: options.deps?.now ?? options.now ?? Date.now,
    materialize: options.deps?.materialize ?? materializeEveCronOccurrences,
    inputs: options.deps?.inputs ?? listInputs,
    admit: options.deps?.admit ?? admitEvecronOccurrence
  };
}

function exactScheduleInput(row: InputEntry, occurrence: EveCronOccurrence): boolean {
  return row.id === occurrence.inputId && row.purpose === 'schedule' && row.scheduleOccurrenceId === occurrence.id;
}

/**
 * One bounded maintenance pass.
 *
 * The schedule core is the sole recurrence/authority owner. Maintenance only materializes its
 * already-authorized horizon and hands due installation-agent rows to the existing fresh-chat
 * runner. A durable outbox row is the admission receipt: once it exists, later ticks/restarts do
 * not call the runner again. A claimed occurrence with no outbox row is deliberately retried so a
 * crash between the schedule claim and outbox commit can heal via the runner's stable input id.
 */
export async function runScheduleMaintenanceOnce(
  options: Pick<ScheduleMaintenanceOptions, 'now' | 'deps'> = {}
): Promise<ScheduleMaintenanceRunResult> {
  const deps = dependencies(options);
  const now = deps.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Schedule maintenance clock is invalid');
  const occurrences = await deps.materialize(
    Math.max(0, now - SCHEDULE_MAINTENANCE_LOOKBACK_MS),
    now + SCHEDULE_MAINTENANCE_LOOKAHEAD_MS,
    now
  );
  const outbox = await deps.inputs();
  const due = occurrences
    .filter(row => row.state === 'scheduled' && row.dueAt <= now)
    .sort((left, right) => left.dueAt - right.dueAt || left.id.localeCompare(right.id));
  const result: ScheduleMaintenanceRunResult = {
    materialized: occurrences.length,
    due: due.length,
    admitted: [],
    alreadyAdmitted: [],
    ignoredNonInstallation: [],
    failed: []
  };

  for (const occurrence of due) {
    if (occurrence.work.target.kind !== 'installation-agent') {
      result.ignoredNonInstallation.push(occurrence.id);
      continue;
    }
    if (outbox.some(row => exactScheduleInput(row, occurrence))) {
      result.alreadyAdmitted.push(occurrence.id);
      continue;
    }
    try {
      await deps.admit(occurrence.id, now);
      result.admitted.push(occurrence.id);
    } catch (error) {
      result.failed.push({ occurrenceId: occurrence.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Start one non-overlapping process-owned maintenance loop; returned stop waits for an active pass. */
export function startScheduleMaintenance(options: ScheduleMaintenanceOptions = {}): () => Promise<void> {
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let timer: TimerHandle | null = null;
  let stopped = false;
  let active: Promise<void> = Promise.resolve();

  const scheduleNext = (): void => {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, SCHEDULE_MAINTENANCE_INTERVAL_MS);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const pass = runScheduleMaintenanceOnce(options)
      .then((result) => {
        scheduleNext();
        options.onRun?.(result);
      })
      .catch((error) => {
        scheduleNext();
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    active = pass;
    await pass;
    if (active === pass) active = Promise.resolve();
  };

  void tick();
  return async () => {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    await active;
  };
}
