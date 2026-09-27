import { readDurableStrict, writeDurableNow } from './durable.js';
import { addLocalDays, ianaTimeZoneSchema, localDateAt, localDateSchema } from '../shared/schedule.js';
import {
  ISO_WEEKDAYS,
  resolveUserSchedule,
  type UserScheduleDayInput,
  type UserScheduleTemporaryChangeInput,
  type UserScheduleWindowInput,
  type UserWeeklyScheduleInput
} from '../shared/user-schedule.js';

const STATE = 'user-schedule';
const STATE_VERSION = 1 as const;
const MAX_CHANGES = 14;

export interface UserScheduleRecord {
  version: typeof STATE_VERSION;
  baseline: UserWeeklyScheduleInput;
  changes: UserScheduleTemporaryChangeInput[];
  updatedAt: number;
}

export interface UserScheduleReplaceInput {
  baseline: UserWeeklyScheduleInput;
  changes?: readonly UserScheduleTemporaryChangeInput[];
}

let mutations: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(work, work);
  mutations = result.catch(() => undefined);
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`${label} is invalid`);
}

function normalizeWindow(raw: unknown): UserScheduleWindowInput {
  const value = object(raw, 'User schedule window');
  exactKeys(value, ['start', 'end'], 'User schedule window');
  if (typeof value.start !== 'string' || typeof value.end !== 'string') throw new Error('User schedule window is invalid');
  return { start: value.start, end: value.end };
}

function normalizeDay(raw: unknown, label: string): UserScheduleDayInput {
  const value = object(raw, label);
  exactKeys(value, ['availability', 'windows'], label);
  if (value.availability !== 'known' && value.availability !== 'unknown') throw new Error(`${label} is invalid`);
  if (value.windows !== undefined && !Array.isArray(value.windows)) throw new Error(`${label} is invalid`);
  return {
    availability: value.availability,
    ...(value.windows === undefined ? {} : { windows: value.windows.map(normalizeWindow) })
  };
}

function normalizeBaseline(raw: unknown): UserWeeklyScheduleInput {
  const value = object(raw, 'User weekly schedule');
  exactKeys(value, ['timeZone', 'days'], 'User weekly schedule');
  if (typeof value.timeZone !== 'string') throw new Error('User weekly schedule is invalid');
  const timeZone = ianaTimeZoneSchema.parse(value.timeZone);
  const rawDays = object(value.days, 'User weekly schedule days');
  const days: UserWeeklyScheduleInput['days'] = {};
  const weekdayKeys = new Set(ISO_WEEKDAYS.map(String));
  if (Object.keys(rawDays).some(key => !weekdayKeys.has(key))) throw new Error('User weekly schedule days are invalid');
  for (const weekday of ISO_WEEKDAYS) {
    const rawDay = rawDays[String(weekday)];
    if (rawDay !== undefined) days[weekday] = normalizeDay(rawDay, `User weekday ${weekday}`);
  }
  return { timeZone, days };
}

function normalizeChange(raw: unknown): UserScheduleTemporaryChangeInput {
  const value = object(raw, 'Temporary user schedule change');
  exactKeys(value, ['date', 'availability', 'windows'], 'Temporary user schedule change');
  if (typeof value.date !== 'string') throw new Error('Temporary user schedule change is invalid');
  const date = localDateSchema.parse(value.date);
  return { date, ...normalizeDay({ availability: value.availability, windows: value.windows }, `Temporary user schedule change ${date}`) };
}

function normalizeInput(
  raw: UserScheduleReplaceInput | unknown,
  now: number,
  current: UserScheduleRecord | null
): Omit<UserScheduleRecord, 'version' | 'updatedAt'> {
  const value = object(raw, 'User schedule');
  exactKeys(value, ['baseline', 'changes'], 'User schedule');
  const baseline = normalizeBaseline(value.baseline);
  if (value.changes !== undefined && !Array.isArray(value.changes)) throw new Error('User schedule changes are invalid');
  const changes = (value.changes ?? []).map(normalizeChange);
  if (changes.length > MAX_CHANGES) throw new Error('Too many temporary user schedule changes');
  if (new Set(changes.map(change => change.date)).size !== changes.length) throw new Error('Temporary user schedule change dates must be unique');
  // Seven consecutive local days validate every weekly weekday. Historical temporary rows remain
  // durable context after their edit window; an ordinary weekly edit must not force the user to
  // erase them. Only a newly introduced or changed out-of-window row is refused.
  const first = localDateAt(now, baseline.timeZone);
  const last = addLocalDays(first, 6);
  const inWindow = changes.filter(change => change.date >= first && change.date <= last);
  const currentByDate = new Map((current?.changes ?? []).map(change => [change.date, change]));
  for (const change of changes) {
    if (change.date >= first && change.date <= last) continue;
    const held = currentByDate.get(change.date);
    if (!held || JSON.stringify(held) !== JSON.stringify(change)) {
      throw new Error('Temporary user schedule changes may only target the next 7 local calendar days');
    }
    // Validate preserved rows against the new baseline without applying today's horizon.
    resolveUserSchedule({ baseline, startDate: change.date, days: 1, changes: [change] });
  }
  resolveUserSchedule({
    baseline,
    startDate: first,
    days: 7,
    changes: inWindow
  });
  return { baseline, changes };
}

function parseStored(raw: unknown): UserScheduleRecord {
  const value = object(raw, 'Durable user schedule');
  exactKeys(value, ['version', 'baseline', 'changes', 'updatedAt'], 'Durable user schedule');
  if (value.version !== STATE_VERSION || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) {
    throw new Error('Durable user schedule is invalid');
  }
  const baseline = normalizeBaseline(value.baseline);
  if (!Array.isArray(value.changes) || value.changes.length > MAX_CHANGES) throw new Error('Durable user schedule is invalid');
  const changes = value.changes.map(normalizeChange);
  if (new Set(changes.map(change => change.date)).size !== changes.length) throw new Error('Durable user schedule is invalid');
  // Validate every stored wall-clock window without applying today's seven-day edit horizon.
  resolveUserSchedule({ baseline, startDate: '2026-01-05', days: 7 });
  for (const change of changes) {
    resolveUserSchedule({ baseline, startDate: change.date, days: 1, changes: [change] });
  }
  return { version: STATE_VERSION, baseline, changes, updatedAt: Number(value.updatedAt) };
}

async function load(): Promise<UserScheduleRecord | null> {
  const raw = await readDurableStrict<unknown>(STATE);
  return raw === null ? null : parseStored(raw);
}

export function readUserSchedule(): Promise<UserScheduleRecord | null> {
  return serial(async () => {
    const record = await load();
    return record ? structuredClone(record) : null;
  });
}

/** Replace the complete user availability document under one optimistic revision fence. */
export function replaceUserSchedule(
  raw: UserScheduleReplaceInput,
  expectedUpdatedAt: number | null,
  now = Date.now()
): Promise<UserScheduleRecord> {
  return serial(async () => {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('User schedule update time is invalid');
    const current = await load();
    if (current === null) {
      if (expectedUpdatedAt !== null) throw new Error('User schedule changed; refresh before editing it again');
    } else if (expectedUpdatedAt !== current.updatedAt) {
      throw new Error('User schedule changed; refresh before editing it again');
    }
    const normalized = normalizeInput(raw, now, current);
    const updatedAt = current ? Math.max(now, current.updatedAt + 1) : now;
    const next: UserScheduleRecord = { version: STATE_VERSION, ...normalized, updatedAt };
    await writeDurableNow(STATE, next);
    return structuredClone(next);
  });
}

/**
 * Resolve only currently relevant changes. Historical rows can remain durable audit context without
 * making tomorrow's read fail the next-seven-day validator.
 */
export async function resolveStoredUserSchedule(startDate: string, days = 7): Promise<ReturnType<typeof resolveUserSchedule> | null> {
  const record = await readUserSchedule();
  if (!record) return null;
  const first = localDateSchema.parse(startDate);
  const lastDate = addLocalDays(first, 6);
  return resolveUserSchedule({
    baseline: record.baseline,
    startDate: first,
    days,
    changes: record.changes.filter(change => change.date >= first && change.date <= lastDate)
  });
}

export function resetUserScheduleStoreForTests(): void {
  mutations = Promise.resolve();
}
