import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { appendEvent, createSession, getSession, initSessionStore, observeSessionModel, readEvents, resetSessionStoreForTests, upsertMessageEvent, upsertNativeImageEvent, writeAsset } from '../src/main/session/store.js';
import { recordDeliveredInput, recordedInputImage, recordedInputImageThumbnail } from '../src/main/session/input-history.js';
import type { InputEntry } from '../src/main/session/input.js';
import { chronological } from '../src/shared/chronology.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-input-history-')); initSessionStore(directory); });
afterEach(async () => { resetSessionStoreForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('does not republish an inherited finish task model as a new picker observation', async () => {
  const session = await createSession({ conversationId: 'continued-chat', title: 'Finish inheritance' });
  await observeSessionModel(session.id, 'continued-chat', '5.6', 100, 'xhigh');
  const entry: InputEntry = { id: 'checkpoint', sessionId: session.id, state: 'sent', text: 'Check result', mode: 'finish',
    dueAt: 0, createdAt: 0, owner: 'page', messageId: 'native-checkpoint', deliveredAt: 200,
    model: '6', reasoningEffort: 'pro', conversationId: 'continued-chat' };
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: '5.6', reasoningEffort: 'xhigh', observedAt: 100 });
  expect((await getSession(session.id))?.browserModelIntent).toBeUndefined();
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
});

it('serves real recorded tool PNG pixels and refuses unreferenced or invalid images', async () => {
  const session = await createSession({ title: 'Tool image' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/png');
  const broken = await writeAsset(session.id, Buffer.from('not image bytes'), 'image/png');
  const text = { text: '{}', chars: 2, truncated: false };
  await appendEvent(session.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
    callId: 'tool-image', tool: 'get_viewport_screenshot', requestId: null, conversationId: null,
    attribution: 'unattributed', attributionMethod: 'unattributed', args: text, result: text,
    outcome: 'ok', durationMs: 1, summary: { kind: 'other', title: 'Screenshot', tone: 'neutral' }, assets: [asset, broken]
  } });
  expect(await recordedInputImage(session.id, asset.id)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  expect(await recordedInputImage(session.id, broken.id)).toBeNull();
  const assetPath = path.join(directory, 'sessions', session.id, 'assets', asset.id);
  await fs.truncate(assetPath, 17 * 1024 * 1024);
  const readFile = vi.spyOn(fs, 'readFile');
  try {
    expect(await recordedInputImage(session.id, asset.id)).toBeNull();
    expect(readFile.mock.calls.some(args => String(args[0]) === assetPath)).toBe(false);
  } finally { readFile.mockRestore(); }
  await writeAsset(other.id, bytes, 'image/png');
  expect(await recordedInputImage(other.id, asset.id)).toBeNull();
});

it('derives a bounded local WebP thumbnail from a recorded image asset', async () => {
  const session = await createSession({ title: 'Pinned image preview' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#663399' } }).png().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/png');
  await upsertMessageEvent(session.id, { time: Date.now(), source: 'app', kind: 'user_message',
    messageId: 'thumbnail-source', message: { text: '', chars: 0, truncated: false }, assets: [asset] });

  const data = await recordedInputImageThumbnail(session.id, asset.id);
  expect(data).toMatch(/^data:image\/webp;base64,/);
  const thumbnail = Buffer.from(data!.split(',')[1]!, 'base64');
  expect(thumbnail.length).toBeLessThanOrEqual(96 * 1024);
  const metadata = await sharp(thumbnail).metadata();
  expect(metadata.format).toBe('webp');
  expect(metadata.width).toBeLessThanOrEqual(360);
  expect(metadata.height).toBeLessThanOrEqual(240);
  expect(await recordedInputImageThumbnail(other.id, asset.id)).toBeNull();
});

it('rehydrates exact native generated-image metadata and its local preview after a store restart', async () => {
  const session = await createSession({ conversationId: 'generated-images', title: 'Generated images' });
  const other = await createSession({ title: 'Other' });
  const messageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const providerAssetId = 'file_00000000000000000000000000000001';
  const first = await upsertNativeImageEvent(session.id, {
    time: 200, source: 'extension', kind: 'native_image', messageId, providerAssetId,
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'in_progress',
    width: 1254, height: 1254, previewStatus: 'pending', turnId: 'turn-one'
  });
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).webp().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/webp');
  await upsertNativeImageEvent(session.id, {
    time: 300, source: 'extension', kind: 'native_image', messageId, providerAssetId,
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully',
    width: 1254, height: 1254, previewStatus: 'available', previewWidth: 12, previewHeight: 8, asset
  });
  await upsertNativeImageEvent(session.id, {
    time: 210, source: 'extension', kind: 'native_image', messageId,
    providerAssetId: 'file_00000000000000000000000000000002', providerRole: 'tool', providerChannel: 'final',
    width: 1024, height: 768, previewStatus: 'unavailable', previewError: 'not_loaded'
  });

  resetSessionStoreForTests(); initSessionStore(directory);
  const restored = (await readEvents(session.id, { kinds: ['native_image'] }))
    .filter(event => event.kind === 'native_image');
  expect(restored).toHaveLength(2);
  expect(restored[0]).toMatchObject({ origin: first.event.origin ?? first.event.seq, messageId, providerAssetId,
    providerStatus: 'finished_successfully', previewStatus: 'available', asset });
  expect(restored[1]).toMatchObject({ previewStatus: 'unavailable', previewError: 'not_loaded' });
  expect(await recordedInputImage(session.id, asset.id)).toBe(`data:image/webp;base64,${bytes.toString('base64')}`);
  expect(await recordedInputImage(other.id, asset.id)).toBeNull();
});

it.each([true, false])('merges a native echo before=%s with the receipt and preserves real image pixels', async (echoFirst) => {
  const session = await createSession({ conversationId: 'conversation-one', title: 'Input history' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } }).webp({ lossless: true }).toBuffer();
  const entry: InputEntry = { id: '00000000-0000-4000-8000-000000000001', sessionId: session.id, text: 'Inspect this image', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'sent', owner: 'page', createdAt: 100, conversationId: 'conversation-one', messageId: 'native-user-message', deliveredAt: 200, images: [{ name: 'red.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] };
  const echo = () => upsertMessageEvent(session.id, { time: 190, source: 'extension', kind: 'user_message', messageId: entry.messageId!, message: { text: entry.text, chars: entry.text.length, truncated: false } });
  entry.model = 'gpt-5.6-sol'; entry.reasoningEffort = 'high';
  entry.deliveryText = entry.text + '\n\nTransport-only control instruction';
  if (echoFirst) await echo();
  expect(await recordDeliveredInput(entry)).toBe(true);
  await echo();
  await recordDeliveredInput(entry);
  const messages = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ authoredText: entry.text, message: { text: entry.deliveryText } });
  expect(messages[0]).toMatchObject({ inputId: entry.id, messageId: entry.messageId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  const assetId = messages[0]!.kind === 'user_message' ? messages[0]!.assets![0]!.id : '';
  const data = await recordedInputImage(session.id, assetId);
  expect(data).toBe(entry.images![0]!.dataUrl);
  const pixels = await sharp(Buffer.from(data!.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true });
  expect(pixels.info).toMatchObject({ width: 3, height: 2, channels: 3 });
  expect([...pixels.data]).toEqual(Array.from({ length: 6 }, () => [255, 0, 0]).flat());
  expect(await recordedInputImage(other.id, assetId)).toBeNull();
  const unreferenced = await writeAsset(session.id, bytes, 'image/webp');
  // A real asset alone is not sufficient; only a canonical user attachment grants access.
  const stranger = await writeAsset(other.id, bytes, 'image/webp');
  expect(unreferenced.id).toBe(stranger.id);
  expect(await recordedInputImage(other.id, stranger.id)).toBeNull();
});

it('does not publish a queued intent or an unresolved fresh-session receipt', async () => {
  const entry = { sessionId: null, state: 'queued', text: 'intent', images: [] } as unknown as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(false);
  expect(await recordDeliveredInput({ ...entry, state: 'sent', messageId: 'native', deliveredAt: 100 })).toBe(false);
});

it('records the latest ordinary native browser-send model intent without letting an older receipt win', async () => {
  const session = await createSession({ conversationId: 'native-policy-chat', title: 'Native policy' });
  const base = { id: 'native-policy-input', sessionId: session.id, state: 'sent', text: 'Keep ChatGPT native', mode: 'auto',
    dueAt: 0, createdAt: 0, owner: 'page', messageId: 'native-policy-message', conversationId: 'native-policy-chat', transportIntent: 'browser' } as InputEntry;

  expect(await recordDeliveredInput({ ...base, model: null, reasoningEffort: null, deliveredAt: 200 })).toBe(true);
  expect((await getSession(session.id))?.browserModelIntent).toEqual({
    conversationId: 'native-policy-chat', mode: 'native', confirmedAt: 200
  });

  expect(await recordDeliveredInput({ ...base, id: 'explicit-input', messageId: 'explicit-message', model: 'gpt-6', reasoningEffort: 'high', deliveredAt: 300 })).toBe(true);
  expect((await getSession(session.id))?.browserModelIntent).toEqual({
    conversationId: 'native-policy-chat', mode: 'explicit', confirmedAt: 300
  });

  await recordDeliveredInput({ ...base, model: null, reasoningEffort: null, deliveredAt: 250 });
  expect((await getSession(session.id))?.browserModelIntent).toEqual({
    conversationId: 'native-policy-chat', mode: 'explicit', confirmedAt: 300
  });
});

it('does not mint native-default intent from generated recovery or legacy browser receipts', async () => {
  const session = await createSession({ conversationId: 'native-policy-chat', title: 'Native provenance' });
  const base = { id: 'native-policy-input', sessionId: session.id, state: 'sent', text: 'Keep working', mode: 'auto',
    dueAt: 0, createdAt: 0, owner: 'page', messageId: 'native-policy-message', conversationId: 'native-policy-chat',
    model: null, reasoningEffort: null, deliveredAt: 200 } as InputEntry;

  await recordDeliveredInput({ ...base, transportIntent: 'browser', finishOwner: { turnId: 'generated-turn', periodic: false } });
  expect((await getSession(session.id))?.browserModelIntent).toBeUndefined();

  await recordDeliveredInput({ ...base, id: 'recovery-input', messageId: 'recovery-message', deliveredAt: 210,
    transportIntent: 'browser', recoveryTurnId: 'interrupted-turn' });
  expect((await getSession(session.id))?.browserModelIntent).toBeUndefined();

  // Rows written before browser transport provenance existed remain valid history receipts,
  // but their null model cannot retroactively prove that the user chose ChatGPT native default.
  await recordDeliveredInput({ ...base, id: 'legacy-input', messageId: 'legacy-message', deliveredAt: 220 });
  expect((await getSession(session.id))?.browserModelIntent).toBeUndefined();
});

it('anchors a tool handout before later prose and confirms the same row without moving or duplicating it', async () => {
  const session = await createSession({ conversationId: 'tool-conversation', title: 'Tool chronology' });
  const offered = { id: 'offered-input', sessionId: session.id, conversationId: 'tool-conversation',
    state: 'tool', owner: 'exact-request', offeredAt: 200, text: 'look inside',
    deliveryText: 'look inside\n\nTransport-only instruction' } as InputEntry;
  expect(await recordDeliveredInput(offered)).toBe(true);
  const first = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  expect(first).toMatchObject({ messageId: 'input:offered-input', inputId: offered.id,
    inputDelivery: 'offered', time: 200, authoredText: 'look inside' });
  expect(offered.deliveredAt).toBeUndefined();
  expect(offered.messageId).toBeUndefined();
  await upsertMessageEvent(session.id, { time: 250, source: 'extension', kind: 'assistant_message',
    messageId: 'later-prose', final: false, message: { text: 'Checking inside.', chars: 16, truncated: false } });
  const nextFrom = Math.max(...(await readEvents(session.id)).map(event => event.seq)) + 1;
  await recordDeliveredInput({ ...offered, state: 'sent', messageId: 'input:offered-input', deliveredAt: 300 });
  const incremental = await readEvents(session.id, { from: nextFrom });
  expect(incremental).toHaveLength(1);
  expect(incremental[0]).toMatchObject({ messageId: 'input:offered-input', inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, time: 200 });
  expect(incremental[0]!.seq).toBeGreaterThanOrEqual(nextFrom);
  // A delayed repeat of the handout must not undo the subsequently proven receipt.
  await recordDeliveredInput(offered);
  const rows = chronological(await readEvents(session.id)).filter(event =>
    event.kind === 'user_message' || event.kind === 'assistant_message');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: 'user_message', time: 200, inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, authoredText: 'look inside' });
  expect(rows[1]).toMatchObject({ kind: 'assistant_message', messageId: 'later-prose' });
});

it('does not project an unclaimed tool row or mere browser/queued intent into history', async () => {
  const session = await createSession({ title: 'Not offered' });
  const entry = { id: 'unclaimed', sessionId: session.id, text: 'intent', state: 'tool' } as InputEntry;
  expect(await recordDeliveredInput({ ...entry, offeredAt: 100 })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request', offeredAt: 100, state: 'queued' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'page', offeredAt: 100, state: 'browser' })).toBe(false);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toEqual([]);
});

it('does not attribute an injected message to the model selected for a future native send', async () => {
  const session = await createSession({ conversationId: 'injected-conversation', title: 'Injection' });
  const entry = { id: 'injected-id', sessionId: session.id, state: 'sent', text: 'Keep working',
    messageId: 'input:injected-id', deliveredAt: 100, model: 'gpt-6-astra', reasoningEffort: 'pro' } as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(true);
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
  expect((await getSession(session.id))?.selectedModel).toBeUndefined();
  expect((await getSession(session.id))?.browserModelIntent).toBeUndefined();
});

it('records only a native receipt in the currently attached conversation as model selection', async () => {
  const session = await createSession({ conversationId: 'native-conversation', title: 'Native' });
  const entry = { id: 'native-id', sessionId: session.id, state: 'sent', text: 'Work',
    messageId: 'native-id', deliveredAt: 100, model: 'gpt-6', reasoningEffort: 'pro',
    conversationId: 'native-conversation' } as InputEntry;
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: 'gpt-6', reasoningEffort: 'pro', observedAt: 100 });
  await recordDeliveredInput({ ...entry, model: 'gpt-5.6-pro', conversationId: 'retired-conversation', deliveredAt: 200 });
  expect((await getSession(session.id))?.selectedModel?.model).toBe('gpt-6');
});
