import { randomUUID } from 'node:crypto';

export const ARCHIVE_MEMORY_SCHEMA_VERSION = 1 as const;

export const ARCHIVE_MEMORY_SCOPES = ['global', 'project', 'thread', 'agent'] as const;
export const ARCHIVE_MEMORY_AUTHORS = ['user', 'eve', 'system'] as const;
export const ARCHIVE_MEMORY_STATUSES = ['active', 'superseded', 'retired'] as const;

export type ArchiveMemoryScope = (typeof ARCHIVE_MEMORY_SCOPES)[number];
export type ArchiveMemoryAuthor = (typeof ARCHIVE_MEMORY_AUTHORS)[number];
export type ArchiveMemoryStatus = (typeof ARCHIVE_MEMORY_STATUSES)[number];

/**
 * A pointer into canonical archive evidence. Memory stores only this identity, never a copy of
 * the source event/blob object. At least one event/blob selector is required so a memory item
 * cannot claim provenance from a session merely because the session existed.
 */
export interface ArchiveMemorySourceRef {
  sessionId: string;
  eventSeq?: number;
  assetId?: string;
}

/** Canonical curated memory. Evidence remains authoritative and independently reconstructable. */
export interface ArchiveMemoryRecord {
  schemaVersion: typeof ARCHIVE_MEMORY_SCHEMA_VERSION;
  id: string;
  scope: ArchiveMemoryScope;
  scopeId?: string;
  text: string;
  sourceRefs: readonly ArchiveMemorySourceRef[];
  createdAt: number;
  updatedAt: number;
  authoredBy: ArchiveMemoryAuthor;
  status: ArchiveMemoryStatus;
  /** Older record replaced by this one. The older text/provenance remains in the ledger. */
  supersedesId?: string;
  /** Newer record that replaced this one. Present only while status === superseded. */
  supersededById?: string;
}

export interface CreateArchiveMemoryInput {
  scope: ArchiveMemoryScope;
  scopeId?: string;
  text: string;
  sourceRefs: readonly ArchiveMemorySourceRef[];
  authoredBy: ArchiveMemoryAuthor;
}

export interface ArchiveMemoryWriteOptions {
  id?: string;
  now?: number;
}

export interface ArchiveMemoryListOptions {
  scope?: ArchiveMemoryScope;
  scopeId?: string;
  statuses?: readonly ArchiveMemoryStatus[];
}

const MAX_MEMORY_TEXT_CHARS = 32_000;
const MAX_SOURCE_REFS = 64;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

function nonEmpty(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeSourceRef(value: ArchiveMemorySourceRef): Readonly<ArchiveMemorySourceRef> {
  const sessionId = nonEmpty(value.sessionId, 'Memory source session id', 160);
  const eventSeq = value.eventSeq;
  const assetId = value.assetId;
  if (eventSeq !== undefined && (!Number.isSafeInteger(eventSeq) || eventSeq < 0)) {
    throw new Error('Memory source event sequence is invalid');
  }
  if (assetId !== undefined) nonEmpty(assetId, 'Memory source asset id', 256);
  if (eventSeq === undefined && assetId === undefined) {
    throw new Error('Memory source must identify an event or asset');
  }
  return Object.freeze({
    sessionId,
    ...(eventSeq === undefined ? {} : { eventSeq }),
    ...(assetId === undefined ? {} : { assetId })
  });
}

function normalizeSourceRefs(refs: readonly ArchiveMemorySourceRef[]): readonly Readonly<ArchiveMemorySourceRef>[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_SOURCE_REFS) {
    throw new Error('Memory source references are invalid');
  }
  const normalized = refs.map(normalizeSourceRef);
  const keys = normalized.map(ref => `${ref.sessionId}\u0000${ref.eventSeq ?? ''}\u0000${ref.assetId ?? ''}`);
  if (new Set(keys).size !== keys.length) throw new Error('Memory source references must be unique');
  return Object.freeze(normalized);
}

function normalizeScope(scope: unknown, scopeId: unknown): { scope: ArchiveMemoryScope; scopeId?: string } {
  if (!isOneOf(ARCHIVE_MEMORY_SCOPES, scope)) throw new Error('Memory scope is invalid');
  if (scope === 'global') {
    if (scopeId !== undefined) throw new Error('Global memory must not have a scope id');
    return { scope };
  }
  return { scope, scopeId: nonEmpty(scopeId, 'Memory scope id', 256) };
}

function normalizeInput(input: CreateArchiveMemoryInput): Omit<ArchiveMemoryRecord, 'schemaVersion' | 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const scoped = normalizeScope(input.scope, input.scopeId);
  if (!isOneOf(ARCHIVE_MEMORY_AUTHORS, input.authoredBy)) throw new Error('Memory author is invalid');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_MEMORY_TEXT_CHARS) {
    throw new Error('Memory text is invalid');
  }
  return {
    ...scoped,
    text: input.text,
    sourceRefs: normalizeSourceRefs(input.sourceRefs),
    authoredBy: input.authoredBy
  };
}

function freezeRecord(record: ArchiveMemoryRecord): Readonly<ArchiveMemoryRecord> {
  const frozenRefs = normalizeSourceRefs(record.sourceRefs);
  return Object.freeze({ ...record, sourceRefs: frozenRefs });
}

function normalizeRecord(value: ArchiveMemoryRecord): Readonly<ArchiveMemoryRecord> {
  if (value.schemaVersion !== ARCHIVE_MEMORY_SCHEMA_VERSION) throw new Error('Memory schema version is unsupported');
  const id = nonEmpty(value.id, 'Memory id', 128);
  const scoped = normalizeScope(value.scope, value.scopeId);
  if (!isOneOf(ARCHIVE_MEMORY_AUTHORS, value.authoredBy)) throw new Error('Memory author is invalid');
  if (!isOneOf(ARCHIVE_MEMORY_STATUSES, value.status)) throw new Error('Memory status is invalid');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_MEMORY_TEXT_CHARS) {
    throw new Error('Memory text is invalid');
  }
  const createdAt = timestamp(value.createdAt, 'Memory creation time');
  const updatedAt = timestamp(value.updatedAt, 'Memory update time');
  if (updatedAt < createdAt) throw new Error('Memory update precedes creation');
  const supersedesId = value.supersedesId === undefined ? undefined : nonEmpty(value.supersedesId, 'Superseded memory id', 128);
  const supersededById = value.supersededById === undefined ? undefined : nonEmpty(value.supersededById, 'Superseding memory id', 128);
  if (supersedesId === id || supersededById === id) throw new Error('Memory lifecycle link cannot reference itself');
  if (value.status === 'superseded' && !supersededById) throw new Error('Superseded memory must identify its replacement');
  if (value.status !== 'superseded' && supersededById) throw new Error('Only superseded memory may identify a replacement');
  return freezeRecord({
    schemaVersion: ARCHIVE_MEMORY_SCHEMA_VERSION,
    id,
    ...scoped,
    text: value.text,
    sourceRefs: normalizeSourceRefs(value.sourceRefs),
    createdAt,
    updatedAt,
    authoredBy: value.authoredBy,
    status: value.status,
    ...(supersedesId ? { supersedesId } : {}),
    ...(supersededById ? { supersededById } : {})
  });
}

function validateLifecycleLinks(records: ReadonlyMap<string, Readonly<ArchiveMemoryRecord>>): void {
  for (const record of records.values()) {
    if (record.supersedesId) {
      const previous = records.get(record.supersedesId);
      if (!previous || previous.supersededById !== record.id) {
        throw new Error(`Memory ${record.id} has a broken supersedes link`);
      }
      if (previous.scope !== record.scope || previous.scopeId !== record.scopeId) {
        throw new Error(`Memory ${record.id} changes scope across a supersede link`);
      }
    }
    if (record.supersededById) {
      const next = records.get(record.supersededById);
      if (!next || next.supersedesId !== record.id) {
        throw new Error(`Memory ${record.id} has a broken superseded-by link`);
      }
    }
  }
}

/**
 * Reference canonical ledger used by the experiment. Persistence can append/replace its JSONL
 * representation; source archive evidence is never passed in or mutated by this owner.
 */
export class ArchiveMemoryLedger {
  private records: Map<string, Readonly<ArchiveMemoryRecord>>;

  constructor(seed: readonly ArchiveMemoryRecord[] = []) {
    const records = new Map<string, Readonly<ArchiveMemoryRecord>>();
    for (const raw of seed) {
      const record = normalizeRecord(raw);
      if (records.has(record.id)) throw new Error(`Duplicate memory id: ${record.id}`);
      records.set(record.id, record);
    }
    validateLifecycleLinks(records);
    this.records = records;
  }

  get(id: string): Readonly<ArchiveMemoryRecord> | null {
    return this.records.get(id) ?? null;
  }

  list(options: ArchiveMemoryListOptions = {}): readonly Readonly<ArchiveMemoryRecord>[] {
    const statuses = options.statuses ? new Set(options.statuses) : null;
    if (statuses && [...statuses].some(status => !isOneOf(ARCHIVE_MEMORY_STATUSES, status))) {
      throw new Error('Memory status filter is invalid');
    }
    return Object.freeze([...this.records.values()]
      .filter(record => options.scope === undefined || record.scope === options.scope)
      .filter(record => options.scopeId === undefined || record.scopeId === options.scopeId)
      .filter(record => !statuses || statuses.has(record.status))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)));
  }

  create(input: CreateArchiveMemoryInput, options: ArchiveMemoryWriteOptions = {}): Readonly<ArchiveMemoryRecord> {
    const normalized = normalizeInput(input);
    const id = nonEmpty(options.id ?? randomUUID(), 'Memory id', 128);
    if (this.records.has(id)) throw new Error(`Duplicate memory id: ${id}`);
    const now = timestamp(options.now ?? Date.now(), 'Memory creation time');
    const record = freezeRecord({
      schemaVersion: ARCHIVE_MEMORY_SCHEMA_VERSION,
      id,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      status: 'active'
    });
    this.records.set(record.id, record);
    return record;
  }

  supersede(id: string, replacement: CreateArchiveMemoryInput, options: ArchiveMemoryWriteOptions = {}): Readonly<ArchiveMemoryRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error('Memory record not found');
    if (current.status !== 'active') throw new Error('Only active memory can be superseded');
    const normalized = normalizeInput(replacement);
    if (normalized.scope !== current.scope || normalized.scopeId !== current.scopeId) {
      throw new Error('Superseding memory must keep the same scope');
    }
    const replacementId = nonEmpty(options.id ?? randomUUID(), 'Memory id', 128);
    if (replacementId === id || this.records.has(replacementId)) throw new Error(`Duplicate memory id: ${replacementId}`);
    const now = timestamp(options.now ?? Date.now(), 'Memory update time');
    if (now < current.updatedAt) throw new Error('Memory update time moved backwards');
    const oldRecord = freezeRecord({ ...current, status: 'superseded', updatedAt: now, supersededById: replacementId });
    const newRecord = freezeRecord({
      schemaVersion: ARCHIVE_MEMORY_SCHEMA_VERSION,
      id: replacementId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      supersedesId: id
    });
    const next = new Map(this.records);
    next.set(id, oldRecord);
    next.set(replacementId, newRecord);
    validateLifecycleLinks(next);
    this.records = next;
    return newRecord;
  }

  retire(id: string, nowInput = Date.now()): Readonly<ArchiveMemoryRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error('Memory record not found');
    if (current.status !== 'active') throw new Error('Only active memory can be retired');
    const now = timestamp(nowInput, 'Memory update time');
    if (now < current.updatedAt) throw new Error('Memory update time moved backwards');
    const retired = freezeRecord({ ...current, status: 'retired', updatedAt: now });
    this.records.set(id, retired);
    return retired;
  }

  snapshot(): readonly Readonly<ArchiveMemoryRecord>[] {
    return this.list();
  }
}

/** Deterministic canonical JSONL projection for archive/memory/entries.jsonl. */
export function archiveMemoryJsonl(records: readonly ArchiveMemoryRecord[]): string {
  const ledger = new ArchiveMemoryLedger(records);
  return ledger.snapshot().map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

export function parseArchiveMemoryJsonl(text: string): readonly Readonly<ArchiveMemoryRecord>[] {
  const parsed: ArchiveMemoryRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid memory JSONL at line ${index + 1}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid memory record at line ${index + 1}`);
    }
    parsed.push(value as ArchiveMemoryRecord);
  }
  return new ArchiveMemoryLedger(parsed).snapshot();
}
