import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DiskArchiveIndex,
  InMemoryArchiveIndex,
  createDiskArchiveIndex,
  createReferenceArchiveIndex,
  type ArchiveIndexProjection,
  type ArchiveIndexDocument
} from '../src/main/archive/archive-index.js';

const documents = (): ArchiveIndexDocument[] => [
  {
    id: 'session:s1',
    kind: 'session',
    authority: { kind: 'session', sessionId: 's1-session' },
    title: 'Release archive design',
    text: 'Durable chat history and local images.',
    projectId: 'project-a',
    threadIds: ['thread-archive'],
    timestamp: 10
  },
  {
    id: 'event:s1:4',
    kind: 'event',
    authority: { kind: 'evidence', sessionId: 's1-session', eventSeq: 4 },
    text: 'SQLite is a rebuildable search projection, not evidence authority.',
    projectId: 'project-a',
    threadIds: ['thread-archive'],
    quiltIds: ['quilt-eve'],
    timestamp: 20
  },
  {
    id: 'memory:m1',
    kind: 'memory',
    authority: { kind: 'memory', memoryId: 'm1' },
    title: 'Archive preference',
    text: 'Keep provider-neutral memory compact and provenance linked.',
    projectId: 'project-a',
    threadIds: ['thread-archive'],
    timestamp: 30
  },
  {
    id: 'asset:img1',
    kind: 'asset',
    authority: { kind: 'evidence', sessionId: 's1-session', assetId: 'sha256-image.webp' },
    filename: 'diagram.webp',
    text: 'architecture diagram',
    projectId: 'project-a',
    timestamp: 40
  }
];

async function tempArchiveRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'paradigmeve-archive-index-'));
}

function comparableStats(index: ArchiveIndexProjection): Omit<ReturnType<ArchiveIndexProjection['stats']>, 'backend'> {
  const { backend: _backend, ...rest } = index.stats();
  return rest;
}

describe('archive rebuildable index', () => {
  it('searches inert projections while preserving authority refs and source objects', async () => {
    const source = documents();
    const original = JSON.parse(JSON.stringify(source));
    const index = createReferenceArchiveIndex();
    const stats = await index.rebuild(source);
    expect(stats).toMatchObject({ backend: 'memory-reference', generation: 1, documents: 4 });

    const memory = await index.search('provider neutral', { kinds: ['memory'], projectId: 'project-a' });
    expect(memory).toHaveLength(1);
    expect(memory[0]?.document.authority).toEqual({ kind: 'memory', memoryId: 'm1' });
    const image = await index.search('diagram', { sessionId: 's1-session' });
    expect(image.map(hit => hit.document.id)).toEqual(['asset:img1']);
    expect(source).toEqual(original);
  });

  it('publishes a rebuild only after every replacement document validates', async () => {
    const index = new InMemoryArchiveIndex();
    await index.rebuild(documents());
    const before = index.stats();
    const bad = [
      { ...documents()[0]!, text: 'replacement' },
      { ...documents()[0]!, text: 'duplicate id' }
    ];
    await expect(index.rebuild(bad)).rejects.toThrow(/duplicate index document id/i);
    expect(index.stats()).toEqual(before);
    expect((await index.search('durable')).map(hit => hit.document.id)).toContain('session:s1');
  });

  it('replaces the whole disposable projection without retaining stale authority', async () => {
    const index = new InMemoryArchiveIndex();
    await index.rebuild(documents());
    await index.rebuild([{
      id: 'memory:m2',
      kind: 'memory',
      authority: { kind: 'memory', memoryId: 'm2' },
      text: 'Fresh replacement index',
      projectId: 'project-b',
      timestamp: 100
    }]);
    expect(index.stats()).toMatchObject({ generation: 2, documents: 1 });
    expect(await index.search('archive')).toEqual([]);
    expect((await index.search('replacement'))[0]?.document.authority).toEqual({ kind: 'memory', memoryId: 'm2' });
  });

  it('supports project/thread/quilt filters and can be discarded without touching source evidence', async () => {
    const source = documents();
    const index = new InMemoryArchiveIndex();
    await index.rebuild(source);
    expect((await index.search('', { threadId: 'thread-archive' })).map(hit => hit.document.id)).toHaveLength(3);
    expect((await index.search('', { quiltId: 'quilt-eve' })).map(hit => hit.document.id)).toEqual(['event:s1:4']);
    await index.dispose();
    expect(source).toHaveLength(4);
    expect(() => index.stats()).toThrow(/disposed/i);
    await expect(index.search('memory')).rejects.toThrow(/disposed/i);
  });

  it('keeps the disk backend semantically identical to the in-memory oracle', async () => {
    const archiveRoot = await tempArchiveRoot();
    const source: ArchiveIndexDocument[] = [
      ...documents(),
      {
        id: 'event:s2:1',
        kind: 'event',
        authority: { kind: 'evidence', sessionId: 's2-session', eventSeq: 1 },
        title: 'Archive archive',
        text: 'provider neutral archive archive',
        provider: 'provider archive',
        projectId: 'project-a',
        threadIds: ['thread-other'],
        quiltIds: ['quilt-eve'],
        timestamp: 40
      },
      {
        id: 'event:s2:2',
        kind: 'event',
        authority: { kind: 'evidence', sessionId: 's2-session', eventSeq: 2 },
        title: 'Archive',
        text: 'provider neutral archive',
        provider: 'provider',
        projectId: 'project-a',
        threadIds: ['thread-archive'],
        timestamp: 40
      }
    ];
    const memory = new InMemoryArchiveIndex();
    const disk = new DiskArchiveIndex(archiveRoot);
    await memory.rebuild(source);
    await disk.rebuild((async function *(): AsyncGenerator<ArchiveIndexDocument> {
      for (const document of source) yield document;
    })());

    expect(comparableStats(disk)).toEqual(comparableStats(memory));
    expect(disk.stats().backend).toBe('jsonl-disk');
    const cases: Array<[string, Parameters<ArchiveIndexProjection['search']>[1]]> = [
      ['archive', undefined],
      ['provider neutral', { projectId: 'project-a' }],
      ['', { threadId: 'thread-archive' }],
      ['', { quiltId: 'quilt-eve' }],
      ['archive', { kinds: ['event'], sessionId: 's2-session', limit: 2 }],
      ['diagram', { kinds: ['asset'] }]
    ];
    for (const [query, options] of cases) {
      expect(await disk.search(query, options)).toEqual(await memory.search(query, options));
    }

    await memory.dispose();
    await disk.dispose();
    await expect(disk.search('archive')).rejects.toThrow(/disposed/i);
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  it('keeps the previously published disk generation after duplicate or invalid rebuild input', async () => {
    const archiveRoot = await tempArchiveRoot();
    const disk = createDiskArchiveIndex(archiveRoot);
    await disk.rebuild(documents());
    const beforeStats = disk.stats();
    const beforeSearch = await disk.search('durable');
    const indexFile = path.join(archiveRoot, 'derived', 'archive-index.jsonl');
    const beforeBytes = await fs.readFile(indexFile);

    const duplicate = [
      { ...documents()[0]!, text: 'replacement' },
      { ...documents()[0]!, text: 'duplicate id' }
    ];
    await expect(disk.rebuild(duplicate)).rejects.toThrow(/duplicate index document id: session:s1/i);
    expect(disk.stats()).toEqual(beforeStats);
    expect(await disk.search('durable')).toEqual(beforeSearch);
    expect(await fs.readFile(indexFile)).toEqual(beforeBytes);

    await expect(disk.rebuild([{ ...documents()[0]!, text: 'x'.repeat(2_000_001) }]))
      .rejects.toThrow(/index text is invalid/i);
    expect(disk.stats()).toEqual(beforeStats);
    expect(await fs.readFile(indexFile)).toEqual(beforeBytes);

    await disk.rebuild([{
      id: 'memory:replacement',
      kind: 'memory',
      authority: { kind: 'memory', memoryId: 'replacement' },
      text: 'fresh disk replacement',
      timestamp: 999
    }]);
    expect(disk.stats()).toMatchObject({ generation: 2, documents: 1 });
    expect(await disk.search('durable')).toEqual([]);
    expect((await disk.search('replacement'))[0]?.document.authority).toEqual({ kind: 'memory', memoryId: 'replacement' });
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  it('fails closed when the derived index parent is a real symlink or junction', async () => {
    const archiveRoot = await tempArchiveRoot();
    const outside = await tempArchiveRoot();
    await fs.symlink(outside, path.join(archiveRoot, 'derived'), process.platform === 'win32' ? 'junction' : 'dir');
    const disk = new DiskArchiveIndex(archiveRoot);

    await expect(disk.rebuild(documents())).rejects.toThrow(/ARCHIVE_DIRECTORY_UNSAFE/);
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.rm(archiveRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
});
