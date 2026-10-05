/**
 * The chat owns its history; providers execute turns.
 *
 * End to end through the real IPC send handler, outbox, session store and bridge: an Ollama
 * turn is answered in-process and archived like any other turn, a later ChatGPT turn receives
 * the turns it never saw, switching needs the user's confirmation of that scope, and a
 * local-only chat refuses every provider that is not on this computer.
 */

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';

type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: async () => null }));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret, clearSecret } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { createSession, getSession, initSessionStore, readEvents, resetSessionStoreForTests, upsertMessageEvent, writeAsset } =
  await import('../src/main/session/store.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { bridgePort, startBridge, stopBridge } = await import('../src/main/bridge.js');
const input = await import('../src/main/session/input.js');
const history = await import('../src/main/session/provider-history.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let directory: string;
let bearer: string;
const rendererWebContents = { send: vi.fn() };
const rendererWindow = { isDestroyed: () => false, webContents: rendererWebContents };
const rendererEvent = { sender: rendererWebContents };

// ---------------------------------------------------------------- fake Ollama

const realFetch = globalThis.fetch;
const ollamaRequests: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
let replyText = 'Hello from Ollama';
let visionModels = new Set<string>(['llava']);
let pulled: string[] = [];
/** When set, Ollama's chat answer waits for it: proves a send returned before payload work. */
let chatGate: Promise<void> | null = null;
function sse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const fakeFetch = async (resource: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(resource instanceof Request ? resource.url : resource);
  if (!url.includes(':11434') && !url.startsWith('https://ollama.com')) return realFetch(resource as never, init);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  ollamaRequests.push({ url, body, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
  if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gemma4:cloud' }, { id: 'llama3.2' }, { id: 'llava' }] });
  // The local app: pulled models only, cloud stubs marked by remote_host.
  if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [
    { name: 'gemma4:cloud', remote_host: 'https://ollama.com', remote_model: 'gemma4:31b', capabilities: ['completion', 'vision'] },
    { name: 'llama3.2', capabilities: ['completion'] },
    { name: 'llava', capabilities: ['completion', 'vision'] },
    ...pulled.map(name => ({ name, remote_host: 'https://ollama.com', capabilities: ['completion'] }))
  ] });
  // The public cloud catalog, by remote names.
  if (url === 'https://ollama.com/api/tags') return Response.json({ models: [{ name: 'gemma4:31b' }, { name: 'kimi-k3' }, { name: 'mistral-large-3:675b' }] });
  if (url.endsWith('/api/pull')) { pulled.push(body.model); return Response.json({ status: 'success' }); }
  if (url.endsWith('/api/show')) return Response.json({ capabilities: visionModels.has(body.model) ? ['completion', 'vision'] : ['completion'] });
  if (url.endsWith('/v1/chat/completions')) {
    if (chatGate) { const gate = chatGate; ollamaRequests.pop(); await gate; ollamaRequests.push({ url, body, headers: {} }); }
    return sse([replyText.slice(0, 5), replyText.slice(5)]);
  }
  return new Response('not found', { status: 404 });
};

async function post(route: string, body: unknown) {
  const response = await realFetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

function send(fields: Record<string, unknown>) {
  return handlers.get('sessions:send')!(rendererEvent, {
    id: randomUUID(), sessionId: null, text: 'Hi', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null, automation: 'off',
    ...fields
  });
}

async function finished(sessionId: string, turnId: string) {
  await vi.waitFor(async () => {
    const events = await readEvents(sessionId, { kinds: ['turn_end'] });
    expect(events.some((event) => event.turnId === turnId)).toBe(true);
  }, { timeout: 5000 });
  return readEvents(sessionId, { kinds: ['user_message', 'assistant_message', 'chat_error', 'turn_end'] });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  directory = await makeTempDir('eve-ollama-chat-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  registerIpc(() => rendererWindow as never, () => undefined);
  await startBridge();
  bearer = (await post('/pair', {})).body.token;
});
beforeEach(async () => {
  await writeDurableNow('session-input', []);
  input.resetInputForTests();
  ollamaRequests.length = 0;
  pulled = [];
  replyText = 'Hello from Ollama';
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('answers a fresh Ollama chat in-process and archives both turns with provider provenance', async () => {
  const id = randomUUID();
  const accepted = await send({ id, provider: 'ollama', model: 'llama3.2', text: 'What is 2+2?' });
  expect(accepted.ok, accepted.error).toBe(true);

  await vi.waitFor(async () => expect((await input.listInputs()).find((row) => row.id === id)?.state).toBe('sent'));
  const row = (await input.listInputs()).find((entry) => entry.id === id)!;
  expect(row.conversationId).toMatch(/^ollama-/);
  const session = (await getSession(row.deliveredSessionId!))!;
  expect(session).toMatchObject({ conversationId: row.conversationId, provider: { id: 'ollama', model: 'llama3.2' } });

  const events = await finished(session.id, `ollama-turn:${id}`);
  expect(events.find((event) => event.kind === 'user_message')).toMatchObject({ inputId: id, provider: { id: 'ollama', model: 'llama3.2' } });
  expect(events.find((event) => event.kind === 'assistant_message')).toMatchObject({
    final: true, state: 'final', provider: { id: 'ollama', model: 'llama3.2' }, message: { text: 'Hello from Ollama' }
  });
  expect(events.find((event) => event.kind === 'turn_end')).toMatchObject({ outcome: 'completed' });

  const chat = ollamaRequests.find((request) => request.url.endsWith('/chat/completions'))!;
  expect(chat.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  expect(chat.body.model).toBe('llama3.2');
  expect(chat.body.messages.at(-1)).toEqual({ role: 'user', content: 'What is 2+2?' });
  // The local daemon never receives the stored cloud key.
  expect(chat.headers.authorization).toBeUndefined();
  // The browser transport never sees an Ollama row.
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it('builds provider-switch consent from canonical messages without scanning the forensic event journal', async () => {
  const session = await createSession({ title: 'Tool-heavy chat', conversationId: randomUUID() });
  await upsertMessageEvent(session.id, {
    time: 1, source: 'extension', kind: 'user_message', messageId: 'u-canonical',
    message: { text: 'Keep this context.', truncated: false, chars: 18 }
  });
  await upsertMessageEvent(session.id, {
    time: 2, source: 'extension', kind: 'assistant_message', messageId: 'a-canonical',
    message: { text: 'Context retained.', truncated: false, chars: 17 }, final: true, state: 'final'
  });

  const readFile = vi.spyOn(fs, 'readFile');
  try {
    const preview = await history.providerSwitchPreview(session.id, { id: 'ollama', model: 'llama3.2' });
    expect(preview).toMatchObject({ switching: true, messages: 2, images: 0, files: 0 });
    expect(readFile.mock.calls.some(([file]) => String(file).endsWith('events.jsonl'))).toBe(false);
  } finally {
    readFile.mockRestore();
  }
});

it('gives Ollama the ChatGPT history and its images, and refuses an image the model cannot read', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Started in ChatGPT', conversationId });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).png().toBuffer();
  const asset = await writeAsset(session.id, png, 'image/png');
  await upsertMessageEvent(session.id, { time: 1, source: 'extension', kind: 'user_message', messageId: 'u1', message: { text: 'Look at this', truncated: false, chars: 12 }, assets: [asset] });
  await upsertMessageEvent(session.id, { time: 2, source: 'extension', kind: 'assistant_message', messageId: 'a1', message: { text: 'A red square.', truncated: false, chars: 13 }, final: true, state: 'final' });

  // Without the user's confirmation, the switch is refused and nothing is sent.
  const refused = await send({ sessionId: session.id, provider: 'ollama', model: 'llava', text: 'What colour was it?' });
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/PROVIDER_SWITCH_CONSENT_REQUIRED/);

  const preview = await history.providerSwitchPreview(session.id, { id: 'ollama', model: 'llava' });
  expect(preview).toMatchObject({ switching: true, from: 'chatgpt', to: 'ollama-local', messages: 2, images: 1, files: 0 });
  const id = randomUUID();
  const accepted = await send({ id, sessionId: session.id, provider: 'ollama', model: 'llava', text: 'What colour was it?',
    providerConsent: { to: preview.to, messages: preview.messages, images: preview.images, files: preview.files } });
  expect(accepted.ok, accepted.error).toBe(true);
  await finished(session.id, `ollama-turn:${id}`);

  const chat = ollamaRequests.find((request) => request.url.endsWith('/chat/completions'))!;
  const [system, user, assistant, current] = chat.body.messages;
  expect(system.role).toBe('system');
  expect(user.role).toBe('user');
  expect(user.content[0]).toEqual({ type: 'text', text: 'Look at this' });
  expect(user.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  expect(assistant).toEqual({ role: 'assistant', content: 'A red square.' });
  expect(current).toEqual({ role: 'user', content: 'What colour was it?' });

  // A model without vision cannot be handed a new image: the turn fails clearly, the image stays archived.
  const imageTurn = randomUUID();
  const webp = await sharp(png).webp().toBuffer();
  const sentImage = await send({ id: imageTurn, sessionId: session.id, provider: 'ollama', model: 'llama3.2', text: 'And this one?',
    images: [{ name: 'square.webp', dataUrl: `data:image/webp;base64,${webp.toString('base64')}` }],
    providerConsent: { to: 'ollama-local', messages: 0, images: 0, files: 0 } });
  expect(sentImage.ok, sentImage.error).toBe(true);
  const events = await finished(session.id, `ollama-turn:${imageTurn}`);
  expect(events.filter((event) => event.kind === 'chat_error').at(-1)).toMatchObject({ message: { text: expect.stringContaining('cannot read images') } });
  expect(events.filter((event) => event.kind === 'turn_end').at(-1)).toMatchObject({ outcome: 'failed' });
  expect(events.filter((event) => event.kind === 'user_message').at(-1)?.assets?.length).toBe(1);
});

it('catches ChatGPT up on Ollama turns once, and binds a ChatGPT conversation to an Ollama-started chat', async () => {
  const first = randomUUID();
  expect((await send({ id: first, provider: 'ollama', model: 'llama3.2', text: 'Remember the codeword: tangerine.' })).ok).toBe(true);
  await vi.waitFor(async () => expect((await input.listInputs()).find((row) => row.id === first)?.state).toBe('sent'));
  const row = (await input.listInputs()).find((entry) => entry.id === first)!;
  const sessionId = row.deliveredSessionId!;
  await finished(sessionId, `ollama-turn:${first}`);

  const preview = await history.providerSwitchPreview(sessionId, null);
  expect(preview).toMatchObject({ switching: true, from: 'ollama-local', to: 'chatgpt', messages: 2 });
  const second = randomUUID();
  const accepted = await send({ id: second, sessionId, text: 'What was the codeword?',
    providerConsent: { to: 'chatgpt', messages: preview.messages, images: 0, files: 0 } });
  expect(accepted.ok, accepted.error).toBe(true);

  // An Ollama-started chat opens a fresh ChatGPT conversation for its first ChatGPT turn.
  expect((await input.pendingBrowserInputs()).find((entry) => entry.id === second)).toMatchObject({ conversationId: null });
  const claim = await post('/input/claim', { id: second, owner: 'fresh-page', conversationId: null });
  const delivered = claim.body.input.text as string;
  expect(delivered).toContain('[Context from Eve:');
  expect(delivered).toContain('Remember the codeword: tangerine.');
  expect(delivered).toContain('Assistant (Ollama on this computer · llama3.2):');
  expect(delivered.indexOf('[End of context]')).toBeLessThan(delivered.indexOf('What was the codeword?'));

  const chatgpt = randomUUID();
  expect((await post('/input/ack', { id: second, owner: 'fresh-page', conversationId: chatgpt, messageId: 'native-user' })).body.ok).toBe(true);
  const moved = (await getSession(sessionId))!;
  expect(moved.conversationId).toBe(chatgpt);
  expect(moved.provider).toBeUndefined();
  // ChatGPT has now seen everything: no second catch-up, no switch prompt.
  expect(await history.chatGptCatchUp(sessionId, 50_000, 4)).toBeNull();
  expect((await history.providerSwitchPreview(sessionId, null)).switching).toBe(false);
});

it('keeps a local-only chat on this computer and labels cloud models honestly', async () => {
  const session = await createSession({ title: 'Private', conversationId: `ollama-${randomUUID()}` });
  const locked = await handlers.get('sessions:setLocalOnly')!(rendererEvent, { id: session.id, localOnly: true });
  expect(locked.ok, locked.error).toBe(true);
  expect((await send({ sessionId: session.id, provider: 'ollama', model: 'gemma4:cloud' })).error).toMatch(/local only/i);
  expect((await send({ sessionId: session.id })).error).toMatch(/local only/i);

  expect(history.providerRoute({ id: 'ollama', model: 'gemma4:cloud' })).toBe('ollama-cloud');
  expect(history.providerRoute({ id: 'ollama', model: 'gpt-oss:120b-cloud' })).toBe('ollama-cloud');
  expect(history.providerRoute({ id: 'ollama', model: 'llama3.2' })).toBe('ollama-local');
  expect(history.providerRoute({ id: 'ollama', model: 'llama3.2' }, 'https://ollama.com/v1')).toBe('ollama-cloud');

  const models = await handlers.get('ollama:models')!(rendererEvent, undefined);
  expect(models.data).toEqual([
    { id: 'gemma4:cloud', cloud: true, installed: true, vision: true, route: 'ollama-cloud' },
    { id: 'llama3.2', cloud: false, installed: true, vision: false, route: 'ollama-local' },
    { id: 'llava', cloud: false, installed: true, vision: true, route: 'ollama-local' },
    // The cloud catalog under the local app's cloud names; gemma4:31b is already the gemma4:cloud stub.
    { id: 'kimi-k3:cloud', cloud: true, installed: false, route: 'ollama-cloud' },
    { id: 'mistral-large-3:675b-cloud', cloud: true, installed: false, route: 'ollama-cloud' }
  ]);
});

it('pulls a cloud model picked from the catalog before its first turn, never a local model', async () => {
  await handlers.get('ollama:models')!(rendererEvent, undefined);
  const id = randomUUID();
  expect((await send({ id, provider: 'ollama', model: 'kimi-k3:cloud', text: 'Hello cloud' })).ok).toBe(true);
  await vi.waitFor(async () => expect((await input.listInputs()).find(row => row.id === id)?.state).toBe('sent'));
  const row = (await input.listInputs()).find(entry => entry.id === id)!;
  await finished(row.deliveredSessionId!, `ollama-turn:${id}`);
  expect(pulled).toEqual(['kimi-k3:cloud']);
  expect(ollamaRequests.find(request => request.url.endsWith('/chat/completions'))?.body.model).toBe('kimi-k3:cloud');

  const local = randomUUID();
  expect((await send({ id: local, provider: 'ollama', model: 'llama3.2', text: 'Hello local' })).ok).toBe(true);
  await vi.waitFor(async () => expect((await input.listInputs()).find(entry => entry.id === local)?.state).toBe('sent'));
  expect(pulled).toEqual(['kimi-k3:cloud']);
});

it('starts a new chat locked to this computer when Local only is ticked before the first send', async () => {
  expect((await send({ provider: 'ollama', model: 'gemma4:cloud', localOnly: true })).error).toMatch(/model on this computer/);
  const id = randomUUID();
  expect((await send({ id, provider: 'ollama', model: 'llama3.2', localOnly: true, text: 'Private start' })).ok).toBe(true);
  await vi.waitFor(async () => expect((await input.listInputs()).find(row => row.id === id)?.state).toBe('sent'));
  const session = (await getSession((await input.listInputs()).find(row => row.id === id)!.deliveredSessionId!))!;
  expect(session.localOnly).toBe(true);
  // An existing chat changes the lock in its options, not on a send.
  expect((await send({ sessionId: session.id, provider: 'ollama', model: 'llama3.2', localOnly: true })).ok).toBe(false);
});

it('sends the stored Ollama key only to an HTTPS endpoint', async () => {
  const { ollamaHeaders } = await import('../src/main/ollama-client.js');
  await setSecret('ollamaApiKey', 'test-key-value');
  try {
    expect((await ollamaHeaders('https://ollama.com/v1')).authorization).toBe('Bearer test-key-value');
    expect((await ollamaHeaders('http://127.0.0.1:11434/v1')).authorization).toBeUndefined();
  } finally {
    await clearSecret('ollamaApiKey');
  }
});

it('previews and enqueues a switch on a long cold chat promptly, preparing the Ollama payload only afterwards', async () => {
  const { flushSessions, writeOverflowText } = await import('../src/main/session/store.js');
  const { onLog } = await import('../src/main/logger.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Long GPT chat', conversationId });
  const long = 'x'.repeat(20_000);
  for (let turn = 0; turn < 300; turn++) {
    const at = 1_000 + turn * 10;
    await upsertMessageEvent(session.id, { time: at, source: 'extension', kind: 'user_message', messageId: `u${turn}`,
      message: { text: `Question ${turn}`, truncated: false, chars: 12 },
      ...(turn % 25 === 0 ? { attachments: [{ id: randomUUID(), name: `notes-${turn}.pdf`, size: 1000, mimeType: 'application/pdf' }] } : {}) });
    const overflow = turn % 10 === 0 ? await writeOverflowText(session.id, long) : null;
    await upsertMessageEvent(session.id, { time: at + 5, source: 'extension', kind: 'assistant_message', messageId: `a${turn}`,
      message: overflow ? { text: long.slice(0, 12_000), truncated: true, chars: long.length, assetId: overflow } : { text: `Answer ${turn}`, truncated: false, chars: 9 },
      final: true, state: 'final' });
  }
  // Cold: the chat is not open in this process, as after a restart.
  await flushSessions();
  resetSessionStoreForTests();
  initSessionStore(directory);

  const lines: string[] = [];
  const stopLog = onLog(entry => { if (entry.message.includes('provider-switch timing')) lines.push(entry.message); });
  try {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const preview = await handlers.get('sessions:providerPreview')!(rendererEvent, { id: session.id, provider: { id: 'ollama', model: 'llama3.2' }, traceId });
    const previewMs = Date.now() - startedAt;
    expect(preview.ok, preview.error).toBe(true);
    expect(preview.data).toMatchObject({ switching: true, messages: 600, files: 12 });
    expect(previewMs).toBeLessThan(5_000);
    // Consent counts rows; it never reads the 30 long answers' overflow text.
    expect(lines.find(line => line.includes(`trace=${traceId.slice(0, 8)}`) && line.includes('step=archivedTurns'))).toContain('overflow_reads=0');

    // Hold Ollama's answer: the send must return (durably queued) while the payload is still pending.
    let release!: () => void;
    chatGate = new Promise<void>(resolve => { release = resolve; });
    const id = randomUUID();
    const sendStartedAt = Date.now();
    const accepted = await send({ id, sessionId: session.id, provider: 'ollama', model: 'llama3.2', text: 'Continue here',
      providerConsent: { to: preview.data.to, messages: preview.data.messages, images: preview.data.images, files: preview.data.files } });
    expect(accepted.ok, accepted.error).toBe(true);
    expect(Date.now() - sendStartedAt).toBeLessThan(5_000);
    expect((await input.listInputs()).find(row => row.id === id)).toBeTruthy();
    expect(ollamaRequests.some(request => request.url.endsWith('/chat/completions') && request.body?.messages)).toBe(false);
    release();
    await finished(session.id, `ollama-turn:${id}`);
    const chat = ollamaRequests.find(request => request.url.endsWith('/chat/completions'))!;
    // The real payload, built after enqueue, does carry the long answers in full.
    expect(chat.body.messages.some((message: { content: unknown }) => typeof message.content === 'string' && message.content.length === long.length)).toBe(true);
  } finally {
    stopLog();
    chatGate = null;
  }
}, 60_000);
