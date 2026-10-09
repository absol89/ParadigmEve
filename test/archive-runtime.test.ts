import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef, SessionEvent, SessionSummary } from '../src/shared/session.js';
import {
  ArchiveRuntime,
  PAGE_USER_RECEIPT_GRACE_MS,
  type ArchiveRuntimeSource,
  type CurrentSessionArchiveSnapshot
} from '../src/main/archive/archive-runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function tempArchiveRoot(): Promise<string> {
  // The archive refuses a non-canonical parent; CI temp dirs are not canonical (RUNNER~1, /var -> /private/var).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eve-archive-runtime-')));
  tempDirs.push(directory);
  return path.join(directory, 'archive');
}

async function generatedStaticFiles(indexPath: string): Promise<{ html: string; generation: string; search: string; chunks: string[] }> {
  const html = await fs.readFile(indexPath, 'utf8');
  const match = /data\/(g-[a-f0-9]{32})\/search\.js/u.exec(html);
  if (!match) throw new Error('static archive generation path missing');
  const generation = match[1]!;
  const generationRoot = path.join(path.dirname(indexPath), 'data', generation);
  const search = await fs.readFile(path.join(generationRoot, 'search.js'), 'utf8');
  const chunks = (await fs.readdir(generationRoot))
    .filter(name => /^chat-\d+-segment-\d+\.js$/u.test(name))
    .sort((left, right) => {
      const leftMatch = /^chat-(\d+)-segment-(\d+)\.js$/u.exec(left)!;
      const rightMatch = /^chat-(\d+)-segment-(\d+)\.js$/u.exec(right)!;
      return Number(leftMatch[1]) - Number(rightMatch[1]) || Number(leftMatch[2]) - Number(rightMatch[2]);
    })
    .map(name => path.join(generationRoot, name));
  return { html, generation, search, chunks };
}

function summary(id: string, title = 'Archive chat'): SessionSummary {
  return {
    id,
    title,
    conversationId: 'conv-current-1234',
    chatIds: ['conv-old-1234', 'conv-current-1234'],
    startedAt: 100,
    updatedAt: 200,
    endedAt: null,
    events: 0,
    userMessages: 0,
    toolCalls: 0,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    agents: [],
    origin: null
  };
}

function user(seq: number, text: string, assets: AssetRef[] | undefined = undefined): SessionEvent {
  return {
    seq,
    time: 100 + seq,
    source: 'app',
    kind: 'user_message',
    messageId: 'user-message-1',
    message: { text, chars: text.length, truncated: false },
    ...(assets?.length ? { assets } : {})
  };
}

function assistant(seq: number, text: string, final: boolean, extra: Partial<Extract<SessionEvent, { kind: 'assistant_message' }>> = {}): SessionEvent {
  return {
    seq,
    time: 100 + seq,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-message-1',
    message: { text, chars: text.length, truncated: false },
    final,
    state: final ? 'final' : 'streaming',
    ...extra
  };
}

function sourceFor(snapshot: CurrentSessionArchiveSnapshot, assets = new Map<string, Uint8Array>()): ArchiveRuntimeSource {
  return {
    listSessionIds: async () => [snapshot.summary.id],
    readSession: async id => id === snapshot.summary.id ? snapshot : null,
    readAsset: async (_sessionId, assetId) => assets.get(assetId) ?? null
  };
}

describe('ArchiveRuntime', () => {
  it('preserves published evidence and settles partial when source history is later reordered', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-source-order-repair';
    const firstUser = { ...user(1, 'first request'), messageId: 'user-first' } as SessionEvent;
    const firstAssistant = { ...assistant(2, 'first answer', true), messageId: 'assistant-first' } as SessionEvent;
    let current: CurrentSessionArchiveSnapshot = {
      summary: summary(id),
      events: [firstUser, firstAssistant]
    };
    const errors: Error[] = [];
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => current,
        readAsset: async () => null
      },
      onError: error => errors.push(error)
    });

    await runtime.start();
    await runtime.drain();
    const published = await runtime.store.readSession(id);

    current = {
      summary: { ...summary(id), updatedAt: 300 },
      events: [
        firstUser,
        { ...user(2, 'late historical request'), messageId: 'user-late' } as SessionEvent,
        { ...firstAssistant, seq: 3 } as SessionEvent
      ]
    };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    const repaired = await runtime.store.readSession(id);
    expect(errors).toEqual([]);
    // Published evidence is immutable and keeps its order; the late row is appended, not lost.
    expect(repaired.events.slice(0, published.events.length)).toEqual(published.events);
    expect(repaired.events.map(event => event.eventId)).toEqual(['user:user-first', 'assistant:assistant-first', 'user:user-late']);
    expect(repaired.events.map(event => event.eventSeq)).toEqual([1, 2, 3]);
    expect(repaired.manifest?.captureState).toBe('partial');
  });

  it('holds a fresh page user row until the app receipt adds its input id and image', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-late-receipt';
    const bytes = new TextEncoder().encode('screenshot sent to GPT');
    const copy: AssetRef = { id: 'shot.bin', mimeType: 'image/png', bytes: bytes.byteLength };
    const errors: Error[] = [];
    let clock = 1_000;
    const page = { ...user(1, 'Sending the last screenshot'), time: 1_000, source: 'extension', messageId: 'native-user' } as SessionEvent;
    const answer = { ...assistant(2, 'Seen it', true), time: 1_200, messageId: 'answer' } as SessionEvent;
    let current: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [page] };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      now: () => clock,
      source: { listSessionIds: async () => [id], readSession: async () => current, readAsset: async (_session, assetId) => assetId === copy.id ? bytes : null },
      onError: error => errors.push(error)
    });
    await runtime.start();
    await runtime.drain();
    // Within the receipt grace the bare page row is not published: published evidence is never rewritten.
    expect((await runtime.store.readSession(id)).events).toEqual([]);

    // The ACK lands ~100 ms later on the same message and brings the input id and the image copy.
    clock = 1_300;
    current = { summary: { ...summary(id), updatedAt: 300 }, events: [{
      ...page, inputId: 'app-input', authoredText: 'Sending the last screenshot',
      attachments: [{ id: 'staged', name: 'shot.png', size: bytes.byteLength, mimeType: 'image/png' }],
      archivedAttachments: [{ attachmentId: 'staged', asset: copy }]
    } as SessionEvent, answer] };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    const archived = await runtime.store.readSession(id);
    expect(errors.map(error => error.message)).toEqual([]);
    expect(archived.events.map(event => event.eventId)).toEqual(['user:native-user', 'assistant:answer']);
    expect(archived.events[0]).toMatchObject({ appInputId: 'app-input' });
    expect(archived.events[0]!.assets).toHaveLength(1);
  });

  it('archives a browser upload captured after its text row was first seen', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-late-page-image';
    const bytes = new TextEncoder().encode('page preview webp');
    const preview: AssetRef = { id: 'preview.bin', mimeType: 'image/webp', bytes: bytes.byteLength };
    let clock = 1_000;
    const text = { ...user(1, 'self test now'), time: 1_000, source: 'extension', messageId: 'browser-user' } as SessionEvent;
    let current: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [text] };
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', now: () => clock,
      source: { listSessionIds: async () => [id], readSession: async () => current, readAsset: async (_s, assetId) => assetId === preview.id ? bytes : null } });
    await runtime.start();
    await runtime.drain();
    clock = 6_000;
    current = { summary: { ...summary(id), updatedAt: 300 }, events: [{ ...text, assets: [preview] } as SessionEvent] };
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    clock = 1_000 + PAGE_USER_RECEIPT_GRACE_MS;
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    const archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.eventId)).toEqual(['user:browser-user']);
    expect(archived.events[0]!.assets).toHaveLength(1);
  });

  it('shows an interrupted GPT-6 reply that never resolved as missing words, not as the pointer', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-unresolved-reference';
    const pointer = '::chatgpt-content-reference{index="0" source_message_id="POINTER-ID-MUST-NOT-SHOW"}';
    const events = [
      { ...user(1, 'first question'), messageId: 'user-first' } as SessionEvent,
      { ...assistant(2, pointer, false), messageId: 'assistant-pointer' } as SessionEvent,
      { ...user(3, 'second question'), messageId: 'user-second' } as SessionEvent
    ];
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', source: sourceFor({ summary: summary(id), events }) });
    await runtime.start();
    await runtime.drain();
    await runtime.rebuildDerived();
    const generated = await generatedStaticFiles(runtime.staticSiteTarget().indexPath);
    const chunk = await fs.readFile(generated.chunks[0]!, 'utf8');
    expect(chunk).toContain('ChatGPT sent only a reference to this reply');
    expect(chunk).not.toContain('POINTER-ID-MUST-NOT-SHOW');
  });

  it('publishes a page-authored user row once no app receipt can still arrive', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-page-authored';
    let clock = 1_000;
    const page = { ...user(1, 'typed on chatgpt.com'), time: 1_000, source: 'extension', messageId: 'page-user' } as SessionEvent;
    const current: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [page] };
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', now: () => clock, source: sourceFor(current) });
    await runtime.start();
    await runtime.drain();
    expect((await runtime.store.readSession(id)).events).toEqual([]);
    clock = 1_000 + PAGE_USER_RECEIPT_GRACE_MS;
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    expect((await runtime.store.readSession(id)).events.map(event => event.eventId)).toEqual(['user:page-user']);
  });

  it('keeps archiving new evidence after source history is reordered instead of freezing at the reorder', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-reorder-keeps-appending';
    const firstUser = { ...user(1, 'first request'), messageId: 'user-first' } as SessionEvent;
    const firstAssistant = { ...assistant(2, 'first answer', true), messageId: 'assistant-first' } as SessionEvent;
    let current: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [firstUser, firstAssistant] };
    const errors: Error[] = [];
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: { listSessionIds: async () => [id], readSession: async () => current, readAsset: async () => null },
      onError: error => errors.push(error)
    });
    await runtime.start();
    await runtime.drain();

    // A late row sorts before already-published evidence, and new turns keep arriving after it.
    const late = { ...user(3, 'late historical request'), messageId: 'user-late' } as SessionEvent;
    const laterUser = { ...user(4, 'second request'), messageId: 'user-second' } as SessionEvent;
    const laterAssistant = { ...assistant(5, 'second answer', true), messageId: 'assistant-second' } as SessionEvent;
    current = { summary: { ...summary(id), updatedAt: 300 }, events: [firstUser, late, firstAssistant, laterUser, laterAssistant] };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    // Every later reconcile must stay stable and keep picking up what is new.
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    const laterTail = { ...assistant(6, 'third answer', true), messageId: 'assistant-third' } as SessionEvent;
    current = { summary: { ...summary(id), updatedAt: 400 }, events: [...current.events, laterTail] };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    const result = await runtime.store.readSession(id);
    expect(errors).toEqual([]);
    expect(result.events.map(event => event.eventId)).toEqual([
      'user:user-first',
      'assistant:assistant-first',
      'user:user-late',
      'user:user-second',
      'assistant:assistant-second',
      'assistant:assistant-third'
    ]);
    expect(result.events.map(event => event.eventSeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.manifest?.captureState).toBe('partial');
  });

  it('retains local bytes before publication, rebuilds search/static projections, and repairs a tampered same-size site asset', async () => {
    const archiveRoot = await tempArchiveRoot();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const id = 'session-runtime-asset';
    const snapshot: CurrentSessionArchiveSnapshot = {
      summary: { ...summary(id), projectId: '11111111-1111-4111-8111-111111111111' },
      threadIds: ['thread-one'],
      quiltIds: ['quilt-one'],
      events: [
        user(1, 'hello durable archive', [{ id: 'image-a.png', mimeType: 'image/png', bytes: bytes.byteLength, width: 2, height: 3 }]),
        assistant(2, 'retained locally', true)
      ]
    };
    const diagnostics: string[] = [];
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor(snapshot, new Map([['image-a.png', bytes]])),
      now: () => 500,
      onDiagnostic: message => diagnostics.push(message)
    });

    expect(await runtime.start()).toBe(1);
    await runtime.drain();
    const archived = await runtime.store.readSession(id);
    expect(archived.events).toHaveLength(2);
    expect(archived.events[0]!.assets[0]).toMatchObject({ captureState: 'retained', kind: 'image' });
    const blob = archived.events[0]!.assets[0]!.blob!;
    expect((await runtime.store.blobs.inspect(blob)).state).toBe('present');

    const derived = await runtime.rebuildDerived();
    expect(derived.index.documents).toBeGreaterThanOrEqual(4);
    expect(diagnostics.some(message => message.includes('derived rebuild headers ready 1 session(s) rss='))).toBe(true);
    expect(diagnostics.some(message => message.includes('derived rebuild HTML published bytes=') && message.includes('rss='))).toBe(true);
    expect((await runtime.search('durable archive')).map(hit => hit.document.kind)).toContain('event');
    const generated = await generatedStaticFiles(derived.staticSite.indexPath);
    expect(generated.html).not.toContain('hello durable archive');
    expect(generated.html).toContain('#chat-0/c/conv-current-1234');
    expect(generated.search).toContain('hello durable archive');
    expect(generated.chunks).toHaveLength(1);
    expect(await fs.readFile(generated.chunks[0]!, 'utf8')).toContain(`assets/${blob.sha256}.png`);
    const siteAsset = path.join(derived.staticSite.siteRoot, 'assets', `${blob.sha256}.png`);
    expect([...await fs.readFile(siteAsset)]).toEqual([...bytes]);

    await fs.writeFile(siteAsset, new Uint8Array([9, 9, 9, 9, 9, 9]));
    await runtime.rebuildDerived();
    expect([...await fs.readFile(siteAsset)]).toEqual([...bytes]);
    expect(runtime.staticSiteTarget().indexPath).toBe(path.join(archiveRoot, 'site', 'index.html'));
  });

  it('publishes retained native attachments by send time and sanitized original filename', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-named-attachments';
    const firstBytes = new TextEncoder().encode('first jpeg-ish attachment');
    const secondBytes = new TextEncoder().encode('second jpeg-ish attachment');
    const firstAsset: AssetRef = { id: 'first.bin', mimeType: 'image/jpeg', bytes: firstBytes.byteLength };
    const secondAsset: AssetRef = { id: 'second.bin', mimeType: 'image/jpeg', bytes: secondBytes.byteLength };
    const at = Date.parse('2026-10-05T17:03:31.123Z');
    const event: SessionEvent = {
      seq: 1, time: at, source: 'app', kind: 'user_message', messageId: 'attachment-user',
      message: { text: 'two files', chars: 9, truncated: false },
      attachments: [
        { id: 'attachment-one', name: 'Untitled.jpg', size: firstBytes.byteLength, mimeType: 'image/jpeg' },
        { id: 'attachment-two', name: 'Untitled.jpg', size: secondBytes.byteLength, mimeType: 'image/jpeg' }
      ],
      archivedAttachments: [
        { attachmentId: 'attachment-one', asset: firstAsset },
        { attachmentId: 'attachment-two', asset: secondAsset }
      ]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id), events: [event] }, new Map([
        [firstAsset.id, firstBytes], [secondAsset.id, secondBytes]
      ]))
    });

    await runtime.start();
    await runtime.drain();
    const archived = await runtime.store.readSession(id);
    expect(archived.events[0]!.assets).toHaveLength(2);
    expect(archived.events[0]!.assets.map(asset => asset.fileName)).toEqual(['Untitled.jpg', 'Untitled.jpg']);
    await runtime.rebuildDerived();
    const names = (await fs.readdir(path.join(archiveRoot, 'site', 'attachments'))).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('2026-10-05T17-03-31.123Z__Untitled.jpg');
    expect(names[1]).toMatch(/^2026-10-05T17-03-31\.123Z__Untitled__[a-f0-9]{8}\.jpg$/);
    const generated = await generatedStaticFiles(runtime.staticSiteTarget().indexPath);
    const chunk = await fs.readFile(generated.chunks[0]!, 'utf8');
    expect(chunk).toContain('attachments/2026-10-05T17-03-31.123Z__Untitled.jpg');
    expect(chunk).toContain('Untitled.jpg');
  });

  it('shows what the user wrote, not the provider catch-up wrapper that was sent', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-authored-text';
    const event: SessionEvent = {
      seq: 1, time: Date.parse('2026-10-06T00:17:43.381Z'), source: 'app', kind: 'user_message', messageId: 'switched-user',
      message: { text: '[[PARADIGMEVE_CONTEXT:120]] CATCH-UP-WRAPPER\nNow on ChatGPT', chars: 60, truncated: false },
      authoredText: 'Now on ChatGPT'
    };
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', source: sourceFor({ summary: summary(id), events: [event] }) });
    await runtime.start();
    await runtime.drain();
    await runtime.rebuildDerived();
    const generated = await generatedStaticFiles(runtime.staticSiteTarget().indexPath);
    const chunk = await fs.readFile(generated.chunks[0]!, 'utf8');
    expect(chunk).toContain('Now on ChatGPT');
    expect(chunk).not.toContain('CATCH-UP-WRAPPER');
  });

  it('keeps heavy tool output out of the shell/search corpus and writes it only to the selected-chat shard', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-heavy-static-chunk';
    const transcriptNeedle = 'violet marmalade phrase only in the user transcript';
    const toolMarker = `TOOL-ONLY-${'x'.repeat(250_000)}`;
    const tool: SessionEvent = {
      seq: 2,
      time: 102,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-heavy-static',
        tool: 'exec_command',
        attribution: 'request_id',
        requestId: 'request-heavy-static',
        conversationId: 'conv-current-1234',
        attributionMethod: 'request_id',
        args: { text: '{}', chars: 2, truncated: false },
        result: { text: toolMarker, chars: toolMarker.length, truncated: false },
        outcome: 'ok',
        durationMs: 1,
        summary: { title: 'Large tool evidence', tone: 'neutral', kind: 'run' }
      }
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id, 'Heavy output chat'), events: [user(1, transcriptNeedle), tool] })
    });
    await runtime.start();
    await runtime.drain();

    const derived = await runtime.rebuildDerived();
    const generated = await generatedStaticFiles(derived.staticSite.indexPath);
    const chunk = await fs.readFile(generated.chunks[0]!, 'utf8');
    expect(generated.html).not.toContain(transcriptNeedle);
    expect(generated.html).not.toContain('TOOL-ONLY-');
    expect(generated.search).toContain(transcriptNeedle);
    expect(generated.search).not.toContain('TOOL-ONLY-');
    expect(chunk).toContain('TOOL-ONLY-');
    expect(Buffer.byteLength(generated.html, 'utf8')).toBeLessThan(Buffer.byteLength(chunk, 'utf8'));
  });

  it('splits a huge tool-heavy chat into bounded lazy segments instead of one giant browser payload', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-huge-static-segments';
    const transcriptNeedle = 'authored phrase still searchable across a huge tool-heavy chat';
    const tools: SessionEvent[] = Array.from({ length: 32 }, (_, index) => {
      const marker = `HUGE-TOOL-${String(index).padStart(2, '0')}-`;
      const result = marker + 'x'.repeat(160_000);
      return {
        seq: index + 2,
        time: 102 + index,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: `call-huge-static-${index}`,
          tool: 'exec_command',
          attribution: 'request_id',
          requestId: `request-huge-static-${index}`,
          conversationId: 'conv-current-1234',
          attributionMethod: 'request_id',
          args: { text: '{}', chars: 2, truncated: false },
          result: { text: result, chars: result.length, truncated: false },
          outcome: 'ok',
          durationMs: 1,
          summary: { title: `Huge tool evidence ${index}`, tone: 'neutral', kind: 'run' }
        }
      };
    });
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id, 'Huge tool-heavy chat'), events: [user(1, transcriptNeedle), ...tools] })
    });
    await runtime.start();
    await runtime.drain();

    const derived = await runtime.rebuildDerived();
    const generated = await generatedStaticFiles(derived.staticSite.indexPath);
    const sizes = await Promise.all(generated.chunks.map(async chunk => (await fs.stat(chunk)).size));
    const combined = sizes.reduce((sum, size) => sum + size, 0);
    expect(generated.chunks.length).toBeGreaterThan(8);
    expect(Math.max(...sizes)).toBeLessThan(800_000);
    expect(combined).toBeGreaterThan(4_000_000);
    expect(generated.html).toContain(`data-chat-segments="${generated.chunks.length}"`);
    expect(generated.html).not.toContain('HUGE-TOOL-');
    expect(generated.search).toContain(transcriptNeedle);
    expect(generated.search).not.toContain('HUGE-TOOL-');
    expect(await fs.readFile(generated.chunks[0]!, 'utf8')).toContain('HUGE-TOOL-00-');
    expect(await fs.readFile(generated.chunks.at(-1)!, 'utf8')).toContain('HUGE-TOOL-31-');
  });

  it('publishes generation-scoped chunks atomically, cleans stale generations, and preserves the old shell on shard failure', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-static-generation-swap';
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id), events: [user(1, 'generation-safe transcript')] })
    });
    await runtime.start();
    await runtime.drain();

    const first = await runtime.rebuildDerived();
    const firstGenerated = await generatedStaticFiles(first.staticSite.indexPath);
    const dataRoot = path.join(first.staticSite.siteRoot, 'data');
    expect(await fs.readdir(dataRoot)).toEqual([firstGenerated.generation]);

    await runtime.rebuildDerived();
    const secondGenerated = await generatedStaticFiles(first.staticSite.indexPath);
    expect(secondGenerated.generation).not.toBe(firstGenerated.generation);
    expect(new Set(await fs.readdir(dataRoot))).toEqual(new Set([firstGenerated.generation, secondGenerated.generation]));

    await runtime.rebuildDerived();
    const thirdGenerated = await generatedStaticFiles(first.staticSite.indexPath);
    expect(thirdGenerated.generation).not.toBe(secondGenerated.generation);
    expect(new Set(await fs.readdir(dataRoot))).toEqual(new Set([secondGenerated.generation, thirdGenerated.generation]));
    const publishedBeforeFailure = await fs.readFile(first.staticSite.indexPath, 'utf8');

    const scan = vi.spyOn(runtime.store, 'scanSessionEvents').mockRejectedValueOnce(new Error('synthetic static shard failure'));
    await expect(runtime.rebuildDerived()).rejects.toThrow('synthetic static shard failure');
    scan.mockRestore();
    expect(await fs.readFile(first.staticSite.indexPath, 'utf8')).toBe(publishedBeforeFailure);
    expect(new Set(await fs.readdir(dataRoot))).toEqual(new Set([secondGenerated.generation, thirdGenerated.generation]));
  });

  it('retains the generation referenced by the published shell instead of a newer crash orphan', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-static-crash-orphan';
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id), events: [user(1, 'published generation survives an orphan')] })
    });
    await runtime.start();
    await runtime.drain();

    const first = await runtime.rebuildDerived();
    const firstGenerated = await generatedStaticFiles(first.staticSite.indexPath);
    const dataRoot = path.join(first.staticSite.siteRoot, 'data');
    const firstShell = await fs.readFile(first.staticSite.indexPath, 'utf8');
    expect(firstShell).toContain(`data-archive-generation="${firstGenerated.generation}"`);
    // Simulate the already-installed first lazy-shell candidate, which named its generation only
    // through the local search.js path and therefore needs the bounded compatibility scan.
    await fs.writeFile(first.staticSite.indexPath, firstShell.replace(` data-archive-generation="${firstGenerated.generation}"`, ''));
    const orphanGeneration = `g-${'f'.repeat(32)}`;
    const orphanRoot = path.join(dataRoot, orphanGeneration);
    await fs.mkdir(orphanRoot);
    await fs.writeFile(path.join(orphanRoot, 'search.js'), 'orphan search');
    await fs.writeFile(path.join(orphanRoot, 'chat-99-segment-0.js'), 'orphan segment');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(orphanRoot, future, future);

    await runtime.rebuildDerived();
    const secondGenerated = await generatedStaticFiles(first.staticSite.indexPath);
    expect(secondGenerated.generation).not.toBe(firstGenerated.generation);
    expect(new Set(await fs.readdir(dataRoot))).toEqual(new Set([firstGenerated.generation, secondGenerated.generation]));
    await expect(fs.stat(orphanRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a pre-existing static-site symlink before writing derived HTML outside the archive', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-site-symlink';
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id), events: [user(1, 'stay local')] })
    });
    await runtime.start();
    await runtime.drain();

    const outside = path.join(path.dirname(archiveRoot), 'outside-site');
    await fs.mkdir(outside);
    await fs.symlink(outside, runtime.staticSiteTarget().siteRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runtime.rebuildDerived()).rejects.toThrow('ARCHIVE_DIRECTORY_UNSAFE');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a pre-existing static data symlink before writing lazy chunks outside the archive', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-data-symlink';
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({ summary: summary(id), events: [user(1, 'stay inside archive data')] })
    });
    await runtime.start();
    await runtime.drain();

    const siteRoot = runtime.staticSiteTarget().siteRoot;
    await fs.mkdir(siteRoot, { recursive: true });
    const outside = path.join(path.dirname(archiveRoot), 'outside-static-data');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(siteRoot, 'data'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runtime.rebuildDerived()).rejects.toThrow('ARCHIVE_DIRECTORY_UNSAFE');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses a pre-existing static asset symlink before copying retained bytes outside the archive', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-assets-symlink';
    const bytes = new Uint8Array([7, 8, 9]);
    const snapshot: CurrentSessionArchiveSnapshot = {
      summary: summary(id),
      events: [user(1, 'keep asset local', [{ id: 'local.png', mimeType: 'image/png', bytes: bytes.byteLength }])]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor(snapshot, new Map([['local.png', bytes]]))
    });
    await runtime.start();
    await runtime.drain();

    const siteRoot = runtime.staticSiteTarget().siteRoot;
    await runtime.rebuildDerived();
    const publishedBeforeFailure = await fs.readFile(runtime.staticSiteTarget().indexPath, 'utf8');
    const outside = path.join(path.dirname(archiveRoot), 'outside-assets');
    await fs.rm(path.join(siteRoot, 'assets'), { recursive: true, force: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(siteRoot, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(runtime.rebuildDerived()).rejects.toThrow('ARCHIVE_DIRECTORY_UNSAFE');
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(runtime.staticSiteTarget().indexPath, 'utf8')).toBe(publishedBeforeFailure);
    expect((await fs.readdir(siteRoot)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('runs one dirty follow-up when a newer whole-session snapshot arrives during reconcile', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-dirty-follow-up';
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { resolveFirst = resolve; });
    let calls = 0;
    const first: CurrentSessionArchiveSnapshot = { summary: summary(id, 'first'), events: [user(1, 'one')] };
    const second: CurrentSessionArchiveSnapshot = { summary: { ...summary(id, 'second'), updatedAt: 300 }, events: [user(1, 'one'), assistant(2, 'two', true)] };
    const source: ArchiveRuntimeSource = {
      listSessionIds: async () => [],
      readSession: async () => {
        calls += 1;
        if (calls === 1) { await firstGate; return first; }
        return second;
      },
      readAsset: async () => null
    };
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', source });

    runtime.queueSessionReconcile(id);
    await vi.waitFor(() => expect(calls).toBe(1));
    runtime.queueSessionReconcile(id);
    resolveFirst();
    await runtime.drain();

    expect(calls).toBe(2);
    const archived = await runtime.store.readSession(id);
    expect(archived.manifest?.title).toBe('second');
    expect(archived.events.map(event => event.kind)).toEqual(['user_message', 'assistant_message']);
    expect(runtime.status().lastError).toBeNull();
  });

  it('holds new reconciles until a derived archive scan releases its Windows read handles', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-derived-writer-gate';
    let sourceReads = 0;
    const snapshot: CurrentSessionArchiveSnapshot = {
      summary: summary(id, 'derived writer gate'),
      events: [user(1, 'one stable row')]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => {
          sourceReads += 1;
          return snapshot;
        },
        readAsset: async () => null
      }
    });
    await runtime.start();
    await runtime.drain();
    expect(sourceReads).toBe(1);

    let releaseDerived!: () => void;
    const derivedGate = new Promise<void>(resolve => { releaseDerived = resolve; });
    let reachedDerived!: () => void;
    const reached = new Promise<void>(resolve => { reachedDerived = resolve; });
    const rebuild = runtime.index.rebuild.bind(runtime.index);
    const indexSpy = vi.spyOn(runtime.index, 'rebuild').mockImplementation(async documents => {
      reachedDerived();
      await derivedGate;
      return rebuild(documents);
    });
    try {
      const derived = runtime.rebuildDerived();
      await reached;
      runtime.queueSessionReconcile(id);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(sourceReads).toBe(1);

      releaseDerived();
      await derived;
      await runtime.drain();
      expect(sourceReads).toBe(2);
      expect(runtime.status().lastError).toBeNull();
    } finally {
      releaseDerived();
      indexSpy.mockRestore();
    }
  });

  it('bounds historical seed reconciliation instead of opening every retained session at once', async () => {
    const archiveRoot = await tempArchiveRoot();
    const ids = Array.from({ length: 6 }, (_, index) => `session-${index + 1}`);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      maxConcurrentReconciles: 2,
      source: {
        listSessionIds: async () => ids,
        readSession: async (id) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate;
          active -= 1;
          return { summary: summary(id), events: [user(1, id)] };
        },
        readAsset: async () => null
      }
    });

    expect(await runtime.start()).toBe(ids.length);
    await vi.waitFor(() => expect(active).toBe(2));
    expect(maxActive).toBe(2);
    release();
    await runtime.drain();
    expect(maxActive).toBe(2);
    for (const id of ids) expect((await runtime.store.readSession(id)).events).toHaveLength(1);
  });

  it('defers provisional canonical rows so streaming-to-final reconciliation only appends immutable archive evidence', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-stable-prefix';
    let current: CurrentSessionArchiveSnapshot = {
      summary: summary(id),
      events: [user(1, 'request'), assistant(2, 'partial answer', false)]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => current,
        readAsset: async () => null
      }
    });

    await runtime.start();
    await runtime.drain();
    let archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.kind)).toEqual(['user_message']);
    expect(archived.manifest?.captureState).toBe('partial');

    current = {
      summary: { ...summary(id), updatedAt: 300 },
      events: [user(1, 'request'), assistant(3, 'final answer', true)]
    };
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.kind)).toEqual(['user_message', 'assistant_message']);
    expect(archived.events[1]!.payload).toMatchObject({ text: 'final answer', final: true });
    expect(runtime.status().lastError).toBeNull();

    current = {
      summary: { ...summary(id), updatedAt: 400 },
      events: [user(1, 'request'), assistant(4, 'final answer', true, { model: 'later-metadata' })]
    };
    runtime.queueSessionReconcile(id);
    await runtime.drain();
    archived = await runtime.store.readSession(id);
    expect(archived.events).toHaveLength(2);
    expect(archived.events[1]!.provider?.model).toBeUndefined();
    expect(archived.manifest?.captureState).toBe('partial');
    expect(runtime.status().lastError).toBeNull();
  });

  it('preserves a historical interrupted assistant row and later stable evidence after a later user boundary', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-interrupted-history';
    const laterUser: SessionEvent = {
      seq: 3,
      time: 103,
      source: 'extension',
      kind: 'user_message',
      messageId: 'user-message-2',
      message: { text: 'continue anyway', chars: 15, truncated: false }
    };
    const pageTool: SessionEvent = {
      seq: 4,
      time: 104,
      source: 'extension',
      kind: 'page_tool',
      messageId: 'page-tool-1',
      label: 'Inspected archive'
    };
    let current: CurrentSessionArchiveSnapshot = {
      summary: summary(id),
      events: [
        user(1, 'request'),
        assistant(2, 'interrupted answer', false),
        laterUser,
        pageTool,
        assistant(5, 'later final answer', true, { messageId: 'assistant-message-2' })
      ]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => current,
        readAsset: async () => null
      }
    });

    await runtime.start();
    await runtime.drain();

    let archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.kind)).toEqual([
      'user_message',
      'assistant_message',
      'user_message',
      'page_tool',
      'assistant_message'
    ]);
    expect(archived.events[1]!.payload).toMatchObject({
      text: 'interrupted answer',
      state: 'streaming',
      final: false
    });
    expect(archived.events[4]!.payload).toMatchObject({ text: 'later final answer', final: true });
    expect(archived.manifest?.captureState).toBe('partial');

    current = {
      summary: { ...summary(id), updatedAt: 400 },
      events: [
        user(1, 'request'),
        assistant(6, 'source later finalized this row', true),
        laterUser,
        pageTool,
        assistant(5, 'later final answer', true, { messageId: 'assistant-message-2' })
      ]
    };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    archived = await runtime.store.readSession(id);
    expect(archived.events).toHaveLength(5);
    expect(archived.events[1]!.payload).toMatchObject({
      text: 'interrupted answer',
      state: 'streaming',
      final: false
    });
    expect(archived.manifest?.captureState).toBe('partial');
    expect(runtime.status().lastError).toBeNull();
  });

  it('continues past a historical interruption but still defers a later live assistant frontier', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-interrupted-then-streaming';
    const laterUser: SessionEvent = {
      seq: 3,
      time: 103,
      source: 'extension',
      kind: 'user_message',
      messageId: 'user-message-2',
      message: { text: 'new turn', chars: 8, truncated: false }
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: sourceFor({
        summary: summary(id),
        events: [
          user(1, 'request'),
          assistant(2, 'old interrupted answer', false),
          laterUser,
          assistant(4, 'new live answer', false, { messageId: 'assistant-message-2' })
        ]
      })
    });

    await runtime.start();
    await runtime.drain();

    const archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.kind)).toEqual([
      'user_message',
      'assistant_message',
      'user_message'
    ]);
    expect(archived.events[1]!.payload).toMatchObject({ text: 'old interrupted answer', final: false });
    expect(JSON.stringify(archived.events)).not.toContain('new live answer');
    expect(archived.manifest?.captureState).toBe('partial');
  });

  it('preserves terminal provider-only and missing native-image states without persisting provider URLs', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-native-states';
    const providerUrl = 'https://files.provider.invalid/signed-secret';
    const pending = {
      seq: 2,
      time: 102,
      source: 'extension',
      kind: 'native_image',
      messageId: 'native-message-1',
      providerAssetId: 'provider-asset-1',
      providerRole: 'assistant',
      providerStatus: 'in_progress',
      previewStatus: 'pending',
      providerUrl
    } as unknown as SessionEvent;
    let current: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [user(1, 'make image'), pending] };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => current,
        readAsset: async () => null
      }
    });

    await runtime.start();
    await runtime.drain();
    expect((await runtime.store.readSession(id)).events).toHaveLength(1);

    const providerOnly = {
      seq: 3,
      time: 102,
      source: 'extension',
      kind: 'native_image',
      messageId: 'native-message-1',
      providerAssetId: 'provider-asset-1',
      providerRole: 'assistant',
      providerStatus: 'finished_successfully',
      previewStatus: 'unavailable',
      previewError: 'oversized',
      providerUrl
    } as unknown as SessionEvent;
    const missing = {
      seq: 4,
      time: 104,
      source: 'extension',
      kind: 'native_image',
      messageId: 'native-message-2',
      providerAssetId: 'provider-asset-2',
      providerRole: 'assistant',
      providerStatus: 'finished_successfully',
      previewStatus: 'available',
      asset: { id: 'missing.webp', mimeType: 'image/webp', bytes: 5 },
      providerUrl
    } as unknown as SessionEvent;
    current = { summary: { ...summary(id), updatedAt: 400 }, events: [user(1, 'make image'), providerOnly, missing] };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    const archived = await runtime.store.readSession(id);
    expect(archived.events[1]!.assets[0]).toMatchObject({ captureState: 'provider-only', providerAssetId: 'provider-asset-1' });
    expect(archived.events[2]!.assets[0]).toMatchObject({ captureState: 'missing', providerAssetId: 'provider-asset-2' });
    const jsonl = await fs.readFile(path.join(archiveRoot, 'sessions', id, 'events.jsonl'), 'utf8');
    expect(jsonl).not.toContain(providerUrl);

    const derived = await runtime.rebuildDerived();
    const generated = await generatedStaticFiles(derived.staticSite.indexPath);
    const chunk = await fs.readFile(generated.chunks[0]!, 'utf8');
    expect(generated.html).not.toContain('Provider-only content was not captured locally.');
    expect(chunk).toContain('Provider-only content was not captured locally.');
    expect(chunk).toContain('Local session asset bytes are missing or do not match recorded size.');
    expect(generated.html).not.toContain(providerUrl);
    expect(generated.search).not.toContain(providerUrl);
    expect(chunk).not.toContain(providerUrl);
  });

  it('defers recoverable provider-only native images until later local pixels can be retained', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-native-late-capture';
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
    let current: CurrentSessionArchiveSnapshot = {
      summary: summary(id),
      events: [user(1, 'make image'), {
        seq: 2,
        time: 102,
        source: 'extension',
        kind: 'native_image',
        messageId: 'native-message-late',
        providerAssetId: 'provider-asset-late',
        providerRole: 'assistant',
        providerStatus: 'finished_successfully',
        previewStatus: 'unavailable',
        previewError: 'ambiguous'
      }]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => [id],
        readSession: async () => current,
        readAsset: async (_sessionId, assetId) => assetId === 'late.webp' ? bytes : null
      }
    });

    await runtime.start();
    await runtime.drain();
    let archived = await runtime.store.readSession(id);
    expect(archived.events.map(event => event.kind)).toEqual(['user_message']);
    expect(archived.manifest?.captureState).toBe('partial');

    current = {
      summary: { ...summary(id), updatedAt: 300 },
      events: [user(1, 'make image'), {
        seq: 3,
        time: 102,
        source: 'extension',
        kind: 'native_image',
        messageId: 'native-message-late',
        providerAssetId: 'provider-asset-late',
        providerRole: 'assistant',
        providerStatus: 'finished_successfully',
        previewStatus: 'available',
        previewWidth: 2,
        previewHeight: 1,
        asset: { id: 'late.webp', mimeType: 'image/webp', bytes: bytes.byteLength, width: 2, height: 1 }
      }]
    };
    runtime.queueSessionReconcile(id);
    await runtime.drain();

    archived = await runtime.store.readSession(id);
    expect(archived.events).toHaveLength(2);
    expect(archived.events[1]!.assets[0]).toMatchObject({
      captureState: 'retained',
      kind: 'generated-image',
      providerAssetId: 'provider-asset-late'
    });
    expect(archived.manifest?.captureState).toBe('complete');
  });

  it('retires an explicitly deleted session from canonical and derived archive views', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-explicit-delete';
    let current: CurrentSessionArchiveSnapshot | null = {
      summary: summary(id, 'Delete me from archive'),
      events: [user(1, 'private old chat')]
    };
    const runtime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'runtime-test',
      source: {
        listSessionIds: async () => current ? [id] : [],
        readSession: async () => current,
        readAsset: async () => null
      }
    });

    await runtime.start();
    await runtime.drain();
    await runtime.rebuildDerived();
    expect((await runtime.store.readSession(id)).state).not.toBe('missing');
    expect(await fs.readFile(runtime.staticSiteTarget().indexPath, 'utf8')).toContain('Delete me from archive');

    current = null;
    await runtime.retireSession(id);

    expect((await runtime.store.readSession(id)).state).toBe('missing');
    expect(await runtime.store.listSessionIds()).not.toContain(id);
    const html = await fs.readFile(runtime.staticSiteTarget().indexPath, 'utf8');
    expect(html).not.toContain('Delete me from archive');
    expect(html).not.toContain('valuu old chat');
  });

  it('subscribes before seeding, isolates reconcile failures, reports status, and unsubscribes on dispose', async () => {
    const archiveRoot = await tempArchiveRoot();
    const id = 'session-subscribe-seed';
    let listener: ((sessionId: string) => void) | null = null;
    let fail = true;
    const unsubscribe = vi.fn();
    const errors: string[] = [];
    const snapshot: CurrentSessionArchiveSnapshot = { summary: summary(id), events: [user(1, 'recovered')] };
    const source: ArchiveRuntimeSource = {
      subscribeCommitted: next => { listener = next; return unsubscribe; },
      listSessionIds: async () => {
        expect(listener).not.toBeNull();
        listener!(id);
        return [id];
      },
      readSession: async () => {
        if (fail) { fail = false; throw new Error('source read failed'); }
        return snapshot;
      },
      readAsset: async () => null
    };
    const runtime = new ArchiveRuntime({ archiveRoot, writerVersion: 'runtime-test', source, onError: error => errors.push(error.message) });

    expect(await runtime.start()).toBe(1);
    await runtime.drain();
    expect(errors).toContain('source read failed');
    expect((await runtime.store.readSession(id)).events).toHaveLength(1);
    expect(runtime.status()).toMatchObject({ initialized: true, disposed: false, lastReconciledSessionId: id, lastError: null });

    await runtime.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.status().disposed).toBe(true);
  });
});
