import { createHash, randomUUID } from 'node:crypto';
import { readDurableStrict, writeDurableNow } from './durable.js';
import {
  addLocalDays,
  entryTimeZone,
  eveCronEntryCreateSchema,
  eveCronEntrySchema,
  eveCronEntryPatchSchema,
  eveCronOccurrenceSchema,
  frozenScheduleWorkSchema,
  ianaTimeZoneSchema,
  localDateAt,
  resolveZonedLocalTime,
  scheduleCompletionReceiptSchema,
  scheduleDeliveryReceiptSchema,
  scheduleFailureSchema,
  scheduleStateSchema,
  weekdayForLocalDate,
  type EveCronEntry,
  type EveCronEntryCreate,
  type EveCronEntryPatch,
  type EveCronOccurrence,
  type FrozenScheduleWork,
  type ScheduleCompletionReceipt,
  type ScheduleDeliveryReceipt,
  type ScheduleFailure,
  type ScheduleLocalSlot,
  type ScheduleState
} from '../shared/schedule.js';

const STATE = 'schedule';
const STATE_VERSION = 1 as const;
const DAY_MS = 24 * 60 * 60_000;
const MAX_MATERIALIZATION_DAYS = 32;

let mutations: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(work, work);
  mutations = result.catch(() => undefined);
  return result;
}

function systemTimeZone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return ianaTimeZoneSchema.parse(detected);
}

function emptyState(defaultTimeZone = systemTimeZone()): ScheduleState {
  return { version: STATE_VERSION, defaultTimeZone: ianaTimeZoneSchema.parse(defaultTimeZone), entries: [], occurrences: [] };
}

async function loadState(): Promise<ScheduleState> {
  const raw = await readDurableStrict<unknown>(STATE);
  return raw === null ? emptyState() : scheduleStateSchema.parse(raw);
}

async function publish(state: ScheduleState): Promise<void> {
  await writeDurableNow(STATE, scheduleStateSchema.parse(state));
}

function nextTimestamp(previous: number, now: number): number {
  return Math.max(now, previous + 1);
}

function canonicalWorkPayload(work: Pick<FrozenScheduleWork, 'target' | 'text' | 'automation' | 'objective' | 'projectId' | 'context'>): string {
  return JSON.stringify({
    target: work.target,
    text: work.text,
    automation: work.automation ?? 'off',
    objective: work.objective ?? null,
    projectId: work.projectId ?? null,
    context: work.context ?? null
  });
}

/** Hash only executable work. A Plan/Pin reference is provenance and cannot grant authority. */
export function eveCronWorkPayloadHash(
  work: Pick<FrozenScheduleWork, 'target' | 'text' | 'automation' | 'objective' | 'projectId' | 'context'>
): string {
  return createHash('sha256').update(canonicalWorkPayload(work), 'utf8').digest('hex');
}

/**
 * Schedules authorized before 2.3.4 were hashed without a `context` key. The key was added to the
 * canonical payload later, which silently invalidated every stored schedule. Work without context
 * is byte-identical in meaning to what the user authorized, so also accept the legacy digest for it.
 */
export function eveCronWorkAuthorityMatches(
  work: Pick<FrozenScheduleWork, 'target' | 'text' | 'automation' | 'objective' | 'projectId' | 'context' | 'authority'>
): boolean {
  const recorded = work.authority.payloadHash;
  if (recorded === eveCronWorkPayloadHash(work)) return true;
  if (work.context) return false;
  const legacy = JSON.stringify({
    target: work.target,
    text: work.text,
    automation: work.automation ?? 'off',
    objective: work.objective ?? null,
    projectId: work.projectId ?? null
  });
  return recorded === createHash('sha256').update(legacy, 'utf8').digest('hex');
}

function assertFrozenWorkAuthority(work: FrozenScheduleWork): void {
  const parsed = frozenScheduleWorkSchema.parse(work);
  if (!eveCronWorkAuthorityMatches(parsed)) {
    throw new Error('Scheduled work authority does not match its executable payload');
  }
}

function dateIndex(localDate: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day) / DAY_MS);
}

function exceptionWindow(entry: Pick<EveCronEntry, 'trigger' | 'exceptions'> | Pick<EveCronEntryCreate, 'trigger' | 'exceptions'>, now: number): void {
  const zone = entryTimeZone(entry);
  const today = localDateAt(now, zone);
  const start = dateIndex(today);
  const end = start + 6;
  for (const exception of entry.exceptions) {
    const nominalIndex = dateIndex(exception.nominalDate);
    if (nominalIndex < start || nominalIndex > end) {
      throw new Error('Schedule exceptions may only target the next 7 local calendar days');
    }
    if (entry.trigger.kind === 'once') {
      if (exception.nominalDate !== entry.trigger.localDate) throw new Error('A one-time exception must target its one scheduled date');
    } else {
      if (entry.trigger.startsOn && exception.nominalDate < entry.trigger.startsOn) {
        throw new Error('A weekly exception cannot target a date before the schedule starts');
      }
      if (!entry.trigger.weekdays.includes(weekdayForLocalDate(exception.nominalDate))) {
        throw new Error('A weekly exception must target one of the entry weekdays');
      }
    }
    if (exception.action === 'move') {
      const movedIndex = dateIndex(exception.moveTo.localDate);
      if (movedIndex < start || movedIndex > end) {
        throw new Error('Moved occurrences must stay inside the next 7 local calendar days');
      }
    }
  }
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function occurrenceSlotKey(entry: EveCronEntry, nominalDate: string): string {
  return `${entry.id}:${nominalDate}T${entry.trigger.localTime}@${entry.trigger.timeZone}`;
}

interface CandidateOccurrence {
  slotKey: string;
  nominal: ScheduleLocalSlot;
  scheduled: ScheduleLocalSlot;
  dueAt: number;
  dstResolution: EveCronOccurrence['dstResolution'];
  skipped: boolean;
  skipReason?: EveCronOccurrence['skipReason'];
  skipNote?: string;
}

function candidateDates(entry: EveCronEntry, fromAt: number, throughAt: number): string[] {
  if (entry.trigger.kind === 'once') return [entry.trigger.localDate];
  const zone = entry.trigger.timeZone;
  const first = addLocalDays(localDateAt(fromAt, zone), -1);
  const last = addLocalDays(localDateAt(throughAt, zone), 1);
  const dates = new Set<string>();
  for (let date = first, count = 0; date <= last && count <= MAX_MATERIALIZATION_DAYS + 2; date = addLocalDays(date, 1), count += 1) {
    if (entry.trigger.startsOn && date < entry.trigger.startsOn) continue;
    if (entry.trigger.weekdays.includes(weekdayForLocalDate(date))) dates.add(date);
  }
  // A moved exception may be materialized while its effective date is in the requested horizon
  // even after the nominal weekday has moved just behind the horizon boundary.
  for (const exception of entry.exceptions) dates.add(exception.nominalDate);
  return [...dates].sort();
}

function candidateFor(entry: EveCronEntry, nominalDate: string): CandidateOccurrence | null {
  if (entry.trigger.kind === 'once' && nominalDate !== entry.trigger.localDate) return null;
  if (entry.trigger.kind === 'weekly') {
    if (entry.trigger.startsOn && nominalDate < entry.trigger.startsOn) return null;
    if (!entry.trigger.weekdays.includes(weekdayForLocalDate(nominalDate))) return null;
  }
  const zone = entry.trigger.timeZone;
  const nominal: ScheduleLocalSlot = { localDate: nominalDate, localTime: entry.trigger.localTime, timeZone: zone };
  const exception = entry.exceptions.find(value => value.nominalDate === nominalDate);
  const scheduled: ScheduleLocalSlot = exception?.action === 'move'
    ? { ...exception.moveTo, timeZone: zone }
    : nominal;
  const resolved = resolveZonedLocalTime(scheduled.localDate, scheduled.localTime, zone);
  const skipped = entry.state === 'paused' || exception?.action === 'skip';
  return {
    slotKey: occurrenceSlotKey(entry, nominalDate),
    nominal,
    scheduled,
    dueAt: resolved.dueAt,
    dstResolution: resolved.resolution,
    skipped,
    ...(skipped ? { skipReason: exception?.action === 'skip' ? 'exception' as const : 'paused' as const } : {}),
    ...(skipped && exception?.reason ? { skipNote: exception.reason } : {})
  };
}

function candidateOccurrences(entry: EveCronEntry, fromAt: number, throughAt: number): CandidateOccurrence[] {
  return candidateDates(entry, fromAt, throughAt)
    .flatMap(date => {
      const candidate = candidateFor(entry, date);
      return candidate ? [candidate] : [];
    })
    .filter(candidate => candidate.dueAt >= fromAt && candidate.dueAt <= throughAt);
}

export interface EveCronOccurrencePreview {
  id: string;
  slotKey: string;
  entryId: string;
  entryVersion: number;
  entryTitle: string;
  nominal: ScheduleLocalSlot;
  scheduled: ScheduleLocalSlot;
  dueAt: number;
  dstResolution: EveCronOccurrence['dstResolution'];
  durationMinutes?: number;
  state: 'scheduled' | 'skipped';
  skipReason?: EveCronOccurrence['skipReason'];
  skipNote?: string;
}

/**
 * Pure read-only recurrence projection. It deliberately omits executable work and receipt
 * capabilities, so a renderer/read API can preview the same slots the materializer would create
 * without writing state or leaking execution authority.
 */
export function previewEveCronOccurrences(
  rawEntries: readonly EveCronEntry[],
  fromAt: number,
  throughAt: number
): EveCronOccurrencePreview[] {
  if (!Number.isSafeInteger(fromAt) || !Number.isSafeInteger(throughAt) || fromAt < 0 || throughAt < fromAt) {
    throw new Error('Schedule projection range is invalid');
  }
  if (throughAt - fromAt > MAX_MATERIALIZATION_DAYS * DAY_MS) throw new Error('Schedule projection range is too large');
  const previews: EveCronOccurrencePreview[] = [];
  for (const rawEntry of rawEntries) {
    const entry = eveCronEntrySchema.parse(rawEntry);
    for (const candidate of candidateOccurrences(entry, fromAt, throughAt)) {
      previews.push({
        id: deterministicUuid(`evecron-occurrence\0${candidate.slotKey}`),
        slotKey: candidate.slotKey,
        entryId: entry.id,
        entryVersion: entry.updatedAt,
        entryTitle: entry.title,
        nominal: candidate.nominal,
        scheduled: candidate.scheduled,
        dueAt: candidate.dueAt,
        dstResolution: candidate.dstResolution,
        ...(entry.durationMinutes === undefined ? {} : { durationMinutes: entry.durationMinutes }),
        state: candidate.skipped ? 'skipped' : 'scheduled',
        ...(candidate.skipReason ? { skipReason: candidate.skipReason } : {}),
        ...(candidate.skipNote ? { skipNote: candidate.skipNote } : {})
      });
    }
  }
  return previews.sort((left, right) => left.dueAt - right.dueAt || left.id.localeCompare(right.id));
}

function terminalOrClaimed(occurrence: EveCronOccurrence): boolean {
  return occurrence.claimedAt !== undefined || occurrence.state === 'running' || occurrence.state === 'done' || occurrence.state === 'failed';
}

function occurrenceFromCandidate(entry: EveCronEntry, candidate: CandidateOccurrence, existing: EveCronOccurrence | undefined, now: number): EveCronOccurrence {
  const id = existing?.id ?? deterministicUuid(`evecron-occurrence\0${candidate.slotKey}`);
  const inputId = existing?.inputId ?? deterministicUuid(`evecron-input\0${candidate.slotKey}`);
  const receiptKey = existing?.receiptKey ?? `evecron:${randomUUID()}`;
  const projected = eveCronOccurrenceSchema.parse({
    id,
    slotKey: candidate.slotKey,
    entryId: entry.id,
    entryVersion: entry.updatedAt,
    entryTitle: entry.title,
    nominal: candidate.nominal,
    scheduled: candidate.scheduled,
    dueAt: candidate.dueAt,
    dstResolution: candidate.dstResolution,
    ...(entry.durationMinutes === undefined ? {} : { durationMinutes: entry.durationMinutes }),
    inputId,
    receiptKey,
    state: candidate.skipped ? 'skipped' : 'scheduled',
    work: entry.work,
    ...(candidate.skipReason ? { skipReason: candidate.skipReason } : {}),
    ...(candidate.skipNote ? { skipNote: candidate.skipNote } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now
  });
  if (!existing || JSON.stringify(projected) === JSON.stringify(existing)) return projected;
  return eveCronOccurrenceSchema.parse({ ...projected, updatedAt: nextTimestamp(existing.updatedAt, now) });
}

export function readScheduleState(): Promise<ScheduleState> {
  return serial(async () => structuredClone(await loadState()));
}

export function createEveCronEntry(input: EveCronEntryCreate, now = Date.now()): Promise<EveCronEntry> {
  return serial(async () => {
    const parsed = eveCronEntryCreateSchema.parse(input);
    assertFrozenWorkAuthority(parsed.work);
    exceptionWindow(parsed, now);
    const state = await loadState();
    if (state.entries.length >= 500) throw new Error('Schedule entry limit reached');
    const entry: EveCronEntry = { id: randomUUID(), ...parsed, createdAt: now, updatedAt: now };
    await publish({ ...state, entries: [...state.entries, entry] });
    return structuredClone(entry);
  });
}

export function updateEveCronEntry(id: string, patch: EveCronEntryPatch, expectedUpdatedAt: number, now = Date.now()): Promise<EveCronEntry> {
  return serial(async () => {
    const parsedPatch = eveCronEntryPatchSchema.parse(patch);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new Error('Schedule revision is invalid');
    const state = await loadState();
    const index = state.entries.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('Schedule entry not found');
    const current = state.entries[index]!;
    if (current.updatedAt !== expectedUpdatedAt) throw new Error('Schedule changed; refresh before editing it again');
    const updated = eveCronEntryCreateSchema.parse({
      title: parsedPatch.title ?? current.title,
      state: parsedPatch.state ?? current.state,
      durationMinutes: parsedPatch.durationMinutes ?? current.durationMinutes,
      trigger: parsedPatch.trigger ?? current.trigger,
      exceptions: parsedPatch.exceptions ?? current.exceptions,
      work: parsedPatch.work ?? current.work
    });
    assertFrozenWorkAuthority(updated.work);
    // Historical exceptions may remain as audit/context after their seven-day editing window.
    // Ordinary title/state/work edits must not become impossible merely because time advanced.
    if (parsedPatch.trigger !== undefined || parsedPatch.exceptions !== undefined) exceptionWindow(updated, now);
    const entry: EveCronEntry = {
      id: current.id,
      ...updated,
      createdAt: current.createdAt,
      updatedAt: nextTimestamp(current.updatedAt, now)
    };
    const entries = [...state.entries];
    entries[index] = entry;
    await publish({ ...state, entries });
    return structuredClone(entry);
  });
}

/**
 * Reconcile a bounded occurrence horizon. Already-claimed/running/terminal rows are immutable;
 * only future unclaimed rows may adopt a newer entry revision or become schedule-edited skips.
 */
export function materializeEveCronOccurrences(fromAt: number, throughAt: number, now = Date.now()): Promise<EveCronOccurrence[]> {
  return serial(async () => {
    if (!Number.isSafeInteger(fromAt) || !Number.isSafeInteger(throughAt) || fromAt < 0 || throughAt < fromAt) {
      throw new Error('Schedule materialization range is invalid');
    }
    if (throughAt - fromAt > MAX_MATERIALIZATION_DAYS * DAY_MS) throw new Error('Schedule materialization range is too large');
    const state = await loadState();
    const existingBySlot = new Map(state.occurrences.map(row => [row.slotKey, row]));
    const desired = new Map<string, { entry: EveCronEntry; candidate: CandidateOccurrence }>();
    for (const entry of state.entries) {
      assertFrozenWorkAuthority(entry.work);
      for (const candidate of candidateOccurrences(entry, fromAt, throughAt)) desired.set(candidate.slotKey, { entry, candidate });
    }

    const next = [...state.occurrences];
    const indexById = new Map(next.map((row, index) => [row.id, index]));
    for (const { entry, candidate } of desired.values()) {
      const existing = existingBySlot.get(candidate.slotKey);
      if (existing && (terminalOrClaimed(existing) || existing.dueAt < now)) continue;
      const occurrence = occurrenceFromCandidate(entry, candidate, existing, now);
      if (existing) next[indexById.get(existing.id)!] = occurrence;
      else {
        indexById.set(occurrence.id, next.length);
        next.push(occurrence);
      }
    }

    for (const existing of state.occurrences) {
      if (existing.dueAt < fromAt || existing.dueAt > throughAt || desired.has(existing.slotKey) ||
          terminalOrClaimed(existing) || existing.dueAt < now) continue;
      if (existing.state === 'skipped' && existing.skipReason === 'schedule-edited') continue;
      const replacement = eveCronOccurrenceSchema.parse({
        ...existing,
        state: 'skipped',
        skipReason: 'schedule-edited',
        skipNote: undefined,
        delivery: undefined,
        completion: undefined,
        failure: undefined,
        updatedAt: nextTimestamp(existing.updatedAt, now)
      });
      next[indexById.get(existing.id)!] = replacement;
    }

    const parsed = scheduleStateSchema.parse({ ...state, occurrences: next });
    if (JSON.stringify(parsed.occurrences) !== JSON.stringify(state.occurrences)) await publish(parsed);
    return structuredClone(parsed.occurrences.filter(row => row.dueAt >= fromAt && row.dueAt <= throughAt));
  });
}

export function claimEveCronOccurrence(id: string, inputId: string, claimedAt = Date.now()): Promise<EveCronOccurrence> {
  return serial(async () => {
    const state = await loadState();
    const index = state.occurrences.findIndex(row => row.id === id);
    if (index < 0) throw new Error('Schedule occurrence not found');
    const current = state.occurrences[index]!;
    if (current.inputId !== inputId) throw new Error('Schedule occurrence input identity does not match');
    if (current.state !== 'scheduled') throw new Error('Only scheduled occurrences may be claimed');
    if (current.claimedAt !== undefined) return structuredClone(current);
    const updated = eveCronOccurrenceSchema.parse({
      ...current,
      claimedAt,
      updatedAt: nextTimestamp(current.updatedAt, claimedAt)
    });
    const occurrences = [...state.occurrences];
    occurrences[index] = updated;
    await publish({ ...state, occurrences });
    return structuredClone(updated);
  });
}

export function markEveCronOccurrenceRunning(id: string, inputId: string, receipt: ScheduleDeliveryReceipt): Promise<EveCronOccurrence> {
  return serial(async () => {
    const delivery = scheduleDeliveryReceiptSchema.parse(receipt);
    const state = await loadState();
    const index = state.occurrences.findIndex(row => row.id === id);
    if (index < 0) throw new Error('Schedule occurrence not found');
    const current = state.occurrences[index]!;
    if (current.inputId !== inputId) throw new Error('Schedule occurrence input identity does not match');
    if (current.state === 'running' && JSON.stringify(current.delivery) === JSON.stringify(delivery)) return structuredClone(current);
    if (current.state !== 'scheduled') throw new Error('Only a scheduled occurrence may start running');
    const updated = eveCronOccurrenceSchema.parse({
      ...current,
      state: 'running',
      claimedAt: current.claimedAt ?? delivery.acceptedAt,
      delivery,
      updatedAt: nextTimestamp(current.updatedAt, delivery.acceptedAt)
    });
    const occurrences = [...state.occurrences];
    occurrences[index] = updated;
    await publish({ ...state, occurrences });
    return structuredClone(updated);
  });
}

export function completeEveCronOccurrence(id: string, receipt: ScheduleCompletionReceipt): Promise<EveCronOccurrence> {
  return serial(async () => {
    const completion = scheduleCompletionReceiptSchema.parse(receipt);
    const state = await loadState();
    const index = state.occurrences.findIndex(row => row.id === id);
    if (index < 0) throw new Error('Schedule occurrence not found');
    const current = state.occurrences[index]!;
    if (completion.key !== current.receiptKey) throw new Error('Schedule completion receipt key does not match');
    if (!current.delivery || current.delivery.sessionId !== completion.sessionId || current.delivery.conversationId !== completion.conversationId) {
      throw new Error('Schedule completion receipt does not belong to the accepted delivery');
    }
    if ((current.state === 'done' || current.state === 'failed') && JSON.stringify(current.completion) === JSON.stringify(completion)) {
      return structuredClone(current);
    }
    if (current.state !== 'running') throw new Error('Only a running occurrence may complete semantically');
    const updated = eveCronOccurrenceSchema.parse({
      ...current,
      state: completion.result,
      completion,
      failure: undefined,
      updatedAt: nextTimestamp(current.updatedAt, completion.completedAt)
    });
    const occurrences = [...state.occurrences];
    occurrences[index] = updated;
    await publish({ ...state, occurrences });
    return structuredClone(updated);
  });
}

export function failEveCronOccurrence(id: string, failure: ScheduleFailure): Promise<EveCronOccurrence> {
  return serial(async () => {
    const parsedFailure = scheduleFailureSchema.parse(failure);
    const state = await loadState();
    const index = state.occurrences.findIndex(row => row.id === id);
    if (index < 0) throw new Error('Schedule occurrence not found');
    const current = state.occurrences[index]!;
    if (current.state === 'done' || current.state === 'failed') return structuredClone(current);
    if (current.state === 'skipped') throw new Error('Skipped occurrences do not fail');
    const updated = eveCronOccurrenceSchema.parse({
      ...current,
      state: 'failed',
      failure: parsedFailure,
      completion: undefined,
      updatedAt: nextTimestamp(current.updatedAt, parsedFailure.failedAt)
    });
    const occurrences = [...state.occurrences];
    occurrences[index] = updated;
    await publish({ ...state, occurrences });
    return structuredClone(updated);
  });
}

export function resetScheduleForTests(): void {
  mutations = Promise.resolve();
}
