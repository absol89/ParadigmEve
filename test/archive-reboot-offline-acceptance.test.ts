import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveRuntime, type ArchiveRuntimeSource, type CurrentSessionArchiveSnapshot } from '../src/main/archive/archive-runtime.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function summary(id: string): SessionSummary {
  return {
    id,
    title: 'Offline native image recovery',
    conversationId: 'conversation-offline-current',
    chatIds: ['conversation-offline-current'],
    startedAt: 1_000,
    updatedAt: 1_400,
    endedAt: null,
    events: 4,
    userMessages: 1,
    toolCalls: 0,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 20,
    contextTokens: 20,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: 'completed',
    agents: [],
    origin: null
  };
}

function providerUrlEvent(event: SessionEvent, providerUrl: string): SessionEvent {
  return { ...event, providerUrl } as unknown as SessionEvent;
}

async function generatedChunk(indexPath: string): Promise<{ html: string; search: string; chunk: string }> {
  const html = await fs.readFile(indexPath, 'utf8');
  const match = /data\/(g-[a-f0-9]{32})\/search\.js/u.exec(html);
  if (!match) throw new Error('static archive generation path missing');
  const root = path.join(path.dirname(indexPath), 'data', match[1]!);
  return {
    html,
    search: await fs.readFile(path.join(root, 'search.js'), 'utf8'),
    chunk: await fs.readFile(path.join(root, 'chat-0-segment-0.js'), 'utf8')
  };
}

describe('archive reboot/offline acceptance', () => {
  it('rebuilds retained and provider-only native images after runtime recreation without provider access', async () => {
    // The archive refuses a non-canonical parent; CI temp dirs are not canonical (RUNNER~1, /var -> /private/var).
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eve-archive-reboot-offline-')));
    tempRoots.push(parent);
    const archiveRoot = path.join(parent, 'archive');
    const sessionId = 'session-reboot-offline-native';
    const localAssetId = 'native-preview.webp';
    const providerUrl = 'https://provider.invalid/temporary/signed-image-secret';
    const localBytes = new Uint8Array([82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]);
    const expectedHash = createHash('sha256').update(localBytes).digest('hex');
    const transcriptText = 'The generated image is retained locally for offline recovery.';

    const events: SessionEvent[] = [
      {
        seq: 1,
        time: 1_100,
        source: 'app',
        kind: 'user_message',
        messageId: 'user-native-request',
        message: { text: 'Generate an image and keep it available after reboot.', chars: 52, truncated: false }
      },
      {
        seq: 2,
        time: 1_200,
        source: 'extension',
        kind: 'assistant_message',
        messageId: 'assistant-native-answer',
        message: { text: transcriptText, chars: transcriptText.length, truncated: false },
        state: 'final',
        final: true
      },
      providerUrlEvent({
        seq: 3,
        time: 1_300,
        source: 'extension',
        kind: 'native_image',
        messageId: 'native-message-retained',
        providerAssetId: 'provider-asset-retained',
        providerRole: 'assistant',
        providerStatus: 'finished_successfully',
        previewStatus: 'available',
        previewWidth: 2,
        previewHeight: 2,
        asset: { id: localAssetId, mimeType: 'image/webp', bytes: localBytes.byteLength, width: 2, height: 2 }
      }, providerUrl),
      providerUrlEvent({
        seq: 4,
        time: 1_400,
        source: 'extension',
        kind: 'native_image',
        messageId: 'native-message-provider-only',
        providerAssetId: 'provider-asset-metadata-only',
        providerRole: 'assistant',
        providerStatus: 'finished_successfully',
        previewStatus: 'unavailable',
        previewError: 'oversized'
      }, providerUrl)
    ];
    const snapshot: CurrentSessionArchiveSnapshot = { summary: summary(sessionId), events };
    const firstSource: ArchiveRuntimeSource = {
      listSessionIds: vi.fn(async () => [sessionId]),
      readSession: vi.fn(async id => id === sessionId ? snapshot : null),
      readAsset: vi.fn(async (_id, assetId) => assetId === localAssetId ? localBytes : null)
    };
    const firstRuntime = new ArchiveRuntime({ archiveRoot, writerVersion: 'acceptance-first', source: firstSource, now: () => 2_000 });

    expect(await firstRuntime.start()).toBe(1);
    await firstRuntime.drain();
    const beforeReboot = await firstRuntime.store.readSession(sessionId);
    expect(beforeReboot.state).toBe('partial');
    expect(beforeReboot.events.map(event => event.kind)).toEqual([
      'user_message', 'assistant_message', 'native_image', 'native_image'
    ]);
    expect(beforeReboot.events[1]!.payload).toMatchObject({ text: transcriptText, final: true });

    const retainedBefore = beforeReboot.events[2]!.assets[0]!;
    expect(retainedBefore).toMatchObject({
      kind: 'generated-image',
      captureState: 'retained',
      providerAssetId: 'provider-asset-retained',
      blob: { sha256: expectedHash, byteLength: localBytes.byteLength, mimeType: 'image/webp' }
    });
    const providerOnlyBefore = beforeReboot.events[3]!.assets[0]!;
    expect(providerOnlyBefore).toMatchObject({
      kind: 'generated-image',
      captureState: 'provider-only',
      providerAssetId: 'provider-asset-metadata-only'
    });
    expect(providerOnlyBefore.blob).toBeUndefined();

    const retainedInspection = await firstRuntime.store.blobs.inspect(retainedBefore.blob!);
    expect(retainedInspection.state).toBe('present');
    if (retainedInspection.state !== 'present') throw new Error('retained native image blob is unavailable before reboot');
    expect(new Uint8Array(await fs.readFile(retainedInspection.path))).toEqual(localBytes);

    const firstDerived = await firstRuntime.rebuildDerived();
    const firstStatic = await generatedChunk(firstDerived.staticSite.indexPath);
    const relativeAsset = `assets/${expectedHash}.webp`;
    expect(firstStatic.html).not.toContain(transcriptText);
    expect(firstStatic.search).toContain(transcriptText.toLocaleLowerCase());
    expect(firstStatic.chunk).toContain(relativeAsset);
    expect(firstStatic.chunk).toContain('provider-only');
    expect(firstStatic.chunk).toContain('Provider-only content was not captured locally.');
    expect(firstStatic.html).not.toContain(providerUrl);
    expect(firstStatic.search).not.toContain(providerUrl);
    expect(firstStatic.chunk).not.toContain(providerUrl);
    expect(await fs.readFile(path.join(firstDerived.staticSite.siteRoot, ...relativeAsset.split('/')))).toEqual(Buffer.from(localBytes));
    expect(await fs.readFile(path.join(archiveRoot, 'sessions', sessionId, 'events.jsonl'), 'utf8')).not.toContain(providerUrl);

    await firstRuntime.dispose();

    const offlineSource: ArchiveRuntimeSource = {
      listSessionIds: vi.fn(async () => { throw new Error('offline reboot must not enumerate live/provider sessions'); }),
      readSession: vi.fn(async () => { throw new Error('offline reboot must not read live/provider session state'); }),
      readAsset: vi.fn(async () => { throw new Error('offline reboot must not fetch provider/current-session bytes'); })
    };
    const rebootedRuntime = new ArchiveRuntime({ archiveRoot, writerVersion: 'acceptance-reboot', source: offlineSource, now: () => 3_000 });
    await rebootedRuntime.initialize();

    const afterReboot = await rebootedRuntime.store.readSession(sessionId);
    expect(afterReboot.state).toBe('partial');
    expect(afterReboot.events[1]!.payload).toMatchObject({ text: transcriptText, final: true });
    const retainedAfter = afterReboot.events[2]!.assets[0]!;
    const providerOnlyAfter = afterReboot.events[3]!.assets[0]!;
    expect(retainedAfter.captureState).toBe('retained');
    expect(retainedAfter.blob?.sha256).toBe(expectedHash);
    expect(providerOnlyAfter.captureState).toBe('provider-only');
    expect(providerOnlyAfter.blob).toBeUndefined();

    const rebootInspection = await rebootedRuntime.store.blobs.inspect(retainedAfter.blob!);
    expect(rebootInspection.state).toBe('present');
    if (rebootInspection.state !== 'present') throw new Error('retained native image blob did not survive runtime recreation');
    expect(createHash('sha256').update(await fs.readFile(rebootInspection.path)).digest('hex')).toBe(expectedHash);
    expect(new Uint8Array(await fs.readFile(rebootInspection.path))).toEqual(localBytes);

    const rebuilt = await rebootedRuntime.rebuildDerived();
    const rebootStatic = await generatedChunk(rebuilt.staticSite.indexPath);
    expect(rebootStatic.html).not.toContain(transcriptText);
    expect(rebootStatic.search).toContain(transcriptText.toLocaleLowerCase());
    expect(rebootStatic.chunk).toContain(relativeAsset);
    expect(rebootStatic.chunk).toContain('provider-only');
    expect(rebootStatic.chunk).toContain('Provider-only content was not captured locally.');
    expect(rebootStatic.html).not.toContain(providerUrl);
    expect(rebootStatic.search).not.toContain(providerUrl);
    expect(rebootStatic.chunk).not.toContain(providerUrl);
    expect(await fs.readFile(path.join(rebuilt.staticSite.siteRoot, ...relativeAsset.split('/')))).toEqual(Buffer.from(localBytes));

    expect(offlineSource.listSessionIds).not.toHaveBeenCalled();
    expect(offlineSource.readSession).not.toHaveBeenCalled();
    expect(offlineSource.readAsset).not.toHaveBeenCalled();
    await rebootedRuntime.dispose();
  });

  it('keeps uploaded attachment bytes and metadata through runtime recreation and a forced static rebuild', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'eve-archive-reboot-upload-')));
    tempRoots.push(parent);
    const archiveRoot = path.join(parent, 'archive');
    const sessionId = 'session-reboot-upload';
    const attachmentId = 'attachment-pdf';
    const assetId = 'upload-copy.pdf';
    const bytes = new TextEncoder().encode('%PDF-1.7\nretained upload across reboot\n%%EOF');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const at = Date.parse('2026-10-09T16:40:00.000Z');
    const snapshot: CurrentSessionArchiveSnapshot = {
      summary: { ...summary(sessionId), title: 'Uploaded attachment recovery', updatedAt: at },
      events: [{
        seq: 1,
        time: at,
        source: 'app',
        kind: 'user_message',
        messageId: 'user-with-upload',
        inputId: 'input-with-upload',
        message: { text: 'Keep this PDF in the archive.', chars: 29, truncated: false },
        attachments: [{ id: attachmentId, name: 'Dinner notes.pdf', size: bytes.byteLength, mimeType: 'application/pdf' }],
        archivedAttachments: [{ attachmentId, asset: { id: assetId, mimeType: 'application/pdf', bytes: bytes.byteLength } }]
      }]
    };
    const firstRuntime = new ArchiveRuntime({
      archiveRoot,
      writerVersion: 'acceptance-upload-first',
      source: {
        listSessionIds: async () => [sessionId],
        readSession: async id => id === sessionId ? snapshot : null,
        readAsset: async (_id, requested) => requested === assetId ? bytes : null
      }
    });

    await firstRuntime.start();
    await firstRuntime.drain();
    const archivedBefore = await firstRuntime.store.readSession(sessionId);
    expect(archivedBefore.events[0]!.assets[0]).toMatchObject({
      kind: 'file',
      captureState: 'retained',
      fileName: 'Dinner notes.pdf',
      blob: { sha256: expectedHash, byteLength: bytes.byteLength, mimeType: 'application/pdf' }
    });
    await firstRuntime.rebuildDerived();
    await firstRuntime.dispose();

    const offlineSource: ArchiveRuntimeSource = {
      listSessionIds: vi.fn(async () => { throw new Error('rebooted archive must use retained canonical evidence'); }),
      readSession: vi.fn(async () => { throw new Error('rebooted archive must not reread live sessions'); }),
      readAsset: vi.fn(async () => { throw new Error('rebooted archive must not reread staged attachments'); })
    };
    const rebootedRuntime = new ArchiveRuntime({ archiveRoot, writerVersion: 'acceptance-upload-reboot', source: offlineSource });
    await rebootedRuntime.initialize();

    const archivedAfter = await rebootedRuntime.store.readSession(sessionId);
    const retained = archivedAfter.events[0]!.assets[0]!;
    expect(retained).toMatchObject({
      kind: 'file',
      captureState: 'retained',
      fileName: 'Dinner notes.pdf',
      blob: { sha256: expectedHash, byteLength: bytes.byteLength, mimeType: 'application/pdf' }
    });
    const inspection = await rebootedRuntime.store.blobs.inspect(retained.blob!);
    expect(inspection.state).toBe('present');
    if (inspection.state !== 'present') throw new Error('retained upload blob missing after reboot');
    expect(new Uint8Array(await fs.readFile(inspection.path))).toEqual(bytes);

    const rebuilt = await rebootedRuntime.rebuildDerived();
    const staticFiles = await generatedChunk(rebuilt.staticSite.indexPath);
    expect(staticFiles.chunk).toContain('Dinner notes.pdf');
    expect(staticFiles.chunk).toContain('attachments/2026-10-09T16-40-00.000Z__Dinner%20notes.pdf');
    expect(await fs.readFile(path.join(rebuilt.staticSite.siteRoot, 'attachments', '2026-10-09T16-40-00.000Z__Dinner notes.pdf'))).toEqual(Buffer.from(bytes));
    expect(offlineSource.listSessionIds).not.toHaveBeenCalled();
    expect(offlineSource.readSession).not.toHaveBeenCalled();
    expect(offlineSource.readAsset).not.toHaveBeenCalled();
    await rebootedRuntime.dispose();
  });
});
