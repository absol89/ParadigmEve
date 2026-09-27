import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ARCHIVE_EVENT_SCHEMA_VERSION, ARCHIVE_SCHEMA_VERSION, type ArchiveEvent, type ArchiveSessionManifest } from '../src/shared/archive.js';
import { archiveBlobPath } from '../src/main/archive/archive-blobs.js';
import { publishArchiveIntegritySummary, scanArchiveIntegrity } from '../src/main/archive/archive-integrity.js';
import { ArchiveStore } from '../src/main/archive/archive-store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let store: ArchiveStore;

const manifest = (sessionId: string): ArchiveSessionManifest => ({
  schemaVersion: ARCHIVE_SCHEMA_VERSION,
  sessionId,
  title: sessionId,
  createdAt: 1,
  updatedAt: 1,
  threadIds: [], quiltIds: [], providerConversationIds: [],
  eventCount: 0, assetCount: 0, captureState: 'complete'
});

const event = (sessionId: string, blob?: Awaited<ReturnType<ArchiveStore['blobs']['put']>>): ArchiveEvent => ({
  schemaVersion: ARCHIVE_EVENT_SCHEMA_VERSION,
  sessionId,
  eventSeq: 1,
  eventId: `${sessionId}-event-1`,
  at: 2,
  kind: 'assistant_message',
  actor: 'assistant',
  assets: blob ? [{ id: `${sessionId}-image`, kind: 'generated-image', captureState: 'retained', blob }] : [],
  sourceRefs: [],
  payload: { text: 'done' }
});

beforeEach(async () => {
  directory = await makeTempDir('eve-archive-integrity-');
  store = new ArchiveStore(path.join(directory, 'archive'), { writerVersion: 'integrity-test', now: () => 100 });
  await store.initialize();
});

afterEach(async () => removeTempDir(directory));

describe('archive integrity scan', () => {
  it('reports clean retained evidence and can publish only the rebuildable integrity summary', async () => {
    const blob = await store.blobs.put(Buffer.from('retained pixels'), { mimeType: 'image/webp', extension: 'webp' });
    await store.publishSession({ manifest: manifest('clean'), events: [event('clean', blob)] });

    const report = await scanArchiveIntegrity(store, 200);
    expect(report).toMatchObject({ status: 'clean', referencedBlobCount: 1, storedBlobCount: 1, issues: [] });
    await publishArchiveIntegritySummary(store, report);
    expect((await store.readArchiveManifest()).manifest?.integrity).toEqual({ scannedAt: 200, status: 'clean', issueCount: 0 });
  });

  it('reports a missing retained blob without hiding the session', async () => {
    const blob = await store.blobs.put(Buffer.from('will disappear'), { mimeType: 'image/png' });
    await store.publishSession({ manifest: manifest('missing-blob-session'), events: [event('missing-blob-session', blob)] });
    await fs.rm(archiveBlobPath(path.join(directory, 'archive'), blob.sha256));

    const report = await scanArchiveIntegrity(store);
    expect(report.status).toBe('corrupt');
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-blob', sessionId: 'missing-blob-session', blobSha256: blob.sha256 })]));
    expect(report.sessions).toEqual([expect.objectContaining({ sessionId: 'missing-blob-session', state: 'partial' })]);
  });

  it('reports intentional metadata-only capture as partial rather than structurally clean', async () => {
    await store.publishSession({ manifest: { ...manifest('metadata-only'), captureState: 'metadata-only' }, events: [event('metadata-only')] });
    const report = await scanArchiveIntegrity(store);
    expect(report.status).toBe('partial');
    expect(report.issues).toEqual([]);
    expect(report.sessions).toEqual([expect.objectContaining({ sessionId: 'metadata-only', state: 'partial' })]);
  });

  it('detects blob hash corruption and unreferenced orphan bytes', async () => {
    const blob = await store.blobs.put(Buffer.from('original bytes'), { mimeType: 'application/octet-stream' });
    await store.publishSession({ manifest: manifest('corrupt-blob-session'), events: [event('corrupt-blob-session', blob)] });
    await fs.writeFile(archiveBlobPath(path.join(directory, 'archive'), blob.sha256), 'tampered');
    const orphan = await store.blobs.put(Buffer.from('orphan bytes'), { mimeType: 'application/octet-stream' });

    const report = await scanArchiveIntegrity(store);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'hash-mismatch', blobSha256: blob.sha256 }),
      expect.objectContaining({ code: 'orphan-blob', blobSha256: orphan.sha256 })
    ]));
  });

  it('keeps malformed JSONL and impossible lineage visible as partial/corrupt evidence', async () => {
    const lineage = { ...manifest('lineage'), continuation: { successorSessionId: 'lineage' } };
    await store.publishSession({ manifest: lineage, events: [event('lineage')] });
    await fs.appendFile(path.join(directory, 'archive', 'sessions', 'lineage', 'events.jsonl'), '{ definitely not json\n');

    const report = await scanArchiveIntegrity(store);
    expect(report.status).toBe('corrupt');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-jsonl', sessionId: 'lineage' }),
      expect.objectContaining({ code: 'impossible-lineage', sessionId: 'lineage' })
    ]));
    expect(report.sessions[0]).toMatchObject({ sessionId: 'lineage', state: 'partial' });
  });
});
