/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EveReadiness } from '../src/shared/types.js';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const setupAssistantMocks = vi.hoisted(() => ({
  openParadigmEveChromeProfile: vi.fn(async () => undefined),
  restoreParadigmEveBrowser: vi.fn(async () => undefined),
  paradigmeEveBrowserWindowOpen: vi.fn(async () => false)
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));
vi.mock('../src/main/setup-assistant.js', () => ({
  openSetupAssistantLink: vi.fn(async () => undefined),
  openParadigmEveChromeProfile: setupAssistantMocks.openParadigmEveChromeProfile,
  onSetupAssistantChange: vi.fn(() => () => undefined),
  paradigmeEveBrowserWindowOpen: setupAssistantMocks.paradigmeEveBrowserWindowOpen,
  restoreParadigmEveBrowser: setupAssistantMocks.restoreParadigmEveBrowser,
  setupAssistantSnapshot: vi.fn(() => ({ stage: 'idle', running: false, detail: '', error: null })),
  startSetupAssistant: vi.fn(async () => ({ stage: 'idle', running: false, detail: '', error: null })),
  stopSetupAssistant: vi.fn(async () => undefined),
  SetupAssistantStoppedError: class SetupAssistantStoppedError extends Error {}
}));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { getOrCreateLanPeerIdentity } = await import('../src/main/lan-peer-identity.js');
const { clearLanGroupKey, getLanGroupKey } = await import('../src/main/lan-peer-key.js');
const { lanPeerNicknameReservation } = await import('../src/main/lan-peer-reservations.js');
const { appendEvent, createSession, initSessionStore, rebindSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { pendingCommands, resetBridgeForTests, setBrowserOpener, startBridge, stopBridge } = await import(
  '../src/main/bridge.js'
);
const {
  bindConversation,
  finishAgent,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  snapshotRetiredWorkers,
  snapshotSwarm,
  spawn,
  swarmStateForCaller
} = await import('../src/main/agents.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { app, nativeTheme, safeStorage, shell, dialog } = await import('electron');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} | null = null;
/** How many times the IPC layer asked the app to quit so a staged update can be applied. */
let quitToInstallCalls = 0;

function makeWindow() {
  return {
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  };
}

function trustedEvent(): { sender: unknown } {
  return { sender: currentWindow?.webContents };
}

const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(trustedEvent(), { patch, base }) as Promise<any>;
const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(trustedEvent(), payload) as Promise<any>;
const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(trustedEvent(), payload) as Promise<any>;
const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(trustedEvent(), payload) as Promise<any>;
const sessionList = (): Promise<any> => handlers.get('sessions:list')!(trustedEvent(), undefined) as Promise<any>;
it('persists the composer preference through IPC without changing worker defaults', async () => {
  const worker = structuredClone(getConfig().multiAgent);
  const prefer = (model: string | null, reasoningEffort: string | null): Promise<any> =>
    handlers.get('chatModels:preference')!(trustedEvent(), { model, reasoningEffort }) as Promise<any>;
  const reply = await prefer('5.6', 'high');
  expect(reply.ok, reply.error).toBe(true);
  expect(getConfig().ui).toMatchObject({ chatModel: '5.6', chatReasoning: 'high' });
  expect(getConfig().multiAgent).toEqual(worker);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  expect(stored.ui).toMatchObject({ chatModel: '5.6', chatReasoning: 'high' });
  expect((await prefer(null, 'high')).ok).toBe(false);
  expect(getConfig().ui.chatModel).toBe('5.6');
  expect((await prefer(null, null)).ok).toBe(true);
  expect(getConfig().ui).toMatchObject({ chatModel: null, chatReasoning: null });
});


it('exposes the read-only schedule projection without renderer-side execution authority', async () => {
  const reply = await handlers.get('schedule:read')!(trustedEvent(), undefined) as any;
  expect(reply.ok, reply.error).toBe(true);
  expect(['resolved', 'unresolved-eve-duration']).toContain(reply.data.overlap.status);
  if (reply.data.overlap.status === 'unresolved-eve-duration') expect(reply.data.overlap.windows).toEqual([]);
  const serialized = JSON.stringify(reply.data);
  expect(serialized).not.toContain('payloadHash');
  expect(serialized).not.toContain('receiptKey');
  expect(serialized).not.toContain('inputId');
  expect(serialized).not.toContain('work');
});

it('validates dropped file count and stages arbitrary native file types', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(trustedEvent(), payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: Array(21).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ files: [''] })).toMatchObject({ ok: false });
  expect(await drop({ files: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: true, data: [expect.objectContaining({ name: 'package.json', mimeType: 'application/json' })] });
});

it('publishes Goal draft progress through the session refresh channel without a new transcript event', async () => {
  const { startGoalDraft, resetGoalStateForTests } = await import('../src/main/goal.js');
  const session = await createSession({ title: 'Goal progress', conversationId: 'ipc-goal-progress' });
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  try {
    startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'finished-turn', deferStart: true });
    expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
  } finally {
    resetGoalStateForTests();
  }
});

it('stages clipboard image bytes with a preview through the general attachment owner', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(trustedEvent(), payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: [{ name: 'huge.png', bytes: new Uint8Array(12 * 1024 * 1024 + 1) }] })).toMatchObject({ ok: false });
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const pasted = await drop({ files: [{ name: 'screenshot.png', bytes: new Uint8Array(bytes) }] });
  expect(pasted).toMatchObject({ ok: true, data: [{ name: 'screenshot.png', size: bytes.length, mimeType: 'image/png', preview: expect.stringMatching(/^data:image\/webp;base64,/) }] });
  const { readInputAttachmentChunk } = await import('../src/main/session/input-attachments.js');
  expect(await readInputAttachmentChunk(pasted.data[0], 0)).toBe(bytes.toString('base64'));
});

it('does not authorize the composer Generate Goal action from an absent or stale finish wait', async () => {
  const generate = (payload: unknown) => handlers.get('sessions:generateFinishGoal')!(trustedEvent(), payload) as Promise<any>;
  const session = await createSession({ title: 'No finish wait', conversationId: 'finish-action-ipc-chat' });
  expect(await generate({ id: session.id })).toMatchObject({ ok: false });
  expect(await generate({ id: session.id, expectedTurnId: 'old-turn' })).toMatchObject({ ok: false });
});

it('round-trips Goal controls and cannot revive old periodic input when Off cancellation fails then On retries', async () => {
  const outbox = await import('../src/main/session/input.js');
  const durable = await import('../src/main/durable.js');
  const store = await import('../src/main/session/store.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const config = (minutes: number) => ({ ...settings({ record: true, multiAgent: false }),
    ui: { ...defaultConfig().ui, finishTool: true },
    goal: { ...defaultConfig().goal, impulseMinutes: minutes, includeToolCalls: true } });
  let write: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await save(config(1))).toMatchObject({ ok: true });
    expect(getConfig().goal).toMatchObject({ impulseMinutes: 1, includeToolCalls: true });
    const session = await createSession({ title: 'Periodic ownership', conversationId: 'periodic-settings-chat' });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'periodic-turn', time: Date.now() });
    await store.observeSessionModel(session.id, 'periodic-settings-chat', 'gpt-6-astra', Date.now());
    const row = await outbox.enqueueInput({ id: 'f0f00014-1111-4111-8111-111111111111', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, userRequested: true });
    // Seed an old-version row; current code deliberately refuses new periodic input.
    await writeDurableNow('session-input', [{ ...row, finishOwner: { turnId: 'periodic-turn', periodic: true } }]);
    outbox.resetInputForTests();
    write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('Cancellation disk failure'));
    expect(await save(config(0))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Off was published before retirement.
    write.mockRejectedValueOnce(new Error('Still cannot retire'));
    expect(await save(config(1))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Failed retirement cannot publish On.
    write.mockRestore(); write = undefined;
    expect(await save(config(1))).toMatchObject({ ok: true });
    outbox.resetInputForTests();
    expect((await outbox.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual({ messages: [], reminder: '' });
  } finally {
    write?.mockRestore();
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('keeps generated worker-final attention out of the editable renderer outbox', async () => {
  const outbox = await import('../src/main/session/input.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  try {
    const session = await createSession({ title: 'Prime attention owner', conversationId: 'attention-prime-chat' });
    const attention = await outbox.enqueueWorkerAttention(session.id, {
      key: 'ipc-run:worker-1:turn-final:message-final',
      workerId: 'worker-1',
      conversationId: 'attention-worker-chat',
      task: 'Inspect the worker result',
      finalText: 'The worker finished its check.'
    });
    expect((await outbox.listInputs()).find(row => row.id === attention.id)?.purpose).toBe('attention');
    const visible = await handlers.get('sessions:outbox')!(trustedEvent(), undefined) as any;
    expect(visible.ok).toBe(true);
    expect(visible.data.some((row: any) => row.id === attention.id)).toBe(false);
  } finally {
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('native opening cancellation aborts the exact IPC invocation and prevents a late ready result', async () => {
  const goal = await import('../src/main/goal.js');
  const requestId = 'ad3ecbf4-c3a1-4d0d-9e9f-619787bcf982';
  let signal: AbortSignal | undefined;
  const draft = vi.spyOn(goal, 'draftOpeningMessage').mockImplementation(async (_text, _mode, _progress, current) => {
    signal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  });
  try {
    const opening = handlers.get('sessions:goalOpening')!(trustedEvent(), { text: 'Implement safely', mode: 'goal', requestId });
    const cancelled = await handlers.get('tasks:cancel')!(trustedEvent(), { requestId }) as any;
    expect(cancelled).toEqual({ ok: true, data: true });
    expect(signal?.aborted).toBe(true);
    expect(await opening).toMatchObject({ ok: false, error: 'task_cancelled' });
    expect(draft).toHaveBeenCalledTimes(1);
  } finally { draft.mockRestore(); }
});

it('projects exact retained worker parents without adopting same-name unrelated recordings', async () => {
  const prime = await createSession({ title: 'Parent', conversationId: 'parent-projection' });
  spawn({ workers: [{ task: 'test parent identity' }], caller: { conversationId: 'parent-projection' } });
  expect(bindConversation('worker-1', 'worker-projection')).toBe(true);
  const origin = { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'test parent identity' };
  const child = await createSession({ title: 'Child', conversationId: 'worker-projection', origin });
  const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-worker', origin });
  const result = await sessionList();
  expect(result.ok).toBe(true);
  expect(result.data.sessions.find((row: any) => row.id === child.id).origin.fromSessionId).toBe(prime.id);
  expect(result.data.sessions.find((row: any) => row.id === unrelated.id).origin.fromSessionId).toBeNull();
  restoreSwarm(null); // End this fixture without user-clear retiring it into later tests.
});

it('adds picker-selected projects, reuses containing approval, and leaves cancellation unchanged', async () => {
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const folder = path.join(dir, 'picker-project');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await writeDurableNow('projects', []);
  const add = () => handlers.get('projects:add')!(trustedEvent(), {}) as Promise<any>;
  expect((await add()).data).toBeNull();
  expect(getConfig().roots).toHaveLength(0);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [folder] });
  const first = await add();
  expect(first.ok, first.error).toBe(true);
  expect(first.data.name).toBe('picker-project');
  expect(getConfig().roots).toHaveLength(1);
  expect((await add()).data.id).toBe(first.data.id);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path.join(folder, 'child')] });
  expect((await add()).data.name).toBe('child');
  expect(getConfig().roots).toHaveLength(1);
  const listed = await handlers.get('projects:list')!(trustedEvent(), {}) as any;
  expect(listed.data).toHaveLength(2);
  const removed = await handlers.get('projects:remove')!(trustedEvent(), { id: first.data.id }) as any;
  expect(removed).toMatchObject({ ok: true, data: { id: first.data.id, ungrouped: true } });
  expect(getConfig().roots).toHaveLength(1);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await handlers.get('projects:remove')!(trustedEvent(), { id: folder })).toMatchObject({ ok: false });
});

it('keeps the Pin destination mandatory across the trusted renderer IPC boundary', async () => {
  const collection = await handlers.get('pins:createCollection')!(trustedEvent(), { name: `IPC ${Date.now()}` }) as any;
  expect(collection.ok, collection.error).toBe(true);
  const created = await handlers.get('pins:create')!(trustedEvent(), {
    kind: 'message',
    target: { mode: 'new', title: 'IPC Quilt', collectionIds: [collection.data.id] },
    title: 'Pinned reply',
    provenance: { sessionId: 'session-ipc-pin', conversationId: null, eventSeq: 4, messageId: 'message-ipc-pin' }
  }) as any;
  expect(created.ok, created.error).toBe(true);
  expect(created.data.pin.quiltId).toBe(created.data.quilt.id);
  expect(await handlers.get('pins:setSticky')!(trustedEvent(), { pinId: created.data.pin.id, sticky: true })).toMatchObject({
    ok: true,
    data: { id: created.data.pin.id, quiltId: created.data.quilt.id, sticky: true }
  });

  const missing = await handlers.get('pins:create')!(trustedEvent(), {
    kind: 'message',
    target: { quiltId: created.data.quilt.id },
    provenance: { sessionId: 'session-ipc-pin', conversationId: null, eventSeq: 5 }
  }) as any;
  expect(missing.ok).toBe(false);

  const archived = await handlers.get('pins:setQuiltState')!(trustedEvent(), { quiltId: created.data.quilt.id, state: 'archived' }) as any;
  expect(archived).toMatchObject({ ok: true, data: { state: 'archived' } });
  const refused = await handlers.get('pins:create')!(trustedEvent(), {
    kind: 'result',
    target: { mode: 'existing', quiltId: created.data.quilt.id },
    provenance: { sessionId: 'session-ipc-pin', conversationId: null, eventSeq: 6 }
  }) as any;
  expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/restore/i) });
  expect(await handlers.get('pins:setQuiltState')!(trustedEvent(), { quiltId: created.data.quilt.id, state: 'pinned' })).toMatchObject({
    ok: true, data: { state: 'pinned' }
  });
});

it('validates and transitions first-class Plans through the trusted renderer IPC boundary', async () => {
  const original = await readDurable<unknown>('plans');
  await writeDurableNow('plans', { version: 1, plans: [] });
  try {
    const create = (payload: unknown) => handlers.get('plans:create')!(trustedEvent(), payload) as Promise<any>;
    const update = (payload: unknown) => handlers.get('plans:update')!(trustedEvent(), payload) as Promise<any>;
    const archive = (payload: unknown) => handlers.get('plans:archive')!(trustedEvent(), payload) as Promise<any>;
    const list = () => handlers.get('plans:list')!(trustedEvent(), undefined) as Promise<any>;

    expect(await create({ title: 'Empty', items: [] })).toMatchObject({ ok: false });
    const created = await create({
      title: 'Persist this result',
      provenance: { kind: 'result', conversationId: 'conversation-7', toolCallId: 'call-7' },
      items: [{ text: 'Review result', status: 'in_progress', priority: 'high' }, { text: 'Archive it', status: 'todo' }]
    });
    expect(created).toMatchObject({ ok: true, data: { section: 'live', readyToArchive: false } });
    expect(await archive({ id: created.data.id })).toMatchObject({ ok: false, error: expect.stringContaining('not ready') });

    const completed = await update({
      id: created.data.id,
      expectedUpdatedAt: created.data.updatedAt,
      patch: { items: created.data.items.map((item: any) => ({ ...item, status: 'done' })) }
    });
    expect(completed).toMatchObject({ ok: true, data: { readyToArchive: true } });
    expect(await archive({ id: created.data.id })).toMatchObject({ ok: true, data: { section: 'done', readyToArchive: false } });
    expect(await list()).toMatchObject({ ok: true, data: { live: [], done: [{ id: created.data.id }] } });
    expect(await update({ id: created.data.id, patch: { title: 'Too late' } })).toMatchObject({ ok: false });
  } finally {
    await writeDurableNow('plans', original);
  }
});

/** The whole settings object the renderer sends, with the parts a test cares about set. */
function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
    tunnel: base.tunnel,
    ui: base.ui,
    sessions: { ...base.sessions, record: over.record },
    compaction: base.compaction,
    multiAgent: { ...base.multiAgent, enabled: over.multiAgent },
    goal: base.goal
  };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-ipc-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersist(() => writeDurableSoon('ipc-swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('ipc-swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('ipc-retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow('ipc-retired-workers', snapshot));
  registerIpc(
    () => currentWindow as any,
    () => {
      quitToInstallCalls += 1;
    }
  );
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  onSwarmPersist(null);
  onSwarmPersistNow(null);
  onRetiredWorkersPersist(null);
  onRetiredWorkersPersistNow(null);
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  currentWindow = makeWindow();
  setupAssistantMocks.openParadigmEveChromeProfile.mockClear();
  setupAssistantMocks.restoreParadigmEveBrowser.mockClear();
  setupAssistantMocks.paradigmeEveBrowserWindowOpen.mockClear().mockResolvedValue(false);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  nativeTheme.themeSource = 'system';
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(shell.openPath).mockReset().mockResolvedValue('');
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined);
  vi.mocked(app.getVersion).mockReset().mockReturnValue('0.0.0');
  resetSwarm();
  resetBridgeForTests();
  resetWorkspaces();
  // The app opens the worker's chat itself; a command only exists while a page it opened
  // still has it to redeem.
  setBrowserOpener(async () => undefined);
  await saveConfig({
    ...defaultConfig(),
    sessions: { ...defaultConfig().sessions, record: true },
    multiAgent: { enabled: true, maxWorkers: 3, allowUnattributedCalls: false, recoverAgentTabs: true }
  });
});

describe('explicit settings replace the published tool contract', () => {
  it('revokes Window2 observation authority across an offline screen/control Off→On cycle', async () => {
    const { getStatus } = await import('../src/main/connection.js');
    const desktop = await import('../src/main/mcp/tools-desktop-windows.js');
    const retire = vi.spyOn(desktop, 'retireWindowsComputerContexts');
    // The Window2 retirement is a Windows-only settings transition; pin the platform it runs on.
    const hostPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {

    const enable = { ...getConfig(), capabilities: { ...getConfig().capabilities, screen: true, control: true } };
    expect((await save(enable)).ok).toBe(true);
    expect(getStatus().state).toBe('disconnected'); // No MCP registrar can witness the transition below.
    retire.mockClear();

    const off = { ...getConfig(), capabilities: { ...getConfig().capabilities, screen: false, control: false } };
    expect((await save(off)).ok).toBe(true);
    const on = { ...getConfig(), capabilities: { ...getConfig().capabilities, screen: true, control: true } };
    expect((await save(on)).ok).toBe(true);
    expect(getStatus().state).toBe('disconnected');
    expect(retire).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
      retire.mockRestore();
    }
  });

  it.each(['finish', 'command', 'session'] as const)('withdraws %s from real endpoint publication after its setting is disabled', async kind => {
    const { startMcpServer } = await import('../src/main/mcp/server.js');
    const { effectiveCapabilities } = await import('../src/main/config.js');
    const { publishPluginSurface, pluginRefreshPublications, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    const initial = getConfig();
    await saveConfig({ ...initial, ui: { ...initial.ui, finishTool: true }, capabilities: { ...initial.capabilities, read: true } });
    const endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
    const snapshot = () => {
      endpoint.publication!('core', (name, version, instructions, tools) => publishPluginSurface('core', name, version, instructions, tools));
      return pluginRefreshPublications().find(row => row.surface === 'core')!;
    };
    try {
      const before = snapshot();
      const tool = kind === 'finish' ? 'session_finish' : kind === 'command' ? 'exec_command' : kind;
      expect(before.tools.map(row => row.name)).toContain(tool);
      const current = getConfig();
      const patch = { ...current, ...(kind === 'finish' ? { ui: { ...current.ui, finishTool: false } } : kind === 'command' ? { capabilities: { ...current.capabilities, command: false } } : { sessions: { ...current.sessions, record: false } }) };
      expect((await save(patch)).ok).toBe(true);
      const after = snapshot();
      expect(after.tools.map(row => row.name)).not.toContain(tool);
      expect(after.schemaId).not.toBe(before.schemaId);
      const saved = getConfig();
      expect((await save({ ...saved, ui: { ...saved.ui, theme: 'dark' } })).ok).toBe(true);
      expect(snapshot().schemaId).toBe(after.schemaId);
    } finally { await endpoint.stop(); resetPluginRefreshForTests(); }
  });
});

describe('startup state without secure storage', () => {
  it('still returns a usable app/bridge state instead of crashing state discovery', async () => {
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const reply = (await handlers.get('state:get')!(trustedEvent(), undefined)) as any;
    expect(reply.ok).toBe(true);
    expect(reply.data.secureStorage.available).toBe(false);
    expect(reply.data.hasApiKey).toBe(false);
    expect(reply.data.hasGoalKey).toBe(false);
    expect(reply.data.bridge.paired).toBe(false);
  });
});

describe('OpenAI tunnel API key IPC boundary', () => {
  it('stores the key inward but projects only presence back to the renderer', async () => {
    const key = `sk-${'renderer-must-not-read-this-'.repeat(2)}`;
    const store = handlers.get('secret:set')!;
    try {
      const stored = await store(trustedEvent(), { key: 'openaiApiKey', value: key }) as any;
      expect(stored.ok, stored.error).toBe(true);
      expect(stored.data.hasApiKey).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(key);

      const state = await handlers.get('state:get')!(trustedEvent(), undefined) as any;
      expect(state.ok, state.error).toBe(true);
      expect(state.data.hasApiKey).toBe(true);
      expect(JSON.stringify(state)).not.toContain(key);
    } finally {
      await store(trustedEvent(), { key: 'openaiApiKey', value: '' });
    }
  });
});

describe('debug LAN group IPC', () => {
  const lan = (payload: unknown): Promise<any> => handlers.get('lan:action')!(trustedEvent(), payload) as Promise<any>;

  it('creates one encrypted group, toggles live discovery authority, and forgets it without projecting the key', async () => {
    await clearLanGroupKey();
    await saveConfig({ ...getConfig(), lan: { enabled: false } });
    try {
      const created = await lan({ action: 'create' });
      expect(created.ok, created.error).toBe(true);
      expect(created.data.joinKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(created.data.state.lan).toMatchObject({ enabled: true, joined: true });
      expect(JSON.stringify(created.data.state)).not.toContain(created.data.joinKey);
      expect(getConfig().lan.enabled).toBe(true);
      const groupKey = await getLanGroupKey();
      expect(groupKey).not.toBeNull();
      const identity = await getOrCreateLanPeerIdentity();
      expect(await lanPeerNicknameReservation(groupKey!, getConfig().mcp.connectorName)).toEqual({
        peerId: identity.peerId,
        nickname: getConfig().mcp.connectorName
      });

      const off = await lan({ action: 'set-enabled', enabled: false });
      expect(off).toMatchObject({ ok: true, data: { joinKey: null, state: { lan: { enabled: false, joined: true, running: false } } } });

      const on = await lan({ action: 'set-enabled', enabled: true });
      expect(on).toMatchObject({ ok: true, data: { joinKey: null, state: { lan: { enabled: true, joined: true } } } });

      const forgotten = await lan({ action: 'forget' });
      expect(forgotten).toMatchObject({ ok: true, data: { joinKey: null, state: { lan: { enabled: false, joined: false, running: false } } } });
      expect(await getLanGroupKey()).toBeNull();
      expect(getConfig().lan.enabled).toBe(false);
      expect(await lanPeerNicknameReservation(groupKey!, 'Eve')).toBeNull();
    } finally {
      await saveConfig({ ...getConfig(), lan: { enabled: false } });
      await clearLanGroupKey();
    }
  });

  it('rejects malformed join material and refuses On before a group exists', async () => {
    await clearLanGroupKey();
    await saveConfig({ ...getConfig(), lan: { enabled: false } });
    expect(await lan({ action: 'join', key: 'not-a-group-key' })).toMatchObject({ ok: false, error: expect.stringMatching(/32 bytes.*base64url/i) });
    expect(await lan({ action: 'set-enabled', enabled: true })).toMatchObject({ ok: false, error: expect.stringMatching(/create or join/i) });
    expect(getConfig().lan.enabled).toBe(false);
  });

  it('rejects malformed replacement join material without disabling or replacing a working group', async () => {
    await clearLanGroupKey();
    await saveConfig({ ...getConfig(), lan: { enabled: false } });
    try {
      const created = await lan({ action: 'create' });
      expect(created.ok, created.error).toBe(true);
      const beforeKey = await getLanGroupKey();
      expect(beforeKey).not.toBeNull();
      expect(getConfig().lan.enabled).toBe(true);

      const rejected = await lan({ action: 'join', key: 'not-a-group-key' });
      expect(rejected).toMatchObject({ ok: false, error: expect.stringMatching(/32 bytes.*base64url/i) });
      expect(await getLanGroupKey()).toEqual(beforeKey);
      expect(getConfig().lan.enabled).toBe(true);
    } finally {
      await lan({ action: 'forget' });
    }
  });

  it('still permits Off when secure storage is temporarily unavailable', async () => {
    await saveConfig({ ...getConfig(), lan: { enabled: true } });
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    const reply = await lan({ action: 'set-enabled', enabled: false });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().lan.enabled).toBe(false);
  });
});

describe('renderer IPC authority', () => {
  it('rejects an alternate renderer before plugin side effects while the active renderer still works', async () => {
    const invoke = handlers.get('plugins:legalNotices')!;
    const alternateRenderer = { sender: { send: vi.fn() } };

    const rejected = await invoke(alternateRenderer, undefined) as any;
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringMatching(/active ParadigmEve window/i)
    });
    expect(shell.openPath).not.toHaveBeenCalled();

    const trusted = await invoke(trustedEvent(), undefined) as any;
    expect(trusted).toEqual({ ok: true, data: undefined });
    expect(shell.openPath).toHaveBeenCalledTimes(1);
  });

  it('rejects everyday browser recovery from an alternate renderer before launch side effects', async () => {
    const invoke = handlers.get('browser:restoreCompanion')!;
    const rejected = await invoke({ sender: { send: vi.fn() } }, undefined) as any;
    expect(rejected).toMatchObject({ ok: false, error: expect.stringMatching(/active ParadigmEve window/i) });
    expect(setupAssistantMocks.restoreParadigmEveBrowser).not.toHaveBeenCalled();

    const trusted = await invoke(trustedEvent(), undefined) as any;
    expect(trusted.ok, trusted.error).toBe(true);
    expect(setupAssistantMocks.restoreParadigmEveBrowser).toHaveBeenCalledTimes(1);
    const restoreCalls = setupAssistantMocks.restoreParadigmEveBrowser.mock.calls as unknown as unknown[][];
    expect(typeof restoreCalls[0]?.[0]).toBe('function');
  });

  it('opens a fresh Eve Browser tab only for the active renderer', async () => {
    setupAssistantMocks.openParadigmEveChromeProfile.mockClear();
    const invoke = handlers.get('browser:openCompanionTab')!;
    const rejected = await invoke({ sender: { send: vi.fn() } }, undefined) as any;
    expect(rejected).toMatchObject({ ok: false, error: expect.stringMatching(/active ParadigmEve window/i) });
    expect(setupAssistantMocks.openParadigmEveChromeProfile).not.toHaveBeenCalled();

    const trusted = await invoke(trustedEvent(), undefined) as any;
    expect(trusted.ok, trusted.error).toBe(true);
    expect(setupAssistantMocks.openParadigmEveChromeProfile).toHaveBeenCalledTimes(1);
    expect(setupAssistantMocks.openParadigmEveChromeProfile).toHaveBeenCalledWith();
  });
});

describe('bounded readiness repair IPC', () => {
  const projected = (
    nextAction: EveReadiness['nextAction'],
    state: EveReadiness['state'] = 'needs-attention'
  ): EveReadiness => ({
    state,
    nextAction,
    summary: 'test readiness',
    detail: 'test readiness detail',
    backends: {
      orchestrator: { backend: 'gpt-chat', label: 'GPT Chat', support: 'supported', readiness: 'unknown', reason: null, detail: null },
      worker: { backend: 'gpt-chat', label: 'GPT Chat', support: 'supported', readiness: 'unknown', reason: null, detail: null }
    }
  });

  it('calls connect at most once for the derived safe repair action', async () => {
    const readiness = await import('../src/main/eve-readiness.js');
    const connection = await import('../src/main/connection.js');
    const derive = vi.spyOn(readiness, 'eveReadiness').mockReturnValue(projected('connect'));
    const connectOnce = vi.spyOn(connection, 'connect').mockResolvedValue(undefined);
    try {
      const reply = await handlers.get('readiness:repair')!(trustedEvent(), undefined) as any;
      expect(reply.ok, reply.error).toBe(true);
      expect(connectOnce).toHaveBeenCalledTimes(1);
      expect(setupAssistantMocks.restoreParadigmEveBrowser).not.toHaveBeenCalled();
      expect(derive).toHaveBeenCalled();
    } finally {
      connectOnce.mockRestore();
      derive.mockRestore();
    }
  });

  it('starts/ensures the bridge and restores the Companion at most once', async () => {
    const readiness = await import('../src/main/eve-readiness.js');
    const bridgeModule = await import('../src/main/bridge.js');
    const derive = vi.spyOn(readiness, 'eveReadiness').mockReturnValue(projected('restore-browser'));
    const ensureBridge = vi.spyOn(bridgeModule, 'startBridge').mockResolvedValue(8765);
    try {
      const reply = await handlers.get('readiness:repair')!(trustedEvent(), undefined) as any;
      expect(reply.ok, reply.error).toBe(true);
      expect(ensureBridge).toHaveBeenCalledTimes(1);
      expect(setupAssistantMocks.restoreParadigmEveBrowser).toHaveBeenCalledTimes(1);
      const restoreCalls = setupAssistantMocks.restoreParadigmEveBrowser.mock.calls as unknown as unknown[][];
      expect(typeof restoreCalls[0]?.[0]).toBe('function');
    } finally {
      ensureBridge.mockRestore();
      derive.mockRestore();
    }
  });

  it('leaves user-boundary readiness unchanged with no repair side effects', async () => {
    const readiness = await import('../src/main/eve-readiness.js');
    const connection = await import('../src/main/connection.js');
    const bridgeModule = await import('../src/main/bridge.js');
    const derive = vi.spyOn(readiness, 'eveReadiness').mockReturnValue(projected('verify-chatgpt', 'needs-user'));
    const connectOnce = vi.spyOn(connection, 'connect').mockResolvedValue(undefined);
    const ensureBridge = vi.spyOn(bridgeModule, 'startBridge').mockResolvedValue(8765);
    try {
      const reply = await handlers.get('readiness:repair')!(trustedEvent(), undefined) as any;
      expect(reply.ok, reply.error).toBe(true);
      expect(reply.data.readiness.nextAction).toBe('verify-chatgpt');
      expect(connectOnce).not.toHaveBeenCalled();
      expect(ensureBridge).not.toHaveBeenCalled();
      expect(setupAssistantMocks.restoreParadigmEveBrowser).not.toHaveBeenCalled();
    } finally {
      ensureBridge.mockRestore();
      connectOnce.mockRestore();
      derive.mockRestore();
    }
  });

  it('rejects an alternate renderer before readiness inspection or repair side effects', async () => {
    const readiness = await import('../src/main/eve-readiness.js');
    const connection = await import('../src/main/connection.js');
    const derive = vi.spyOn(readiness, 'eveReadiness').mockReturnValue(projected('connect'));
    const connectOnce = vi.spyOn(connection, 'connect').mockResolvedValue(undefined);
    try {
      const rejected = await handlers.get('readiness:repair')!({ sender: { send: vi.fn() } }, undefined) as any;
      expect(rejected).toMatchObject({ ok: false, error: expect.stringMatching(/active ParadigmEve window/i) });
      expect(derive).not.toHaveBeenCalled();
      expect(connectOnce).not.toHaveBeenCalled();
      expect(setupAssistantMocks.restoreParadigmEveBrowser).not.toHaveBeenCalled();
    } finally {
      connectOnce.mockRestore();
      derive.mockRestore();
    }
  });
});

describe('turning multi-agent mode off', () => {
  /**
   * Pausing execution must withdraw queued browser work before the bridge goes away. The
   * durable worker history itself survives; only the pending transport is cancelled.
   */
  it('cancels the run’s queued worker chats before the bridge goes away', async () => {
    await startBridge();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: 'c-prime' } });
    // Opening is asynchronous, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingCommands().length).toBe(1);

    // Recording off as well, so this really is the case where the bridge is shut down.
    await save(settings({ record: false, multiAgent: false }));

    expect(getConfig().multiAgent.enabled).toBe(false);
    expect(pendingCommands(), 'a worker chat was left queued for a run that has ended').toEqual([]);
  });

  it('does not acknowledge the toggle until the parked retained history is durable', async () => {
    const prime = '11111111-2222-4333-8444-555555555555';
    const worker = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'must stay fenced after disable' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);
    expect(await readDurable('ipc-swarm')).not.toBeNull();

    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(await readDurable<any>('ipc-swarm')).toMatchObject({
      version: 7,
      currentAgentConversationId: prime,
      runId: null,
      primeConversationId: null,
      agents: [],
      dormantRuns: [
        expect.objectContaining({
          primeConversationId: prime,
          agents: expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({
                id: 'worker-1',
                conversationId: worker,
                state: 'sleeping',
                revivable: true
              })
            })
          ])
        })
      ]
    });
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({ workers: [] });
  });

  it('survives a disabled restart and re-enable with the exact old worker chat still revivable', async () => {
    const prime = '22222222-3333-4444-8555-666666666666';
    const worker = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    spawn({ workers: [{ task: 'remember this exact worker' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved).not.toBeNull();

    // The startup path restores authority even while the feature is off, then canonicalizes
    // any leftover active incarnation into parked history. Reproduce that process boundary here.
    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    expect(snapshotSwarm()).toMatchObject({
      runId: null,
      dormantRuns: [expect.objectContaining({ primeConversationId: prime })]
    });

    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: prime }).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worker-1',
          conversationId: worker,
          state: 'sleeping',
          revivable: true
        })
      ])
    );

    sendMessage({ conversationId: prime }, 'worker-1', 'continue in the exact worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: worker })
    ]);
  });

  it('preserves every parked owner when disabling a different prime that is still active', async () => {
    const primeA = '33333333-4444-4555-8666-777777777777';
    const workerA = 'cccccccc-dddd-4eee-8fff-000000000001';
    spawn({ workers: [{ task: 'A retained history' }], caller: { conversationId: primeA } });
    expect(bindConversation('worker-1', workerA)).toBe(true);
    finishAgent({ conversationId: workerA }, 'A is parked already');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB = '44444444-5555-4666-8777-888888888888';
    const workerB = 'dddddddd-eeee-4fff-8000-000000000002';
    spawn({ workers: [{ task: 'B is live when disabled' }], caller: { conversationId: primeB } });
    expect(bindConversation('worker-1', workerB)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved?.runId).toBeNull();
    expect(saved?.dormantRuns).toHaveLength(2);
    expect(saved?.dormantRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primeConversationId: primeA }),
        expect.objectContaining({ primeConversationId: primeB })
      ])
    );

    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: primeA }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerA
    });
    expect(swarmStateForCaller({ conversationId: primeB }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerB
    });
  });

  it('keeps disabled history until the explicit Clear swarm IPC destroys it', async () => {
    const prime = '55555555-6666-4777-8888-999999999999';
    const worker = 'eeeeeeee-ffff-4000-8111-000000000003';
    spawn({ workers: [{ task: 'survive disable until explicit clear' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    expect((await readDurable<any>('ipc-swarm'))?.dormantRuns).toHaveLength(1);

    const cleared = await handlers.get('swarm:reset')!(trustedEvent(), undefined) as any;
    expect(cleared.ok, cleared.error).toBe(true);
    expect(await readDurable('ipc-swarm')).toBeNull();
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({
      workers: expect.arrayContaining([expect.objectContaining({ id: 'worker-1', conversationId: worker })])
    });
  });
});

describe('bounded IPC identities and OS launch results', () => {
  it('reports shell.openPath failure instead of claiming the extension folder opened', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Access is denied');
    const reply = (await handlers.get('bridge:openExtensionFolder')!(trustedEvent(), undefined)) as {
      ok: boolean;
      error?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/could not open.*access is denied/i);
  });

  it('has no runtime web-download IPC for the companion extension', () => {
    expect(handlers.has('bridge:downloadExtension')).toBe(false);
  });

  it('bounds and validates an agent id before it reaches the global broker', async () => {
    const clear = handlers.get('swarm:clearAgent')!;
    const oversized = (await clear(trustedEvent(), 'worker-' + 'x'.repeat(200_000))) as { ok: boolean; error?: string };
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatch(/64|too big/i);

    const punctuation = (await clear(trustedEvent(), 'worker-1\nspoofed')) as { ok: boolean; error?: string };
    expect(punctuation.ok).toBe(false);
  });
});

describe('ChatGPT browser settings', () => {
  it('persists Edge and keeps it through an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const result = await save({ ...base, ui: { ...base.ui, chatBrowser: 'edge' } }, base);
    expect(result.ok, result.error).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.chatBrowser).toBe('edge');
    const stale = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ chatBrowser: 'edge', theme: 'light' });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, chatBrowser: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.chatBrowser).toBe('edge');
  });
});

describe('Concepts presentation settings', () => {
  it('persists bounded preview choices and preserves them across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = {
      ...base,
      ui: {
        ...base.ui,
        conceptQuiltRows: 4,
        conceptPinPreviewDensity: 3 as const,
        conceptDescriptionTextSize: 'large' as const,
        conceptDescriptionRows: 6,
        conceptPromptTextSize: 'small' as const,
        conceptPromptRows: 3
      }
    };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(getConfig().ui).toMatchObject({
      conceptQuiltRows: 4,
      conceptPinPreviewDensity: 3,
      conceptDescriptionTextSize: 'large',
      conceptDescriptionRows: 6,
      conceptPromptTextSize: 'small',
      conceptPromptRows: 3
    });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui).toMatchObject({
      conceptQuiltRows: 4,
      conceptPinPreviewDensity: 3,
      conceptDescriptionTextSize: 'large',
      conceptDescriptionRows: 6,
      conceptPromptTextSize: 'small',
      conceptPromptRows: 3
    });

    expect((await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).ok).toBe(true);
    expect(getConfig().ui).toMatchObject({ conceptQuiltRows: 4, conceptPinPreviewDensity: 3, conceptDescriptionRows: 6, conceptPromptRows: 3 });

    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, conceptQuiltRows: 0 } }, current)).ok).toBe(false);
    expect((await save({ ...current, ui: { ...current.ui, conceptPinPreviewDensity: 5 as any } }, current)).ok).toBe(false);
    expect((await save({ ...current, ui: { ...current.ui, conceptPromptTextSize: 'huge' } }, current)).ok).toBe(false);
    expect(getConfig().ui).toMatchObject({ conceptQuiltRows: 4, conceptPromptTextSize: 'small' });
  });
});

describe('settings writes from more than one UI', () => {
  it('validates and persists the Plugins tunnel id through Settings, including explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'a'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).tunnel.pluginsTunnelId).toBe(tunnelId);
    for (const invalid of ['not-a-tunnel', `tunnel_${'g'.repeat(32)}`, `tunnel_${'a'.repeat(31)}`, 'x'.repeat(129)]) {
      const current = getConfig();
      expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: invalid } }, current)).ok).toBe(false);
      expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    }
    const current = getConfig();
    expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: '' } }, current)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe('');
  });

  it('preserves a newer Plugins tunnel across stale and legacy renderer saves', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'b'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    const legacy = { ...base, tunnel: { ...base.tunnel } };
    delete legacy.tunnel.pluginsTunnelId;
    expect((await save({ ...legacy, ui: { ...legacy.ui, minimizeToTray: !legacy.ui.minimizeToTray } }, legacy)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(getConfig().ui.minimizeToTray).toBe(!legacy.ui.minimizeToTray);
  });

  it('changes login registration only on a changed preference and reports failure after other effects', async () => {
    const lifecycle = await import('../src/main/window-lifecycle.js');
    const connection = await import('../src/main/connection.js');
    const applied = vi.spyOn(connection, 'applySettings');
    const login = vi.spyOn(lifecycle, 'applyLoginStartup').mockImplementation(() => { throw new Error('login registration refused'); });
    try {
      const base = defaultConfig();
      await saveConfig(base);
      const cosmetic = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
      expect(cosmetic.ok, cosmetic.error).toBe(true);
      expect(login).not.toHaveBeenCalled();
      applied.mockClear();
      const current = getConfig();
      const changed = await save({ ...current, ui: { ...current.ui, theme: 'dark', startAtLogin: true } }, current);
      expect(changed.ok).toBe(false);
      expect(changed.error).toContain('login registration refused');
      expect(getConfig().ui.startAtLogin).toBe(true);
      expect(nativeTheme.themeSource).toBe('dark');
      expect(applied).toHaveBeenCalledOnce();
      expect(login).toHaveBeenCalledOnce();
      expect(applied.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]!);
    } finally { login.mockRestore(); applied.mockRestore(); }
  });
  it('rotates only the active Goal provider and exposes key presence without the secret', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, goal: { ...base.goal, provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
    const goal = await import('../src/main/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      await handlers.get('secret:set')!(trustedEvent(), { key: 'openRouterApiKey', value: 'synthetic-inactive-key' });
      expect(retired).not.toHaveBeenCalled();
      const response = await handlers.get('secret:set')!(trustedEvent(), { key: 'customProviderApiKey', value: 'synthetic-active-key' });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(response)).not.toContain('synthetic-active-key');
    } finally { retired.mockRestore(); }
  });
  it('persists connector instructions through IPC, preserves concurrent edits, and allows explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const wanted = {
      ...base,
      mcp: { ...base.mcp, connectorName: 'Eva Å', instructions: 'Use the approved project only.' },
      ui: { ...base.ui, browserOnly: true }
    };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    const legacy = { ...base } as any; delete legacy.mcp;
    expect((await save(legacy, legacy)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    const current = getConfig();
    expect((await save({ ...current, mcp: { ...current.mcp, instructions: '' } }, current)).ok).toBe(true);
    expect(getConfig().mcp.instructions).toBe('');
    expect(getConfig().mcp.connectorName).toBe('Eva Å');
    expect((await save({ ...current, mcp: { ...current.mcp, instructions: 'x'.repeat(4001) } }, current)).ok).toBe(false);
    expect(getConfig().mcp.instructions).toBe('');
  });
  it('saves helper settings and tab retention through the renderer schema and merge boundary', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = { ...base, ui: { ...base.ui, tabsToKeepOpen: 6 }, goal: {
      ...base.goal, helperModel: 'account-helper', helperReasoning: 'medium' as const
    } };
    const result = await save(wanted, base);
    expect(result.ok, result.error).toBe(true);
    expect(getConfig().ui.tabsToKeepOpen).toBe(6);
    expect(getConfig().goal).toMatchObject({ helperModel: 'account-helper', helperReasoning: 'medium', models: base.goal.models });
  });
  it('persists the planner backend and preserves it across an unrelated stale settings save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const selected = await save({ ...base, ui: { ...base.ui, planBackend: 'api' } }, base);
    expect(selected.ok, selected.error).toBe(true);
    expect(getConfig().ui.planBackend).toBe('api');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.planBackend).toBe('api');
    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ planBackend: 'api', minimizeToTray: !base.ui.minimizeToTray });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'chatgpt' } }, current)).ok).toBe(true);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
  });
  it('round-trips agent execution choices and three-way merges each role independently', async () => {
    const base = defaultConfig();
    await saveConfig(base);

    // Another writer changes the worker after the renderer captured its base snapshot.
    await saveConfig({ ...base, execution: { orchestrator: 'gpt-chat', worker: 'ollama' } });
    const wanted = { ...base, execution: { orchestrator: 'gpt-work' as const, worker: 'gpt-chat' as const } };
    const merged = await save(wanted, base);
    expect(merged.ok, merged.error).toBe(true);
    expect(getConfig().execution).toEqual({ orchestrator: 'gpt-work', worker: 'ollama' });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).execution).toEqual({
      orchestrator: 'gpt-work', worker: 'ollama'
    });

    // The current renderer predates selectors and omits this section entirely. An unrelated
    // save must therefore keep the live backend choices untouched.
    const legacyBase = { ...base } as any;
    const legacyWanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } } as any;
    delete legacyBase.execution;
    delete legacyWanted.execution;
    expect((await save(legacyWanted, legacyBase)).ok).toBe(true);
    expect(getConfig().execution).toEqual({ orchestrator: 'gpt-work', worker: 'ollama' });
  });
  it('round-trips Ollama worker runtime settings without letting stale renderer state overwrite them', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = {
      ...base,
      execution: { orchestrator: 'gpt-chat' as const, worker: 'ollama' as const },
      agentRuntime: { ollama: { endpoint: 'http://127.0.0.1:11434/v1', model: 'gemma4:cloud' } }
    };
    const first = await save(wanted, base);
    expect(first.ok, first.error).toBe(true);
    expect(getConfig()).toMatchObject({
      execution: { orchestrator: 'gpt-chat', worker: 'ollama' },
      agentRuntime: { ollama: { endpoint: 'http://127.0.0.1:11434/v1', model: 'gemma4:cloud' } }
    });

    const live = getConfig();
    await saveConfig({
      ...live,
      agentRuntime: { ollama: { endpoint: 'https://gpu.example/v1', model: 'server-model' } }
    });
    const staleWanted = { ...wanted, ui: { ...wanted.ui, minimizeToTray: !wanted.ui.minimizeToTray } };
    expect((await save(staleWanted, wanted)).ok).toBe(true);
    expect(getConfig().agentRuntime.ollama).toEqual({ endpoint: 'https://gpu.example/v1', model: 'server-model', chatDirectTools: true });
  });
  it('does not let a stale renderer snapshot undo a newer extension setting', async () => {
    currentWindow = {
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const original = defaultConfig();
    const base = {
      ...original,
      ui: { ...original.ui, theme: 'light' as const },
      goal: { ...original.goal, enabled: true }
    };
    await saveConfig(base);

    // The extension writes after the renderer has already captured `base` for an unrelated
    // form edit. This is exactly the race a serialized config queue cannot solve by itself.
    await saveConfig({ ...base, goal: { ...base.goal, enabled: false } });
    const wanted = { ...base, ui: { ...base.ui, theme: 'dark' as const } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.theme).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#0e0e11');
    if (process.platform === 'win32') expect(currentWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 36, color: '#1a2129', symbolColor: '#b8c0c5'
    });
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('preserves a newer unattributed-call choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, allowUnattributedCalls: true }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.allowUnattributedCalls).toBe(true);
  });

  it('preserves a newer cross-chat Eve opt-out across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      eveAuthority: { ...base.eveAuthority!, allowOtherChats: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().eveAuthority?.allowOtherChats).toBe(false);
  });

  it('preserves a newer agent-tab recovery choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, recoverAgentTabs: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.recoverAgentTabs).toBe(false);
  });
});

describe('root namespace invariants', () => {
  it('approves a dropped folder path exactly like the picker, and refuses a dropped file', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await saveConfig({ ...defaultConfig(), roots: [] });
    const folder = path.join(dir, 'dropped-project');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(dir, 'dropped-file.txt');
    await fs.writeFile(file, 'not a folder');
    const addPath = (payload: unknown): Promise<any> => handlers.get('roots:addPath')!(trustedEvent(), payload) as Promise<any>;

    const added = await addPath({ path: folder });
    expect(added.ok).toBe(true);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['dropped-project']);

    // The drop zone is not a second, weaker approval path: the same validation applies.
    const refused = await addPath({ path: file });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not a folder/i);
    expect((await addPath({ path: '' })).ok).toBe(false);
    expect(getConfig().roots).toHaveLength(1);
  });

  it('refuses a live rename into the reserved /skills namespace', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [
        { name: 'project', path: 'C:\\Users\\example\\project' },
        { name: 'skills-folder', path: 'C:\\Users\\example\\skills-folder' }
      ]
    });

    const reply = await renameRoot({ name: 'project', newName: 'skills' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/reserved/i);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['project', 'skills-folder']);
  });

  it('moves live workspace bindings with a root rename and drops them with root removal', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    });
    setWorkspaceFor('chat:conv-root-change', {
      virtual: '/project/src',
      real: 'C:\\Users\\example\\project\\src'
    });

    const renamed = await renameRoot({ name: 'project', newName: 'repo' });
    expect(renamed.ok, renamed.error).toBe(true);
    expect(workspaceEntries()).toEqual([{ key: 'chat:conv-root-change', virtual: '/repo/src' }]);

    const removed = await removeRoot({ name: 'repo' });
    expect(removed.ok, removed.error).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses stale root rename/remove requests instead of reporting a no-op as success', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const renamed = await renameRoot({ name: 'gone', newName: 'other' });
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/not an approved folder/i);
    const removed = await removeRoot({ name: 'gone' });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/not an approved folder/i);
  });
});

/** Exercise the real IPC policy for both Settings buttons and authored chat links. */
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    for (const url of offered) expect(await handlers.get('link:open')!(trustedEvent(), { url })).toEqual({ ok: true, data: true });
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(trustedEvent(), { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    expect(await open(trustedEvent(), { url: 'https://example.com/reference#section' })).toEqual({ ok: true, data: true });
  });

  it.each(['https://example.com/path?q=hello', 'http://localhost:3000/', 'mailto:person@example.com?subject=Hello'])(
    'opens an authored external link: %s', async url => {
      expect(await handlers.get('link:open')!(trustedEvent(), { url })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
  );
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'ms-settings:privacy',
    'x-apple.systempreferences:unapproved', 'https://user:password@example.com/', '//example.com/',
    'https:example.com', 'https://example.com/\nfoo', 'mailto:a@example.com?body=%0Ainjected', 'https://example.com/\\path'])(
    'refuses unsafe authored link: %s', async url => {
    const before = vi.mocked(shell.openExternal).mock.calls.length;
    const refused = (await handlers.get('link:open')!(trustedEvent(), { url })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
    expect(vi.mocked(shell.openExternal).mock.calls.length).toBe(before);
  });

  it('serializes non-Error throws into a real IPC error string', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce('Windows shell refused the request');
    const reply = (await handlers.get('link:open')!(trustedEvent(), {
      url: 'https://openrouter.ai/settings/keys'
    })) as { ok: boolean; error?: string };
    expect(reply).toEqual({ ok: false, error: 'Windows shell refused the request' });
  });
});

describe('durable Thread resource destinations', () => {
  it('opens a stored local folder by durable Thread id without renderer-supplied path authority', async () => {
    const created = await handlers.get('pins:createThread')!(trustedEvent(), {
      title: 'ipc-local-folder',
      link: dir,
      collectionNames: []
    }) as { ok: true; data: { id: string } };
    expect(created.ok).toBe(true);
    expect(await handlers.get('pins:openDestination')!(trustedEvent(), { threadId: created.data.id }))
      .toEqual({ ok: true, data: true });
    expect(shell.openPath).toHaveBeenLastCalledWith(dir);
    expect(shell.openExternal).not.toHaveBeenCalledWith(dir);
  });

  it('reveals an executable-like local destination instead of executing it on a generic UI open', async () => {
    const executable = path.join(dir, 'ParadigmEve-2.2.3-x64-Angel.exe');
    await fs.writeFile(executable, 'fixture');
    const created = await handlers.get('pins:createThread')!(trustedEvent(), {
      title: 'ipc-local-executable',
      link: executable,
      collectionNames: []
    }) as { ok: true; data: { id: string } };
    const openPathCalls = vi.mocked(shell.openPath).mock.calls.length;
    expect(await handlers.get('pins:openDestination')!(trustedEvent(), { threadId: created.data.id }))
      .toEqual({ ok: true, data: true });
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(executable);
    expect(vi.mocked(shell.openPath).mock.calls.length).toBe(openPathCalls);
  });

  it('opens a local HTML document through the OS association', async () => {
    const html = path.join(dir, 'report.html');
    await fs.writeFile(html, '<!doctype html><title>Report</title>');
    const created = await handlers.get('pins:createThread')!(trustedEvent(), {
      title: 'ipc-local-html',
      link: html,
      collectionNames: []
    }) as { ok: true; data: { id: string } };
    expect(await handlers.get('pins:openDestination')!(trustedEvent(), { threadId: created.data.id }))
      .toEqual({ ok: true, data: true });
    expect(shell.openPath).toHaveBeenLastCalledWith(html);
  });
});

/**
 * The Install button, from the renderer's side of the wire.
 *
 * There is one thing to be sure of here: a press with nothing staged must not quit the app. The
 * button exists because this app is closed to the tray and a quit is rare and deliberate, so a
 * press that closed the window and installed nothing would be worse than no button at all.
 */
describe('installing a downloaded update on request', () => {
  it('refuses, and does not quit, when nothing has been downloaded', async () => {
    const before = quitToInstallCalls;
    const reply = (await handlers.get('update:install')!(trustedEvent(), undefined)) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no downloaded update/i);
    expect(quitToInstallCalls).toBe(before);
  });
});

/**
 * OpenRouter publishes twelve ids that begin with `~` — `~deepseek/deepseek-v4-flash-latest`
 * and its siblings — and they are aliases that always resolve to the newest model in a
 * family. The picker lists them because the catalogue does, so a validator that refused the
 * `~` made the one kind of entry most worth choosing the one kind that could not be saved:
 * the click reported an error and the model in use silently stayed where it was.
 */
describe('the goal model id', () => {
  const withOpenRouterModels = (openrouter: string[]) => ({
    ...settings({ record: false, multiAgent: false }),
    goal: { ...defaultConfig().goal, models: { ...defaultConfig().goal.models, openrouter } }
  });

  it('accepts the family aliases OpenRouter marks with a tilde', async () => {
    const reply = await save(withOpenRouterModels(['~z-ai/glm-latest', 'z-ai/glm-5.3']));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.models.openrouter).toEqual(['~z-ai/glm-latest', 'z-ai/glm-5.3']);
  });

  it('still accepts an ordinary pinned id, with or without a variant suffix', async () => {
    expect((await save(withOpenRouterModels(['deepseek/deepseek-v4-flash-0731']))).ok).toBe(true);
    expect((await save(withOpenRouterModels(['openai/gpt-5.2-mini:nitro']))).ok).toBe(true);
  });

  it('refuses something that is not a model id at all', async () => {
    const reply = await save(withOpenRouterModels(['not a model']));
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/vendor\/model/);
  });

  /** The shipped default is one of those aliases, so it has to survive its own validator. */
  it('accepts the default this app ships with', async () => {
    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.models.openrouter).toEqual(defaultConfig().goal.models.openrouter);
  });

  it('accepts ordered bare endpoint ids while custom and stores the base URL verbatim', async () => {
    const patch = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1/' },
        models: { ...defaultConfig().goal.models, custom: ['llama3.1', 'qwen3:8b'] }
      }
    };
    const reply = await save(patch);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.provider).toEqual({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/' });
    expect(getConfig().goal.models).toEqual({
      openrouter: defaultConfig().goal.models.openrouter,
      custom: ['llama3.1', 'qwen3:8b']
    });
  });

  it('still refuses a bare id while on OpenRouter, and an unknown provider kind', async () => {
    const custom = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' },
        models: { openrouter: ['llama3.1'], custom: ['llama3.1'] }
      }
    };
    // Same model, OpenRouter provider: the vendor/model shape still applies.
    const openrouter = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'openrouter' as const, baseUrl: '' } }
    };
    expect((await save(openrouter)).ok).toBe(false);
    const unknown = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'own' as never, baseUrl: '' } }
    };
    expect((await save(unknown)).ok).toBe(false);
  });

  it('keeps the inactive provider list unchanged when switching providers', async () => {
    const base = defaultConfig();
    base.goal.models = {
      openrouter: ['z-ai/glm-5.3', 'openai/gpt-5.2-mini'],
      custom: ['llama3.1', 'qwen3:8b']
    };
    await saveConfig(base);
    const wanted = {
      ...base,
      goal: { ...base.goal, provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' } }
    };
    const reply = await save(wanted, base);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.models).toEqual(base.goal.models);
  });
});

describe('the custom provider key slot', () => {
  const storeSecret = (payload: unknown): Promise<any> =>
    handlers.get('secret:set')!(trustedEvent(), payload) as Promise<any>;

  it('stores a custom key in its own slot and refuses an unnamed one', async () => {
    const prior = await handlers.get('state:get')!(trustedEvent(), undefined) as any;
    const stored = await storeSecret({ value: 'sk-custom-1', key: 'customProviderApiKey' });
    expect(stored.ok, stored.error).toBe(true);
    expect(stored.data.hasCustomProviderKey).toBe(true);
    // The OpenRouter slot is untouched: naming is exact, never a shared bucket.
    expect(stored.data.hasGoalKey).toBe(prior.data.hasGoalKey);
    const cleared = await storeSecret({ value: '', key: 'customProviderApiKey' });
    expect(cleared.ok).toBe(true);
    expect(cleared.data.hasCustomProviderKey).toBe(false);
    const refused = await storeSecret({ value: 'x', key: 'nobodyDefinedThis' });
    expect(refused.ok).toBe(false);
  });
});

describe('the editable goal system prompt', () => {
  it('stores a deliberate custom prompt', async () => {
    const prompt = 'Only continue explicit missing work. Return NO_REPLY when ChatGPT says done.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, prompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.prompt).toBe(prompt);
  });

  it('refuses blank and unbounded prompts at the renderer boundary', async () => {
    const base = settings({ record: false, multiAgent: false });
    expect((await save({ ...base, goal: { ...base.goal, prompt: '   ' } })).ok).toBe(false);
    expect((await save({ ...base, goal: { ...base.goal, prompt: 'x'.repeat(20_001) } })).ok).toBe(false);
  });

  /**
   * The driver prompt crosses the same boundary as the gate, so it needs the same guards.
   * It used to be a source constant no renderer could reach; now that it is editable, a
   * blank or unbounded value has to be refused here rather than reaching the goal loop.
   */
  it('stores the goal driver prompt and holds it to the same bounds', async () => {
    const objectivePrompt = 'Drive to the goal. NO_REPLY once it is reached.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, objectivePrompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.objectivePrompt).toBe(objectivePrompt);

    expect((await save({ ...base, goal: { ...base.goal, objectivePrompt: '   ' } })).ok).toBe(false);
    expect(
      (await save({ ...base, goal: { ...base.goal, objectivePrompt: 'x'.repeat(20_001) } })).ok
    ).toBe(false);
  });
});

describe('session IPC contracts', () => {
  it('projects absent live activity without persisting the runtime deadline', async () => {
    const { observeSessionModel, getSession } = await import('../src/main/session/store.js');
    const pro = await createSession({ title: 'Idle Pro', conversationId: 'idle-pro-projection' });
    const sol = await createSession({ title: 'Idle Sol', conversationId: 'idle-sol-projection' });
    await observeSessionModel(pro.id, pro.conversationId!, 'gpt-6', Date.now(), 'pro');
    await observeSessionModel(sol.id, sol.conversationId!, 'gpt-5.6', Date.now(), 'medium');
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions.find((row: any) => row.id === pro.id).activityExpiresAt).toBeNull();
    expect(reply.data.sessions.find((row: any) => row.id === sol.id).activityExpiresAt).toBeNull();
    expect(await getSession(pro.id)).not.toHaveProperty('activityExpiresAt');
  });

  it('keeps total as the whole session size on an explicit event page', async () => {
    const session = await createSession({ title: 'paged IPC total', conversationId: null });
    for (let index = 0; index < 5; index++) {
      await appendEvent(session.id, {
        time: 10_000 + index,
        source: 'app',
        kind: 'note',
        message: { text: `note-${index}`, truncated: false, chars: 6 }
      });
    }

    const reply = await sessionEvents({ id: session.id, from: 3, limit: 2 });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.events).toHaveLength(2);
    expect(reply.data.total).toBe(5);
  });

  it('does not send pressure rows for sessions it already omitted from the capped list', async () => {
    for (let index = 0; index < 61; index++) {
      await createSession({ title: `list cap ${index}`, conversationId: null });
    }
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions).toHaveLength(60);
    expect(reply.data.pressure).toHaveLength(60);
    expect(new Set(reply.data.pressure.map((entry: { id: string }) => entry.id))).toEqual(
      new Set(reply.data.sessions.map((entry: { id: string }) => entry.id))
    );
  });

  it('projects compaction pressure from the current chat context, not session lifetime history', async () => {
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'reset context pressure', conversationId: chatA });
    await appendEvent(session.id, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: { text: 'x'.repeat(8_000), truncated: false, chars: 8_000 }
    });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const reply = await sessionList();
    const listed = reply.data.sessions.find((entry: { id: string }) => entry.id === session.id);
    const pressure = reply.data.pressure.find((entry: { id: string }) => entry.id === session.id);
    expect(listed.estimatedTokens).toBeGreaterThan(0);
    expect(listed.contextTokens).toBe(0);
    expect(pressure.estimated).toBe(0);
    expect(pressure.level).toBe('ok');
  });

  it('blocks and releases the stored conversation, and never a renderer-supplied one', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'rogue chat', conversationId });

    const blocked = (await handlers.get('sessions:block')!(trustedEvent(), { id: session.id, blocked: true })) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(blocked.data).toEqual([conversationId]);
    expect(isChatBlocked(conversationId)).toBe(true);

    const released = (await handlers.get('sessions:block')!(trustedEvent(), { id: session.id, blocked: false })) as any;
    expect(released.ok, released.error).toBe(true);
    expect(released.data).toEqual([]);
    expect(isChatBlocked(conversationId)).toBe(false);

    // The renderer names a session; it can neither name a conversation nor block a session
    // that has none — the same boundary `sessions:openChat` holds.
    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = (await handlers.get('sessions:block')!(trustedEvent(), { id: unattributed.id, blocked: true })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
    resetBlockedChatsForTests();
  });

  it('releases a block when the row that carries its button is deleted', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'blocked then deleted', conversationId });
    await handlers.get('sessions:block')!(trustedEvent(), { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(trustedEvent(), { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    // Otherwise the conversation stays refused with nothing left in the app to release it.
    expect(isChatBlocked(conversationId)).toBe(false);
  });

  it('reports the blocked set with every session list, so one paint marks every row', async () => {
    const { resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while blocked', conversationId });

    expect((await sessionList()).data.blocked).toEqual([]);
    await handlers.get('sessions:block')!(trustedEvent(), { id: session.id, blocked: true });
    expect((await sessionList()).data.blocked).toEqual([conversationId]);
    resetBlockedChatsForTests();
  });

  it('opens only the stored conversation URL in Eve Browser', async () => {
    const session = await createSession({
      title: 'open me',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    });
    const reply = await handlers.get('sessions:openChat')!(trustedEvent(), { id: session.id }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(setupAssistantMocks.openParadigmEveChromeProfile).toHaveBeenCalledWith(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );

    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = await handlers.get('sessions:openChat')!(trustedEvent(), { id: unattributed.id }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
  });
});

describe('renderer pushes after the window is gone', () => {
  it('does not touch a destroyed BrowserWindow, whose members all throw', async () => {
    // Electron keeps the object after the window is destroyed, so the existing `?.` on
    // `getWindow()` never fires: the reference is truthy and reading `.webContents` throws.
    // The log push is the one that matters, because `onLog` listeners run synchronously on
    // the writer's stack — during a quit that turned every teardown log line into a throw
    // inside the teardown step that wrote it.
    const { logInfo } = await import('../src/main/logger.js');
    let touchedWebContents = false;
    const destroyed = {
      isDestroyed: () => true,
      get webContents() {
        touchedWebContents = true;
        throw new Error('Object has been destroyed');
      }
    } as unknown as import('electron').BrowserWindow;

    currentWindow = destroyed as any;
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});

describe('Stop IPC exact session and turn authority', () => {
  it('requires an explicit current turn and cannot stop a replacement conversation', async () => {
    const invoke = (payload: unknown) => handlers.get('sessions:stopTurn')!(trustedEvent(), payload) as Promise<any>;
    const conversationId = 'f1111111-aaaa-4bbb-8ccc-111111111111';
    const session = await createSession({ title: 'Stop IPC', conversationId });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'ipc-stop-one' });
    expect((await invoke({ id: session.id })).ok).toBe(false);
    expect(await invoke({ id: session.id, expectedTurnId: 'other-turn' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    // A stored historical start alone cannot authorize stopping a browser turn.
    expect(await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    await rebindSession(session.id, conversationId, 'f2222222-aaaa-4bbb-8ccc-111111111111');
    expect((await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).ok).toBe(false);
    const missing = await createSession({ title: 'No browser ownership', conversationId: null });
    expect(await invoke({ id: missing.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'session_not_recorded' });
  });
});
