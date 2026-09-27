import { listEvecronExecutions } from './evecron-execution.js';
import { previewEveCronOccurrences, readScheduleState, type EveCronOccurrencePreview } from './schedule.js';
import { readUserSchedule, resolveStoredUserSchedule } from './user-schedule-store.js';
import { addLocalDays, localDateAt, resolveZonedLocalTime, type EveCronOccurrence } from '../shared/schedule.js';
import type { EvecronExecutionState } from '../shared/evecron-execution.js';
import type {
  ScheduleProjectionDay,
  ScheduleProjectionEveItem,
  ScheduleProjectionOverlapWindow,
  ScheduleProjectionReceipt,
  ScheduleProjectionWeeklyDay,
  ScheduleReadProjection
} from '../shared/schedule-projection.js';
import {
  ISO_WEEKDAYS,
  resolveUserSchedule,
  type IsoWeekday,
  type ResolvedUserScheduleSnapshot,
  type UserWeeklyScheduleInput
} from '../shared/user-schedule.js';

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

type ProjectionEveRow = EveCronOccurrence | EveCronOccurrencePreview;

function projectionLocal(at: number, timeZone: string): { date: string; minute: number } {
  const parts = new Map(new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).map(part => [part.type, part.value]));
  const date = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  return { date, minute: Number(parts.get('hour')) * 60 + Number(parts.get('minute')) };
}

function occurrenceStatus(
  occurrence: Pick<EveCronOccurrence, 'state'> | Pick<EveCronOccurrencePreview, 'state'>,
  execution: EvecronExecutionState | undefined
): ScheduleProjectionEveItem['status'] {
  if (execution) return execution.status;
  if (occurrence.state === 'running') return 'running';
  if (occurrence.state === 'done') return 'done';
  if (occurrence.state === 'failed') return 'failed';
  if (occurrence.state === 'skipped') return 'skipped';
  return 'scheduled';
}

function receiptViews(execution: EvecronExecutionState | undefined): ScheduleProjectionReceipt[] {
  if (!execution) return [];
  return execution.receipts.map(receipt => ({
    id: receipt.id,
    kind: receipt.kind,
    at: receipt.at,
    label: receipt.label,
    ...(receipt.detail ? { detail: receipt.detail } : {}),
    ...(receipt.links.resultRef
      ? { action: { kind: 'result' as const, targetId: receipt.links.resultRef } }
      : receipt.links.planId
        ? { action: { kind: 'plan' as const, targetId: receipt.links.planId } }
        : {})
  }));
}

function eveView(
  row: ProjectionEveRow,
  execution: EvecronExecutionState | undefined,
  projectionZone: string
): ScheduleProjectionEveItem {
  const local = projectionLocal(row.dueAt, projectionZone);
  const durationMinutes = row.durationMinutes ?? null;
  let endMinute: number | null = null;
  if (durationMinutes !== null) {
    const end = projectionLocal(row.dueAt + durationMinutes * MINUTE_MS, projectionZone);
    if (end.date > local.date) endMinute = 24 * 60;
    else if (end.date === local.date && end.minute > local.minute) endMinute = end.minute;
  }
  return {
    occurrenceId: row.id,
    entryId: row.entryId,
    entryVersion: row.entryVersion,
    title: row.entryTitle,
    date: local.date,
    startMinute: local.minute,
    durationMinutes,
    endMinute,
    status: occurrenceStatus(row, execution),
    temporary: row.nominal.localDate !== row.scheduled.localDate || row.nominal.localTime !== row.scheduled.localTime,
    receipts: receiptViews(execution)
  };
}

interface MinuteWindow {
  startMinute: number;
  endMinute: number;
}

function mergeMinuteWindows(windows: readonly MinuteWindow[]): MinuteWindow[] {
  const sorted = [...windows].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const merged: MinuteWindow[] = [];
  for (const window of sorted) {
    if (window.startMinute < 0 || window.endMinute > 24 * 60 || window.startMinute >= window.endMinute) {
      throw new Error('Projected Eve busy window is invalid');
    }
    const previous = merged.at(-1);
    if (previous && window.startMinute <= previous.endMinute) previous.endMinute = Math.max(previous.endMinute, window.endMinute);
    else merged.push({ ...window });
  }
  return merged;
}

function dayBounds(date: string, timeZone: string): { startAt: number; endAt: number } {
  return {
    startAt: resolveZonedLocalTime(date, '00:00', timeZone).dueAt,
    endAt: resolveZonedLocalTime(addLocalDays(date, 1), '00:00', timeZone).dueAt
  };
}

function projectBusyWindows(
  rows: readonly ProjectionEveRow[],
  dates: readonly string[],
  timeZone: string
): { unresolvedDuration: boolean; byDate: Map<string, MinuteWindow[]> } {
  const byDate = new Map<string, MinuteWindow[]>();
  const bounds = new Map(dates.map(date => [date, dayBounds(date, timeZone)]));
  const earliest = dates.length ? bounds.get(dates[0]!)!.startAt - DAY_MS : 0;
  const latest = dates.length ? bounds.get(dates.at(-1)!)!.endAt : 0;

  for (const row of rows) {
    if (row.state === 'skipped' || row.dueAt >= latest) continue;
    // A legacy occurrence immediately before the view can still run into the first day. With no
    // explicit bound, that ambiguity invalidates overlap rather than silently declaring Eve free.
    if (row.durationMinutes === undefined) {
      if (row.dueAt >= earliest) return { unresolvedDuration: true, byDate: new Map() };
      continue;
    }
    const busyEnd = row.dueAt + row.durationMinutes * MINUTE_MS;
    if (busyEnd <= bounds.get(dates[0]!)!.startAt) continue;
    for (const date of dates) {
      const day = bounds.get(date)!;
      const startAt = Math.max(row.dueAt, day.startAt);
      const endAt = Math.min(busyEnd, day.endAt);
      if (startAt >= endAt) continue;
      const startMinute = startAt === day.startAt ? 0 : projectionLocal(startAt, timeZone).minute;
      const endMinute = endAt === day.endAt ? 24 * 60 : projectionLocal(endAt, timeZone).minute;
      // A duration crossing the repeated part of a DST fold cannot be represented faithfully by
      // one wall-clock minute interval. Fail closed instead of flattening two real instants together.
      if (endMinute <= startMinute) return { unresolvedDuration: true, byDate: new Map() };
      const held = byDate.get(date) ?? [];
      held.push({ startMinute, endMinute });
      byDate.set(date, held);
    }
  }
  for (const [date, windows] of byDate) byDate.set(date, mergeMinuteWindows(windows));
  return { unresolvedDuration: false, byDate };
}

function subtractBusy(
  free: readonly { startMinute: number; endMinute: number }[],
  busy: readonly MinuteWindow[]
): MinuteWindow[] {
  const result: MinuteWindow[] = [];
  const normalizedBusy = mergeMinuteWindows(busy);
  for (const available of free) {
    let cursor = available.startMinute;
    for (const occupied of normalizedBusy) {
      if (occupied.endMinute <= cursor) continue;
      if (occupied.startMinute >= available.endMinute) break;
      if (occupied.startMinute > cursor) {
        result.push({ startMinute: cursor, endMinute: Math.min(occupied.startMinute, available.endMinute) });
      }
      cursor = Math.max(cursor, occupied.endMinute);
      if (cursor >= available.endMinute) break;
    }
    if (cursor < available.endMinute) result.push({ startMinute: cursor, endMinute: available.endMinute });
  }
  return result;
}

function overlapProjection(
  userDays: readonly ScheduleProjectionDay[],
  rows: readonly ProjectionEveRow[],
  timeZone: string,
  now: number
): { overlap: ScheduleReadProjection['overlap']; nextOverlap: ScheduleReadProjection['nextOverlap'] } {
  const dates = userDays.map(day => day.date);
  if (!dates.length) return { overlap: { status: 'resolved', windows: [] }, nextOverlap: null };
  const busy = projectBusyWindows(rows, dates, timeZone);
  if (busy.unresolvedDuration) {
    return { overlap: { status: 'unresolved-eve-duration', windows: [] }, nextOverlap: null };
  }
  const nowLocal = projectionLocal(now, timeZone);
  const windows: ScheduleProjectionOverlapWindow[] = [];
  for (const day of userDays) {
    if (day.user.effective.availability !== 'known') continue;
    const free = subtractBusy(day.user.effective.windows, busy.byDate.get(day.date) ?? []);
    for (const window of free) {
      const current = day.date === nowLocal.date && window.startMinute <= nowLocal.minute && nowLocal.minute < window.endMinute;
      windows.push({
        id: `${day.date}:overlap:${window.startMinute}-${window.endMinute}`,
        date: day.date,
        ...window,
        current
      });
    }
  }
  windows.sort((left, right) => left.date.localeCompare(right.date) || left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const nextOverlap = windows.find(window =>
    window.date > nowLocal.date || (window.date === nowLocal.date && window.endMinute > nowLocal.minute)
  ) ?? null;
  return { overlap: { status: 'resolved', windows }, nextOverlap };
}

function unknownSnapshot(): ResolvedUserScheduleSnapshot {
  return { availability: 'unknown', windows: [] };
}

function emptyUserBaseline(timeZone: string): UserWeeklyScheduleInput {
  return { timeZone, days: {} };
}

/**
 * Read-only schedule projection for the desktop renderer. It reads durable state and pure recurrence
 * previews only; it never materializes an occurrence, claims work, writes a receipt or changes a
 * user schedule revision.
 */
export async function readScheduleProjection(options: { now?: number; days?: number } = {}): Promise<ScheduleReadProjection> {
  const now = options.now ?? Date.now();
  const dayCount = options.days ?? 7;
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) throw new Error('Schedule projection must contain between 1 and 7 days');
  const [core, userRecord, executions] = await Promise.all([
    readScheduleState(),
    readUserSchedule(),
    listEvecronExecutions()
  ]);
  const timeZone = userRecord?.baseline.timeZone ?? core.defaultTimeZone;
  const startDate = localDateAt(now, timeZone);
  const user = userRecord
    ? await resolveStoredUserSchedule(startDate, dayCount)
    : resolveUserSchedule({ baseline: emptyUserBaseline(timeZone), startDate, days: dayCount });
  if (!user) throw new Error('User schedule projection unexpectedly disappeared');

  const rangeStart = dayBounds(addLocalDays(startDate, -1), timeZone).startAt;
  const rangeEnd = dayBounds(addLocalDays(startDate, dayCount), timeZone).startAt;
  const previews = previewEveCronOccurrences(core.entries, rangeStart, rangeEnd);
  const persistedBySlot = new Map(core.occurrences.map(row => [row.slotKey, row]));
  const projectedRows = previews.map(row => persistedBySlot.get(row.slotKey) ?? row);
  const previewIds = new Set(projectedRows.map(row => row.id));
  for (const occurrence of core.occurrences) {
    if (!previewIds.has(occurrence.id)) projectedRows.push(occurrence);
  }
  const executionByOccurrence = new Map(executions.map(state => [state.binding.occurrenceId, state]));
  const eve = projectedRows
    .map(row => eveView(row, executionByOccurrence.get(row.id), timeZone))
    .filter(row => row.date >= startDate && row.date < addLocalDays(startDate, dayCount))
    .sort((left, right) => left.date.localeCompare(right.date) || left.startMinute - right.startMinute || left.occurrenceId.localeCompare(right.occurrenceId));

  const byDate = new Map<string, ScheduleProjectionEveItem[]>();
  for (const row of eve) {
    const held = byDate.get(row.date) ?? [];
    held.push(row);
    byDate.set(row.date, held);
  }
  const days: ScheduleProjectionDay[] = user.days.map(day => ({
    date: day.date,
    weekday: day.weekday,
    user: {
      source: day.source,
      temporaryChange: day.temporaryChange,
      usual: day.usual,
      effective: day.effective
    },
    eve: byDate.get(day.date) ?? []
  }));

  const weeklyUser = resolveUserSchedule({ baseline: userRecord?.baseline ?? emptyUserBaseline(timeZone), startDate: '2026-01-05', days: 7 });
  const usualWeek: ScheduleProjectionWeeklyDay[] = ISO_WEEKDAYS.map((weekday, index) => ({
    weekday,
    user: weeklyUser.days[index]?.usual ?? unknownSnapshot(),
    eve: core.entries
      .filter(entry => entry.trigger.kind === 'weekly' && entry.trigger.weekdays.includes(weekday))
      .map(entry => ({
        entryId: entry.id,
        title: entry.title,
        weekday: weekday as IsoWeekday,
        localTime: entry.trigger.localTime,
        timeZone: entry.trigger.timeZone,
        durationMinutes: entry.durationMinutes ?? null,
        state: entry.state
      }))
      .sort((left, right) => left.localTime.localeCompare(right.localTime) || left.entryId.localeCompare(right.entryId))
  }));

  const resolvedOverlap = overlapProjection(days, projectedRows, timeZone, now);
  return {
    timeZone,
    startDate,
    userScheduleUpdatedAt: userRecord?.updatedAt ?? null,
    days,
    usualWeek,
    ...resolvedOverlap
  };
}
