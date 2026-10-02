import { z } from 'zod';

export const EVE_CRON_ENTRY_STATES = ['enabled', 'paused'] as const;
export const EVE_CRON_OCCURRENCE_STATES = ['scheduled', 'skipped', 'running', 'done', 'failed'] as const;
export const EVE_CRON_SKIP_REASONS = ['exception', 'paused', 'schedule-edited'] as const;
export const EVE_CRON_DST_RESOLUTIONS = ['exact', 'fold-first', 'gap-forward'] as const;

const timestampSchema = z.number().int().nonnegative();
const uuidSchema = z.string().uuid();
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Use HH:mm local time');
const payloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a SHA-256 payload hash');
export const scheduleDurationMinutesSchema = z.number().int().min(1).max(24 * 60);

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const localDateSchema = z.string().refine(validLocalDate, 'Use a real YYYY-MM-DD calendar date');
export const ianaTimeZoneSchema = z.string().trim().min(1).max(120).refine(validTimeZone, 'Use a valid IANA time zone');
export const weekdaySchema = z.number().int().min(1).max(7);

const weeklyTriggerSchema = z.object({
  kind: z.literal('weekly'),
  weekdays: z.array(weekdaySchema).min(1).max(7)
    .refine(values => new Set(values).size === values.length, 'Weekdays must be unique'),
  localTime: localTimeSchema,
  timeZone: ianaTimeZoneSchema,
  startsOn: localDateSchema.optional()
}).strict();

const onceTriggerSchema = z.object({
  kind: z.literal('once'),
  localDate: localDateSchema,
  localTime: localTimeSchema,
  timeZone: ianaTimeZoneSchema
}).strict();

export const scheduleTriggerSchema = z.discriminatedUnion('kind', [weeklyTriggerSchema, onceTriggerSchema]);

const moveTargetSchema = z.object({
  localDate: localDateSchema,
  localTime: localTimeSchema
}).strict();

const skipExceptionSchema = z.object({
  nominalDate: localDateSchema,
  action: z.literal('skip'),
  reason: z.string().trim().min(1).max(240).optional()
}).strict();

const moveExceptionSchema = z.object({
  nominalDate: localDateSchema,
  action: z.literal('move'),
  moveTo: moveTargetSchema,
  reason: z.string().trim().min(1).max(240).optional()
}).strict();

export const scheduleExceptionSchema = z.discriminatedUnion('action', [skipExceptionSchema, moveExceptionSchema]);

const installationTargetSchema = z.object({ kind: z.literal('installation-agent') }).strict();
const sessionTargetSchema = z.object({
  kind: z.literal('session'),
  sessionId: z.string().min(8).max(64)
}).strict();

export const scheduleWorkTargetSchema = z.discriminatedUnion('kind', [installationTargetSchema, sessionTargetSchema]);

const chatAuthoritySchema = z.object({
  kind: z.literal('chat-user'),
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().min(8).max(256),
  requestId: z.string().min(1).max(256),
  authorizedAt: timestampSchema,
  payloadHash: payloadHashSchema
}).strict();

const uiAuthoritySchema = z.object({
  kind: z.literal('ui-user'),
  changeId: uuidSchema,
  authorizedAt: timestampSchema,
  payloadHash: payloadHashSchema
}).strict();

export const scheduleAuthoritySchema = z.discriminatedUnion('kind', [chatAuthoritySchema, uiAuthoritySchema]);

export const scheduleWorkProvenanceSchema = z.object({
  planId: uuidSchema.optional(),
  itemId: uuidSchema.optional(),
  pinId: uuidSchema.optional()
}).strict().refine(value => Object.keys(value).length > 0, 'Empty schedule provenance is not useful');

const scheduleSourceReferenceSchema = z.object({
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().min(8).max(256),
  messageIds: z.array(z.string().min(1).max(256)).min(1).max(32).optional()
}).strict();

const contextLineSchema = z.string().trim().min(1).max(2_000);
const instructionReferenceSchema = z.string().trim().regex(/^%\S{1,79}$/u, 'Use an exact %Thread or %Instruction reference');
const dataReferenceSchema = z.string().trim().regex(/^#\S{1,79}$/u, 'Use an exact #Quilt or #Concept reference');

/** Durable purpose captured from the conversation that created or refined scheduled work. */
export const scheduleTaskContextSchema = z.object({
  purpose: z.string().trim().min(1).max(8_000),
  desiredOutcome: z.string().trim().min(1).max(8_000),
  completionCriteria: z.array(contextLineSchema).max(16).optional(),
  decisions: z.array(contextLineSchema).max(24).optional(),
  observations: z.array(contextLineSchema).max(24).optional(),
  constraints: z.array(contextLineSchema).max(24).optional(),
  requestedFormat: z.string().trim().min(1).max(4_000).optional(),
  sources: z.array(scheduleSourceReferenceSchema).min(1).max(16),
  instructionRefs: z.array(instructionReferenceSchema).max(16).optional(),
  contextRefs: z.array(dataReferenceSchema).max(16).optional()
}).strict();

export const frozenScheduleWorkSchema = z.object({
  target: scheduleWorkTargetSchema,
  text: z.string().trim().min(1).max(16_000),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  objective: z.string().trim().min(1).max(16_000).optional(),
  projectId: uuidSchema.optional(),
  context: scheduleTaskContextSchema.optional(),
  authority: scheduleAuthoritySchema,
  provenance: scheduleWorkProvenanceSchema.optional()
}).strict();

const entryFields = {
  title: z.string().trim().min(1).max(160),
  state: z.enum(EVE_CRON_ENTRY_STATES),
  /**
   * Explicit scheduled busy-window length. Legacy entries may omit it; readers must then fail
   * closed rather than infer a duration from work prose, receipts, history, or neighboring slots.
   */
  durationMinutes: scheduleDurationMinutesSchema.optional(),
  trigger: scheduleTriggerSchema,
  exceptions: z.array(scheduleExceptionSchema).max(32)
    .refine(values => new Set(values.map(value => value.nominalDate)).size === values.length,
      'Only one exception may target a nominal occurrence'),
  work: frozenScheduleWorkSchema
};

export const eveCronEntryCreateSchema = z.object(entryFields).strict();

export const eveCronEntryPatchSchema = z.object({
  title: entryFields.title.optional(),
  state: entryFields.state.optional(),
  durationMinutes: entryFields.durationMinutes,
  trigger: entryFields.trigger.optional(),
  exceptions: entryFields.exceptions.optional(),
  work: entryFields.work.optional()
}).strict().refine(value => Object.keys(value).length > 0, 'Schedule update is empty');

export const eveCronEntrySchema = z.object({
  id: uuidSchema,
  ...entryFields,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Schedule entry update time is invalid');

export const scheduleLocalSlotSchema = z.object({
  localDate: localDateSchema,
  localTime: localTimeSchema,
  timeZone: ianaTimeZoneSchema
}).strict();

export const scheduleDeliveryReceiptSchema = z.object({
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().min(8).max(256),
  messageId: z.string().min(1).max(256),
  acceptedAt: timestampSchema
}).strict();

export const scheduleCompletionReceiptSchema = z.object({
  key: z.string().min(16).max(180),
  sessionId: z.string().min(8).max(64),
  conversationId: z.string().min(8).max(256),
  requestId: z.string().min(1).max(256),
  completedAt: timestampSchema,
  result: z.enum(['done', 'failed']),
  error: z.string().trim().min(1).max(500).optional()
}).strict();

export const scheduleFailureSchema = z.object({
  kind: z.enum(['delivery', 'missed', 'authority', 'internal']),
  failedAt: timestampSchema,
  error: z.string().trim().min(1).max(500)
}).strict();

export const eveCronOccurrenceSchema = z.object({
  id: uuidSchema,
  slotKey: z.string().min(1).max(400),
  entryId: uuidSchema,
  entryVersion: timestampSchema,
  entryTitle: z.string().min(1).max(160),
  nominal: scheduleLocalSlotSchema,
  scheduled: scheduleLocalSlotSchema,
  dueAt: timestampSchema,
  dstResolution: z.enum(EVE_CRON_DST_RESOLUTIONS),
  /** Frozen from the owning entry so claimed/history rows keep the busy window they were given. */
  durationMinutes: scheduleDurationMinutesSchema.optional(),
  inputId: uuidSchema,
  receiptKey: z.string().min(16).max(180),
  state: z.enum(EVE_CRON_OCCURRENCE_STATES),
  work: frozenScheduleWorkSchema,
  skipReason: z.enum(EVE_CRON_SKIP_REASONS).optional(),
  skipNote: z.string().trim().min(1).max(240).optional(),
  claimedAt: timestampSchema.optional(),
  delivery: scheduleDeliveryReceiptSchema.optional(),
  completion: scheduleCompletionReceiptSchema.optional(),
  failure: scheduleFailureSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.state === 'skipped' && !value.skipReason) {
    ctx.addIssue({ code: 'custom', path: ['skipReason'], message: 'Skipped occurrences need a reason' });
  }
  if (value.state !== 'skipped' && value.skipReason) {
    ctx.addIssue({ code: 'custom', path: ['skipReason'], message: 'Only skipped occurrences may have a skip reason' });
  }
  if (value.state === 'running' && !value.delivery) {
    ctx.addIssue({ code: 'custom', path: ['delivery'], message: 'Running occurrences need an accepted delivery receipt' });
  }
  if (value.state === 'done' && !value.completion) {
    ctx.addIssue({ code: 'custom', path: ['completion'], message: 'Done occurrences need a completion receipt' });
  }
  if (value.state === 'failed' && !value.completion && !value.failure) {
    ctx.addIssue({ code: 'custom', path: ['failure'], message: 'Failed occurrences need semantic or system failure evidence' });
  }
  if (value.completion && value.completion.result !== value.state) {
    ctx.addIssue({ code: 'custom', path: ['completion', 'result'], message: 'Completion result must match occurrence state' });
  }
});

export const scheduleStateSchema = z.object({
  version: z.literal(1),
  defaultTimeZone: ianaTimeZoneSchema,
  entries: z.array(eveCronEntrySchema).max(500),
  occurrences: z.array(eveCronOccurrenceSchema).max(10_000)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) {
    ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Schedule entry ids must be unique' });
  }
  if (new Set(value.occurrences.map(row => row.id)).size !== value.occurrences.length) {
    ctx.addIssue({ code: 'custom', path: ['occurrences'], message: 'Schedule occurrence ids must be unique' });
  }
  if (new Set(value.occurrences.map(row => row.slotKey)).size !== value.occurrences.length) {
    ctx.addIssue({ code: 'custom', path: ['occurrences'], message: 'Schedule occurrence slots must be unique' });
  }
});

export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;
export type ScheduleAuthority = z.infer<typeof scheduleAuthoritySchema>;
export type ScheduleTaskContext = z.infer<typeof scheduleTaskContextSchema>;
export type FrozenScheduleWork = z.infer<typeof frozenScheduleWorkSchema>;
export type EveCronEntryCreate = z.infer<typeof eveCronEntryCreateSchema>;
export type EveCronEntryPatch = z.infer<typeof eveCronEntryPatchSchema>;
export type EveCronEntry = z.infer<typeof eveCronEntrySchema>;
export type ScheduleLocalSlot = z.infer<typeof scheduleLocalSlotSchema>;
export type ScheduleDeliveryReceipt = z.infer<typeof scheduleDeliveryReceiptSchema>;
export type ScheduleCompletionReceipt = z.infer<typeof scheduleCompletionReceiptSchema>;
export type ScheduleFailure = z.infer<typeof scheduleFailureSchema>;
export type EveCronOccurrence = z.infer<typeof eveCronOccurrenceSchema>;
export type ScheduleState = z.infer<typeof scheduleStateSchema>;

export interface ResolvedScheduleTime {
  dueAt: number;
  resolution: typeof EVE_CRON_DST_RESOLUTIONS[number];
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const held = formatters.get(timeZone);
  if (held) return held;
  const created = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  formatters.set(timeZone, created);
  return created;
}

function localParts(at: number, timeZone: string): LocalParts {
  const values = new Map(formatter(timeZone).formatToParts(at).map(part => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute'))
  };
}

function parseLocal(localDate: string, localTime: string): LocalParts {
  const parsedDate = localDateSchema.parse(localDate);
  const parsedTime = localTimeSchema.parse(localTime);
  const [year, month, day] = parsedDate.split('-').map(Number);
  const [hour, minute] = parsedTime.split(':').map(Number);
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute! };
}

function partsEpoch(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function sameParts(left: LocalParts, right: LocalParts): boolean {
  return partsEpoch(left) === partsEpoch(right);
}

export function localDateAt(at: number, timeZone: string): string {
  const zone = ianaTimeZoneSchema.parse(timeZone);
  const parts = localParts(at, zone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function addLocalDays(localDate: string, days: number): string {
  const parsed = parseLocal(localDate, '00:00');
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function weekdayForLocalDate(localDate: string): number {
  const parts = parseLocal(localDate, '00:00');
  const sundayZero = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

/** Resolve a human wall-clock time without turning a DST fold into two runs. */
export function resolveZonedLocalTime(localDate: string, localTime: string, timeZone: string): ResolvedScheduleTime {
  const zone = ianaTimeZoneSchema.parse(timeZone);
  const target = parseLocal(localDate, localTime);
  const targetEpoch = partsEpoch(target);
  const offsets = new Set<number>();
  for (let sample = targetEpoch - 36 * 60 * 60_000; sample <= targetEpoch + 36 * 60 * 60_000; sample += 6 * 60 * 60_000) {
    offsets.add(partsEpoch(localParts(sample, zone)) - sample);
  }
  const matches = [...offsets]
    .map(offset => targetEpoch - offset)
    .filter(candidate => sameParts(localParts(candidate, zone), target))
    .sort((left, right) => left - right);
  if (matches.length) return { dueAt: matches[0]!, resolution: matches.length > 1 ? 'fold-first' : 'exact' };

  // The requested wall time is in a spring-forward gap. Walk real instants in chronological
  // order and choose the first representable local minute after it. The bounded ±16h window is
  // wider than every legal IANA UTC offset and avoids assuming a one-hour DST transition.
  for (let candidate = targetEpoch - 16 * 60 * 60_000; candidate <= targetEpoch + 16 * 60 * 60_000; candidate += 60_000) {
    if (partsEpoch(localParts(candidate, zone)) > targetEpoch) return { dueAt: candidate, resolution: 'gap-forward' };
  }
  throw new Error(`Could not resolve ${localDate} ${localTime} in ${zone}`);
}

export function entryTimeZone(entry: Pick<EveCronEntry, 'trigger'> | Pick<EveCronEntryCreate, 'trigger'>): string {
  return entry.trigger.timeZone;
}
