import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ARCHIVE_EVENT_SCHEMA_VERSION, ARCHIVE_SCHEMA_VERSION, type ArchiveEvent, type ArchiveSessionManifest } from '../src/shared/archive.js';
import { ArchiveBlobStore, archiveBlobPath } from '../src/main/archive/archive-blobs.js';
import { ArchiveStore } from '../src/main/archive/archive-store.js';
import { rebuildArchiveFromScan, scanArchiveForRebuild } from '../src/main/archive/archive-migrate.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let store: ArchiveStore;

const event = (sessionId: string, eventSeq: number, id = `event-${eventSeq}`): ArchiveEvent => ({
  schemaVersion: ARCHIVE_EVENT_SCHEMA_VERSION,
  sessionId,
  eventSeq,
  eventId: id,
  at: 1_700_000_000_000 + eventSeq,
  kind: eventSeq % 2 ? 'user_message' : 'assistant_message',
  actor: eventSeq % 2 ? 'user' : 'assistant',
  assets: [],
  sourceRefs: [],
  payload: { text: `message ${eventSeq}` }
});

const manifest = (sessionId: string, captureState: ArchiveSessionManifest['captureState'] = 'complete'): ArchiveSessionManifest => ({
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  sessionId,
  title: `Session ${sessionId}`,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  threadIds: [],
  quiltIds: [],
  providerConversationIds: [],
  eventCount: 0,
  assetCount: 0,
  captureState
});

beforeEach(async () => {
  directory = await makeTempDir('eve-archive-store-');
  store = new ArchiveStore(path.join(directory, 'archive'), { writerVersion: 'experiment-test' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(directory);
});

describe('archive blob store', () => {
  it('publishes SHA-256 addressed bytes once and deduplicates metadata aliases', async () => {
    const blobs = new ArchiveBlobStore(path.join(directory, 'archive'));
    const bytes = Buffer.from('same retained bytes');
    const [first, concurrent] = await Promise.all([
      blobs.put(bytes, { mimeType: 'image/png', extension: '.PNG', width: 10, height: 20 }),
      blobs.put(bytes, { mimeType: 'image/png', extension: 'png' })
    ]);
    const second = await blobs.put(bytes, { mimeType: 'application/octet-stream', extension: 'bin' });

    expect(concurrent.sha256).toBe(first.sha256);
    expect(second.sha256).toBe(first.sha256);
    expect(await fs.readFile(archiveBlobPath(path.join(directory, 'archive'), first.sha256), 'utf8')).toBe('same retained bytes');
    expect((await blobs.scanStored()).filter(row => row.sha256)).toHaveLength(1);
    expect((await fs.readdir(path.dirname(archiveBlobPath(path.join(directory, 'archive'), first.sha256)))).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a pre-existing blob junction parent without creating bytes outside archiveRoot', async () => {
    const archiveRoot = path.join(directory, 'archive');
    const outside = path.join(directory, 'outside-blobs');
    await fs.mkdir(path.join(archiveRoot, 'blobs'), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(archiveRoot, 'blobs', 'sha256'), DIR_LINK);

    const blobs = new ArchiveBlobStore(archiveRoot);
    await expect(blobs.put(Buffer.from('must stay inside'), { mimeType: 'application/octet-stream' }))
      .rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses blob inspection through a replaced hash-prefix junction', async () => {
    const archiveRoot = path.join(directory, 'archive');
    const blobs = new ArchiveBlobStore(archiveRoot);
    const ref = await blobs.put(Buffer.from('retained bytes'), { mimeType: 'application/octet-stream' });
    const prefix = path.dirname(archiveBlobPath(archiveRoot, ref.sha256));
    const outside = path.join(directory, 'outside-prefix');
    await fs.rename(prefix, outside);
    await fs.symlink(outside, prefix, DIR_LINK);

    await expect(blobs.inspect(ref)).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    await expect(blobs.scanStored()).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
  });
});

describe('canonical archive store', () => {
  it('refuses a junction parent before creating archiveRoot outside the requested path', async () => {
    const outside = path.join(directory, 'outside-parent');
    const linkedParent = path.join(directory, 'linked-parent');
    await fs.mkdir(outside);
    await fs.symlink(outside, linkedParent, DIR_LINK);
    const linked = new ArchiveStore(path.join(linkedParent, 'archive'), { writerVersion: 'experiment-test' });

    await expect(linked.initialize()).rejects.toThrow(/ARCHIVE_ROOT_PARENT_UNSAFE/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses an archiveRoot that is already a junction', async () => {
    const outside = path.join(directory, 'outside-root');
    const linkedRoot = path.join(directory, 'linked-archive');
    await fs.mkdir(outside);
    await fs.symlink(outside, linkedRoot, DIR_LINK);
    const linked = new ArchiveStore(linkedRoot, { writerVersion: 'experiment-test' });

    await expect(linked.initialize()).rejects.toThrow(/ARCHIVE_ROOT_UNSAFE/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a pre-existing session junction without publishing canonical bytes outside archiveRoot', async () => {
    const archiveRoot = path.join(directory, 'archive');
    const outside = path.join(directory, 'outside-session');
    await store.initialize();
    await fs.mkdir(path.join(archiveRoot, 'sessions'), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(archiveRoot, 'sessions', 'escape-session'), DIR_LINK);

    await expect(store.publishSession({ manifest: manifest('escape-session'), events: [event('escape-session', 1)] }))
      .rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses reads and session scans through a replaced session junction', async () => {
    await store.initialize();
    await store.publishSession({ manifest: manifest('linked-read'), events: [event('linked-read', 1)] });
    const sessionPath = path.join(directory, 'archive', 'sessions', 'linked-read');
    const outside = path.join(directory, 'outside-read');
    await fs.rename(sessionPath, outside);
    await fs.symlink(outside, sessionPath, DIR_LINK);

    await expect(store.readSession('linked-read')).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    await expect(store.scanSessionEvents('linked-read')).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    await expect(store.listSessionIds()).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
  });

  it('creates versioned manifests, reopens events, and appends in monotonic order', async () => {
    const root = await store.initialize();
    expect(root).toMatchObject({ schemaVersion: 1, hashAlgorithm: 'sha256', writerVersion: 'experiment-test' });
    await store.publishSession({ manifest: manifest('session-a'), events: [event('session-a', 1)] });
    await store.appendEvent('session-a', event('session-a', 2));

    const reopened = new ArchiveStore(path.join(directory, 'archive'), { writerVersion: 'experiment-test' });
    expect(await reopened.readSession('session-a')).toMatchObject({
      state: 'complete',
      manifest: { eventCount: 2, assetCount: 0 },
      events: [{ eventSeq: 1 }, { eventSeq: 2 }],
      issues: []
    });
    await expect(reopened.appendEvent('session-a', event('session-a', 4))).rejects.toThrow(/SEQUENCE/);
  });

  it('allows idempotent/append-only scan publication but refuses canonical evidence rewrites', async () => {
    await store.initialize();
    await store.publishSession({ manifest: manifest('immutable'), events: [event('immutable', 1)] });
    await expect(store.publishSession({ manifest: { ...manifest('immutable'), title: 'Updated projection title' }, events: [event('immutable', 1)] }))
      .resolves.toMatchObject({ title: 'Updated projection title', eventCount: 1 });
    await expect(store.publishSession({ manifest: manifest('immutable'), events: [event('immutable', 1), event('immutable', 2)] }))
      .resolves.toMatchObject({ eventCount: 2 });

    const changed = event('immutable', 1);
    changed.payload = { text: 'rewritten evidence' };
    await expect(store.publishSession({ manifest: manifest('immutable'), events: [changed, event('immutable', 2)] }))
      .rejects.toThrow(/EVIDENCE_REWRITE_REFUSED/);
    await expect(store.publishSession({ manifest: manifest('immutable'), events: [event('immutable', 1)] }))
      .rejects.toThrow(/EVIDENCE_REWRITE_REFUSED/);
  });

  it('requires retained blob bytes before evidence may claim local retention', async () => {
    await store.initialize();
    const retained = event('session-asset', 1);
    retained.assets.push({
      id: 'asset-1', kind: 'image', captureState: 'retained',
      blob: { sha256: 'a'.repeat(64), mimeType: 'image/png', byteLength: 10 }
    });
    await expect(store.publishSession({ manifest: manifest('session-asset'), events: [retained] }))
      .rejects.toThrow(/RETAINED_BLOB_NOT_AVAILABLE/);

    const blob = await store.blobs.put(Buffer.from('pixels'), { mimeType: 'image/png', extension: 'png' });
    retained.assets[0]!.blob = blob;
    const published = await store.publishSession({ manifest: manifest('session-asset'), events: [retained] });
    expect(published).toMatchObject({ assetCount: 1, captureState: 'complete' });
  });

  it('surfaces missing and metadata-only sessions instead of inventing completeness', async () => {
    await store.initialize();
    expect(await store.readSession('does-not-exist')).toEqual({
      sessionId: 'does-not-exist', state: 'missing', manifest: null, events: [], issues: []
    });
    await store.publishSession({ manifest: manifest('metadata', 'metadata-only'), events: [event('metadata', 1)] });
    expect((await store.readSession('metadata')).state).toBe('partial');

    await fs.rm(path.join(directory, 'archive', 'sessions', 'metadata', 'events.jsonl'));
    const partial = await store.readSession('metadata');
    expect(partial.state).toBe('partial');
    expect(partial.issues.map(issue => issue.code)).toContain('events-missing');
  });

  it('publishes events before manifest so a failed manifest rename is a visible rebuildable lag', async () => {
    await store.initialize();
    await store.publishSession({ manifest: manifest('ordered'), events: [event('ordered', 1)] });
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(path.join('ordered', 'manifest.json'))) throw Object.assign(new Error('disk busy'), { code: 'EBUSY' });
      return originalRename(from, to);
    });
    await expect(store.appendEvent('ordered', event('ordered', 2))).rejects.toThrow('disk busy');
    rename.mockRestore();

    const lag = await store.readSession('ordered');
    expect(lag.events.map(row => row.eventSeq)).toEqual([1, 2]);
    expect(lag.manifest?.eventCount).toBe(1);
    expect(lag.state).toBe('partial');
    expect(lag.issues.map(issue => issue.code)).toContain('event-count-mismatch');
  });

  it('rebuilds projections from an external canonical scan and yields partial sessions to rebuilders', async () => {
    const seen: string[] = [];
    const report = await rebuildArchiveFromScan(store, {
      listSessionIds: async () => ['b', 'gone', 'a', 'a'],
      projectSession: async sessionId => sessionId === 'gone' ? null : ({ manifest: manifest(sessionId), events: [event(sessionId, 1)] })
    }, { afterSession: row => { seen.push(row.sessionId); } });
    expect(report).toEqual({ scannedSessionIds: ['a', 'b', 'gone'], publishedSessionIds: ['a', 'b'], skippedSessionIds: ['gone'] });
    expect(seen).toEqual(['a', 'b']);

    await fs.appendFile(path.join(directory, 'archive', 'sessions', 'b', 'events.jsonl'), '{bad json\n');
    const states: Array<[string, string]> = [];
    await scanArchiveForRebuild(store, row => { states.push([row.sessionId, row.state]); });
    expect(states).toEqual([['a', 'complete'], ['b', 'partial']]);
  });
});
