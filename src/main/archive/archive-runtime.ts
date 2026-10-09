/**
 * Main-process owner for the archive experiment.
 *
 * This module deliberately depends on injected current-session readers instead of importing the
 * live session store. Prime can wire the eventual post-commit hook without making archive code a
 * second session authority or coupling this experiment to recorder/browser internals.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  ARCHIVE_EVENT_SCHEMA_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveAssetRef,
  type ArchiveContinuation,
  type ArchiveEvent,
  type ArchiveJson,
  type ArchiveSessionManifest,
  type ArchiveSessionProjection
} from '../../shared/archive.js';
import type { AssetRef, ChatProvider, SessionEvent, SessionSummary, StoredText } from '../../shared/session.js';
import { isUnresolvedContentReference } from '../../shared/content-reference.js';
import {
  createDiskArchiveIndex,
  type ArchiveIndexDocument,
  type ArchiveIndexHit,
  type ArchiveIndexProjection,
  type ArchiveIndexSearchOptions,
  type ArchiveIndexStats
} from './archive-index.js';
import {
  archiveChatTokenMap,
  renderLazyArchiveHtml,
  renderArchiveTranscriptItemParts
} from './archive-html.js';
import type { ArchiveViewAsset, ArchiveViewChatHeader, ArchiveViewTranscriptItem } from './archive-view-model.js';
import { ensureArchiveDirectory, ensureArchiveFile } from './archive-path-security.js';
import { ArchiveStore } from './archive-store.js';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_SOURCE_EVENTS = 100_000;
const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SESSION_ASSET_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_OVERFLOW_TEXT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_RECONCILES = 4;
const STATIC_GENERATION_RE = /^g-[a-f0-9]{32}$/u;
const STATIC_GENERATION_FILE_RE = /^(?:search|chat-\d+|chat-\d+-segment-\d+)\.js$/u;
const STATIC_SEGMENT_TARGET_BYTES = 512 * 1024;
const STATIC_SEGMENT_TEXT_CHARS = 64 * 1024;
const STATIC_SHELL_GENERATION_SCAN_BYTES = 2 * 1024 * 1024;

export interface CurrentSessionArchiveSnapshot {
  summary: SessionSummary;
  /** Canonical source ordering supplied by the current session owner. */
  events: readonly SessionEvent[];
  threadIds?: readonly string[];
  quiltIds?: readonly string[];
  projectPathLabel?: string;
  /** Optional stronger lineage supplied by the current owner. */
  continuation?: ArchiveContinuation;
}

export interface ArchiveRuntimeSource {
  listSessionIds(): Promise<readonly string[]>;
  readSession(sessionId: string): Promise<CurrentSessionArchiveSnapshot | null>;
  /** Returns current-session owned bytes for an exact retained asset id, or null when unavailable. */
  readAsset(sessionId: string, assetId: string): Promise<Uint8Array | null>;
  /** Optional future store-level committed-projection hook. The runtime never imports its owner. */
  subscribeCommitted?: (listener: (sessionId: string) => void) => () => void;
}

export interface ArchiveRuntimeOptions {
  archiveRoot: string;
  writerVersion: string;
  source: ArchiveRuntimeSource;
  now?: () => number;
  maxSourceEvents?: number;
  maxAssetBytes?: number;
  maxSessionAssetBytes?: number;
  maxOverflowTextBytes?: number;
  maxConcurrentReconciles?: number;
  onError?: (error: Error) => void;
  onDiagnostic?: (message: string) => void;
  /**
   * Which route a non-ChatGPT turn went to (`ollama-local` / `ollama-cloud`). Supplied by the app;
   * without it an Ollama turn is archived as `ollama` with its model, never as ChatGPT.
   */
  providerRoute?: (provider: ChatProvider) => string;
}

export interface ArchiveStaticSiteTarget {
  archiveRoot: string;
  siteRoot: string;
  indexPath: string;
}

export interface ArchiveRuntimeStatus {
  initialized: boolean;
  disposed: boolean;
  queuedSessions: number;
  reconcilingSessions: number;
  lastReconciledSessionId: string | null;
  lastReconciledAt: number | null;
  lastDerivedAt: number | null;
  lastError: string | null;
  index: ArchiveIndexStats | null;
  staticSite: ArchiveStaticSiteTarget;
}

export interface ArchiveDerivedResult {
  index: ArchiveIndexStats;
  chats: number;
  staticSite: ArchiveStaticSiteTarget;
}

interface ReconcileState {
  dirty: boolean;
  running: Promise<void> | null;
}

interface ProjectionContext {
  totalRetainedBytes: number;
  retainedAssets: Map<string, Omit<ArchiveAssetRef, 'kind' | 'providerAssetId'>>;
  partial: boolean;
}

interface ArchiveDerivedSessionHeader {
  sessionId: string;
  state: 'complete' | 'partial';
  manifest: ArchiveSessionManifest;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function memoryMiB(bytes: number): number {
  return Math.round(bytes / 1048576);
}

function memorySummary(): string {
  return 'rss=' + memoryMiB(process.memoryUsage().rss) + 'MiB';
}

function uniqueBounded(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 512))];
}

function bounded(value: string | undefined | null, max = 512): string | undefined {
  return value && value.length <= max ? value : undefined;
}

function assetExtension(asset: AssetRef): string | undefined {
  const fromId = /\.([a-z0-9]{1,16})$/i.exec(asset.id)?.[1]?.toLowerCase();
  if (fromId) return fromId === 'jpeg' ? 'jpg' : fromId;
  switch (asset.mimeType.toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'application/pdf': return 'pdf';
    case 'text/plain': return 'txt';
    default: return undefined;
  }
}

function archiveAssetKind(source: AssetRef, context: 'message' | 'tool' | 'native'): ArchiveAssetRef['kind'] {
  if (context === 'native') return 'generated-image';
  if (context === 'tool' && source.mimeType.startsWith('image/')) return 'tool-image';
  if (source.mimeType.startsWith('image/')) return 'image';
  if (source.mimeType) return 'file';
  return 'unknown';
}

function providerIdentity(event: SessionEvent, route?: (provider: ChatProvider) => string): ArchiveEvent['provider'] | undefined {
  // A turn answered or sent through another provider keeps that provenance: the archive used to
  // label every Ollama turn as ChatGPT and drop its model (2.3.7 acceptance, 2026-10-09).
  const chatProvider = (event.kind === 'user_message' || event.kind === 'assistant_message') ? event.provider : undefined;
  const model = chatProvider ? chatProvider.model : event.kind === 'tool_call' ? event.call.model ?? event.model : event.model;
  const conversationId = event.kind === 'session_start'
    ? event.conversationId ?? undefined
    : event.kind === 'tool_call'
      ? event.call.conversationId ?? undefined
      : undefined;
  const messageId = event.kind === 'user_message' || event.kind === 'assistant_message' || event.kind === 'native_image' || event.kind === 'page_tool'
    ? bounded(event.messageId)
    : undefined;
  const turnId = bounded(event.turnId);
  const safeModel = bounded(model);
  const safeConversation = bounded(conversationId);
  if (!messageId && !turnId && !safeModel && !safeConversation) return undefined;
  let provider = 'chatgpt';
  if (chatProvider) {
    try { provider = bounded(route?.(chatProvider)) ?? chatProvider.id; } catch { provider = chatProvider.id; }
  }
  return {
    provider,
    ...(safeModel ? { model: safeModel } : {}),
    ...(safeConversation ? { conversationId: safeConversation } : {}),
    ...(messageId ? { messageId } : {}),
    ...(turnId ? { turnId } : {})
  };
}

/** Stable logical source identity for canonical rows that may receive later source-store revisions. */
function sourceEventId(event: SessionEvent): string {
  let identity: string;
  if (event.kind === 'user_message' && event.messageId) identity = `user:${event.messageId}`;
  else if (event.kind === 'assistant_message' && event.messageId) identity = `assistant:${event.messageId}`;
  else if (event.kind === 'native_image') identity = `native:${event.messageId}:${event.providerAssetId}`;
  else if (event.kind === 'page_tool' && event.messageId) identity = `page-tool:${event.messageId}:${event.seq}`;
  else identity = `source:${event.seq}`;
  if (identity.length <= 256) return identity;
  return `${event.kind}:${createHash('sha256').update(identity).digest('hex')}`;
}

function archiveAssetId(value: string, prefix = 'asset'): string {
  if (value.length > 0 && value.length <= 256) return value;
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function safeAttachmentName(value: string): string {
  const base = path.basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  const safe = base && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? base : `attachment${path.extname(base)}`;
  if (safe.length <= 140) return safe;
  const extension = path.extname(safe).slice(0, 24);
  return `${safe.slice(0, Math.max(1, 140 - extension.length))}${extension}`;
}

function attachmentTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/:/g, '-');
}

/**
 * Rows whose canonical source record is explicitly known to be provisional.
 *
 * ArchiveStore is append-only. Publishing one of these rows early would make the later stable
 * revision look like evidence rewriting. Active-frontier provisional rows are therefore deferred.
 * A historical unfinished assistant row is the narrow exception once a later user_message proves
 * that ChatGPT advanced to another authored turn: preserve that exact interrupted snapshot as
 * partial evidence instead of withholding every later stable row. Recoverable native images never
 * use that exception because their local bytes may still arrive. Unexpected later revisions of an
 * already archived logical id are handled separately by retaining the immutable archive event.
 */
/**
 * A user row read from the ChatGPT page can precede the app's own receipt for the same message by
 * up to the delivery timeout; the receipt adds the input id and the archived image copies (2.3.6
 * c11: a GPT screenshot stayed out of the archive because the bare row was published ~100 ms
 * earlier, and published evidence is never rewritten). Hold such a row back for this long.
 */
export const PAGE_USER_RECEIPT_GRACE_MS = 90_000;

function knownMutableEvent(event: SessionEvent, now: number): boolean {
  if (event.kind === 'user_message') return event.source === 'extension' && !event.inputId && now - event.time < PAGE_USER_RECEIPT_GRACE_MS;
  if (event.kind === 'assistant_message') return event.final !== true && event.state !== 'final';
  if (event.kind !== 'native_image') return false;
  if (event.asset) return false;
  if (event.providerStatus !== 'finished_successfully') return true;
  if (event.previewStatus === 'pending' || event.previewStatus === 'available') return true;
  if (event.previewStatus !== 'unavailable') return true;
  return event.previewError !== 'oversized' && event.previewError !== 'removed';
}

function archivedAssistantIncomplete(event: ArchiveEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.final !== true;
}

function archivedSourceSeq(event: ArchiveEvent): number | undefined {
  return event.sourceRefs.find(ref => ref.kind === 'session' && ref.id === event.sessionId)?.eventSeq;
}

function actorFor(event: SessionEvent): ArchiveEvent['actor'] {
  if (event.kind === 'user_message') return 'user';
  if (event.kind === 'assistant_message' || event.kind === 'progress' || event.kind === 'native_image') return 'assistant';
  if (event.kind === 'tool_call' || event.kind === 'page_tool') return 'tool';
  if (event.kind === 'session_start' || event.kind === 'turn_start' || event.kind === 'turn_end' || event.kind === 'chat_error' || event.kind === 'note' || event.kind === 'handoff') return 'system';
  return 'unknown';
}

async function atomicWriteStream(
  archiveRoot: string,
  file: string,
  write: (append: (chunk: string) => Promise<void>) => Promise<void>
): Promise<number> {
  await ensureArchiveFile(archiveRoot, file, { createParents: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | null = null;
  let byteLength = 0;
  try {
    await ensureArchiveFile(archiveRoot, temporary, { createParents: false });
    handle = await fs.open(temporary, 'wx');
    await write(async chunk => {
      byteLength += Buffer.byteLength(chunk, 'utf8');
      await handle!.write(chunk, null, 'utf8');
    });
    await handle.sync();
    await handle.close();
    handle = null;
    await ensureArchiveFile(archiveRoot, temporary, { createParents: false });
    await ensureArchiveFile(archiveRoot, file, { createParents: false });
    await fs.rename(temporary, file);
    return byteLength;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* Best-effort close before safe cleanup. */ }
    }
    try {
      if (await ensureArchiveFile(archiveRoot, temporary, { createParents: false }) === 'present') {
        await fs.rm(temporary, { force: true });
      }
    } catch {
      // Never follow an unsafe or moved parent during cleanup.
    }
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function scriptString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

function staticSegmentCall(token: string, index: number, html: string): string {
  return `globalThis.__EVE_ARCHIVE_SEGMENT__&&globalThis.__EVE_ARCHIVE_SEGMENT__(${scriptString(token)},${index},${scriptString(html)});\n`;
}

function staticSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

async function removeStaticGeneration(archiveRoot: string, generationRoot: string): Promise<boolean> {
  try {
    if (await ensureArchiveDirectory(archiveRoot, generationRoot, false) === 'missing') return true;
    const entries = await fs.readdir(generationRoot, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || !STATIC_GENERATION_FILE_RE.test(entry.name))) return false;
    for (const entry of entries) {
      const target = path.join(generationRoot, entry.name);
      if (await ensureArchiveFile(archiveRoot, target, { createParents: false }) === 'present') await fs.rm(target, { force: true });
    }
    if ((await fs.readdir(generationRoot)).length !== 0) return false;
    await ensureArchiveDirectory(archiveRoot, generationRoot, false);
    await fs.rmdir(generationRoot);
    return true;
  } catch {
    // Cleanup is disposable projection maintenance. Refuse unsafe/moved paths rather than follow them.
    return false;
  }
}

async function publishedStaticGeneration(archiveRoot: string, indexPath: string): Promise<string | null> {
  if (await ensureArchiveFile(archiveRoot, indexPath, { createParents: false }) === 'missing') return null;
  const handle = await fs.open(indexPath, 'r');
  try {
    const buffer = Buffer.alloc(STATIC_SHELL_GENERATION_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const prefix = buffer.subarray(0, bytesRead).toString('utf8');
    const explicit = /data-archive-generation="(g-[a-f0-9]{32})"/u.exec(prefix)?.[1];
    if (explicit) return explicit;
    // Compatibility with the first lazy-shell candidate, which carried the generation only in
    // its local search-script path. Older monolithic pages have neither marker and need no shard.
    return /data\/(g-[a-f0-9]{32})\/search\.js/u.exec(prefix)?.[1] ?? null;
  } finally {
    await handle.close();
  }
}

async function cleanupStaticGenerations(
  archiveRoot: string,
  dataRoot: string,
  keep: string,
  previousPublished: string | null
): Promise<number> {
  let removed = 0;
  if (await ensureArchiveDirectory(archiveRoot, dataRoot, false) === 'missing') return removed;
  const entries = await fs.readdir(dataRoot, { withFileTypes: true });
  const generations: string[] = [];
  for (const entry of entries) {
    if (!STATIC_GENERATION_RE.test(entry.name) || !entry.isDirectory()) continue;
    const directory = path.join(dataRoot, entry.name);
    try {
      await ensureArchiveDirectory(archiveRoot, directory, false);
      generations.push(entry.name);
    } catch {
      // An unsafe generation-like entry is never followed or removed.
    }
  }
  const protectedGenerations = new Set([keep]);
  if (previousPublished && STATIC_GENERATION_RE.test(previousPublished) && previousPublished !== keep) {
    protectedGenerations.add(previousPublished);
  }
  for (const generation of generations) {
    if (protectedGenerations.has(generation)) continue;
    if (await removeStaticGeneration(archiveRoot, path.join(dataRoot, generation))) removed += 1;
  }
  return removed;
}

function jsonText(payload: ArchiveJson): string {
  const pieces: string[] = [];
  const visit = (value: ArchiveJson): void => {
    if (typeof value === 'string') pieces.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  };
  visit(payload);
  return pieces.join('\n').slice(0, 2_000_000);
}

function payloadRecord(payload: ArchiveJson): Record<string, ArchiveJson> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, ArchiveJson> : {};
}

function payloadString(payload: ArchiveJson, key: string): string | undefined {
  const value = payloadRecord(payload)[key];
  return typeof value === 'string' ? value : undefined;
}

export class ArchiveRuntime {
  readonly store: ArchiveStore;
  readonly index: ArchiveIndexProjection;

  private readonly now: () => number;
  private readonly source: ArchiveRuntimeSource;
  private readonly maxSourceEvents: number;
  private readonly maxAssetBytes: number;
  private readonly maxSessionAssetBytes: number;
  private readonly maxOverflowTextBytes: number;
  private readonly maxConcurrentReconciles: number;
  private readonly onError?: (error: Error) => void;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly reconciles = new Map<string, ReconcileState>();
  private reconcileActive = 0;
  private readonly reconcileWaiters: Array<() => void> = [];
  private initializePromise: Promise<void> | null = null;
  private derivedQueue: Promise<unknown> = Promise.resolve();
  private derivedBuilding = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private initialized = false;
  private lastReconciledSessionId: string | null = null;
  private lastReconciledAt: number | null = null;
  private lastDerivedAt: number | null = null;
  private lastError: string | null = null;
  private lastIndexStats: ArchiveIndexStats | null = null;
  /** When the evidence behind the published static site was read (a derive's start). */
  private derivedSourceAt: number | null = null;
  private derivedStartedAt = 0;
  private runningDerived: Promise<ArchiveDerivedResult> | null = null;
  private pendingSiteRefresh: Promise<ArchiveDerivedResult> | null = null;

  constructor(readonly options: ArchiveRuntimeOptions) {
    if (!path.isAbsolute(options.archiveRoot)) throw new Error('ARCHIVE_RUNTIME_ROOT_MUST_BE_ABSOLUTE');
    if (!options.writerVersion.trim()) throw new Error('ARCHIVE_RUNTIME_WRITER_VERSION_REQUIRED');
    this.source = options.source;
    this.now = options.now ?? Date.now;
    this.maxSourceEvents = options.maxSourceEvents ?? DEFAULT_MAX_SOURCE_EVENTS;
    this.maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
    this.maxSessionAssetBytes = options.maxSessionAssetBytes ?? DEFAULT_MAX_SESSION_ASSET_BYTES;
    this.maxOverflowTextBytes = options.maxOverflowTextBytes ?? DEFAULT_MAX_OVERFLOW_TEXT_BYTES;
    this.maxConcurrentReconciles = options.maxConcurrentReconciles ?? DEFAULT_MAX_CONCURRENT_RECONCILES;
    this.onError = options.onError;
    this.onDiagnostic = options.onDiagnostic;
    for (const [label, value] of [
      ['source events', this.maxSourceEvents],
      ['asset bytes', this.maxAssetBytes],
      ['session asset bytes', this.maxSessionAssetBytes],
      ['overflow text bytes', this.maxOverflowTextBytes],
      ['concurrent reconciles', this.maxConcurrentReconciles]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`ARCHIVE_RUNTIME_INVALID_LIMIT: ${label}`);
    }
    if (this.maxConcurrentReconciles > 32) throw new Error('ARCHIVE_RUNTIME_INVALID_LIMIT: concurrent reconciles');
    this.store = new ArchiveStore(options.archiveRoot, { writerVersion: options.writerVersion, now: this.now });
    this.index = createDiskArchiveIndex(options.archiveRoot);
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    if (!this.initializePromise) {
      this.initializePromise = this.store.initialize().then(() => { this.initialized = true; });
    }
    return this.initializePromise;
  }

  /** Subscribe before enumerating history so a commit racing the seed becomes a dirty follow-up. */
  async start(options: { seed?: boolean } = {}): Promise<number> {
    await this.initialize();
    if (!this.unsubscribe && this.source.subscribeCommitted) {
      this.unsubscribe = this.source.subscribeCommitted(sessionId => this.queueSessionReconcile(sessionId));
    }
    return options.seed === false ? 0 : this.seed();
  }

  async seed(): Promise<number> {
    await this.initialize();
    const ids = uniqueBounded(await this.source.listSessionIds()).filter(id => SESSION_ID_RE.test(id));
    for (const id of ids) this.queueSessionReconcile(id);
    return ids.length;
  }

  queueSessionReconcile(sessionId: string): void {
    this.assertOpen();
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`ARCHIVE_RUNTIME_INVALID_SESSION_ID: ${sessionId}`);
    let state = this.reconciles.get(sessionId);
    if (!state) {
      state = { dirty: false, running: null };
      this.reconciles.set(sessionId, state);
    }
    state.dirty = true;
    // The derived builders scan canonical archive files for a long time on a large history.
    // Windows will not atomically replace an events.jsonl while one of those scans still has
    // the target open. Queue fresh source commits during that read window, then resume them
    // after publication instead of racing a read handle with the canonical rename.
    if (this.derivedBuilding) return;
    if (!state.running) {
      const owned = state;
      // This running pass owns the request that created it. Any later queue call, even one that
      // arrives before the first source read begins, sets dirty again and therefore earns one
      // whole-session follow-up pass.
      state.dirty = false;
      state.running = this.runReconcileLoop(sessionId, state).finally(() => {
        owned.running = null;
        if (!owned.dirty && this.reconciles.get(sessionId) === owned) this.reconciles.delete(sessionId);
        else if (owned.dirty && !this.disposed) this.queueSessionReconcile(sessionId);
      });
    }
  }

  private async runReconcileLoop(sessionId: string, state: ReconcileState): Promise<void> {
    await this.initialize();
    while (!this.disposed) {
      await this.acquireReconcileSlot();
      try {
        const snapshot = await this.source.readSession(sessionId);
        if (snapshot) {
          if (snapshot.summary.id !== sessionId) throw new Error(`ARCHIVE_RUNTIME_SESSION_ID_MISMATCH: ${sessionId}`);
          const projection = await this.projectCurrentSession(snapshot);
          await this.store.publishSession(projection);
          this.lastReconciledSessionId = sessionId;
          this.lastReconciledAt = this.now();
          this.lastError = null;
        }
      } catch (error) {
        this.recordError(error);
      } finally {
        this.releaseReconcileSlot();
      }
      if (!state.dirty) return;
      state.dirty = false;
    }
  }

  private async acquireReconcileSlot(): Promise<void> {
    if (this.reconcileActive < this.maxConcurrentReconciles) {
      this.reconcileActive += 1;
      return;
    }
    await new Promise<void>((resolve) => this.reconcileWaiters.push(resolve));
    this.reconcileActive += 1;
  }

  private releaseReconcileSlot(): void {
    this.reconcileActive = Math.max(0, this.reconcileActive - 1);
    this.reconcileWaiters.shift()?.();
  }

  async drain(): Promise<void> {
    while (true) {
      const running = [...this.reconciles.values()].flatMap(state => state.running ? [state.running] : []);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /**
   * Rebuild the disposable index and static recovery site from canonical archive evidence.
   * Canonical reconciles drain first so derived views cannot publish an older projection.
   * `searchIndex: false` republishes only the static site: the search index is the slow part of a
   * full rebuild (over two minutes of three on a 447-chat archive, 2026-10-09) and the site does not use it.
   */
  rebuildDerived(options: { searchIndex?: boolean } = {}): Promise<ArchiveDerivedResult> {
    this.assertOpen();
    const run: Promise<ArchiveDerivedResult> = this.derivedQueue.catch(() => undefined).then(async () => {
      await this.initialize();
      this.derivedBuilding = true;
      this.runningDerived = run;
      const sourceAt = this.now();
      this.derivedStartedAt = sourceAt;
      try {
        // Set the gate before draining: commits arriving after this point stay dirty but cannot
        // start a new writer. Reconciles that already owned a pass finish before derived reads.
        await this.drain();
        this.recordDiagnostic('derived rebuild start ' + memorySummary());
        const headers = await this.readDerivedSessionHeaders();
        this.recordDiagnostic('derived rebuild headers ready ' + headers.length + ' session(s) ' + memorySummary());
        const index = options.searchIndex === false && this.lastIndexStats
          ? this.lastIndexStats
          : await this.index.rebuild(this.indexDocuments(headers));
        this.recordDiagnostic(options.searchIndex === false && this.lastIndexStats
          ? 'derived rebuild kept the search index (site-only refresh)'
          : 'derived rebuild indexed ' + index.documents + ' document(s) ' + memorySummary());
        const target = this.staticSiteTarget();
        await ensureArchiveDirectory(target.archiveRoot, target.siteRoot, true);
        const viewHeaders = headers.map(header => this.archiveViewHeader(header));
        viewHeaders.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
        this.recordDiagnostic('derived rebuild HTML streaming chats=' + viewHeaders.length + ' ' + memorySummary());
        const htmlBytes = await this.publishStaticArchive(target, headers, viewHeaders);
        this.recordDiagnostic('derived rebuild HTML published bytes=' + htmlBytes + ' ' + memorySummary());
        this.lastIndexStats = index;
        this.lastDerivedAt = this.now();
        this.derivedSourceAt = sourceAt;
        this.lastError = null;
        return { index, chats: viewHeaders.length, staticSite: target };
      } catch (error) {
        this.recordError(error);
        throw error;
      } finally {
        this.derivedBuilding = false;
        if (this.runningDerived === run) this.runningDerived = null;
        // A commit may have arrived while the disposable views were reading archive evidence.
        // Give every such session its normal whole-session reconcile now that no derived reader
        // owns the files. Do not await here: callers that need canonical quiescence already use
        // drain(), and a later derived rebuild will gate/drain these writers before reading.
        for (const [sessionId, state] of this.reconciles) {
          if (state.dirty && !state.running && !this.disposed) this.queueSessionReconcile(sessionId);
        }
      }
    });
    this.derivedQueue = run;
    return run;
  }

  /** Whether archive evidence changed after the published static site read it. */
  staticSiteStale(): boolean {
    return this.derivedSourceAt === null || (this.lastReconciledAt ?? 0) > this.derivedSourceAt;
  }

  /**
   * Bring the static site up to date for a reader who just opened it, without stacking rebuilds:
   * join a refresh already queued, or a running derive that started after the newest archived
   * change, and otherwise queue one site-only refresh. Null when the site is already current.
   * The opened page learns about it through `status.js`.
   */
  refreshStaticSite(): Promise<ArchiveDerivedResult> | null {
    this.assertOpen();
    if (this.pendingSiteRefresh) return this.pendingSiteRefresh;
    if (this.runningDerived && (this.lastReconciledAt ?? 0) <= this.derivedStartedAt) {
      void this.writeStaticStatus(true);
      return this.runningDerived;
    }
    if (!this.staticSiteStale()) return null;
    const run = this.rebuildDerived({ searchIndex: false });
    this.pendingSiteRefresh = run;
    void run.catch(() => undefined).finally(() => {
      if (this.pendingSiteRefresh === run) this.pendingSiteRefresh = null;
    });
    void this.writeStaticStatus(true);
    return run;
  }

  /**
   * `site/status.js`: the published generation and whether a refresh is under way. The opened page
   * polls it, says when newer chats are being added, and reloads into the newer generation.
   */
  private async writeStaticStatus(updating: boolean, generation?: string): Promise<void> {
    try {
      const target = this.staticSiteTarget();
      const published = generation ?? await publishedStaticGeneration(target.archiveRoot, target.indexPath);
      await ensureArchiveDirectory(target.archiveRoot, target.siteRoot, true);
      const status = JSON.stringify({ generation: published ?? '', updating });
      await atomicWriteStream(target.archiveRoot, path.join(target.siteRoot, 'status.js'), async append =>
        append(`globalThis.__EVE_ARCHIVE_STATUS__&&globalThis.__EVE_ARCHIVE_STATUS__(${status});\n`));
    } catch (error) {
      this.recordDiagnostic('static status not written: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  async search(query: string, options?: ArchiveIndexSearchOptions): Promise<readonly ArchiveIndexHit[]> {
    this.assertOpen();
    return this.index.search(query, options);
  }

  staticSiteTarget(): ArchiveStaticSiteTarget {
    const siteRoot = path.join(this.options.archiveRoot, 'site');
    return { archiveRoot: this.options.archiveRoot, siteRoot, indexPath: path.join(siteRoot, 'index.html') };
  }

  status(): ArchiveRuntimeStatus {
    let queuedSessions = 0;
    let reconcilingSessions = 0;
    for (const state of this.reconciles.values()) {
      if (state.dirty) queuedSessions += 1;
      if (state.running) reconcilingSessions += 1;
    }
    return {
      initialized: this.initialized,
      disposed: this.disposed,
      queuedSessions,
      reconcilingSessions,
      lastReconciledSessionId: this.lastReconciledSessionId,
      lastReconciledAt: this.lastReconciledAt,
      lastDerivedAt: this.lastDerivedAt,
      lastError: this.lastError,
      index: this.lastIndexStats,
      staticSite: this.staticSiteTarget()
    };
  }

  async retireSession(sessionId: string): Promise<void> {
    this.assertOpen();
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`ARCHIVE_RUNTIME_INVALID_SESSION_ID: ${sessionId}`);
    await this.initialize();
    while (true) {
      const running = this.reconciles.get(sessionId)?.running;
      if (!running) break;
      await running;
    }
    await this.store.deleteSession(sessionId);
    await this.rebuildDerived();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.drain();
    await this.index.dispose();
    this.disposed = true;
  }

  private async projectCurrentSession(snapshot: CurrentSessionArchiveSnapshot): Promise<ArchiveSessionProjection> {
    const { summary } = snapshot;
    if (snapshot.events.length > this.maxSourceEvents) throw new Error(`ARCHIVE_RUNTIME_SOURCE_EVENT_LIMIT: ${snapshot.events.length}`);
    const context: ProjectionContext = { totalRetainedBytes: 0, retainedAssets: new Map(), partial: false };
    const events: ArchiveEvent[] = [];
    const existing = await this.store.readSession(summary.id);
    let lastUserMessageIndex = -1;
    for (let index = snapshot.events.length - 1; index >= 0; index--) {
      if (snapshot.events[index]!.kind === 'user_message') {
        lastUserMessageIndex = index;
        break;
      }
    }
    // Set once the published order and the source order disagree. From then on position no longer
    // identifies an event, so published evidence is matched by its logical id instead.
    let publishedIds: Set<string> | null = null;
    for (let index = 0; index < snapshot.events.length; index++) {
      const source = snapshot.events[index]!;
      const eventId = sourceEventId(source);
      if (publishedIds === null) {
        const archived = existing.events[index];
        if (archived) {
          if (archived.eventId === eventId) {
            // Once published, evidence is immutable. A later source-store revision with the same
            // logical id cannot rewrite the archive; preserve the exact old event and make the
            // session visibly partial if its source cursor advanced.
            if (archivedSourceSeq(archived) !== source.seq || archivedAssistantIncomplete(archived)) context.partial = true;
            events.push(archived);
            continue;
          }
          // Source history can gain an older provider event after we have already published later
          // evidence: the chronological read order places a late-recorded row inside an earlier
          // turn. Published archive evidence is immutable: never reshuffle or overwrite it to
          // match a newly observed source order, and do not turn that condition into a permanent
          // reconcile-error loop. Keep the whole published suffix and make the session visibly
          // partial. This must not stop the scan: everything the source holds that is not yet
          // published still has to be appended, or the archive stays frozen at this point and
          // silently loses every later event.
          context.partial = true;
          events.push(...existing.events.slice(index));
          publishedIds = new Set(existing.events.map(event => event.eventId));
        }
      }
      if (publishedIds?.has(eventId)) continue;
      if (knownMutableEvent(source, this.now())) {
        context.partial = true;
        const historicalInterruptedAssistant = source.kind === 'assistant_message' && index < lastUserMessageIndex;
        if (!historicalInterruptedAssistant) break;
      }
      events.push(await this.projectEvent(summary.id, source, events.length + 1, context));
    }
    // A temporarily incomplete source read must never truncate evidence already published.
    if (events.length < existing.events.length) {
      context.partial = true;
      events.push(...existing.events.slice(events.length));
    }

    const providerConversationIds = uniqueBounded([
      ...summary.chatIds,
      ...(summary.conversationId ? [summary.conversationId] : [])
    ]);
    const continuation = this.continuation(snapshot.continuation, providerConversationIds);
    const title = summary.title.trim() || 'ChatGPT session';
    const manifest = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      sessionId: summary.id,
      title: title.slice(0, 16_000),
      createdAt: Math.max(0, summary.startedAt),
      updatedAt: Math.max(0, summary.updatedAt),
      ...(bounded(summary.projectId, 4096) ? { projectId: summary.projectId } : {}),
      ...(bounded(snapshot.projectPathLabel, 4096) ? { projectPathLabel: snapshot.projectPathLabel } : {}),
      threadIds: uniqueBounded(snapshot.threadIds),
      quiltIds: uniqueBounded(snapshot.quiltIds),
      providerConversationIds,
      ...(continuation ? { continuation } : {}),
      eventCount: events.length,
      assetCount: new Set(events.flatMap(event => event.assets.map(asset => asset.id))).size,
      captureState: context.partial ? 'partial' as const : 'complete' as const
    };
    return { manifest, events };
  }

  private continuation(explicit: ArchiveContinuation | undefined, providerConversationIds: readonly string[]): ArchiveContinuation | undefined {
    const continuation: ArchiveContinuation = {};
    const copy = (key: keyof ArchiveContinuation, value: string | undefined): void => {
      const safe = bounded(value);
      if (safe) continuation[key] = safe;
    };
    copy('predecessorSessionId', explicit?.predecessorSessionId);
    copy('successorSessionId', explicit?.successorSessionId);
    copy('providerFromConversationId', explicit?.providerFromConversationId);
    copy('providerToConversationId', explicit?.providerToConversationId);
    if (!continuation.providerFromConversationId && !continuation.providerToConversationId && providerConversationIds.length >= 2) {
      continuation.providerFromConversationId = providerConversationIds.at(-2);
      continuation.providerToConversationId = providerConversationIds.at(-1);
    }
    return Object.keys(continuation).length > 0 ? continuation : undefined;
  }

  private async projectEvent(sessionId: string, event: SessionEvent, eventSeq: number, context: ProjectionContext): Promise<ArchiveEvent> {
    const payload = await this.eventPayload(sessionId, event, context);
    const assets = await this.eventAssets(sessionId, event, context);
    if (assets.some(asset => asset.captureState !== 'retained')) context.partial = true;
    const sourceRefs: ArchiveEvent['sourceRefs'] = [{ kind: 'session', id: sessionId, eventSeq: event.seq }];
    if (event.kind === 'user_message' && bounded(event.inputId, 256)) sourceRefs.push({ kind: 'input', id: event.inputId!, eventSeq: event.seq });
    if (event.kind === 'native_image' && bounded(event.providerAssetId)) sourceRefs.push({ kind: 'provider', id: event.providerAssetId, eventSeq: event.seq });
    return {
      schemaVersion: ARCHIVE_EVENT_SCHEMA_VERSION,
      sessionId,
      eventSeq,
      eventId: sourceEventId(event),
      at: Math.max(0, event.time),
      kind: event.kind,
      actor: actorFor(event),
      ...(event.kind === 'user_message' && bounded(event.inputId, 256) ? { appInputId: event.inputId } : {}),
      ...(providerIdentity(event, this.options.providerRoute) ? { provider: providerIdentity(event, this.options.providerRoute) } : {}),
      assets,
      sourceRefs,
      payload
    };
  }

  private async resolvedText(sessionId: string, value: StoredText, context: ProjectionContext): Promise<{ text: string; truncated: boolean; chars: number }> {
    if (!value.truncated) return { text: value.text, truncated: false, chars: value.chars };
    if (!value.assetId) {
      context.partial = true;
      return { text: value.text, truncated: true, chars: value.chars };
    }
    try {
      const bytes = await this.source.readAsset(sessionId, value.assetId);
      if (!bytes || bytes.byteLength > this.maxOverflowTextBytes) {
        context.partial = true;
        return { text: value.text, truncated: true, chars: value.chars };
      }
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false, chars: value.chars };
    } catch {
      context.partial = true;
      return { text: value.text, truncated: true, chars: value.chars };
    }
  }

  private async eventPayload(sessionId: string, event: SessionEvent, context: ProjectionContext): Promise<ArchiveJson> {
    switch (event.kind) {
      case 'user_message': {
        const message = await this.resolvedText(sessionId, event.message, context);
        return {
          text: message.text,
          truncated: message.truncated,
          chars: message.chars,
          ...(event.authoredText ? { authoredText: event.authoredText } : {}),
          ...(event.inputDelivery ? { inputDelivery: event.inputDelivery } : {})
        };
      }
      case 'assistant_message': {
        const message = await this.resolvedText(sessionId, event.message, context);
        return {
          text: message.text,
          truncated: message.truncated,
          chars: message.chars,
          state: event.state ?? (event.final ? 'final' : 'streaming'),
          final: event.final
        };
      }
      case 'native_image':
        return {
          providerRole: event.providerRole,
          previewStatus: event.previewStatus,
          ...(event.providerStatus ? { providerStatus: event.providerStatus } : {}),
          ...(event.providerChannel ? { providerChannel: event.providerChannel } : {}),
          ...(event.previewError ? { previewError: event.previewError } : {}),
          ...(event.width ? { width: event.width } : {}),
          ...(event.height ? { height: event.height } : {}),
          ...(event.previewWidth ? { previewWidth: event.previewWidth } : {}),
          ...(event.previewHeight ? { previewHeight: event.previewHeight } : {})
        };
      case 'progress':
      case 'chat_error':
      case 'note': {
        const message = await this.resolvedText(sessionId, event.message, context);
        return { text: message.text, truncated: message.truncated, chars: message.chars };
      }
      case 'agent_message': {
        const message = await this.resolvedText(sessionId, event.message, context);
        return { text: message.text, from: event.from, to: event.to, delivery: event.delivery, finishReport: event.finishReport === true };
      }
      case 'tool_call': {
        const args = await this.resolvedText(sessionId, event.call.args, context);
        const result = await this.resolvedText(sessionId, event.call.result, context);
        return {
          tool: event.call.tool,
          callId: event.call.callId,
          args: args.text,
          argsTruncated: args.truncated,
          result: result.text,
          resultTruncated: result.truncated,
          outcome: event.call.outcome,
          durationMs: event.call.durationMs,
          summaryTitle: event.call.summary.title,
          ...(event.call.summary.detail ? { summaryDetail: event.call.summary.detail } : {}),
          ...(event.call.summary.metric ? { summaryMetric: event.call.summary.metric } : {})
        };
      }
      case 'session_start': return { title: event.title };
      case 'page_tool': return { label: event.label };
      case 'turn_start': return event.detail ? { detail: event.detail } : {};
      case 'turn_end': return { outcome: event.outcome, ...(event.detail ? { detail: event.detail } : {}) };
      case 'handoff': return { handoffId: event.handoffId, chars: event.chars, reason: event.reason };
    }
  }

  private async eventAssets(sessionId: string, event: SessionEvent, context: ProjectionContext): Promise<ArchiveAssetRef[]> {
    if (event.kind === 'native_image') {
      if (!event.asset) {
        context.partial = true;
        return [{
          id: archiveAssetId(`native:${event.messageId}:${event.providerAssetId}`, 'native'),
          kind: 'generated-image',
          captureState: 'provider-only',
          providerAssetId: event.providerAssetId,
          error: event.previewError ? `Local preview unavailable: ${event.previewError}` : 'Provider image bytes were not captured locally.'
        }];
      }
      return [await this.retainAsset(sessionId, event.asset, 'native', context, event.providerAssetId)];
    }
    if (event.kind === 'user_message') {
      const out: ArchiveAssetRef[] = [];
      for (const asset of event.assets ?? []) out.push(await this.retainAsset(sessionId, asset, 'message', context));
      const retained = new Map((event.archivedAttachments ?? []).map(item => [item.attachmentId, item.asset]));
      for (const attachment of event.attachments ?? []) {
        const archived = retained.get(attachment.id);
        if (archived) {
          out.push(await this.retainAsset(sessionId, archived, 'message', context, undefined, attachment.name));
          continue;
        }
        out.push({
          id: archiveAssetId(`attachment:${attachment.id}`),
          kind: attachment.mimeType.startsWith('image/') ? 'image' : 'file',
          captureState: 'missing',
          fileName: attachment.name,
          error: 'Attachment metadata was retained, but its original bytes were not archived.'
        });
        context.partial = true;
      }
      return out;
    }
    if (event.kind === 'tool_call' && event.call.assets?.length) {
      const out: ArchiveAssetRef[] = [];
      for (const asset of event.call.assets) out.push(await this.retainAsset(sessionId, asset, 'tool', context));
      return out;
    }
    return [];
  }

  private async retainAsset(
    sessionId: string,
    sourceAsset: AssetRef,
    assetContext: 'message' | 'tool' | 'native',
    context: ProjectionContext,
    providerAssetId?: string,
    fileName?: string
  ): Promise<ArchiveAssetRef> {
    const kind = archiveAssetKind(sourceAsset, assetContext);
    const cached = context.retainedAssets.get(sourceAsset.id);
    if (cached) return { ...cached, kind, ...(fileName ? { fileName } : {}), ...(providerAssetId ? { providerAssetId } : {}) };
    const missing = (error: string): ArchiveAssetRef => ({
      id: archiveAssetId(sourceAsset.id),
      kind,
      captureState: 'missing',
      ...(fileName ? { fileName } : {}),
      ...(providerAssetId ? { providerAssetId } : {}),
      error
    });
    if (sourceAsset.bytes <= 0 || sourceAsset.bytes > this.maxAssetBytes) {
      context.partial = true;
      return missing('Local asset exceeds the archive runtime per-asset byte limit.');
    }
    if (context.totalRetainedBytes + sourceAsset.bytes > this.maxSessionAssetBytes) {
      context.partial = true;
      return missing('Local assets exceed the archive runtime per-session byte limit.');
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.source.readAsset(sessionId, sourceAsset.id);
    } catch (error) {
      context.partial = true;
      return missing(`Local session asset could not be read: ${asError(error).message}`.slice(0, 4096));
    }
    if (!bytes || bytes.byteLength !== sourceAsset.bytes || bytes.byteLength > this.maxAssetBytes) {
      context.partial = true;
      return missing('Local session asset bytes are missing or do not match recorded size.');
    }
    const blob = await this.store.blobs.put(bytes, {
      mimeType: sourceAsset.mimeType,
      extension: assetExtension(sourceAsset),
      ...(sourceAsset.width ? { width: sourceAsset.width } : {}),
      ...(sourceAsset.height ? { height: sourceAsset.height } : {})
    });
    context.totalRetainedBytes += bytes.byteLength;
    const retained: Omit<ArchiveAssetRef, 'kind' | 'providerAssetId'> = {
      id: archiveAssetId(sourceAsset.id),
      captureState: 'retained',
      blob
    };
    context.retainedAssets.set(sourceAsset.id, retained);
    return { ...retained, kind, ...(fileName ? { fileName } : {}), ...(providerAssetId ? { providerAssetId } : {}) };
  }

  private async readDerivedSessionHeaders(): Promise<ArchiveDerivedSessionHeader[]> {
    const headers: ArchiveDerivedSessionHeader[] = [];
    for (const sessionId of await this.store.listSessionIds()) {
      const session = await this.store.readSession(sessionId, 0);
      if (!session.manifest || session.state === 'missing') continue;
      headers.push({ sessionId, state: session.state, manifest: session.manifest });
    }
    return headers;
  }

  private async *indexDocuments(headers: readonly ArchiveDerivedSessionHeader[]): AsyncGenerator<ArchiveIndexDocument> {
    for (const header of headers) {
      const manifest = header.manifest;
      yield {
        id: `session:${header.sessionId}`,
        kind: 'session',
        authority: { kind: 'session', sessionId: header.sessionId },
        title: manifest.title,
        text: manifest.projectPathLabel,
        projectId: manifest.projectId,
        threadIds: manifest.threadIds,
        quiltIds: manifest.quiltIds,
        timestamp: manifest.updatedAt
      };
      const session = await this.store.readSession(header.sessionId, this.maxSourceEvents);
      const seenAssets = new Set<string>();
      for (const event of session.events) {
        yield {
          id: `event:${header.sessionId}:${event.eventSeq}`,
          kind: 'event',
          authority: { kind: 'evidence', sessionId: header.sessionId, eventSeq: event.eventSeq },
          title: event.kind,
          text: jsonText(event.payload),
          provider: [event.provider?.provider, event.provider?.model].filter(Boolean).join(' ') || undefined,
          projectId: manifest.projectId,
          threadIds: manifest.threadIds,
          quiltIds: manifest.quiltIds,
          timestamp: event.at
        };
        for (const asset of event.assets) {
          if (seenAssets.has(asset.id)) continue;
          seenAssets.add(asset.id);
          yield {
            id: `asset:${header.sessionId}:${asset.id}`,
            kind: 'asset',
            authority: { kind: 'evidence', sessionId: header.sessionId, eventSeq: event.eventSeq, assetId: asset.id },
            title: asset.kind,
            filename: asset.fileName,
            text: [asset.captureState, asset.error, asset.providerAssetId].filter(Boolean).join(' '),
            projectId: manifest.projectId,
            threadIds: manifest.threadIds,
            quiltIds: manifest.quiltIds,
            timestamp: event.at
          };
        }
      }
    }
  }

  private archiveViewHeader(header: ArchiveDerivedSessionHeader): ArchiveViewChatHeader {
    return {
        id: header.sessionId,
        title: header.manifest.title,
        ...(header.manifest.projectPathLabel ? { subtitle: header.manifest.projectPathLabel } : {}),
        ...(header.manifest.providerConversationIds.at(-1)
          ? { providerConversationId: header.manifest.providerConversationIds.at(-1)! }
          : {}),
        updatedAt: header.manifest.updatedAt,
        captureState: header.state === 'complete' && header.manifest.captureState === 'complete'
          ? 'complete'
          : header.manifest.captureState === 'metadata-only' ? 'metadata-only' : 'partial',
        metadata: header.manifest.projectId ? [{ label: 'Project', value: header.manifest.projectId }] : undefined
    };
  }

  private async publishStaticArchive(
    target: ArchiveStaticSiteTarget,
    headers: readonly ArchiveDerivedSessionHeader[],
    viewHeaders: readonly ArchiveViewChatHeader[]
  ): Promise<number> {
    const sourceById = new Map(headers.map(header => [header.sessionId, header]));
    const tokenByChatId = archiveChatTokenMap(viewHeaders);
    const previousPublishedGeneration = await publishedStaticGeneration(target.archiveRoot, target.indexPath);
    const generation = `g-${randomUUID().replaceAll('-', '')}`;
    const dataRoot = path.join(target.siteRoot, 'data');
    const generationRoot = path.join(dataRoot, generation);
    await ensureArchiveDirectory(target.archiveRoot, dataRoot, true);
    await ensureArchiveDirectory(target.archiveRoot, generationRoot, true);
    const searchPath = path.join(generationRoot, 'search.js');
    const relativeSearchPath = `data/${generation}/search.js`;
    const lazyChats: Array<ArchiveViewChatHeader & { chunkPath: string; segmentCount: number }> = [];
    let published = false;
    try {
      await atomicWriteStream(target.archiveRoot, searchPath, async searchAppend => {
        await searchAppend('globalThis.__EVE_ARCHIVE_SEARCH__=Object.freeze({\n');
        for (const [index, viewHeader] of viewHeaders.entries()) {
          const source = sourceById.get(viewHeader.id);
          if (!source) throw new Error(`ARCHIVE_RUNTIME_DERIVED_HEADER_MISSING: ${viewHeader.id}`);
          const token = tokenByChatId.get(viewHeader.id);
          if (!token) throw new Error(`ARCHIVE_RUNTIME_DERIVED_TOKEN_MISSING: ${viewHeader.id}`);
          await searchAppend(`${scriptString(token)}:Object.freeze([\n`);
          let segmentIndex = 0;
          let segmentBytes = 0;
          let segmentParts: string[] = [];
          const flushSegment = async (empty = false): Promise<void> => {
            if (segmentParts.length === 0 && !empty) return;
            const html = segmentParts.length > 0
              ? segmentParts.join('')
              : '<div class="empty-transcript">No transcript evidence was retained for this chat.</div>';
            const segmentPath = path.join(generationRoot, `chat-${index}-segment-${segmentIndex}.js`);
            const currentSegment = segmentIndex;
            await atomicWriteStream(target.archiveRoot, segmentPath, async append => {
              await append(staticSegmentCall(token, currentSegment, html));
            });
            segmentIndex += 1;
            segmentBytes = 0;
            segmentParts = [];
          };

          await this.store.scanSessionEvents(source.sessionId, {
            collectLimit: 0,
            onEvent: async event => {
              const item = await this.viewItem(event);
              if (!item) return;
              // Search the lightweight prose the static transcript actually presents, but keep
              // tool arguments/results out of this eagerly loaded corpus. Heavy transcript HTML
              // is split into bounded local segments and only one segment is mounted at a time.
              if ((item.kind === 'message' || item.kind === 'notice') && item.text) {
                await searchAppend(`${scriptString(staticSearchText(item.text))},\n`);
              }
              for (const html of renderArchiveTranscriptItemParts(item, tokenByChatId, STATIC_SEGMENT_TEXT_CHARS)) {
                const bytes = Buffer.byteLength(html, 'utf8');
                if (segmentParts.length > 0 && segmentBytes + bytes > STATIC_SEGMENT_TARGET_BYTES) await flushSegment();
                segmentParts.push(html);
                segmentBytes += bytes;
                if (segmentBytes >= STATIC_SEGMENT_TARGET_BYTES) await flushSegment();
              }
            }
          });
          if (segmentParts.length > 0) await flushSegment();
          if (segmentIndex === 0) await flushSegment(true);
          lazyChats.push({
            ...viewHeader,
            chunkPath: `data/${generation}/chat-${index}-segment-0.js`,
            segmentCount: segmentIndex
          });
          await searchAppend(']),\n');
        }
        await searchAppend('});\n');
      });
      const html = renderLazyArchiveHtml({
        archiveTitle: 'ParadigmEve Archive',
        generatedAtLabel: new Date(this.now()).toISOString(),
        searchPath: relativeSearchPath,
        chats: lazyChats
      });
      const htmlBytes = await atomicWriteStream(target.archiveRoot, target.indexPath, async append => append(html));
      published = true;
      await this.writeStaticStatus(this.pendingSiteRefresh !== null && this.pendingSiteRefresh !== this.runningDerived, generation);
      const removed = await cleanupStaticGenerations(target.archiveRoot, dataRoot, generation, previousPublishedGeneration);
      if (removed > 0) this.recordDiagnostic(`derived rebuild cleaned ${removed} stale static generation(s)`);
      return htmlBytes;
    } finally {
      if (!published) await removeStaticGeneration(target.archiveRoot, generationRoot);
    }
  }

  private async viewItem(event: ArchiveEvent): Promise<ArchiveViewTranscriptItem | null> {
    const assets: ArchiveViewAsset[] = [];
    for (const asset of event.assets) assets.push(await this.viewAsset(asset, event.at));
    // A user message carries what the user wrote beside what was sent; the sent text may be wrapped
    // in Eve's provider catch-up context, which the archive reader should not see as the message.
    const recorded = (event.kind === 'user_message' ? payloadString(event.payload, 'authoredText') : null) ?? payloadString(event.payload, 'text');
    // A reply recorded only as ChatGPT's reference to its words is shown as missing words, not as the pointer.
    const text = event.kind === 'assistant_message' && isUnresolvedContentReference(recorded)
      ? '[ChatGPT sent only a reference to this reply; its words were not recorded.]'
      : recorded;
    if (event.kind === 'user_message' || event.kind === 'assistant_message' || event.kind === 'agent_message' || event.kind === 'progress' || event.kind === 'chat_error' || event.kind === 'note') {
      return {
        kind: 'message',
        id: event.eventId,
        role: event.kind === 'user_message' ? 'user' : event.kind === 'chat_error' || event.kind === 'note' ? 'system' : 'assistant',
        text: text ?? '',
        ...(event.provider?.model ? { modelLabel: event.provider.model } : {}),
        ...(assets.length ? { assets } : {})
      };
    }
    if (event.kind === 'native_image') {
      return { kind: 'message', id: event.eventId, role: 'assistant', text: 'Generated image', ...(assets.length ? { assets } : {}) };
    }
    if (event.kind === 'tool_call') {
      return {
        kind: 'tool-group',
        id: event.eventId,
        label: payloadString(event.payload, 'summaryTitle') ?? payloadString(event.payload, 'tool') ?? 'Tool call',
        calls: [{
          name: payloadString(event.payload, 'tool') ?? 'tool',
          status: payloadString(event.payload, 'outcome'),
          argumentsText: payloadString(event.payload, 'args'),
          resultText: payloadString(event.payload, 'result'),
          ...(assets.length ? { assets } : {})
        }]
      };
    }
    if (event.kind === 'page_tool') {
      const label = payloadString(event.payload, 'label') ?? 'Provider activity';
      return { kind: 'tool-group', id: event.eventId, label, calls: [{ name: label }] };
    }
    if (event.kind === 'handoff') {
      return { kind: 'notice', id: event.eventId, tone: 'info', title: 'Compact & Resume handoff', text: payloadString(event.payload, 'reason') };
    }
    if (event.kind === 'turn_end') {
      return { kind: 'notice', id: event.eventId, tone: 'info', title: `Turn ${payloadString(event.payload, 'outcome') ?? 'ended'}` };
    }
    return null;
  }

  private async viewAsset(asset: ArchiveAssetRef, at: number): Promise<ArchiveViewAsset> {
    const kind: ArchiveViewAsset['kind'] = asset.kind === 'image' || asset.kind === 'tool-image' || asset.kind === 'generated-image' ? 'image' : 'file';
    const label = asset.fileName ?? (kind === 'image' ? 'Image' : 'File');
    if (asset.captureState === 'provider-only') {
      return { kind, label, captureState: 'provider-only', detail: asset.error };
    }
    if (asset.captureState === 'missing' || !asset.blob) {
      return { kind, label, captureState: 'missing', detail: asset.error };
    }
    const inspection = await this.store.blobs.inspect(asset.blob);
    if (inspection.state !== 'present') {
      return { kind, label, captureState: 'capture-error', detail: 'Retained archive blob is missing or corrupt.' };
    }
    const relative = asset.fileName
      ? await this.materializeSiteAttachment(asset.blob.sha256, safeAttachmentName(asset.fileName), at, inspection.path, asset.blob.byteLength)
      : await this.materializeSiteAsset(asset.blob.sha256, asset.blob.extension ?? this.extensionForMime(asset.blob.mimeType), inspection.path, asset.blob.byteLength);
    return {
      kind,
      label,
      captureState: 'retained',
      localPath: relative,
      mimeType: asset.blob.mimeType,
      byteLength: asset.blob.byteLength,
      ...(asset.blob.width ? { width: asset.blob.width } : {}),
      ...(asset.blob.height ? { height: asset.blob.height } : {})
    };
  }

  private extensionForMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
      case 'image/png': return 'png';
      case 'image/jpeg': return 'jpg';
      case 'image/webp': return 'webp';
      case 'image/gif': return 'gif';
      case 'application/pdf': return 'pdf';
      case 'text/plain': return 'txt';
      default: return 'bin';
    }
  }

  private async materializeSiteAttachment(sha256: string, fileName: string, at: number, source: string, byteLength: number): Promise<string> {
    const site = this.staticSiteTarget();
    const attachmentsRoot = path.join(site.siteRoot, 'attachments');
    await ensureArchiveDirectory(site.archiveRoot, attachmentsRoot, true);
    const stem = `${attachmentTimestamp(at)}__${fileName}`;
    const ext = path.extname(stem);
    const base = ext ? stem.slice(0, -ext.length) : stem;
    let targetName = stem;
    let target = path.join(attachmentsRoot, targetName);
    const matches = async (candidate: string): Promise<boolean> => {
      if (await ensureArchiveFile(site.archiveRoot, candidate, { createParents: false }) !== 'present') return false;
      const stat = await fs.stat(candidate);
      return stat.isFile() && stat.size === byteLength && await sha256File(candidate) === sha256;
    };
    if (await matches(target)) return `attachments/${targetName}`;
    if (await ensureArchiveFile(site.archiveRoot, target, { createParents: false }) === 'present') {
      targetName = `${base}__${sha256.slice(0, 8)}${ext}`;
      target = path.join(attachmentsRoot, targetName);
      if (await matches(target)) return `attachments/${targetName}`;
    }
    if (await ensureArchiveFile(site.archiveRoot, source, { createParents: false }) !== 'present') {
      throw new Error(`ARCHIVE_RUNTIME_SITE_ATTACHMENT_SOURCE_MISSING: ${sha256}`);
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await ensureArchiveFile(site.archiveRoot, temporary, { createParents: false });
      await fs.copyFile(source, temporary);
      const stat = await fs.stat(temporary);
      if (!stat.isFile() || stat.size !== byteLength || await sha256File(temporary) !== sha256) {
        throw new Error(`ARCHIVE_RUNTIME_SITE_ATTACHMENT_COPY_MISMATCH: ${sha256}`);
      }
      await fs.rename(temporary, target);
      return `attachments/${targetName}`;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async materializeSiteAsset(sha256: string, extension: string, source: string, byteLength: number): Promise<string> {
    const safeExtension = /^[a-z0-9]{1,16}$/i.test(extension) ? extension.toLowerCase() : 'bin';
    const relative = `assets/${sha256}.${safeExtension}`;
    const site = this.staticSiteTarget();
    const assetsRoot = path.join(site.siteRoot, 'assets');
    await ensureArchiveDirectory(site.archiveRoot, assetsRoot, true);
    const target = path.join(assetsRoot, `${sha256}.${safeExtension}`);
    if (await ensureArchiveFile(site.archiveRoot, target, { createParents: false }) === 'present') {
      const stat = await fs.stat(target);
      if (stat.isFile() && stat.size === byteLength) {
        const actual = await sha256File(target);
        if (actual === sha256) return relative;
      }
    }
    if (await ensureArchiveFile(site.archiveRoot, source, { createParents: false }) !== 'present') {
      throw new Error(`ARCHIVE_RUNTIME_SITE_ASSET_SOURCE_MISSING: ${sha256}`);
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await ensureArchiveFile(site.archiveRoot, temporary, { createParents: false });
      await fs.copyFile(source, temporary);
      await ensureArchiveFile(site.archiveRoot, temporary, { createParents: false });
      const stat = await fs.stat(temporary);
      const actual = await sha256File(temporary);
      if (!stat.isFile() || stat.size !== byteLength || actual !== sha256) throw new Error(`ARCHIVE_RUNTIME_SITE_ASSET_COPY_MISMATCH: ${sha256}`);
      await ensureArchiveFile(site.archiveRoot, target, { createParents: false });
      await fs.rename(temporary, target);
    } finally {
      try {
        if (await ensureArchiveFile(site.archiveRoot, temporary, { createParents: false }) === 'present') {
          await fs.rm(temporary, { force: true });
        }
      } catch {
        // Never follow an unsafe or moved parent during cleanup.
      }
    }
    return relative;
  }

  private recordError(value: unknown): void {
    const error = asError(value);
    this.lastError = error.message;
    try { this.onError?.(error); } catch { /* Archive diagnostics cannot break recording or reconcile cleanup. */ }
  }

  private recordDiagnostic(message: string): void {
    try { this.onDiagnostic?.(message); } catch { /* Diagnostics cannot break archive work. */ }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('ARCHIVE_RUNTIME_DISPOSED');
  }
}
