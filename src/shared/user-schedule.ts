import {
  addLocalDays,
  ianaTimeZoneSchema,
  localDateSchema,
  weekdayForLocalDate
} from './schedule.js';

export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export type IsoWeekday = typeof ISO_WEEKDAYS[number];
export type UserAvailabilityKnowledge = 'known' | 'unknown';

/**
 * A local wall-clock interval in the user's schedule timezone. `%schedule` stores availability,
 * not an implicit "everything else is free" rule: callers may intersect only resolved known
 * windows. Cross-midnight availability is represented as two explicit day windows.
 */
export interface UserScheduleWindowInput {
  start: string;
  end: string;
}

export interface UserScheduleDayInput {
  availability: UserAvailabilityKnowledge;
  /** Free/available windows for a known day. Unknown days must not carry windows. */
  windows?: readonly UserScheduleWindowInput[];
}

export interface UserWeeklyScheduleInput {
  /** IANA timezone owned by the durable schedule layer; this resolver keeps local wall-clock time. */
  timeZone: string;
  /** Missing weekdays are deliberately unknown, never inferred free. */
  days: Partial<Record<IsoWeekday, UserScheduleDayInput>>;
}

/**
 * One temporary date replacement. The UI can express a move by writing the complete effective
 * windows for that date. Replacement semantics avoid ambiguous additive/removal ordering.
 */
export interface UserScheduleTemporaryChangeInput extends UserScheduleDayInput {
  date: string;
}

export interface ResolveUserScheduleInput {
  baseline: UserWeeklyScheduleInput;
  /** First local calendar date to project, normally today. */
  startDate: string;
  /** This temporary-change projection is intentionally bounded to the next seven days. */
  days?: number;
  changes?: readonly UserScheduleTemporaryChangeInput[];
}

export interface NormalizedMinuteWindow {
  startMinute: number;
  endMinute: number;
}

export interface ResolvedUserScheduleWindow extends NormalizedMinuteWindow {
  /** Stable within one date projection and convenient for renderer/list keys. */
  key: string;
  startLocal: string;
  endLocal: string;
}

export interface ResolvedUserScheduleSnapshot {
  availability: UserAvailabilityKnowledge;
  windows: ResolvedUserScheduleWindow[];
}

export interface ResolvedUserScheduleDay {
  date: string;
  weekday: IsoWeekday;
  timeZone: string;
  source: 'weekly' | 'temporary' | 'unknown';
  temporaryChange: boolean;
  /** The recurring pattern, retained so UI can explain "Usually … → Today …". */
  usual: ResolvedUserScheduleSnapshot;
  /** Effective availability after the exact-date replacement, if any. */
  effective: ResolvedUserScheduleSnapshot;
}

export interface ResolvedUserSchedule {
  timeZone: string;
  startDate: string;
  days: ResolvedUserScheduleDay[];
}

export interface ResolvedAvailabilityOverlap extends NormalizedMinuteWindow {
  key: string;
  startLocal: string;
  endLocal: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseLocalTime(value: string, allowEndOfDay = false): number {
  if (allowEndOfDay && value === '24:00') return 24 * 60;
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid local schedule time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatLocalTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    throw new Error(`Invalid schedule minute: ${minutes}`);
  }
  if (minutes === 24 * 60) return '24:00';
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeMinuteWindows(windows: readonly NormalizedMinuteWindow[]): NormalizedMinuteWindow[] {
  const sorted = windows.map(window => {
    if (!Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute) ||
        window.startMinute < 0 || window.endMinute > 24 * 60 || window.startMinute >= window.endMinute) {
      throw new Error(`Invalid schedule window: ${window.startMinute}-${window.endMinute}`);
    }
    return { startMinute: window.startMinute, endMinute: window.endMinute };
  }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  const merged: NormalizedMinuteWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, window.endMinute);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function normalizeInputWindows(date: string, windows: readonly UserScheduleWindowInput[] | undefined): ResolvedUserScheduleWindow[] {
  const minuteWindows = (windows ?? []).map(window => {
    const startMinute = parseLocalTime(window.start);
    const endMinute = parseLocalTime(window.end, true);
    if (startMinute >= endMinute) {
      throw new Error(`Schedule windows must stay within one local date: ${date} ${window.start}-${window.end}`);
    }
    return { startMinute, endMinute };
  });
  return normalizeMinuteWindows(minuteWindows).map(window => ({
    ...window,
    key: `${date}:${window.startMinute}-${window.endMinute}`,
    startLocal: formatLocalTime(window.startMinute),
    endLocal: formatLocalTime(window.endMinute)
  }));
}

function resolveSnapshot(date: string, input: UserScheduleDayInput | undefined): ResolvedUserScheduleSnapshot {
  if (!input || input.availability === 'unknown') {
    if (input?.windows && input.windows.length > 0) {
      throw new Error(`Unknown availability cannot carry free windows: ${date}`);
    }
    return { availability: 'unknown', windows: [] };
  }
  return { availability: 'known', windows: normalizeInputWindows(date, input.windows) };
}

/**
 * Resolves `%schedule` into a deterministic local-time projection for Today / Next 7 days.
 * No current clock is read: the caller supplies the local start date, which keeps tests and
 * persistence reconciliation deterministic. Worker-3's durable schedule owner can later adapt its
 * shared types into this pure resolver without moving any authority here.
 */
export function resolveUserSchedule(input: ResolveUserScheduleInput): ResolvedUserSchedule {
  const count = input.days ?? 7;
  if (!Number.isInteger(count) || count < 1 || count > 7) {
    throw new Error('User schedule projection must contain between 1 and 7 days');
  }
  const timeZone = ianaTimeZoneSchema.parse(input.baseline.timeZone);
  const startDate = localDateSchema.parse(input.startDate);
  const lastTemporaryDate = addLocalDays(startDate, 6);
  const changes = new Map<string, UserScheduleTemporaryChangeInput>();
  for (const change of input.changes ?? []) {
    localDateSchema.parse(change.date);
    if (change.date < startDate || change.date > lastTemporaryDate) {
      throw new Error('Temporary user schedule changes may only target the next 7 local calendar days');
    }
    if (changes.has(change.date)) throw new Error(`Duplicate temporary schedule change: ${change.date}`);
    // Validate even out-of-view changes so malformed persisted/user input never hides in the tail.
    resolveSnapshot(change.date, change);
    changes.set(change.date, change);
  }

  const days: ResolvedUserScheduleDay[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = addLocalDays(startDate, offset);
    const weekday = weekdayForLocalDate(date) as IsoWeekday;
    const weekly = input.baseline.days[weekday];
    const usual = resolveSnapshot(date, weekly);
    const temporary = changes.get(date);
    const effective = temporary ? resolveSnapshot(date, temporary) : usual;
    days.push({
      date,
      weekday,
      timeZone,
      source: temporary ? 'temporary' : weekly ? 'weekly' : 'unknown',
      temporaryChange: temporary !== undefined,
      usual,
      effective
    });
  }
  return { timeZone, startDate, days };
}

/**
 * Intersects another lane's local windows with one resolved user day. Unknown user availability
 * always returns no overlap: absence of schedule evidence is never treated as free time.
 */
export function intersectResolvedUserAvailability(
  day: ResolvedUserScheduleDay,
  otherWindows: readonly NormalizedMinuteWindow[]
): ResolvedAvailabilityOverlap[] {
  if (day.effective.availability !== 'known') return [];
  const other = normalizeMinuteWindows(otherWindows);
  const intersections: NormalizedMinuteWindow[] = [];
  for (const user of day.effective.windows) {
    for (const candidate of other) {
      const startMinute = Math.max(user.startMinute, candidate.startMinute);
      const endMinute = Math.min(user.endMinute, candidate.endMinute);
      if (startMinute < endMinute) intersections.push({ startMinute, endMinute });
    }
  }
  return normalizeMinuteWindows(intersections).map(window => ({
    ...window,
    key: `${day.date}:overlap:${window.startMinute}-${window.endMinute}`,
    startLocal: formatLocalTime(window.startMinute),
    endLocal: formatLocalTime(window.endMinute)
  }));
}
