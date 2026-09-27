import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { listPlans } from './plans.js';
import { getSession, readEvents, readOverflowText } from './session/store.js';
import type {
  CreatePinInput,
  CreatePinResult,
  Pin,
  PinsLibrarySnapshot,
  Quilt,
  QuiltCollection,
  QuiltState
} from '../shared/pins.js';
import { pinSourceKey } from '../shared/pins.js';
import { safeResourceDestination } from '../shared/resource-destination.js';
import {
  DEFAULT_THREAD_DEFINITIONS,
  DEFAULT_THREAD_GENERATION,
  type DefaultThreadDefinition,
  type StarterThreadEntry,
  type ThreadSettingsEntry
} from '../shared/default-threads.js';

export const PINS_STATE = 'pins';
export const DEFAULT_THREADS_MIGRATION_STATE = 'default-threads-migration';

const MAX_QUILTS = 2_000;
const MAX_PINS = 10_000;
const MAX_COLLECTIONS = 200;
const defaultThreadsMigrationV1Schema = z.object({
  version: z.literal(1),
  appliedGeneration: z.number().int().nonnegative()
}).strict();
const defaultThreadOwnershipSchema = z.object({
  starterId: z.string().trim().min(1).max(80),
  threadId: z.string().uuid(),
  shippedPromptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  userEditedPrompt: z.boolean()
}).strict();
const defaultThreadsMigrationV2Schema = z.object({
  version: z.literal(2),
  appliedGeneration: z.number().int().nonnegative(),
  starters: z.array(defaultThreadOwnershipSchema).max(100)
    .refine(rows => new Set(rows.map(row => row.starterId)).size === rows.length, 'Starter ids must be unique')
    .refine(rows => new Set(rows.map(row => row.threadId)).size === rows.length, 'Starter Thread ids must be unique')
}).strict();
const defaultThreadsMigrationSchema = z.discriminatedUnion('version', [
  defaultThreadsMigrationV1Schema,
  defaultThreadsMigrationV2Schema
]);
type DefaultThreadOwnership = z.infer<typeof defaultThreadOwnershipSchema>;

const id = z.string().uuid();
const sessionId = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const conversationId = z.string().min(8).max(256).regex(/^[0-9a-z-]+$/i).nullable();
const optionalSourceId = z.string().min(1).max(256).optional();
const THREAD_SIGIL = '%';
const contextNameKey = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();
const referenceNameKey = (value: string, sigil: string): string =>
  contextNameKey(value.startsWith(sigil) ? value.slice(1) : value);
const threadReferenceNameKey = (value: string): string =>
  contextNameKey(value.startsWith(THREAD_SIGIL) ? value.slice(1) : value);
const starterReferenceTitles = (definition: DefaultThreadDefinition): readonly string[] =>
  [definition.title, ...(definition.supersededTitles ?? [])];
const matchesStarterReference = (title: string, definition: DefaultThreadDefinition): boolean =>
  starterReferenceTitles(definition)
    .some(candidate => threadReferenceNameKey(title) === threadReferenceNameKey(candidate));
const promptSha256 = (prompt: string): string => createHash('sha256').update(prompt, 'utf8').digest('hex');
const isShippedStarterPrompt = (prompt: string, definition: DefaultThreadDefinition): boolean =>
  prompt === definition.prompt ||
  Boolean(definition.supersededPrompts?.includes(prompt)) ||
  Boolean(definition.supersededPromptSha256?.includes(promptSha256(prompt)));
const currentStarterPromptSha256 = (definition: DefaultThreadDefinition): string => promptSha256(definition.prompt);

function starterCandidateIndex(quilts: readonly Quilt[], definition: DefaultThreadDefinition): number | null {
  const current = quilts.findIndex(row =>
    threadReferenceNameKey(row.title) === threadReferenceNameKey(definition.title));
  if (current >= 0) return current;
  const superseded = quilts.findIndex(row => definition.supersededTitles?.some(title =>
    threadReferenceNameKey(row.title) === threadReferenceNameKey(title)) === true);
  if (superseded >= 0) return superseded;

  const compatible = quilts.flatMap((row, index) =>
    row.description === definition.description ||
    definition.supersededDescriptions?.includes(row.description ?? '') === true ||
    isShippedStarterPrompt(row.prompt ?? '', definition)
      ? [index]
      : []);
  return compatible.length === 1 ? compatible[0]! : null;
}

async function markStarterPromptUserOwned(threadId: string): Promise<void> {
  const rawMigration = await readDurableStrict<unknown>(DEFAULT_THREADS_MIGRATION_STATE);
  if (rawMigration === null) return;
  const migration = defaultThreadsMigrationSchema.parse(rawMigration);
  if (migration.version !== 2) return;
  const index = migration.starters.findIndex(row => row.threadId === threadId);
  if (index < 0 || migration.starters[index]!.userEditedPrompt) return;
  const starters = [...migration.starters];
  starters[index] = { ...starters[index]!, userEditedPrompt: true };
  await writeDurableNow(DEFAULT_THREADS_MIGRATION_STATE, { ...migration, starters });
}
const previewFields = {
  title: z.string().trim().min(1).max(200).optional(),
  excerpt: z.string().trim().min(1).max(2_000).optional(),
  sourceLabel: z.string().trim().min(1).max(200).optional()
};
const chronologyFields = {
  sourceCreatedAt: z.number().finite().nonnegative().optional(),
  contextCreatedAt: z.number().finite().nonnegative().optional()
};
const pinImageSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('asset'),
    id: z.string().min(1).max(100).regex(/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    alt: z.string().trim().min(1).max(255).optional()
  }).strict(),
  z.object({
    source: z.literal('attachment'),
    id: z.string().min(1).max(256),
    mimeType: z.string().min(7).max(120).regex(/^image\/[\w.+-]+$/),
    alt: z.string().trim().min(1).max(255).optional()
  }).strict()
]);

const messageProvenanceSchema = z.object({
  sessionId,
  conversationId,
  eventSeq: z.number().int().min(1).max(10_000_000),
  messageId: optionalSourceId,
  turnId: optionalSourceId
}).strict();

const resultProvenanceSchema = z.object({
  sessionId,
  conversationId,
  eventSeq: z.number().int().min(1).max(10_000_000),
  callId: optionalSourceId,
  turnId: optionalSourceId
}).strict();

const planProvenanceSchema = z.object({
  planId: id,
  sourceSessionId: sessionId.nullable().optional(),
  sourceConversationId: conversationId.optional()
}).strict();

const pinTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), quiltId: id }).strict(),
  z.object({
    mode: z.literal('new'),
    title: z.string().trim().min(1).max(120),
    collectionIds: z.array(id).max(50).refine(values => new Set(values).size === values.length, 'Quilt ids must be unique')
  }).strict()
]);

export const createPinInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...previewFields, ...chronologyFields, kind: z.literal('prompt'), target: pinTargetSchema, provenance: messageProvenanceSchema, image: pinImageSchema.optional() }).strict(),
  z.object({ ...previewFields, ...chronologyFields, kind: z.literal('message'), target: pinTargetSchema, provenance: messageProvenanceSchema, image: pinImageSchema.optional() }).strict(),
  z.object({ ...previewFields, ...chronologyFields, kind: z.literal('result'), target: pinTargetSchema, provenance: resultProvenanceSchema }).strict(),
  z.object({ ...previewFields, ...chronologyFields, kind: z.literal('plan'), target: pinTargetSchema, provenance: planProvenanceSchema }).strict()
]);

export const createQuiltInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000).optional(),
  collectionIds: z.array(id).max(50).default([]).refine(values => new Set(values).size === values.length, 'Quilt ids must be unique')
}).strict();

export const createThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000).optional(),
  prompt: z.string().max(16_000).optional(),
  link: z.string().trim().max(8_192).refine(value => value === '' || safeResourceDestination(value),
    'Unsafe or invalid Thread destination').optional(),
  collectionNames: z.array(z.string().trim().min(1).max(80)).max(50).default([])
    .refine(values => new Set(values.map(value => referenceNameKey(value, '#'))).size === values.length,
      'Quilt names must be unique')
}).strict();

export const createCollectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1_000).optional()
}).strict();
export const setCollectionDescriptionInputSchema = z.object({
  collectionId: id,
  description: z.string().trim().max(1_000)
}).strict();
export const associateThreadQuiltInputSchema = z.object({
  threadId: id,
  quiltName: z.string().trim().min(1).max(80),
  createIfMissing: z.boolean()
}).strict();
export const setQuiltStateInputSchema = z.object({ quiltId: id, state: z.enum(['pinned', 'archived']) }).strict();
export const setPinStickyInputSchema = z.object({ pinId: id, sticky: z.boolean() }).strict();
export const setQuiltPromptInputSchema = z.object({
  quiltId: id,
  prompt: z.string().max(16_000)
}).strict();
export const updateQuiltMetadataInputSchema = z.object({
  quiltId: id,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).optional(),
  link: z.string().trim().max(8_192).refine(value => value === '' || safeResourceDestination(value), 'Unsafe or invalid Thread destination').optional(),
  collectionNames: z.array(z.string().trim().min(1).max(80)).max(50)
    .refine(values => new Set(values.map(value => referenceNameKey(value, '#'))).size === values.length,
      'Quilt names must be unique')
}).strict();
export const setQuiltCollectionsInputSchema = z.object({
  quiltId: id,
  collectionIds: z.array(id).max(50).refine(values => new Set(values).size === values.length, 'Quilt ids must be unique')
}).strict();

const quiltSchema = z.object({
  id,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1_000).optional(),
  link: z.string().min(1).max(8_192).refine(safeResourceDestination, 'Unsafe or invalid Thread destination').optional(),
  prompt: z.string().min(1).max(16_000).optional(),
  state: z.enum(['pinned', 'archived']),
  collectionIds: z.array(id).max(50),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative()
}).strict();

const collectionSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1_000).optional(),
  createdAt: z.number().finite().nonnegative()
}).strict();

const storedPinBase = {
  id,
  quiltId: id,
  createdAt: z.number().finite().nonnegative(),
  ...chronologyFields,
  ...previewFields
};
const pinSchema = z.discriminatedUnion('kind', [
  z.object({ ...storedPinBase, kind: z.literal('prompt'), provenance: messageProvenanceSchema, image: pinImageSchema.optional(), sticky: z.boolean().optional() }).strict(),
  z.object({ ...storedPinBase, kind: z.literal('message'), provenance: messageProvenanceSchema, image: pinImageSchema.optional(), sticky: z.boolean().optional() }).strict(),
  z.object({ ...storedPinBase, kind: z.literal('result'), provenance: resultProvenanceSchema }).strict(),
  z.object({ ...storedPinBase, kind: z.literal('plan'), provenance: planProvenanceSchema, sticky: z.boolean().optional() }).strict()
]);
const librarySchema = z.object({
  version: z.literal(1),
  quilts: z.array(quiltSchema).max(MAX_QUILTS),
  pins: z.array(pinSchema).max(MAX_PINS),
  collections: z.array(collectionSchema).max(MAX_COLLECTIONS)
}).strict();

const EMPTY_LIBRARY: PinsLibrarySnapshot = { version: 1, quilts: [], pins: [], collections: [] };
let mutations: Promise<unknown> = Promise.resolve();
const changeListeners = new Set<() => void>();

function uniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map(row => row.id)).size === rows.length;
}

interface ValidatedLibrary {
  library: PinsLibrarySnapshot;
  normalizedLegacyPreviews: boolean;
}

const LEGACY_MOJIBAKE_MARKER = /[\u00c2\u00c3\u00e2\u00ee\u00f0\ufffd]/u;
const WINDOWS_1252_BYTE_BY_CODE_POINT = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f]
]);

/**
 * Reverses the one historical preview-capture bug we can prove from durable provenance: UTF-8
 * bytes were once interpreted as Windows-1252 before the display snapshot was saved. This is
 * deliberately not a generic text cleanup. A caller must still compare the decoded candidate to
 * an authoritative recorded source before replacing any user-visible bytes.
 */
function legacyMojibakeCandidate(value: string | undefined): string | null {
  if (!value || !LEGACY_MOJIBAKE_MARKER.test(value)) return null;
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0xff) {
      bytes.push(point);
      continue;
    }
    const mapped = WINDOWS_1252_BYTE_BY_CODE_POINT.get(point);
    if (mapped === undefined) return null;
    bytes.push(mapped);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  if (decoded === value || decoded.includes('\ufffd')) return null;
  return decoded;
}

function currentThreadNames(library: PinsLibrarySnapshot): string[] {
  return [...new Set(library.quilts
    .map(thread => thread.title.startsWith(THREAD_SIGIL) ? thread.title.slice(1) : thread.title)
    .map(title => title.trim())
    .filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeRetiredThreadReferences(value: string, threadNames: readonly string[]): string {
  let normalized = value;
  for (const name of threadNames) {
    const pattern = new RegExp(`\\p{Sc}${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_-])`, 'gu');
    normalized = normalized.replace(pattern, match =>
      (match.codePointAt(0) ?? 0) > 0x7f ? `${THREAD_SIGIL}${name}` : match);
  }
  return normalized;
}

async function exactStoredText(
  sessionIdValue: string,
  stored: { text: string; truncated: boolean; assetId?: string }
): Promise<string> {
  if (!stored.truncated || !stored.assetId) return stored.text;
  return await readOverflowText(sessionIdValue, stored.assetId) ?? stored.text;
}

/**
 * Repairs only legacy display snapshots whose decoded bytes are independently proved by the
 * exact recorded source. The Pin's identity, provenance, chronology and Thread ownership never
 * change. Missing/deleted source history simply leaves the old preview untouched rather than
 * guessing at text.
 */
async function repairLegacyMojibakePreviews(library: PinsLibrarySnapshot): Promise<{
  library: PinsLibrarySnapshot;
  repaired: boolean;
}> {
  const threadNames = currentThreadNames(library);
  const previewCandidate = (value: string | undefined): string | null => {
    if (!value) return null;
    const decoded = legacyMojibakeCandidate(value) ?? value;
    return decoded !== value || normalizeRetiredThreadReferences(decoded, threadNames) !== decoded
      ? decoded
      : null;
  };
  const suspicious = library.pins.filter(pin =>
    previewCandidate(pin.title) !== null ||
    previewCandidate(pin.excerpt) !== null ||
    previewCandidate(pin.sourceLabel) !== null);
  if (suspicious.length === 0) return { library, repaired: false };

  const replacements = new Map<string, Pin>();
  const bySession = new Map<string, Pin[]>();
  for (const pin of suspicious) {
    const sourceSessionId = pin.kind === 'plan' ? pin.provenance.sourceSessionId ?? null : pin.provenance.sessionId;
    if (!sourceSessionId) continue;
    const held = bySession.get(sourceSessionId) ?? [];
    held.push(pin);
    bySession.set(sourceSessionId, held);
  }

  for (const [sourceSessionId, pins] of bySession) {
    try {
      const [summary, events] = await Promise.all([getSession(sourceSessionId), readEvents(sourceSessionId)]);
      if (!summary) continue;
      for (const pin of pins) {
        let next: Pin = replacements.get(pin.id) ?? pin;
        const sourceLabelCandidate = previewCandidate(next.sourceLabel);
        if (sourceLabelCandidate !== null && sourceLabelCandidate === summary.title) {
          next = { ...next, sourceLabel: normalizeRetiredThreadReferences(summary.title, threadNames) };
        }

        if (pin.kind === 'prompt' || pin.kind === 'message') {
          const event = events.find(candidate =>
            (candidate.kind === 'user_message' || candidate.kind === 'assistant_message') &&
            (pin.provenance.messageId
              ? candidate.messageId === pin.provenance.messageId
              : candidate.seq === pin.provenance.eventSeq || candidate.origin === pin.provenance.eventSeq));
          if (!event || (event.kind !== 'user_message' && event.kind !== 'assistant_message')) {
            if (next !== pin) replacements.set(pin.id, next);
            continue;
          }
          // Some early dogfood Pins classified an authored user row as `message` while still
          // preserving its exact canonical message id. Kind is durable historical metadata and is
          // intentionally left alone here; exact message identity is sufficient authority to
          // repair the display snapshot without rewriting provenance semantics.
          const sourceText = event.kind === 'user_message' && event.authoredText !== undefined
            ? event.authoredText
            : await exactStoredText(sourceSessionId, event.message);
          const excerptCandidate = previewCandidate(next.excerpt);
          if (excerptCandidate !== null && sourceText.startsWith(excerptCandidate)) {
            next = {
              ...next,
              excerpt: normalizeRetiredThreadReferences(sourceText.slice(0, 2_000), threadNames)
            };
          }
        } else if (pin.kind === 'result') {
          const event = events.find(candidate => candidate.kind === 'tool_call' &&
            (pin.provenance.callId ? candidate.call.callId === pin.provenance.callId : candidate.seq === pin.provenance.eventSeq));
          if (event?.kind === 'tool_call') {
            const titleCandidate = previewCandidate(next.title);
            if (titleCandidate !== null && titleCandidate === event.call.summary.title) {
              next = {
                ...next,
                title: normalizeRetiredThreadReferences(event.call.summary.title, threadNames)
              };
            }
            const sourceText = await exactStoredText(sourceSessionId, event.call.result);
            const excerptCandidate = previewCandidate(next.excerpt);
            if (excerptCandidate !== null && sourceText.startsWith(excerptCandidate)) {
              next = {
                ...next,
                excerpt: normalizeRetiredThreadReferences(sourceText.slice(0, 2_000), threadNames)
              };
            }
          }
        }
        if (next !== pin) replacements.set(pin.id, next);
      }
    } catch {
      // A missing or damaged source session must not make the Pins library unreadable. Provenance
      // remains intact, so a later recovery can still retry without a speculative text rewrite.
    }
  }

  const suspiciousPlans = suspicious.filter(pin => pin.kind === 'plan' && previewCandidate(pin.title) !== null);
  if (suspiciousPlans.length > 0) {
    try {
      const plans = await listPlans();
      const byId = new Map([...plans.live, ...plans.done].map(plan => [plan.id, plan]));
      for (const pin of suspiciousPlans) {
        if (pin.kind !== 'plan') continue;
        const plan = byId.get(pin.provenance.planId);
        const titleCandidate = previewCandidate(pin.title);
        if (!plan || titleCandidate === null || titleCandidate !== plan.title) continue;
        const held = replacements.get(pin.id) ?? pin;
        replacements.set(pin.id, {
          ...held,
          title: normalizeRetiredThreadReferences(plan.title, threadNames)
        });
      }
    } catch {
      // Plans are optional provenance for this compatibility repair. Never guess when absent.
    }
  }

  if (replacements.size === 0) return { library, repaired: false };
  return {
    library: { ...library, pins: library.pins.map(pin => replacements.get(pin.id) ?? pin) },
    repaired: true
  };
}

/**
 * Existing dogfood state can contain a full old timeline preview even though the durable Pins
 * schema has long bounded `excerpt` to 2,000 characters. Those observed rows retain valid source
 * identity and Thread ownership; rejecting the complete library on upgrade hides otherwise
 * trustworthy Pins because of display-only snapshot bytes.
 *
 * Keep compatibility deliberately narrower than the schema itself. We repair only a parse whose
 * every issue is the known overlong `pins[n].excerpt` preview. Any bad id, provenance, graph link,
 * unknown field, blank preview, or other schema error still reaches the ordinary strict failure.
 * The normalized object is parsed again by `librarySchema` before any caller can use it.
 */
function normalizeLegacyOverlongPreviews(raw: unknown, issues: readonly z.core.$ZodIssue[]): unknown | null {
  if (issues.length === 0 || !issues.every(issue =>
    issue.code === 'too_big' &&
    issue.path.length === 3 &&
    issue.path[0] === 'pins' &&
    typeof issue.path[1] === 'number' &&
    issue.path[2] === 'excerpt')) return null;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { pins?: unknown }).pins)) return null;

  const input = raw as Record<string, unknown> & { pins: unknown[] };
  const pins = [...input.pins];
  for (const issue of issues) {
    const index = issue.path[1] as number;
    const held = pins[index];
    if (!held || typeof held !== 'object') return null;
    const excerpt = (held as { excerpt?: unknown }).excerpt;
    if (typeof excerpt !== 'string') return null;
    pins[index] = { ...held, excerpt: excerpt.trim().slice(0, 2_000) };
  }
  return { ...input, pins };
}

function validateLibrary(raw: unknown): PinsLibrarySnapshot {
  const parsed = librarySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Pins library is invalid');
  const value = parsed.data as PinsLibrarySnapshot;
  if (!uniqueIds(value.quilts) || !uniqueIds(value.pins) || !uniqueIds(value.collections)) {
    throw new Error('Pins library contains duplicate ids');
  }
  if (new Set(value.pins.map(pinSourceKey)).size !== value.pins.length) {
    throw new Error('Pins library contains duplicate source Pins');
  }
  const quiltIds = new Set(value.quilts.map(row => row.id));
  const collectionIds = new Set(value.collections.map(row => row.id));
  for (const quilt of value.quilts) {
    if (new Set(quilt.collectionIds).size !== quilt.collectionIds.length ||
        quilt.collectionIds.some(collectionId => !collectionIds.has(collectionId))) {
      throw new Error('Pins library contains an invalid Thread-to-Quilt link');
    }
  }
  // This is the central invariant: the persisted representation has no orphan-Pin state.
  if (value.pins.some(pin => !quiltIds.has(pin.quiltId))) {
    throw new Error('Pins library contains an orphan Pin');
  }
  return value;
}

function decodeLibrary(raw: unknown): ValidatedLibrary {
  const parsed = librarySchema.safeParse(raw);
  if (parsed.success) {
    return { library: validateLibrary(parsed.data), normalizedLegacyPreviews: false };
  }
  const normalized = normalizeLegacyOverlongPreviews(raw, parsed.error.issues);
  if (normalized === null) throw new Error('Pins library is invalid');
  return { library: validateLibrary(normalized), normalizedLegacyPreviews: true };
}

async function readLibrary(): Promise<PinsLibrarySnapshot> {
  const raw = await readDurableStrict<unknown>(PINS_STATE);
  return raw === null ? EMPTY_LIBRARY : decodeLibrary(raw).library;
}

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutations.then(work);
  mutations = operation.catch(() => undefined);
  return operation;
}

function requireCollections(library: PinsLibrarySnapshot, collectionIds: readonly string[]): void {
  const existing = new Set(library.collections.map(row => row.id));
  if (collectionIds.some(collectionId => !existing.has(collectionId))) throw new Error('Quilt not found');
}

function refuseDuplicateQuiltReference(library: PinsLibrarySnapshot, title: string, exceptId?: string): void {
  const key = threadReferenceNameKey(title);
  if (library.quilts.some(row => row.id !== exceptId && threadReferenceNameKey(row.title) === key)) {
    throw new Error('A Thread with that reference already exists');
  }
}

async function publish(library: PinsLibrarySnapshot): Promise<void> {
  validateLibrary(library);
  await writeDurableNow(PINS_STATE, library);
  for (const listener of changeListeners) listener();
}

export async function pinsLibrary(): Promise<PinsLibrarySnapshot> {
  return readLibrary();
}

/**
 * Settings navigation is opt-in, not a projection of the whole Thread catalog. The shipped starter
 * registry declares which starters own a real settings surface; the durable starter ledger maps that
 * stable starter identity to the concrete Thread id so user renames never change eligibility.
 */
export async function threadSettingsEntries(): Promise<ThreadSettingsEntry[]> {
  const rawMigration = await readDurableStrict<unknown>(DEFAULT_THREADS_MIGRATION_STATE);
  if (rawMigration === null) return [];
  const migration = defaultThreadsMigrationSchema.parse(rawMigration);
  if (migration.version !== 2) return [];
  const library = await readLibrary();
  const threadById = new Map(library.quilts.map(thread => [thread.id, thread]));
  const definitionByStarterId = new Map(DEFAULT_THREAD_DEFINITIONS.map(definition => [definition.starterId, definition]));
  return migration.starters.flatMap(ownership => {
    const definition = definitionByStarterId.get(ownership.starterId);
    const thread = threadById.get(ownership.threadId);
    if (!definition?.settingsSurface || !thread) return [];
    return [{
      starterId: ownership.starterId,
      threadId: ownership.threadId,
      title: thread.title,
      surface: definition.settingsSurface
    } satisfies ThreadSettingsEntry];
  });
}

/** Resolve one shipped starter by durable app-owned identity, never by its editable title. */
export async function starterThreadEntry(starterId: string): Promise<StarterThreadEntry | null> {
  const definition = DEFAULT_THREAD_DEFINITIONS.find(row => row.starterId === starterId);
  if (!definition) return null;
  const rawMigration = await readDurableStrict<unknown>(DEFAULT_THREADS_MIGRATION_STATE);
  if (rawMigration === null) return null;
  const migration = defaultThreadsMigrationSchema.parse(rawMigration);
  if (migration.version !== 2) return null;
  const ownership = migration.starters.find(row => row.starterId === starterId);
  if (!ownership) return null;
  const library = await readLibrary();
  const thread = library.quilts.find(row => row.id === ownership.threadId);
  return thread ? { starterId, threadId: thread.id, title: thread.title } : null;
}

/**
 * Reconcile shipped starter Threads without turning their editable prompt into app authority.
 *
 * The durable starter ledger owns only provenance: stable starter id -> concrete Thread id, the
 * fingerprint of the last app-owned prompt, and whether the user explicitly saved that prompt.
 * A missing owned Thread is recreated; a renamed owned Thread is followed by id; an untouched
 * app-owned prompt advances to the bundled text; and a user-saved prompt is never overwritten.
 * Legacy installs are adopted conservatively from exact starter references, shipped prompt bytes,
 * or the unique shipped description. Persist the Pins library before the ledger so a failed
 * library write remains retryable and can never record ownership for bytes that were not saved.
 */
export function initializeDefaultThreads(): Promise<void> {
  return serialize(async () => {
    const raw = await readDurableStrict<unknown>(PINS_STATE);
    const decoded = raw === null ? null : decodeLibrary(raw);
    const previewRepair = await repairLegacyMojibakePreviews(decoded?.library ?? EMPTY_LIBRARY);
    const library = previewRepair.library;
    const rawMigration = await readDurableStrict<unknown>(DEFAULT_THREADS_MIGRATION_STATE);
    const inferredLegacyGeneration = raw === null
      ? 0
      : Math.max(0, ...DEFAULT_THREAD_DEFINITIONS
          .filter(definition => library.quilts.some(row => matchesStarterReference(row.title, definition)))
          .map(definition => definition.introducedIn));
    const decodedMigration = rawMigration === null
      ? { version: 1 as const, appliedGeneration: inferredLegacyGeneration }
      : defaultThreadsMigrationSchema.parse(rawMigration);
    const appliedGeneration = decodedMigration.appliedGeneration;
    const starters: DefaultThreadOwnership[] = decodedMigration.version === 2
      ? decodedMigration.starters.map(row => ({ ...row }))
      : [];
    const starterById = new Map(starters.map(row => [row.starterId, row]));
    const now = Date.now();
    const collections = [...library.collections];
    const quilts = [...library.quilts];
    const collectionByName = new Map<string, QuiltCollection>(
      collections.map(collection => [referenceNameKey(collection.name, '#'), collection])
    );
    // Persist a compatibility normalization through the same strict publication owner as every
    // other Pins migration, even when this install has no starter-Thread changes to make.
    let changed = decoded?.normalizedLegacyPreviews === true || previewRepair.repaired;

    const defaultCollections = (definition: DefaultThreadDefinition): string[] => {
      const collectionIds: string[] = [];
      for (const name of definition.quiltNames ?? []) {
        const key = referenceNameKey(name, '#');
        if (!collectionByName.has(key)) {
          if (collections.length >= MAX_COLLECTIONS) throw new Error('Quilt limit reached');
          const collection = { id: randomUUID(), name, createdAt: now } satisfies QuiltCollection;
          collectionByName.set(key, collection);
          collections.push(collection);
        }
        collectionIds.push(collectionByName.get(key)!.id);
      }
      return collectionIds;
    };

    for (const definition of DEFAULT_THREAD_DEFINITIONS) {
      if (definition.introducedIn > DEFAULT_THREAD_GENERATION) continue;
      const currentPromptSha256 = currentStarterPromptSha256(definition);
      let ownership = starterById.get(definition.starterId);
      let index = ownership ? quilts.findIndex(row => row.id === ownership!.threadId) : -1;

      // A deleted owned starter may have been replaced manually before the next startup. Rebind
      // to one deterministic compatible object rather than creating a duplicate beside it.
      if (index < 0) {
        const candidate = starterCandidateIndex(quilts, definition);
        if (candidate !== null) {
          index = candidate;
          const held = quilts[index]!;
          const heldPrompt = held.prompt ?? '';
          const exactEmptyStarter = heldPrompt.trim() === '' &&
            threadReferenceNameKey(held.title) === threadReferenceNameKey(definition.title) &&
            held.description === undefined && held.link === undefined;
          const appOwnedPrompt = exactEmptyStarter || isShippedStarterPrompt(heldPrompt, definition);
          ownership = {
            starterId: definition.starterId,
            threadId: held.id,
            shippedPromptSha256: appOwnedPrompt ? promptSha256(heldPrompt) : currentPromptSha256,
            userEditedPrompt: !appOwnedPrompt
          };
          const prior = starterById.get(definition.starterId);
          if (prior) starters[starters.indexOf(prior)] = ownership;
          else starters.push(ownership);
          starterById.set(definition.starterId, ownership);
        }
      }

      if (index < 0) {
        if (quilts.length >= MAX_QUILTS) throw new Error('Thread limit reached');
        const collectionIds = defaultCollections(definition);
        const thread: Quilt = {
          id: randomUUID(),
          title: definition.title,
          description: definition.description,
          prompt: definition.prompt,
          state: 'pinned',
          collectionIds,
          createdAt: now,
          updatedAt: now
        };
        quilts.push(thread);
        ownership = {
          starterId: definition.starterId,
          threadId: thread.id,
          shippedPromptSha256: currentPromptSha256,
          userEditedPrompt: false
        };
        const prior = starterById.get(definition.starterId);
        if (prior) starters[starters.indexOf(prior)] = ownership;
        else starters.push(ownership);
        starterById.set(definition.starterId, ownership);
        changed = true;
        continue;
      }

      const held = quilts[index]!;
      ownership ??= {
        starterId: definition.starterId,
        threadId: held.id,
        shippedPromptSha256: currentPromptSha256,
        userEditedPrompt: true
      };
      const heldPrompt = held.prompt ?? '';
      let userEditedPrompt = ownership.userEditedPrompt;
      const recoverLegacyEmptyStarter = userEditedPrompt && heldPrompt.trim() === '' &&
        threadReferenceNameKey(held.title) === threadReferenceNameKey(definition.title) &&
        held.description === undefined && held.link === undefined;
      if (recoverLegacyEmptyStarter) userEditedPrompt = false;
      if (!recoverLegacyEmptyStarter && !userEditedPrompt &&
          promptSha256(heldPrompt) !== ownership.shippedPromptSha256 &&
          !isShippedStarterPrompt(heldPrompt, definition)) {
        userEditedPrompt = true;
      }
      const appOwnedPrompt = !userEditedPrompt;
      const isSupersededTitle = definition.supersededTitles?.some(title =>
        threadReferenceNameKey(held.title) === threadReferenceNameKey(title)) === true;
      const shouldRename = appOwnedPrompt && isSupersededTitle &&
        (definition.renamedIn === undefined || appliedGeneration < definition.renamedIn);
      const shouldUpgradePrompt = appOwnedPrompt && heldPrompt !== definition.prompt;
      const shouldUpgradeDescription = (appOwnedPrompt && held.description === undefined &&
        threadReferenceNameKey(held.title) === threadReferenceNameKey(definition.title)) ||
        definition.supersededDescriptions?.includes(held.description ?? '') === true;

      if (shouldRename || shouldUpgradePrompt || shouldUpgradeDescription) {
        quilts[index] = {
          ...held,
          ...(shouldRename ? { title: definition.title } : {}),
          ...(shouldUpgradeDescription ? { description: definition.description } : {}),
          ...(shouldUpgradePrompt ? { prompt: definition.prompt } : {}),
          updatedAt: now
        };
        changed = true;
      }

      const nextOwnership: DefaultThreadOwnership = {
        starterId: definition.starterId,
        threadId: held.id,
        shippedPromptSha256: appOwnedPrompt ? currentPromptSha256 : ownership.shippedPromptSha256,
        userEditedPrompt
      };
      const ownershipIndex = starters.findIndex(row => row.starterId === definition.starterId);
      if (ownershipIndex >= 0) starters[ownershipIndex] = nextOwnership;
      else starters.push(nextOwnership);
      starterById.set(definition.starterId, nextOwnership);
    }

    if (changed || raw === null) await publish({ ...library, quilts, collections });
    await writeDurableNow(DEFAULT_THREADS_MIGRATION_STATE, {
      version: 2,
      appliedGeneration: Math.max(appliedGeneration, DEFAULT_THREAD_GENERATION),
      starters
    });
  });
}

export function onPinsChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function createCollection(input: z.input<typeof createCollectionInputSchema>): Promise<QuiltCollection> {
  return serialize(async () => {
    const request = createCollectionInputSchema.parse(input);
    const library = await readLibrary();
    if (library.collections.length >= MAX_COLLECTIONS) throw new Error('Quilt limit reached');
    if (library.collections.some(row => referenceNameKey(row.name, '#') === referenceNameKey(request.name, '#'))) {
      throw new Error('A Quilt with that name already exists');
    }
    const collection: QuiltCollection = {
      id: randomUUID(),
      name: request.name,
      ...(request.description ? { description: request.description } : {}),
      createdAt: Date.now()
    };
    await publish({ ...library, collections: [...library.collections, collection] });
    return collection;
  });
}

export function setCollectionDescription(collectionId: string, description: string): Promise<QuiltCollection> {
  return serialize(async () => {
    const request = setCollectionDescriptionInputSchema.parse({ collectionId, description });
    const library = await readLibrary();
    const held = library.collections.find(row => row.id === request.collectionId);
    if (!held) throw new Error('Quilt not found');
    const nextDescription = request.description.trim();
    if ((held.description ?? '') === nextDescription) return held;
    const quilt: QuiltCollection = {
      ...held,
      ...(nextDescription ? { description: nextDescription } : {})
    };
    if (!nextDescription) delete quilt.description;
    await publish({
      ...library,
      collections: library.collections.map(row => row.id === quilt.id ? quilt : row)
    });
    return quilt;
  });
}

export function setThreadDescription(threadId: string, description: string): Promise<Quilt> {
  return serialize(async () => {
    const library = await readLibrary();
    const held = library.quilts.find(row => row.id === threadId);
    if (!held) throw new Error('Thread not found');
    const nextDescription = z.string().trim().max(1_000).parse(description);
    if ((held.description ?? '') === nextDescription) return held;
    const thread: Quilt = {
      ...held,
      ...(nextDescription ? { description: nextDescription } : {}),
      updatedAt: Date.now()
    };
    if (!nextDescription) delete thread.description;
    await publish({
      ...library,
      quilts: library.quilts.map(row => row.id === thread.id ? thread : row)
    });
    return thread;
  });
}

/**
 * Associates one exact existing Thread with one exact wider Quilt in a single durable commit.
 * Creating the Quilt is an explicit caller choice so recovery can first prove it is missing and
 * obtain user approval; a false value never turns a negative lookup into a mutation.
 */
export function associateThreadWithQuilt(input: z.input<typeof associateThreadQuiltInputSchema>): Promise<
  { status: 'missing' } | { status: 'associated'; thread: Quilt; quilt: QuiltCollection; created: boolean }
> {
  return serialize(async () => {
    const request = associateThreadQuiltInputSchema.parse(input);
    const library = await readLibrary();
    const thread = library.quilts.find(row => row.id === request.threadId);
    if (!thread) throw new Error('Thread not found');

    const quiltName = request.quiltName.startsWith('#') ? request.quiltName.slice(1) : request.quiltName;
    if (!quiltName || /^[#%]/u.test(quiltName)) throw new Error('Invalid Quilt name');
    const key = referenceNameKey(quiltName, '#');
    const matches = library.collections.filter(row => referenceNameKey(row.name, '#') === key);
    if (matches.length > 1) throw new Error('Pins library contains an ambiguous Quilt reference');
    let quilt = matches[0] ?? null;
    if (!quilt && !request.createIfMissing) return { status: 'missing' };

    const collections = [...library.collections];
    let created = false;
    if (!quilt) {
      if (collections.length >= MAX_COLLECTIONS) throw new Error('Quilt limit reached');
      quilt = { id: randomUUID(), name: quiltName, createdAt: Date.now() };
      collections.push(quilt);
      created = true;
    }

    const alreadyAssociated = thread.collectionIds.includes(quilt.id);
    if (alreadyAssociated && !created) return { status: 'associated', thread, quilt, created: false };
    const updated: Quilt = {
      ...thread,
      collectionIds: alreadyAssociated ? thread.collectionIds : [...thread.collectionIds, quilt.id],
      updatedAt: Date.now()
    };
    await publish({
      ...library,
      collections,
      quilts: library.quilts.map(row => row.id === updated.id ? updated : row)
    });
    return { status: 'associated', thread: updated, quilt, created };
  });
}

export function createQuilt(input: z.input<typeof createQuiltInputSchema>): Promise<Quilt> {
  return serialize(async () => {
    const request = createQuiltInputSchema.parse(input);
    const library = await readLibrary();
    if (library.quilts.length >= MAX_QUILTS) throw new Error('Thread limit reached');
    refuseDuplicateQuiltReference(library, request.title);
    requireCollections(library, request.collectionIds);
    const now = Date.now();
    const quilt: Quilt = {
      id: randomUUID(),
      title: request.title,
      ...(request.description ? { description: request.description } : {}),
      state: 'pinned',
      collectionIds: [...request.collectionIds],
      createdAt: now,
      updatedAt: now
    };
    await publish({ ...library, quilts: [...library.quilts, quilt] });
    return quilt;
  });
}

/**
 * Creates one user-facing Thread and any explicitly named Quilts in one durable commit.
 * Legacy storage still calls those wider Quilt rows collections.
 * Prompt and Link are optional first-save fields so renderer creation remains one atomic durable write.
 */
export function createThread(input: z.input<typeof createThreadInputSchema>): Promise<Quilt> {
  return serialize(async () => {
    const request = createThreadInputSchema.parse(input);
    const library = await readLibrary();
    if (library.quilts.length >= MAX_QUILTS) throw new Error('Thread limit reached');
    refuseDuplicateQuiltReference(library, request.title);

    const collections = [...library.collections];
    const collectionIds: string[] = [];
    for (const name of request.collectionNames) {
      const key = referenceNameKey(name, '#');
      let collection = collections.find(row => referenceNameKey(row.name, '#') === key);
      if (!collection) {
        if (collections.length >= MAX_COLLECTIONS) throw new Error('Quilt limit reached');
        collection = { id: randomUUID(), name, createdAt: Date.now() };
        collections.push(collection);
      }
      collectionIds.push(collection.id);
    }

    const now = Date.now();
    const prompt = request.prompt?.trim() ?? '';
    const link = request.link?.trim() ?? '';
    const thread: Quilt = {
      id: randomUUID(),
      title: request.title,
      ...(request.description ? { description: request.description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(link ? { link } : {}),
      state: 'pinned',
      collectionIds,
      createdAt: now,
      updatedAt: now
    };
    await publish({ ...library, collections, quilts: [...library.quilts, thread] });
    return thread;
  });
}

/**
 * Renames a Quilt and edits its Collections as one durable operation. Unknown collection names
 * are created in the same commit, so typing `#Eve` is enough to both create and assign it.
 */
export function updateQuiltMetadata(
  input: z.input<typeof updateQuiltMetadataInputSchema>
): Promise<Quilt> {
  return serialize(async () => {
    const request = updateQuiltMetadataInputSchema.parse(input);
    const library = await readLibrary();
    const held = library.quilts.find(row => row.id === request.quiltId);
    if (!held) throw new Error('Thread not found');
    refuseDuplicateQuiltReference(library, request.title, held.id);

    const collections = [...library.collections];
    const collectionIds: string[] = [];
    for (const name of request.collectionNames) {
      const key = referenceNameKey(name, '#');
      let collection = collections.find(row => referenceNameKey(row.name, '#') === key);
      if (!collection) {
        if (collections.length >= MAX_COLLECTIONS) throw new Error('Quilt limit reached');
        collection = { id: randomUUID(), name, createdAt: Date.now() };
        collections.push(collection);
      }
      collectionIds.push(collection.id);
    }

    const description = request.description === undefined ? (held.description ?? '') : request.description.trim();
    const link = request.link === undefined ? (held.link ?? '') : request.link.trim();
    const sameCollections = held.collectionIds.length === collectionIds.length &&
      held.collectionIds.every((collectionId, index) => collectionId === collectionIds[index]);
    if (held.title === request.title && (held.description ?? '') === description && (held.link ?? '') === link && sameCollections) return held;
    const quilt: Quilt = {
      ...held,
      title: request.title,
      collectionIds,
      ...(description ? { description } : {}),
      ...(link ? { link } : {}),
      updatedAt: Date.now()
    };
    if (!description) delete quilt.description;
    if (!link) delete quilt.link;
    await publish({ ...library, collections, quilts: library.quilts.map(row => row.id === quilt.id ? quilt : row) });
    return quilt;
  });
}

export function setQuiltState(quiltId: string, state: QuiltState): Promise<Quilt> {
  return serialize(async () => {
    const request = setQuiltStateInputSchema.parse({ quiltId, state });
    const library = await readLibrary();
    const held = library.quilts.find(row => row.id === request.quiltId);
    if (!held) throw new Error('Thread not found');
    if (held.state === request.state) return held;
    const quilt: Quilt = { ...held, state: request.state, updatedAt: Date.now() };
    await publish({ ...library, quilts: library.quilts.map(row => row.id === quilt.id ? quilt : row) });
    return quilt;
  });
}

/** Thread-owned freeform guidance shown above Pins and injected before them in a fresh chat. */
export function setQuiltPrompt(quiltId: string, prompt: string): Promise<Quilt> {
  return serialize(async () => {
    const request = setQuiltPromptInputSchema.parse({ quiltId, prompt });
    const library = await readLibrary();
    const held = library.quilts.find(row => row.id === request.quiltId);
    if (!held) throw new Error('Thread not found');
    const nextPrompt = request.prompt.trim();
    if ((held.prompt ?? '') === nextPrompt) {
      await markStarterPromptUserOwned(held.id);
      return held;
    }
    const quilt: Quilt = {
      ...held,
      ...(nextPrompt ? { prompt: nextPrompt } : {}),
      updatedAt: Date.now()
    };
    if (!nextPrompt) delete quilt.prompt;
    await publish({ ...library, quilts: library.quilts.map(row => row.id === quilt.id ? quilt : row) });
    await markStarterPromptUserOwned(quilt.id);
    return quilt;
  });
}

export function setQuiltCollections(quiltId: string, collectionIds: string[]): Promise<Quilt> {
  return serialize(async () => {
    const request = setQuiltCollectionsInputSchema.parse({ quiltId, collectionIds });
    const library = await readLibrary();
    const held = library.quilts.find(row => row.id === request.quiltId);
    if (!held) throw new Error('Thread not found');
    requireCollections(library, request.collectionIds);
    if (held.collectionIds.length === request.collectionIds.length &&
        held.collectionIds.every((collectionId, index) => collectionId === request.collectionIds[index])) return held;
    const quilt: Quilt = { ...held, collectionIds: [...request.collectionIds], updatedAt: Date.now() };
    await publish({ ...library, quilts: library.quilts.map(row => row.id === quilt.id ? quilt : row) });
    return quilt;
  });
}

export function createPin(input: CreatePinInput): Promise<CreatePinResult> {
  return serialize(async () => {
    const request = createPinInputSchema.parse(input) as CreatePinInput;
    const library = await readLibrary();
    if (library.pins.length >= MAX_PINS) throw new Error('Pin limit reached');
    if (library.pins.some(pin => pinSourceKey(pin) === pinSourceKey(request))) {
      throw new Error('This item is already pinned');
    }

    const now = Date.now();
    let quilt: Quilt;
    let quilts = library.quilts;
    const target = request.target;
    if (target.mode === 'existing') {
      const existing = library.quilts.find(row => row.id === target.quiltId);
      if (!existing) throw new Error('Thread not found');
      if (existing.state !== 'pinned') throw new Error('Restore the archived Thread before adding a Pin');
      quilt = { ...existing, updatedAt: now };
      quilts = library.quilts.map(row => row.id === quilt.id ? quilt : row);
    } else {
      if (library.quilts.length >= MAX_QUILTS) throw new Error('Thread limit reached');
      refuseDuplicateQuiltReference(library, target.title);
      requireCollections(library, target.collectionIds);
      quilt = {
        id: randomUUID(),
        title: target.title,
        state: 'pinned',
        collectionIds: [...target.collectionIds],
        createdAt: now,
        updatedAt: now
      };
      quilts = [...library.quilts, quilt];
    }

    const pin = {
      id: randomUUID(),
      quiltId: quilt.id,
      kind: request.kind,
      provenance: request.provenance,
      createdAt: now,
      ...(request.sourceCreatedAt !== undefined ? { sourceCreatedAt: request.sourceCreatedAt } : {}),
      ...(request.contextCreatedAt !== undefined ? { contextCreatedAt: request.contextCreatedAt } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.excerpt ? { excerpt: request.excerpt } : {}),
      ...(request.sourceLabel ? { sourceLabel: request.sourceLabel } : {}),
      ...((request.kind === 'prompt' || request.kind === 'message') && request.image ? { image: request.image } : {})
    } as Pin;
    await publish({ ...library, quilts, pins: [...library.pins, pin] });
    return { pin, quilt };
  });
}

/** Removing a Pin never deletes its Thread; empty Threads remain deliberate user organization. */
export function removePin(pinId: string): Promise<boolean> {
  return serialize(async () => {
    const parsedId = id.parse(pinId);
    const library = await readLibrary();
    if (!library.pins.some(pin => pin.id === parsedId)) return false;
    await publish({ ...library, pins: library.pins.filter(pin => pin.id !== parsedId) });
    return true;
  });
}

/** Sticky is a per-Thread Prompt/Message/Plan emphasis marker; it never duplicates or moves the Pin. */
export function setPinSticky(pinId: string, sticky: boolean): Promise<Pin> {
  return serialize(async () => {
    const request = setPinStickyInputSchema.parse({ pinId, sticky });
    const library = await readLibrary();
    const held = library.pins.find(pin => pin.id === request.pinId);
    if (!held) throw new Error('Pin not found');
    if (held.kind !== 'prompt' && held.kind !== 'message' && held.kind !== 'plan') {
      throw new Error('Only Prompt, Message, or Plan Pins can be made sticky');
    }
    if ((held.sticky === true) === request.sticky) return held;
    const pin: Pin = { ...held, ...(request.sticky ? { sticky: true } : {}) };
    if (!request.sticky) delete pin.sticky;
    await publish({
      ...library,
      pins: library.pins.map(row => row.id === pin.id ? pin : row)
    });
    return pin;
  });
}

/**
 * Deleting a user-facing Thread also deletes the Pins it owns in the same durable commit. Wider
 * user-facing Quilts are independent groupings and may still contain other Threads, so they are
 * deliberately preserved. Internal storage retains the legacy Quilt/Collection type names.
 */
export function deleteQuilt(quiltId: string): Promise<boolean> {
  return serialize(async () => {
    const parsedId = id.parse(quiltId);
    const library = await readLibrary();
    if (!library.quilts.some(quilt => quilt.id === parsedId)) return false;
    await publish({
      ...library,
      quilts: library.quilts.filter(quilt => quilt.id !== parsedId),
      pins: library.pins.filter(pin => pin.quiltId !== parsedId)
    });
    return true;
  });
}

/** Test seam for process-global listeners/serializer. */
export function resetPinsForTests(): void {
  mutations = Promise.resolve();
  changeListeners.clear();
}
