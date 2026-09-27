/** Canonical archive manifests/events with per-file atomic replacement and explicit partial reads. */

import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ARCHIVE_EVENT_SCHEMA_VERSION,
  ARCHIVE_HASH_ALGORITHM,
  ARCHIVE_INDEX_SCHEMA_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_SITE_VERSION,
  type ArchiveAssetRef,
  type ArchiveBlobRef,
  type ArchiveEvent,
  type ArchiveFeatureFlags,
  type ArchiveJson,
  type ArchiveManifest,
  type ArchiveProjectionIssue,
  type ArchiveSessionManifest,
  type ArchiveSessionProjection,
  type ArchiveSessionReadResult
} from '../../shared/archive.js';
import { ArchiveBlobStore, validArchiveSha256 } from './archive-blobs.js';
import {
  ensureArchiveDirectory,
  ensureArchiveFile,
  ensureArchiveRoot,
  isArchivePathSecurityError
} from './archive-path-security.js';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_COLLECT_LIMIT = 50_000;

export const DEFAULT_ARCHIVE_FEATURES: ArchiveFeatureFlags = {
  appUploads: false,
  nativeProviderAssets: false,
  generatedImages: false,
  toolAssets: false
};

export interface ArchiveStoreOptions {
  writerVersion: string;
  now?: () => number;
  features?: Partial<ArchiveFeatureFlags>;
}

export interface ArchiveEventScanResult {
  events: ArchiveEvent[];
  issues: ArchiveProjectionIssue[];
  totalLines: number;
  validEvents: number;
  uniqueAssetCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeSessionId(value: string): string {
  if (!SESSION_ID_RE.test(value) || value === '.' || value === '..') throw new Error(`ARCHIVE_INVALID_SESSION_ID: ${value}`);
  return value;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length <= 512);
}

function jsonValue(value: unknown): value is ArchiveJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(jsonValue);
}

function parseBlobRef(value: unknown): ArchiveBlobRef | null {
  if (!isRecord(value) || typeof value.sha256 !== 'string' || !validArchiveSha256(value.sha256) ||
      typeof value.mimeType !== 'string' || !value.mimeType || value.mimeType.length > 255 ||
      !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) return null;
  if (value.extension !== undefined && (typeof value.extension !== 'string' || !/^[a-z0-9]{1,16}$/.test(value.extension))) return null;
  for (const key of ['width', 'height'] as const) {
    const dimension = value[key];
    if (dimension !== undefined && (!Number.isInteger(dimension) || (dimension as number) <= 0 || (dimension as number) > 1_000_000)) return null;
  }
  return value as unknown as ArchiveBlobRef;
}

function parseAsset(value: unknown): ArchiveAssetRef | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 256 ||
      !['image', 'file', 'tool-image', 'generated-image', 'unknown'].includes(String(value.kind)) ||
      !['retained', 'missing', 'provider-only'].includes(String(value.captureState))) return null;
  if (value.blob !== undefined && !parseBlobRef(value.blob)) return null;
  for (const field of ['fileName', 'providerAssetId', 'error'] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || (value[field] as string).length > 4096)) return null;
  }
  if (value.captureState === 'retained' && value.blob === undefined) return null;
  return value as unknown as ArchiveAssetRef;
}

export function parseArchiveEvent(value: unknown): ArchiveEvent | null {
  if (!isRecord(value) || value.schemaVersion !== ARCHIVE_EVENT_SCHEMA_VERSION ||
      typeof value.sessionId !== 'string' || !SESSION_ID_RE.test(value.sessionId) ||
      !Number.isSafeInteger(value.eventSeq) || (value.eventSeq as number) < 1 ||
      typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 256 ||
      !finiteTimestamp(value.at) || typeof value.kind !== 'string' || !value.kind || value.kind.length > 128 ||
      !['user', 'assistant', 'tool', 'system', 'unknown'].includes(String(value.actor)) ||
      !Array.isArray(value.assets) || !value.assets.every(asset => parseAsset(asset) !== null) ||
      !Array.isArray(value.sourceRefs) || !value.sourceRefs.every(source => isRecord(source) &&
        ['session', 'input', 'pin', 'plan', 'request', 'provider', 'other'].includes(String(source.kind)) &&
        typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 512 &&
        (source.eventSeq === undefined || (Number.isSafeInteger(source.eventSeq) && (source.eventSeq as number) >= 1))) ||
      !jsonValue(value.payload)) return null;
  if (value.appInputId !== undefined && (typeof value.appInputId !== 'string' || value.appInputId.length > 256)) return null;
  if (value.provider !== undefined) {
    if (!isRecord(value.provider)) return null;
    for (const field of ['provider', 'model', 'conversationId', 'messageId', 'turnId']) {
      const entry = value.provider[field];
      if (entry !== undefined && (typeof entry !== 'string' || entry.length > 512)) return null;
    }
  }
  return value as unknown as ArchiveEvent;
}

export function parseArchiveSessionManifest(value: unknown): ArchiveSessionManifest | null {
  if (!isRecord(value) || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION ||
      typeof value.sessionId !== 'string' || !SESSION_ID_RE.test(value.sessionId) ||
      typeof value.title !== 'string' || !value.title || value.title.length > 16_000 ||
      !finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt) ||
      !stringArray(value.threadIds) || !stringArray(value.quiltIds) || !stringArray(value.providerConversationIds) ||
      !Number.isSafeInteger(value.eventCount) || (value.eventCount as number) < 0 ||
      !Number.isSafeInteger(value.assetCount) || (value.assetCount as number) < 0 ||
      !['complete', 'partial', 'metadata-only'].includes(String(value.captureState))) return null;
  for (const field of ['projectId', 'projectPathLabel'] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || (value[field] as string).length > 4096)) return null;
  }
  if (value.continuation !== undefined) {
    if (!isRecord(value.continuation)) return null;
    for (const field of ['predecessorSessionId', 'successorSessionId', 'providerFromConversationId', 'providerToConversationId']) {
      const entry = value.continuation[field];
      if (entry !== undefined && (typeof entry !== 'string' || entry.length > 512)) return null;
    }
  }
  return value as unknown as ArchiveSessionManifest;
}

export function parseArchiveManifest(value: unknown): ArchiveManifest | null {
  if (!isRecord(value) || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION ||
      !finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt) ||
      !(value.migratedAt === null || finiteTimestamp(value.migratedAt)) ||
      typeof value.writerVersion !== 'string' || !value.writerVersion || value.writerVersion.length > 128 ||
      value.hashAlgorithm !== ARCHIVE_HASH_ALGORITHM || value.siteVersion !== ARCHIVE_SITE_VERSION ||
      value.indexSchemaVersion !== ARCHIVE_INDEX_SCHEMA_VERSION || !isRecord(value.features)) return null;
  for (const feature of ['appUploads', 'nativeProviderAssets', 'generatedImages', 'toolAssets']) {
    if (typeof value.features[feature] !== 'boolean') return null;
  }
  if (value.integrity !== undefined) {
    if (!isRecord(value.integrity) || !finiteTimestamp(value.integrity.scannedAt) ||
        !['clean', 'partial', 'corrupt'].includes(String(value.integrity.status)) ||
        !Number.isSafeInteger(value.integrity.issueCount) || (value.integrity.issueCount as number) < 0) return null;
  }
  return value as unknown as ArchiveManifest;
}

async function atomicWrite(archiveRoot: string, file: string, data: string): Promise<void> {
  await ensureArchiveFile(archiveRoot, file, { createParents: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await ensureArchiveFile(archiveRoot, temporary, { createParents: false });
    await fs.writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
    await ensureArchiveFile(archiveRoot, temporary, { createParents: false });
    await ensureArchiveFile(archiveRoot, file, { createParents: false });
    await fs.rename(temporary, file);
  } finally {
    try {
      if (await ensureArchiveFile(archiveRoot, temporary, { createParents: false }) === 'present') await fs.rm(temporary, { force: true });
    } catch {
      // An unsafe or moved parent is never followed for cleanup.
    }
  }
}

async function readJson(archiveRoot: string, file: string): Promise<unknown | null> {
  try {
    if (await ensureArchiveFile(archiveRoot, file, { createParents: false }) === 'missing') return null;
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sessionDirectory(root: string, sessionId: string): string {
  return path.join(root, 'sessions', safeSessionId(sessionId));
}

function eventJson(event: ArchiveEvent): string {
  return JSON.stringify(event);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function uniqueAssetCount(events: readonly ArchiveEvent[]): number {
  const ids = new Set<string>();
  for (const event of events) for (const asset of event.assets) ids.add(asset.id);
  return ids.size;
}

function normalizedCaptureState(requested: ArchiveSessionManifest['captureState'], events: readonly ArchiveEvent[]): ArchiveSessionManifest['captureState'] {
  if (requested === 'metadata-only') return requested;
  return events.some(event => event.assets.some(asset => asset.captureState !== 'retained')) ? 'partial' : requested;
}

function normalizeManifest(manifest: ArchiveSessionManifest, events: readonly ArchiveEvent[]): ArchiveSessionManifest {
  return {
    ...manifest,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    eventCount: events.length,
    assetCount: uniqueAssetCount(events),
    captureState: normalizedCaptureState(manifest.captureState, events),
    updatedAt: Math.max(manifest.updatedAt, ...events.map(event => event.at))
  };
}

function validateProjection(projection: ArchiveSessionProjection): ArchiveSessionProjection {
  const manifest = parseArchiveSessionManifest(projection.manifest);
  if (!manifest) throw new Error('ARCHIVE_INVALID_SESSION_MANIFEST');
  const sessionId = safeSessionId(manifest.sessionId);
  const events = projection.events.map((event, index) => {
    const parsed = parseArchiveEvent(event);
    if (!parsed) throw new Error(`ARCHIVE_INVALID_EVENT: ${index + 1}`);
    if (parsed.sessionId !== sessionId || parsed.eventSeq !== index + 1) throw new Error(`ARCHIVE_EVENT_SEQUENCE_MISMATCH: ${index + 1}`);
    return parsed;
  });
  if (new Set(events.map(event => event.eventId)).size !== events.length) throw new Error('ARCHIVE_DUPLICATE_EVENT_ID');
  return { manifest: normalizeManifest(manifest, events), events };
}

export class ArchiveStore {
  readonly blobs: ArchiveBlobStore;
  private readonly now: () => number;
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private manifestQueue: Promise<void> = Promise.resolve();

  constructor(readonly archiveRoot: string, private readonly options: ArchiveStoreOptions) {
    if (!options.writerVersion.trim()) throw new Error('ARCHIVE_WRITER_VERSION_REQUIRED');
    this.now = options.now ?? Date.now;
    this.blobs = new ArchiveBlobStore(archiveRoot);
  }

  private enqueueSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    safeSessionId(sessionId);
    const prior = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(operation);
    const tracked = run.then(() => undefined, () => undefined).finally(() => {
      if (this.sessionQueues.get(sessionId) === tracked) this.sessionQueues.delete(sessionId);
    });
    this.sessionQueues.set(sessionId, tracked);
    return run;
  }

  private enqueueManifest<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.manifestQueue.catch(() => undefined).then(operation);
    this.manifestQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async initialize(): Promise<ArchiveManifest> {
    return this.enqueueManifest(async () => {
      const existing = await this.readArchiveManifest();
      if (existing.state === 'complete') return existing.manifest!;
      if (existing.state === 'partial') throw new Error('ARCHIVE_MANIFEST_UNREADABLE_OR_UNSUPPORTED');
      await ensureArchiveRoot(this.archiveRoot, true);
      const now = this.now();
      const manifest: ArchiveManifest = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        migratedAt: null,
        writerVersion: this.options.writerVersion.trim(),
        hashAlgorithm: ARCHIVE_HASH_ALGORITHM,
        siteVersion: ARCHIVE_SITE_VERSION,
        indexSchemaVersion: ARCHIVE_INDEX_SCHEMA_VERSION,
        features: { ...DEFAULT_ARCHIVE_FEATURES, ...this.options.features }
      };
      await atomicWrite(this.archiveRoot, path.join(this.archiveRoot, 'archive-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return manifest;
    });
  }

  async readArchiveManifest(): Promise<{ state: 'complete' | 'partial' | 'missing'; manifest: ArchiveManifest | null }> {
    const file = path.join(this.archiveRoot, 'archive-manifest.json');
    try {
      const raw = await readJson(this.archiveRoot, file);
      if (raw === null) return { state: 'missing', manifest: null };
      const manifest = parseArchiveManifest(raw);
      return manifest ? { state: 'complete', manifest } : { state: 'partial', manifest: null };
    } catch (error) {
      if (isArchivePathSecurityError(error)) throw error;
      return { state: 'partial', manifest: null };
    }
  }

  async publishArchiveManifest(manifest: ArchiveManifest): Promise<ArchiveManifest> {
    const parsed = parseArchiveManifest(manifest);
    if (!parsed) throw new Error('ARCHIVE_INVALID_MANIFEST');
    return this.enqueueManifest(async () => {
      await atomicWrite(this.archiveRoot, path.join(this.archiveRoot, 'archive-manifest.json'), JSON.stringify(parsed, null, 2) + '\n');
      return parsed;
    });
  }

  private async verifyRetainedAssets(events: readonly ArchiveEvent[]): Promise<void> {
    const checked = new Set<string>();
    for (const event of events) for (const asset of event.assets) {
      if (asset.captureState !== 'retained') continue;
      if (!asset.blob) throw new Error(`ARCHIVE_RETAINED_ASSET_WITHOUT_BLOB: ${asset.id}`);
      if (checked.has(asset.blob.sha256)) continue;
      checked.add(asset.blob.sha256);
      const inspection = await this.blobs.inspect(asset.blob);
      if (inspection.state !== 'present') throw new Error(`ARCHIVE_RETAINED_BLOB_NOT_AVAILABLE: ${asset.blob.sha256}`);
    }
  }

  private async assertAppendOnlyProjection(sessionId: string, events: readonly ArchiveEvent[]): Promise<void> {
    let existingCount = 0;
    const scan = await this.scanSessionEvents(sessionId, {
      collectLimit: 0,
      onEvent: existing => {
        const projected = events[existingCount];
        if (!projected || stableJson(existing) !== stableJson(projected)) {
          throw new Error(`ARCHIVE_EVIDENCE_REWRITE_REFUSED: existing event ${existing.eventSeq} is not an exact prefix of the projection`);
        }
        existingCount += 1;
      }
    });
    const substantive = scan.issues.filter(issue => issue.code !== 'events-missing');
    if (substantive.length > 0) {
      throw new Error(`ARCHIVE_EXISTING_EVIDENCE_PARTIAL: ${substantive[0]!.code}`);
    }
    if (existingCount > events.length) throw new Error('ARCHIVE_EVIDENCE_REWRITE_REFUSED: projection would truncate existing events');
  }

  async publishSession(projection: ArchiveSessionProjection): Promise<ArchiveSessionManifest> {
    const normalized = validateProjection(projection);
    return this.enqueueSession(normalized.manifest.sessionId, async () => {
      await this.assertAppendOnlyProjection(normalized.manifest.sessionId, normalized.events);
      await this.verifyRetainedAssets(normalized.events);
      const directory = sessionDirectory(this.archiveRoot, normalized.manifest.sessionId);
      // Canonical evidence lands first. A crash before manifest publication leaves a visible,
      // rebuildable lagging projection rather than a manifest claiming evidence that never landed.
      await atomicWrite(this.archiveRoot, path.join(directory, 'events.jsonl'), normalized.events.map(eventJson).join('\n') + (normalized.events.length ? '\n' : ''));
      await atomicWrite(this.archiveRoot, path.join(directory, 'manifest.json'), JSON.stringify(normalized.manifest, null, 2) + '\n');
      return normalized.manifest;
    });
  }

  async appendEvent(sessionId: string, event: ArchiveEvent): Promise<ArchiveSessionManifest> {
    return this.enqueueSession(sessionId, async () => {
      const current = await this.readSession(sessionId);
      if (current.state !== 'complete' || !current.manifest) throw new Error('ARCHIVE_SESSION_NOT_APPENDABLE: projection is missing or partial');
      const parsed = parseArchiveEvent(event);
      if (!parsed || parsed.sessionId !== sessionId || parsed.eventSeq !== current.events.length + 1) throw new Error('ARCHIVE_EVENT_SEQUENCE_MISMATCH');
      if (current.events.some(existing => existing.eventId === parsed.eventId)) throw new Error('ARCHIVE_DUPLICATE_EVENT_ID');
      const events = [...current.events, parsed];
      await this.verifyRetainedAssets([parsed]);
      const manifest = normalizeManifest({ ...current.manifest, updatedAt: Math.max(current.manifest.updatedAt, parsed.at) }, events);
      const directory = sessionDirectory(this.archiveRoot, sessionId);
      await atomicWrite(this.archiveRoot, path.join(directory, 'events.jsonl'), events.map(eventJson).join('\n') + '\n');
      await atomicWrite(this.archiveRoot, path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return manifest;
    });
  }

  /** Remove one explicitly retired canonical archive session without following unsafe paths. */
  async deleteSession(sessionId: string): Promise<boolean> {
    return this.enqueueSession(sessionId, async () => {
      const directory = sessionDirectory(this.archiveRoot, sessionId);
      if (await ensureArchiveDirectory(this.archiveRoot, directory, false) === 'missing') return false;
      await fs.rm(directory, { recursive: true, force: true });
      return true;
    });
  }

  async scanSessionEvents(
    sessionId: string,
    options: { collectLimit?: number; onEvent?: (event: ArchiveEvent) => void | Promise<void> } = {}
  ): Promise<ArchiveEventScanResult> {
    const file = path.join(sessionDirectory(this.archiveRoot, sessionId), 'events.jsonl');
    const issues: ArchiveProjectionIssue[] = [];
    const events: ArchiveEvent[] = [];
    const seenIds = new Set<string>();
    const assetIds = new Set<string>();
    const collectLimit = Math.max(0, Math.floor(options.collectLimit ?? DEFAULT_COLLECT_LIMIT));
    let totalLines = 0;
    let validEvents = 0;
    let expectedSeq = 1;
    let stream: ReturnType<typeof createReadStream>;
    try {
      if (await ensureArchiveFile(this.archiveRoot, file, { createParents: false }) === 'missing') {
        return { events, issues: [{ code: 'events-missing', message: 'Canonical events.jsonl is missing.' }], totalLines, validEvents, uniqueAssetCount: 0 };
      }
      stream = createReadStream(file, { encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events, issues: [{ code: 'events-missing', message: 'Canonical events.jsonl is missing.' }], totalLines, validEvents, uniqueAssetCount: 0 };
      }
      throw error;
    }
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        totalLines += 1;
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
          issues.push({ code: 'event-invalid', line: totalLines, message: `Event line exceeds ${MAX_EVENT_LINE_BYTES} bytes.` });
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          issues.push({ code: 'invalid-jsonl', line: totalLines, message: 'Event line is not valid JSON.' });
          continue;
        }
        if (isRecord(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion !== ARCHIVE_EVENT_SCHEMA_VERSION) {
          issues.push({ code: 'unsupported-schema', line: totalLines, message: `Unsupported event schema version ${raw.schemaVersion}.` });
          continue;
        }
        const event = parseArchiveEvent(raw);
        if (!event || event.sessionId !== sessionId) {
          issues.push({ code: 'event-invalid', line: totalLines, message: 'Event does not satisfy the canonical archive schema or session identity.' });
          continue;
        }
        if (event.eventSeq !== expectedSeq) {
          issues.push({ code: 'event-sequence', line: totalLines, eventSeq: event.eventSeq, message: `Expected eventSeq ${expectedSeq}, found ${event.eventSeq}.` });
          expectedSeq = Math.max(expectedSeq, event.eventSeq + 1);
        } else expectedSeq += 1;
        if (seenIds.has(event.eventId)) {
          issues.push({ code: 'duplicate-event-id', line: totalLines, eventSeq: event.eventSeq, message: `Duplicate event id ${event.eventId}.` });
        }
        seenIds.add(event.eventId);
        for (const asset of event.assets) assetIds.add(asset.id);
        validEvents += 1;
        if (collectLimit > 0 && events.length < collectLimit) events.push(event);
        else if (collectLimit > 0 && !issues.some(issue => issue.code === 'event-limit-exceeded')) {
          issues.push({ code: 'event-limit-exceeded', message: `More than ${collectLimit} events exist; this read is a bounded projection.` });
        }
        await options.onEvent?.(event);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return { events, issues, totalLines, validEvents, uniqueAssetCount: assetIds.size };
  }

  async readSession(sessionId: string, collectLimit = DEFAULT_COLLECT_LIMIT): Promise<ArchiveSessionReadResult> {
    safeSessionId(sessionId);
    const directory = sessionDirectory(this.archiveRoot, sessionId);
    if (await ensureArchiveDirectory(this.archiveRoot, directory, false) === 'missing') {
      return { sessionId, state: 'missing', manifest: null, events: [], issues: [] };
    }

    const issues: ArchiveProjectionIssue[] = [];
    let manifest: ArchiveSessionManifest | null = null;
    try {
      const raw = await readJson(this.archiveRoot, path.join(directory, 'manifest.json'));
      if (raw === null) issues.push({ code: 'manifest-missing', message: 'Session manifest.json is missing.' });
      else if (isRecord(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
        issues.push({ code: 'unsupported-schema', message: `Unsupported session manifest schema version ${raw.schemaVersion}.` });
      } else {
        manifest = parseArchiveSessionManifest(raw);
        if (!manifest || manifest.sessionId !== sessionId) issues.push({ code: 'manifest-invalid', message: 'Session manifest is invalid or belongs to another session.' });
      }
    } catch (error) {
      if (isArchivePathSecurityError(error)) throw error;
      issues.push({ code: 'manifest-invalid', message: 'Session manifest is not valid JSON.' });
    }

    const eventScan = await this.scanSessionEvents(sessionId, { collectLimit });
    issues.push(...eventScan.issues);
    if (manifest) {
      if (manifest.eventCount !== eventScan.validEvents) issues.push({ code: 'event-count-mismatch', message: `Manifest eventCount ${manifest.eventCount} differs from ${eventScan.validEvents} valid events.` });
      if (manifest.assetCount !== eventScan.uniqueAssetCount) issues.push({ code: 'asset-count-mismatch', message: `Manifest assetCount ${manifest.assetCount} differs from ${eventScan.uniqueAssetCount} unique assets.` });
    }
    const partial = issues.length > 0 || manifest?.captureState !== 'complete';
    return { sessionId, state: partial ? 'partial' : 'complete', manifest, events: eventScan.events, issues };
  }

  async listSessionIds(): Promise<string[]> {
    const root = path.join(this.archiveRoot, 'sessions');
    if (await ensureArchiveDirectory(this.archiveRoot, root, false) === 'missing') return [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const sessionIds: string[] = [];
      for (const entry of entries) {
        if (!SESSION_ID_RE.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
        const directory = path.join(root, entry.name);
        const state = await ensureArchiveDirectory(this.archiveRoot, directory, false);
        if (state === 'present') sessionIds.push(entry.name);
      }
      return sessionIds.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
