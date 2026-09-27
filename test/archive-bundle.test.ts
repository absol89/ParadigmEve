import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EVECHAT_MANIFEST_PATH,
  EveChatBundleValidationError,
  planEveChatExport,
  readPlannedEveChatEntry,
  type EveChatExportPlan,
  type EveChatExportSource
} from '../src/main/archive/archive-export.js';
import {
  validateEveChatImport,
  type EveChatContainerEntry
} from '../src/main/archive/archive-import.js';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

function source(path: string, role: EveChatExportSource['role'], text: string, mediaType?: string): EveChatExportSource {
  const value = bytes(text);
  return {
    path,
    role,
    byteLength: value.byteLength,
    ...(mediaType === undefined ? {} : { mediaType }),
    readBytes: async () => value
  };
}

function sources(assetText = 'PNGDATA'): EveChatExportSource[] {
  const asset = bytes(assetText);
  const assetHash = hash(asset);
  return [
    source('events.jsonl', 'events', '{"id":"event-1"}\n', 'application/x-ndjson'),
    source('index.html', 'html', '<!doctype html><title>Offline</title>', 'text/html'),
    source('archive.css', 'css', 'body{}', 'text/css'),
    source('archive.js', 'js', 'globalThis.EVECHAT=true;', 'text/javascript'),
    {
      path: `assets/${assetHash}.png`,
      role: 'asset',
      byteLength: asset.byteLength,
      mediaType: 'image/png',
      readBytes: () => asset
    }
  ];
}

async function plan(entries = sources()): Promise<EveChatExportPlan> {
  return planEveChatExport({
    sessionId: '2026-09-22-archive-test',
    archiveSchemaVersion: 1,
    minimumCompatibleArchiveSchemaVersion: 1,
    entries
  });
}

function containerFromPlan(exportPlan: EveChatExportPlan): EveChatContainerEntry[] {
  return [
    {
      kind: 'file',
      path: EVECHAT_MANIFEST_PATH,
      declaredSize: exportPlan.manifestBytes.byteLength,
      readBytes: () => exportPlan.manifestBytes
    },
    { kind: 'directory', path: 'assets/', declaredSize: 0 },
    ...exportPlan.entries.map(entry => ({
      kind: 'file' as const,
      path: entry.path,
      declaredSize: entry.byteLength,
      readBytes: () => readPlannedEveChatEntry(entry)
    }))
  ];
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(EveChatBundleValidationError);
  expect((error as EveChatBundleValidationError).code).toBe(code);
}

describe('.evechat bundle planning and validation', () => {
  it('creates the same deterministic manifest regardless of export source ordering', async () => {
    const first = await plan(sources());
    const second = await plan([...sources()].reverse());

    expect(Buffer.from(second.manifestBytes)).toEqual(Buffer.from(first.manifestBytes));
    expect(second.manifest.bundleId).toBe(first.manifest.bundleId);
    expect(first.manifest.entries.map(entry => entry.path)).toEqual([
      'events.jsonl', 'index.html', 'archive.css', 'archive.js', first.manifest.entries[4]!.path
    ]);
    expect(first.manifest.bundleId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects export-source drift after the deterministic plan is created', async () => {
    let current = bytes('{"id":"event-1"}\n');
    const changing: EveChatExportSource = {
      path: 'events.jsonl', role: 'events', byteLength: current.byteLength, readBytes: () => current
    };
    const exportPlan = await plan([changing, ...sources().filter(entry => entry.role !== 'events')]);
    current = bytes('{"id":"event-2"}\n');
    await expect(readPlannedEveChatEntry(exportPlan.entries[0]!)).rejects.toMatchObject({ code: 'export-source-changed' });
  });

  it('validates every declared hash and returns read-only import evidence', async () => {
    const exportPlan = await plan();
    const liveSessionExists = vi.fn(async () => false);
    const result = await validateEveChatImport({
      entries: containerFromPlan(exportPlan),
      supportedArchiveSchemaVersion: 1,
      liveSessionExists
    });

    expect(result.disposition).toBe('read-only-import');
    expect(result.manifest.bundleId).toBe(exportPlan.manifest.bundleId);
    expect(result.verifiedPaths).toEqual(exportPlan.manifest.entries.map(entry => entry.path));
    expect(liveSessionExists).toHaveBeenCalledExactlyOnceWith('2026-09-22-archive-test');
  });

  it('rejects hash tampering even when decoded size is unchanged', async () => {
    const exportPlan = await plan();
    const entries = containerFromPlan(exportPlan);
    const events = entries.find(entry => entry.path === 'events.jsonl')!;
    if (events.kind !== 'file') throw new Error('test fixture is not a file');
    events.readBytes = () => bytes('{"id":"event-X"}\n');

    await expect(validateEveChatImport({
      entries,
      supportedArchiveSchemaVersion: 1,
      liveSessionExists: () => false
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'hash-mismatch');
      return true;
    });
  });

  it.each([
    ['../outside', 'unsafe-path'],
    ['/absolute', 'unsafe-path'],
    ['C:/windows/path', 'unsafe-path'],
    ['assets/../../escape', 'unsafe-path']
  ])('rejects unsafe container path %s before reading it', async (unsafePath, expectedCode) => {
    const exportPlan = await plan();
    const readBytes = vi.fn(() => bytes('evil'));
    const entries = [...containerFromPlan(exportPlan), {
      kind: 'file' as const,
      path: unsafePath,
      declaredSize: 4,
      readBytes
    }];

    try {
      await validateEveChatImport({ entries, supportedArchiveSchemaVersion: 1, liveSessionExists: () => false });
      throw new Error('expected import rejection');
    } catch (error) {
      expectCode(error, expectedCode);
    }
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('rejects symlinks before reading target or link bytes', async () => {
    const exportPlan = await plan();
    const readBytes = vi.fn(() => bytes('target'));
    const entries = [...containerFromPlan(exportPlan), {
      kind: 'symlink' as const,
      path: 'assets/' + 'a'.repeat(64),
      declaredSize: 6,
      linkTarget: '../../outside',
      readBytes
    }];

    await expect(validateEveChatImport({
      entries,
      supportedArchiveSchemaVersion: 1,
      liveSessionExists: () => false
    })).rejects.toMatchObject({ code: 'symlink-entry' });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('rejects oversized declared entries before invoking their byte reader', async () => {
    const exportPlan = await plan();
    const entries = containerFromPlan(exportPlan);
    const events = entries.find(entry => entry.path === 'events.jsonl')!;
    if (events.kind !== 'file') throw new Error('test fixture is not a file');
    const readBytes = vi.fn(() => bytes('never'));
    events.declaredSize = 101;
    events.readBytes = readBytes;

    await expect(validateEveChatImport({
      entries,
      supportedArchiveSchemaVersion: 1,
      liveSessionExists: () => false,
      limits: { maxEntryBytes: 100 }
    })).rejects.toMatchObject({ code: 'entry-too-large' });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('passes the manifest size as a decode cap and rejects decoded-size expansion', async () => {
    const exportPlan = await plan();
    const entries = containerFromPlan(exportPlan);
    const events = entries.find(entry => entry.path === 'events.jsonl')!;
    if (events.kind !== 'file') throw new Error('test fixture is not a file');
    const expectedSize = events.declaredSize;
    const readBytes = vi.fn((_maxBytes: number) => new Uint8Array(expectedSize + 1));
    events.readBytes = readBytes;

    await expect(validateEveChatImport({
      entries,
      supportedArchiveSchemaVersion: 1,
      liveSessionExists: () => false
    })).rejects.toMatchObject({ code: 'entry-size-mismatch' });
    expect(readBytes).toHaveBeenCalledExactlyOnceWith(expectedSize);
  });

  it('refuses a live authoritative session before reading payload entries', async () => {
    const exportPlan = await plan();
    const entries = containerFromPlan(exportPlan);
    const payloadReads = entries.filter((entry): entry is Extract<EveChatContainerEntry, { kind: 'file' }> =>
      entry.kind === 'file' && entry.path !== EVECHAT_MANIFEST_PATH).map(entry => {
        const original = entry.readBytes;
        const spy = vi.fn(original);
        entry.readBytes = spy;
        return spy;
      });

    await expect(validateEveChatImport({
      entries,
      supportedArchiveSchemaVersion: 1,
      liveSessionExists: sessionId => sessionId === exportPlan.manifest.session.id
    })).rejects.toMatchObject({ code: 'live-session-collision' });
    for (const spy of payloadReads) expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an asset whose hash-named path disagrees with its bytes during export planning', async () => {
    const asset = bytes('real bytes');
    const badAsset: EveChatExportSource = {
      path: `assets/${'0'.repeat(64)}.png`,
      role: 'asset',
      byteLength: asset.byteLength,
      readBytes: () => asset
    };
    await expect(plan([badAsset, ...sources().filter(entry => entry.role !== 'asset')]))
      .rejects.toMatchObject({ code: 'asset-hash-path-mismatch' });
  });
});
