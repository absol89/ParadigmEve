import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ensureArchiveDirectory, ensureArchiveFile } from './archive-path-security.js';

export const ARCHIVE_INDEX_SCHEMA_VERSION = 1 as const;

export const ARCHIVE_INDEX_DOCUMENT_KINDS = ['session', 'event', 'asset', 'memory'] as const;
export type ArchiveIndexDocumentKind = (typeof ARCHIVE_INDEX_DOCUMENT_KINDS)[number];

/** Stable authority pointer. Search results must resolve through canonical evidence/memory owners. */
export type ArchiveIndexAuthorityRef =
  | { kind: 'session'; sessionId: string }
  | { kind: 'evidence'; sessionId: string; eventSeq?: number; assetId?: string }
  | { kind: 'memory'; memoryId: string };

/**
 * Inert searchable projection. None of these fields becomes transcript, memory or blob authority.
 * A production SQLite backend should persist only this normalized/queryable shape plus authority refs.
 */
export interface ArchiveIndexDocument {
  id: string;
  kind: ArchiveIndexDocumentKind;
  authority: ArchiveIndexAuthorityRef;
  title?: string;
  text?: string;
  filename?: string;
  provider?: string;
  projectId?: string;
  threadIds?: readonly string[];
  quiltIds?: readonly string[];
  timestamp?: number;
}

export interface ArchiveIndexSearchOptions {
  kinds?: readonly ArchiveIndexDocumentKind[];
  sessionId?: string;
  projectId?: string;
  threadId?: string;
  quiltId?: string;
  limit?: number;
}

export interface ArchiveIndexHit {
  score: number;
  document: Readonly<ArchiveIndexDocument>;
}

export interface ArchiveIndexStats {
  schemaVersion: typeof ARCHIVE_INDEX_SCHEMA_VERSION;
  backend: string;
  generation: number;
  documents: number;
  terms: number;
}

export type ArchiveIndexDocuments = Iterable<ArchiveIndexDocument> | AsyncIterable<ArchiveIndexDocument>;

/**
 * Exact production backend seam. `rebuild()` must prepare a complete replacement off to the side
 * and publish it only after every source document validates. For SQLite that means a temporary DB,
 * schema/FTS population and validation, then atomic file publication/reopen. `dispose()` may delete
 * every derived index byte because canonical archive evidence and memory live elsewhere.
 */
export interface ArchiveIndexProjection {
  readonly backend: string;
  rebuild(documents: ArchiveIndexDocuments): Promise<ArchiveIndexStats>;
  search(query: string, options?: ArchiveIndexSearchOptions): Promise<readonly ArchiveIndexHit[]>;
  stats(): ArchiveIndexStats;
  dispose(): Promise<void>;
}

interface IndexedDocument {
  document: Readonly<ArchiveIndexDocument>;
  normalizedTitle: string;
  normalizedText: string;
  normalizedFilename: string;
  normalizedProvider: string;
  terms: readonly string[];
}

interface SearchContext {
  queryTerms: readonly string[];
  limit: number;
  kinds: ReadonlySet<ArchiveIndexDocumentKind> | null;
}

const MAX_DOCUMENT_TEXT_CHARS = 2_000_000;
const MAX_IDS_PER_MEMBERSHIP = 2_000;
// Keep the reference tokenizer deliberately plain and FTS-like: punctuation joins are search
// boundaries, so `provider-neutral` remains discoverable as either `provider` or `neutral`.
const TOKEN = /[\p{L}\p{N}]+/gu;

function clean(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function terms(value: string): string[] {
  return [...normalize(value).matchAll(TOKEN)].map(match => match[0]!);
}

function stringList(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_IDS_PER_MEMBERSHIP) throw new Error(`${label} is invalid`);
  const rows = value.map(item => clean(item, label, 256));
  if (new Set(rows).size !== rows.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze([...rows]);
}

function authority(value: ArchiveIndexAuthorityRef): Readonly<ArchiveIndexAuthorityRef> {
  if (!value || typeof value !== 'object') throw new Error('Index authority reference is invalid');
  if (value.kind === 'session') return Object.freeze({ kind: 'session', sessionId: clean(value.sessionId, 'Session id', 160) });
  if (value.kind === 'memory') return Object.freeze({ kind: 'memory', memoryId: clean(value.memoryId, 'Memory id', 128) });
  if (value.kind !== 'evidence') throw new Error('Index authority reference is invalid');
  const sessionId = clean(value.sessionId, 'Evidence session id', 160);
  const eventSeq = value.eventSeq;
  const assetId = value.assetId;
  if (eventSeq !== undefined && (!Number.isSafeInteger(eventSeq) || eventSeq < 0)) throw new Error('Evidence event sequence is invalid');
  if (assetId !== undefined) clean(assetId, 'Evidence asset id', 256);
  if (eventSeq === undefined && assetId === undefined) throw new Error('Evidence index reference must identify an event or asset');
  return Object.freeze({
    kind: 'evidence',
    sessionId,
    ...(eventSeq === undefined ? {} : { eventSeq }),
    ...(assetId === undefined ? {} : { assetId })
  });
}

function prepare(raw: ArchiveIndexDocument): IndexedDocument {
  const id = clean(raw.id, 'Index document id', 256);
  if (!(ARCHIVE_INDEX_DOCUMENT_KINDS as readonly string[]).includes(raw.kind)) throw new Error('Index document kind is invalid');
  const title = optionalText(raw.title, 'Index title', 16_000);
  const text = optionalText(raw.text, 'Index text', MAX_DOCUMENT_TEXT_CHARS);
  const filename = optionalText(raw.filename, 'Index filename', 1_024);
  const provider = optionalText(raw.provider, 'Index provider', 256);
  const projectId = raw.projectId === undefined ? undefined : clean(raw.projectId, 'Project id', 256);
  const threadIds = stringList(raw.threadIds, 'Thread id');
  const quiltIds = stringList(raw.quiltIds, 'Quilt id');
  const timestamp = raw.timestamp;
  if (timestamp !== undefined && (!Number.isSafeInteger(timestamp) || timestamp < 0)) throw new Error('Index timestamp is invalid');
  const frozen = Object.freeze({
    id,
    kind: raw.kind,
    authority: authority(raw.authority),
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(filename ? { filename } : {}),
    ...(provider ? { provider } : {}),
    ...(projectId ? { projectId } : {}),
    ...(threadIds.length ? { threadIds } : {}),
    ...(quiltIds.length ? { quiltIds } : {}),
    ...(timestamp === undefined ? {} : { timestamp })
  });
  const normalizedTitle = normalize(title);
  const normalizedText = normalize(text);
  const normalizedFilename = normalize(filename);
  const normalizedProvider = normalize(provider);
  return {
    document: frozen,
    normalizedTitle,
    normalizedText,
    normalizedFilename,
    normalizedProvider,
    terms: Object.freeze([...new Set(terms(`${title}\n${text}\n${filename}\n${provider}`))])
  };
}

function sessionIdOf(reference: ArchiveIndexAuthorityRef): string | undefined {
  return reference.kind === 'memory' ? undefined : reference.sessionId;
}

function occurrenceCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function searchContext(query: string, options: ArchiveIndexSearchOptions): SearchContext {
  if (typeof query !== 'string') throw new Error('Index query is invalid');
  const queryTerms = Object.freeze([...new Set(terms(query))]);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Index search limit is invalid');
  const kinds = options.kinds ? new Set(options.kinds) : null;
  if (kinds && [...kinds].some(kind => !(ARCHIVE_INDEX_DOCUMENT_KINDS as readonly string[]).includes(kind))) {
    throw new Error('Index kind filter is invalid');
  }
  return { queryTerms, limit, kinds };
}

function matchesFilters(
  document: Readonly<ArchiveIndexDocument>,
  options: ArchiveIndexSearchOptions,
  kinds: ReadonlySet<ArchiveIndexDocumentKind> | null
): boolean {
  if (kinds && !kinds.has(document.kind)) return false;
  if (options.sessionId !== undefined && sessionIdOf(document.authority) !== options.sessionId) return false;
  if (options.projectId !== undefined && document.projectId !== options.projectId) return false;
  if (options.threadId !== undefined && !document.threadIds?.includes(options.threadId)) return false;
  if (options.quiltId !== undefined && !document.quiltIds?.includes(options.quiltId)) return false;
  return true;
}

function scoreDocument(indexed: IndexedDocument, queryTerms: readonly string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    score += occurrenceCount(indexed.normalizedTitle, term) * 4;
    score += occurrenceCount(indexed.normalizedFilename, term) * 3;
    score += occurrenceCount(indexed.normalizedProvider, term) * 2;
    score += occurrenceCount(indexed.normalizedText, term);
  }
  return score;
}

function compareHits(left: ArchiveIndexHit, right: ArchiveIndexHit): number {
  return right.score - left.score ||
    (right.document.timestamp ?? 0) - (left.document.timestamp ?? 0) ||
    left.document.id.localeCompare(right.document.id);
}

function insertBoundedHit(hits: ArchiveIndexHit[], hit: ArchiveIndexHit, limit: number): void {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareHits(hit, hits[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  if (low < limit) {
    hits.splice(low, 0, hit);
    if (hits.length > limit) hits.pop();
  }
}

/** Dependency-free reference backend. It is intentionally replaceable by SQLite/FTS. */
export class InMemoryArchiveIndex implements ArchiveIndexProjection {
  readonly backend = 'memory-reference';
  private generation = 0;
  private documents = new Map<string, IndexedDocument>();
  private postings = new Map<string, ReadonlySet<string>>();
  private disposed = false;

  async rebuild(source: ArchiveIndexDocuments): Promise<ArchiveIndexStats> {
    this.assertOpen();
    const nextDocuments = new Map<string, IndexedDocument>();
    const mutablePostings = new Map<string, Set<string>>();
    for await (const raw of source) {
      const indexed = prepare(raw);
      if (nextDocuments.has(indexed.document.id)) throw new Error(`Duplicate index document id: ${indexed.document.id}`);
      nextDocuments.set(indexed.document.id, indexed);
      for (const term of indexed.terms) {
        const rows = mutablePostings.get(term) ?? new Set<string>();
        rows.add(indexed.document.id);
        mutablePostings.set(term, rows);
      }
    }
    const nextPostings = new Map<string, ReadonlySet<string>>();
    for (const [term, ids] of mutablePostings) nextPostings.set(term, ids);
    // Publish only after the complete replacement built successfully.
    this.documents = nextDocuments;
    this.postings = nextPostings;
    this.generation += 1;
    return this.stats();
  }

  async search(query: string, options: ArchiveIndexSearchOptions = {}): Promise<readonly ArchiveIndexHit[]> {
    this.assertOpen();
    const { queryTerms, limit, kinds } = searchContext(query, options);

    let candidateIds: Set<string>;
    if (queryTerms.length === 0) {
      candidateIds = new Set(this.documents.keys());
    } else {
      const first = this.postings.get(queryTerms[0]!);
      candidateIds = new Set(first ?? []);
      for (const term of queryTerms.slice(1)) {
        const posting = this.postings.get(term);
        if (!posting) {
          candidateIds.clear();
          break;
        }
        for (const id of [...candidateIds]) if (!posting.has(id)) candidateIds.delete(id);
      }
    }

    const hits: ArchiveIndexHit[] = [];
    for (const id of candidateIds) {
      const indexed = this.documents.get(id)!;
      const document = indexed.document;
      if (!matchesFilters(document, options, kinds)) continue;
      const score = scoreDocument(indexed, queryTerms);
      hits.push(Object.freeze({ score, document }));
    }
    hits.sort(compareHits);
    return Object.freeze(hits.slice(0, limit));
  }

  stats(): ArchiveIndexStats {
    this.assertOpen();
    return Object.freeze({
      schemaVersion: ARCHIVE_INDEX_SCHEMA_VERSION,
      backend: this.backend,
      generation: this.generation,
      documents: this.documents.size,
      terms: this.postings.size
    });
  }

  async dispose(): Promise<void> {
    this.documents.clear();
    this.postings.clear();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Archive index is disposed');
  }
}

const DISTINCT_LEAF_BYTES = 4 * 1024 * 1024;
const DISTINCT_HASH_BYTES = 32;
const DISTINCT_BUCKET_BUFFER_CHARS = 64 * 1024;

type OpenHandle = Awaited<ReturnType<typeof fs.open>>;

async function closeQuietly(handle: OpenHandle | null): Promise<void> {
  if (!handle) return;
  try { await handle.close(); } catch { /* Best-effort close after a failed rebuild. */ }
}

async function removeFencedFile(archiveRoot: string, file: string): Promise<void> {
  if (await ensureArchiveFile(archiveRoot, file, { createParents: false }) === 'present') {
    await fs.rm(file, { force: true });
  }
}

async function readJsonLines(
  archiveRoot: string,
  file: string,
  visit: (line: string) => void | Promise<void>
): Promise<void> {
  if (await ensureArchiveFile(archiveRoot, file, { createParents: false }) === 'missing') return;
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 0) await visit(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function distinctLeaf(
  archiveRoot: string,
  file: string,
  duplicateLabel?: string
): Promise<number> {
  const values = new Set<string>();
  await readJsonLines(archiveRoot, file, line => {
    if (values.has(line)) {
      if (duplicateLabel) {
        let value = line;
        try { value = String(JSON.parse(line)); } catch { /* The spool is internal and validated before publication. */ }
        throw new Error(`${duplicateLabel}: ${value}`);
      }
      return;
    }
    values.add(line);
  });
  return values.size;
}

async function distinctCount(
  archiveRoot: string,
  file: string,
  workspace: string,
  duplicateLabel?: string,
  depth = 0
): Promise<number> {
  if (await ensureArchiveFile(archiveRoot, file, { createParents: false }) === 'missing') return 0;
  const stat = await fs.stat(file);
  if (stat.size <= DISTINCT_LEAF_BYTES || depth >= DISTINCT_HASH_BYTES) {
    return distinctLeaf(archiveRoot, file, duplicateLabel);
  }

  const handles = new Map<number, OpenHandle>();
  const buffers = new Map<number, string>();
  const bucketPaths = new Map<number, string>();
  try {
    await readJsonLines(archiveRoot, file, async line => {
      const bucket = createHash('sha256').update(line).digest()[depth]!;
      let handle = handles.get(bucket);
      if (!handle) {
        const bucketPath = path.join(workspace, `bucket-${depth}-${bucket}-${randomUUID()}.jsonl`);
        await ensureArchiveFile(archiveRoot, bucketPath, { createParents: false });
        handle = await fs.open(bucketPath, 'wx');
        handles.set(bucket, handle);
        bucketPaths.set(bucket, bucketPath);
      }
      const buffered = `${buffers.get(bucket) ?? ''}${line}\n`;
      if (buffered.length >= DISTINCT_BUCKET_BUFFER_CHARS) {
        await handle.writeFile(buffered, { encoding: 'utf8' });
        buffers.set(bucket, '');
      } else buffers.set(bucket, buffered);
    });
    for (const [bucket, buffered] of buffers) {
      if (buffered) await handles.get(bucket)!.writeFile(buffered, { encoding: 'utf8' });
    }
  } finally {
    await Promise.all([...handles.values()].map(handle => closeQuietly(handle)));
  }

  let total = 0;
  for (const bucketPath of bucketPaths.values()) {
    try {
      total += await distinctCount(archiveRoot, bucketPath, workspace, duplicateLabel, depth + 1);
    } finally {
      await removeFencedFile(archiveRoot, bucketPath);
    }
  }
  return total;
}

async function cleanupWorkspace(archiveRoot: string, workspace: string): Promise<void> {
  if (await ensureArchiveDirectory(archiveRoot, workspace, false) === 'missing') return;
  const entries = await fs.readdir(workspace, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await removeFencedFile(archiveRoot, path.join(workspace, entry.name));
  }
  await ensureArchiveDirectory(archiveRoot, workspace, false);
  await fs.rmdir(workspace);
}

/**
 * Production dependency-free archive index. Documents live in one atomically replaced JSONL file;
 * rebuild validation/stat accounting spills ids and terms to disk, and search line-scans that file
 * while retaining at most the requested hit limit. This trades CPU for a rebuild/search memory bound.
 */
export class DiskArchiveIndex implements ArchiveIndexProjection {
  readonly backend = 'jsonl-disk';
  private readonly archiveRoot: string;
  private readonly indexFile: string;
  private generation = 0;
  private documentCount = 0;
  private termCount = 0;
  private disposed = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(archiveRoot: string) {
    if (!path.isAbsolute(archiveRoot)) throw new Error('Archive index root must be absolute');
    this.archiveRoot = path.resolve(archiveRoot);
    this.indexFile = path.join(this.archiveRoot, 'derived', 'archive-index.jsonl');
  }

  async rebuild(source: ArchiveIndexDocuments): Promise<ArchiveIndexStats> {
    return this.exclusive(() => this.rebuildExclusive(source));
  }

  private async rebuildExclusive(source: ArchiveIndexDocuments): Promise<ArchiveIndexStats> {
    const derivedRoot = path.dirname(this.indexFile);
    await ensureArchiveDirectory(this.archiveRoot, derivedRoot, true);
    const nonce = `${process.pid}-${randomUUID()}`;
    const candidate = path.join(derivedRoot, `archive-index-${nonce}.tmp`);
    const workspace = path.join(derivedRoot, `.archive-index-${nonce}`);
    await ensureArchiveDirectory(this.archiveRoot, workspace, true);
    const idsFile = path.join(workspace, 'ids.jsonl');
    const termsFile = path.join(workspace, 'terms.jsonl');
    let candidateHandle: OpenHandle | null = null;
    let idsHandle: OpenHandle | null = null;
    let termsHandle: OpenHandle | null = null;
    let documents = 0;

    try {
      for (const file of [candidate, idsFile, termsFile]) {
        await ensureArchiveFile(this.archiveRoot, file, { createParents: false });
      }
      candidateHandle = await fs.open(candidate, 'wx');
      idsHandle = await fs.open(idsFile, 'wx');
      termsHandle = await fs.open(termsFile, 'wx');

      for await (const raw of source) {
        const indexed = prepare(raw);
        await candidateHandle.writeFile(`${JSON.stringify(indexed.document)}\n`, { encoding: 'utf8' });
        await idsHandle.writeFile(`${JSON.stringify(indexed.document.id)}\n`, { encoding: 'utf8' });
        if (indexed.terms.length > 0) {
          await termsHandle.writeFile(`${indexed.terms.map(term => JSON.stringify(term)).join('\n')}\n`, { encoding: 'utf8' });
        }
        documents += 1;
      }

      await Promise.all([closeQuietly(candidateHandle), closeQuietly(idsHandle), closeQuietly(termsHandle)]);
      candidateHandle = idsHandle = termsHandle = null;
      await ensureArchiveFile(this.archiveRoot, candidate, { createParents: false });
      await distinctCount(this.archiveRoot, idsFile, workspace, 'Duplicate index document id');
      const uniqueTerms = await distinctCount(this.archiveRoot, termsFile, workspace);

      await ensureArchiveFile(this.archiveRoot, this.indexFile, { createParents: false });
      await ensureArchiveFile(this.archiveRoot, candidate, { createParents: false });
      await fs.rename(candidate, this.indexFile);

      this.generation += 1;
      this.documentCount = documents;
      this.termCount = uniqueTerms;
      return this.stats();
    } finally {
      await Promise.all([closeQuietly(candidateHandle), closeQuietly(idsHandle), closeQuietly(termsHandle)]);
      try { await removeFencedFile(this.archiveRoot, candidate); } catch { /* Do not follow a moved/unsafe path during cleanup. */ }
      try { await cleanupWorkspace(this.archiveRoot, workspace); } catch { /* Failed cleanup must not overwrite the rebuild result. */ }
    }
  }

  async search(query: string, options: ArchiveIndexSearchOptions = {}): Promise<readonly ArchiveIndexHit[]> {
    return this.exclusive(async () => {
      const { queryTerms, limit, kinds } = searchContext(query, options);
      const hits: ArchiveIndexHit[] = [];
      await readJsonLines(this.archiveRoot, this.indexFile, line => {
        let raw: unknown;
        try { raw = JSON.parse(line) as unknown; } catch { throw new Error('Disk archive index is invalid JSONL'); }
        const indexed = prepare(raw as ArchiveIndexDocument);
        if (queryTerms.length > 0 && queryTerms.some(term => !indexed.terms.includes(term))) return;
        if (!matchesFilters(indexed.document, options, kinds)) return;
        const hit = Object.freeze({ score: scoreDocument(indexed, queryTerms), document: indexed.document });
        insertBoundedHit(hits, hit, limit);
      });
      return Object.freeze(hits);
    });
  }

  stats(): ArchiveIndexStats {
    this.assertOpen();
    return Object.freeze({
      schemaVersion: ARCHIVE_INDEX_SCHEMA_VERSION,
      backend: this.backend,
      generation: this.generation,
      documents: this.documentCount,
      terms: this.termCount
    });
  }

  async dispose(): Promise<void> {
    await this.operation.catch(() => undefined);
    this.disposed = true;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.operation.catch(() => undefined).then(async () => {
      this.assertOpen();
      return work();
    });
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Archive index is disposed');
  }
}

export function createReferenceArchiveIndex(): ArchiveIndexProjection {
  return new InMemoryArchiveIndex();
}

export function createDiskArchiveIndex(archiveRoot: string): ArchiveIndexProjection {
  return new DiskArchiveIndex(archiveRoot);
}
