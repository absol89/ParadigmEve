import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const firstId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secondId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

it('missing models retain the elected Work document without a New Chat or helper fallback', async () => {
  const h = await worker([]);
  const original = { id: 8, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(original);
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: original.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (tabId, message): Promise<any> => {
    const tab = h.tabs.find(row => row.id === tabId)!;
    if (message.type === 'clf-model-catalog-state') return { ready: true };
    if (message.type === 'clf-model-catalog') {
      if (tabId === 8) return { ok: false, prepare: true, preSend: true, url: tab.url };
      return { ok: true };
    }
    if (message.type === 'clf-prepare-model-catalog') return { ready: false, fallback: true, preSend: true, url: tab.url };
    if (message.type === 'clf-input-reuse-state') return { safe: tabId !== 8, navigationEpoch: 1 };
    if (message.type === 'clf-prepare-desktop-input') { tab.url = `https://chatgpt.com/?cos-input=${firstId}`; return { ready: true }; }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true };
  await h.inspectModels(request, true);
  await h.inspectModels(request, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
  expect(original.url).toBe(`https://chatgpt.com/c/${secondId}`);
});

it.each(['passive', 'missing-receipt', 'closed', 'cancelled'])('catalog %s cannot authorize a fallback tab', async reason => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-model-catalog-state') return { ready: true };
    if (message.type === 'clf-model-catalog') return { prepare: true, preSend: true, url: h.tabs[0]?.url };
    if (message.type === 'clf-prepare-model-catalog') {
      if (reason === 'closed') h.tabs.splice(0);
      if (reason === 'missing-receipt') return undefined;
      return { ready: false, fallback: reason !== 'cancelled', preSend: true, url: `https://chatgpt.com/c/${secondId}` };
    }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: reason !== 'passive' };
  await h.inspectModels(request, true); await h.inspectModels(request, true);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
});
it('waits for an existing hydrating or busy ChatGPT tab rather than opening another catalog helper', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: 'https://chatgpt.com/' });
  h.sendMessage.mockResolvedValue({ ok: true, ready: false });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.create).not.toHaveBeenCalled();
});
it.each([false, true])('never borrows a command-owned opening for model discovery (allowOpen=%s)', async allowOpen => {
  const marker = `https://chatgpt.com/?clf=${firstId}#clf=${firstId}`;
  const h = await worker([], undefined, {}, [], { discardProtectedTabs: {
    7: { commandId: firstId, at: Date.now(), url: marker, conversationId: null }
  } });
  h.tabs.push({ id: 7, url: marker });
  await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000, allowOpen }, true);
  expect(h.sendMessage.mock.calls.filter(([id, message]) => id === 7 && message.type.startsWith('clf-model-catalog'))).toHaveLength(0);
  if (allowOpen) {
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: secondId });
  } else {
    expect(h.create).not.toHaveBeenCalled();
  }
});
it('elects the usable chat when an older Settings tab reports its composer hidden', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}#settings/Plugins` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
  h.sendMessage.mockImplementation(async (id, message) => message.type === 'clf-model-catalog-state' ? { ok: true, ready: id === 8 } : { ok: true });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
  expect(h.sendMessage.mock.calls.filter(([id, message]) => id === 7 && message.type === 'clf-model-catalog')).toHaveLength(0);
  expect(h.create).not.toHaveBeenCalled();
});
it.each(['empty', 'draft', 'navigated', 'rejected', 'transport', 'pinned', 'pinned-during-proof'])('terminal worker failure retires only the exact empty document (%s)', async mode => {
  const h = await worker([]);
  const source = { tab: 8, documentId: 'failed-worker', navigationEpoch: 1 };
  h.tabs.push({ id: 8, url: `https://chatgpt.com/?clf=${firstId}`, pinned: mode === 'pinned' });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: source.documentId, frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.fetch.mockImplementation(async input => ({ ok: mode !== 'transport', status: mode === 'transport' ? 503 : 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, outcome: mode === 'rejected' ? 'committed' : 'terminal-failure', committed: false } }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-tab-close-check') {
      if (mode === 'navigated') h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
      if (mode === 'pinned-during-proof') h.tabs[0]!.pinned = true;
      return { safe: mode !== 'draft', conversationId: null, navigationEpoch: 1 };
    }
    return { ok: true };
  });
  await (h as any).ackCommand(firstId, 'failed', 'model unavailable', null, null, 'worker-client', source);
  expect(h.remove).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0);
  if (mode === 'empty') expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null, failedCommand: { id: firstId, client: 'worker-client' } }, { documentId: source.documentId });
});
it('executes a due refresh before an unrelated input readiness probe settles', async () => {
  const h = await worker([{ id: firstId, conversationId: null }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` }, { id: 9, url: 'https://chatgpt.com/' });
  await h.authorizeDocument({ tab: { id: 9 }, documentId: 'idle-page', frameId: 0, url: h.tabs[1]!.url }, { navigationEpoch: 1 });
  const originalFetch = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url, init) => {
    const reply = await originalFetch(url, init);
    if (new URL(url).pathname === '/status') return { ...reply, json: async () => ({ ok: true,
      inputs: [{ id: firstId, conversationId: null }], repairs: [{ conversationId: secondId, token: 'due-repair' }] }) };
    return reply;
  });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  h.sendMessage.mockImplementation(async (_tabId, message) => {
    if (message.type === 'clf-input-reuse-state') { entered(); await held; }
    return { ok: true };
  });
  const flight = h.maintain();
  try {
    await reached;
    expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('repaired') === 'due-repair')).toBe(true);
  } finally { release(); await flight; }
});

it('withholds queued input from a document being refreshed in the same pass', async () => {
  const h = await worker([{ id: firstId, conversationId: secondId }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  const originalFetch = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url, init) => {
    const reply = await originalFetch(url, init);
    if (new URL(url).pathname === '/status') return { ...reply, json: async () => ({ ok: true,
      inputs: [{ id: firstId, conversationId: secondId }], repairs: [{ conversationId: secondId, token: 'due-repair' }] }) };
    return reply;
  });
  await h.maintain();
  expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
});

it('prefers the active duplicate tab for a conversation when electing a new durable input', async () => {
  const h = await worker([{ id: firstId, conversationId: secondId }]);
  h.tabs.push(
    { id: 7, active: false, url: `https://chatgpt.com/c/${secondId}` },
    { id: 8, active: true, url: `https://chatgpt.com/c/${secondId}` }
  );

  await h.maintain();

  expect(h.sendMessage).toHaveBeenCalledWith(8, {
    type: 'clf-desktop-input', id: firstId, conversationId: secondId
  });
  expect(h.sendMessage.mock.calls.some(([id, message]) => id === 7 && message.type === 'clf-desktop-input')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
});

it('carries the direct-turn offer only to the elected existing conversation', async () => {
  const directTurn = { id: 'tool-free-turn', startedAt: 1000 };
  const h = await worker([{ id: firstId, conversationId: secondId, directTurn }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.maintain();
  expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-desktop-input', id: firstId, conversationId: secondId, directTurn });
  expect(h.create).not.toHaveBeenCalled();
});

it('carries restart-turn authority only with the elected recovery offer', async () => {
  const recoveryTurnId = 'g-old-run-0-4';
  const h = await worker([{ id: firstId, conversationId: secondId, recoveryTurnId }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.maintain();
  expect(h.sendMessage).toHaveBeenCalledWith(8, {
    type: 'clf-desktop-input', id: firstId, conversationId: secondId, recoveryTurnId
  });
  expect(h.create).not.toHaveBeenCalled();
});

it('defers model and Plugins helper maintenance while a durable input owns the browser-opening pass', async () => {
  const h = await worker(
    [{ id: firstId, conversationId: secondId, recoveryTurnId: 'restart-prime-turn' }],
    { nonce: firstId, expiresAt: Date.now() + 60_000 },
    {},
    [{ surface: 'core', schemaId: 'changed-after-update', connectorName: 'ParadigmEve' }],
  );
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });

  await h.maintain();

  expect(h.sendMessage).toHaveBeenCalledWith(8, {
    type: 'clf-desktop-input', id: firstId, conversationId: secondId, recoveryTurnId: 'restart-prime-turn'
  });
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-model-catalog' || message.type === 'clf-prepare-model-catalog')).toBe(false);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/plugin-refresh')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
});

it('does not let an abandoned pending input starve Plugins refresh after its elected tab is gone', async () => {
  const h = await worker(
    [{ id: firstId, conversationId: secondId }],
    undefined,
    { inputOpenings: { [firstId]: { tab: 99, stage: 'ready', conversationId: secondId } } },
    [{ surface: 'core', schemaId: 'changed-after-update', connectorName: 'ParadigmEve' }],
  );

  await h.maintain();

  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/plugin-refresh')).toBe(true);
});

type Tab = { id: number; url?: string; pendingUrl?: string; windowId?: number; active?: boolean; pinned?: boolean };
async function worker(inputs: Array<{ id: string; conversationId: string | null; directTurn?: { id: string; startedAt: number }; recoveryTurnId?: string; supersededConversationId?: string }>, modelCatalogRequest?: { nonce: string; expiresAt: number }, priorLocal: Record<string, unknown> = {}, pluginRefreshRequests: unknown[] = [], priorSession: Record<string, unknown> = {}) {
  const tabs: Tab[] = [];
  const event = { addListener: () => {} };
  const localSaved: Record<string, unknown> = { port: 8765, token: 'test-pairing', ...priorLocal };
  const local = { get: async () => ({ ...localSaved }), set: vi.fn(async (value: object) => { Object.assign(localSaved, value); }), remove: async () => {} };
  const saved: Record<string, unknown> = { ...priorSession };
  const session = { get: async () => ({ ...saved }), set: async (value: object) => { Object.assign(saved, value); }, remove: async (key: string) => { delete saved[key]; } };
  const create = vi.fn(async ({ url, windowId }: { url: string; windowId?: number }) => {
    const tab = { id: tabs.length + 1, pendingUrl: url, windowId }; tabs.push(tab); return tab;
  });
  const windows = {
    get: vi.fn(async (id: number) => ({ id, focused: false })),
    create: vi.fn(async ({ url }: { url: string }) => ({ id: 80, tabs: [await create({ url, windowId: 80 })] })),
    update: vi.fn()
  };
  const remove = vi.fn(async (_id: number) => {});
  const query = vi.fn(async () => [...tabs]);
  const reload = vi.fn(async (_id: number) => {});
  const sendMessage = vi.fn(async (_id: number, _message: any): Promise<{ ok: boolean; ready?: boolean }> => ({ ok: true, ready: true }));
  const update = vi.fn(async (id: number, patch: Partial<Tab>) => { const tab = tabs.find(tab => tab.id === id)!; Object.assign(tab, patch); delete tab.pendingUrl; return tab; });
  const fetch = vi.fn(async (input: string, _init?: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => ({
    ok: true, status: 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs, background: true, modelCatalogRequest, pluginRefreshRequests }
  }));
  const context = vm.createContext({
    chrome: {
      storage: { local, session },
      windows,
      runtime: { getManifest: () => ({ version: '2.0.5' }), onMessage: event, onInstalled: event, onStartup: event },
      tabs: { query, get: async (id: number) => tabs.find(tab => tab.id === id), remove, reload, create, update, sendMessage, onCreated: event, onUpdated: event, onRemoved: event },
      alarms: { onAlarm: event, create: () => {}, clear: async () => true },
      scripting: { executeScript: async () => [], insertCSS: async () => {} }
    },
    fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder, console
  });
  vm.runInContext(`${source}\nglobalThis.testMaintenance = { load, maintain, releaseTab, serializeTab, noteTabConversation, createChatTab, prepareDesktopInputTarget, returnScheduledInputToBackground, authorizeDocument, ackDesktopInput, drainCommandAcks, inspectRequestedModels, desktopInput: HANDLERS.desktop_input, catalog: HANDLERS.model_catalog, events: HANDLERS.events, applyRequestedBrowserPreferences };`, context);
  const api = context.testMaintenance as { releaseTab(...args: any[]): Promise<any>; serializeTab(tab: number, operation: () => Promise<any>): Promise<any>; noteTabConversation(source: any, conversationId: string): Promise<any>; applyRequestedBrowserPreferences(request: object): Promise<void>; prepareDesktopInputTarget(tab: Tab, conversationId?: string | null): Promise<boolean>; returnScheduledInputToBackground(source: unknown): Promise<boolean>; authorizeDocument(sender: unknown, message: unknown): Promise<any>; catalog(message: unknown, sender: unknown, source: unknown): Promise<any>; load(): Promise<void>; maintain(): Promise<void>; createChatTab(url: string, background: boolean): Promise<Tab> };
  await api.load();
  Object.assign(api, { query });
  vm.runInContext('Object.assign(testMaintenance, { offerStopTurns, noteTabConversation, ackCommand })', context);
  return { ...api, update, inspectModels: (context.testMaintenance as any).inspectRequestedModels as (request: unknown, background: boolean) => Promise<void>, ackDesktopInput: (context.testMaintenance as any).ackDesktopInput as (...args: string[]) => Promise<any>, drainCommandAcks: (context.testMaintenance as any).drainCommandAcks as () => Promise<any>, desktopInput: (context.testMaintenance as any).desktopInput as (...args: any[]) => Promise<any>, events: (context.testMaintenance as any).events as (message: any, sender: any, source: any) => Promise<any>, create, sendMessage, tabs, fetch, windows, remove, reload, local, localSaved, saved };
}

describe('one browser maintenance flight per desktop outbox publication', () => {
  it('retires a restored terminal input marker only from its proven app-owned empty window', async () => {
    const h = await worker([], undefined, {
      inputOpenings: { [firstId]: { tab: 7, stage: 'ready', conversationId: null } }
    });
    const tab = { id: 9, windowId: 80, url: `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}` };
    h.tabs.push(tab);
    await h.authorizeDocument({ tab: { id: 9 }, documentId: 'restored-failed-input', frameId: 0, url: tab.url }, { navigationEpoch: 1 });
    h.fetch.mockImplementation(async input => ({ ok: true, status: 200, json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [], inputOpeningIds: [], retiredInputOpeningIds: [firstId], background: true } }));
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? { ok: true, safe: true, navigationEpoch: 1 } as never : { ok: true });

    await h.maintain();

    expect(h.remove).toHaveBeenCalledExactlyOnceWith(9);
    expect((h.localSaved.inputOpenings as any)[firstId]).toBeUndefined();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('leaves a terminal input marker inert in a personal or unsafe page', async () => {
    const h = await worker([], undefined, {
      inputOpenings: { [firstId]: { tab: 7, stage: 'ready', conversationId: null } }
    });
    const marker = { id: 9, windowId: 80, url: `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}` };
    h.tabs.push(marker, { id: 10, windowId: 80, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 9 }, documentId: 'copied-marker', frameId: 0, url: marker.url }, { navigationEpoch: 1 });
    h.fetch.mockImplementation(async input => ({ ok: true, status: 200, json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [], inputOpeningIds: [], retiredInputOpeningIds: [firstId], background: true } }));
    h.sendMessage.mockResolvedValue({ ok: true, safe: true, navigationEpoch: 1 } as never);

    await h.maintain();

    expect(h.remove).not.toHaveBeenCalled();
    expect((h.localSaved.inputOpenings as any)[firstId]).toBeDefined();
  });

  it('selects the exact elected input tab and restores only its owned minimized background window before offers', async () => {
    const h = await worker([]);
    h.saved.chatBackgroundWindow = 80;
    const tab = { id: 7, windowId: 80, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(tab);
    h.windows.get.mockResolvedValue({ id: 80, state: 'minimized' } as never);

    await expect(h.prepareDesktopInputTarget(tab)).resolves.toBe(true);

    expect(h.update).toHaveBeenCalledWith(7, { active: true });
    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'normal', focused: false });
    expect(source).toContain('if (!await prepareDesktopInputTarget(tab, null)) continue;');
    expect(source).toContain('if (!await prepareDesktopInputTarget(tab, target)) continue;');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'clf-browser-repair-state', conversationId: '' },
      undefined
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not restore an unrelated window while preparing an app-input tab', async () => {
    const h = await worker([]);
    h.saved.chatBackgroundWindow = 80;
    const tab = { id: 7, windowId: 81, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(tab);
    h.windows.get.mockResolvedValue({ id: 80, state: 'minimized' } as never);

    await expect(h.prepareDesktopInputTarget(tab)).resolves.toBe(true);

    expect(h.update).toHaveBeenCalledWith(7, { active: true });
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it('does not switch away from the human foreground tab in a focused Chrome window', async () => {
    const h = await worker([]);
    const foreground = { id: 6, windowId: 80, active: true, url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const target = { id: 7, windowId: 80, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(foreground, target);
    h.windows.get.mockResolvedValue({ id: 80, state: 'normal', focused: true } as never);

    await expect(h.prepareDesktopInputTarget(target, secondId)).resolves.toBe(false);

    expect(h.update).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it('may select work inside an unfocused app-owned Chrome window', async () => {
    const h = await worker([]);
    h.saved.chatBackgroundWindow = 80;
    const foreground = { id: 6, windowId: 80, active: true, url: 'https://chatgpt.com/' };
    const target = { id: 7, windowId: 80, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(foreground, target);
    h.windows.get.mockResolvedValue({ id: 80, state: 'normal', focused: false } as never);

    await expect(h.prepareDesktopInputTarget(target, secondId)).resolves.toBe(true);

    expect(h.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('waits before selecting an existing chat while the human is typing', async () => {
    const h = await worker([]);
    const tab = { id: 7, windowId: 80, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(tab);
    h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
      if (message.type === 'clf-browser-repair-state') {
        return { ok: true, protect: true, reason: 'human_typing', conversationId: secondId };
      }
      return { ok: true };
    });

    await expect(h.prepareDesktopInputTarget(tab, secondId)).resolves.toBe(false);

    expect(h.update).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it('does not select a tab when the page cannot prove its draft and voice state is safe', async () => {
    const h = await worker([]);
    const tab = { id: 7, windowId: 80, active: false, url: `https://chatgpt.com/c/${secondId}` };
    h.tabs.push(tab);
    h.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));

    await expect(h.prepareDesktopInputTarget(tab, secondId)).resolves.toBe(false);

    expect(h.update).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it('still permits an app-owned fresh bootstrap to replace a stale autosaved home draft', async () => {
    const h = await worker([]);
    const tab = { id: 7, windowId: 80, active: false, url: 'https://chatgpt.com/?cos-input=fresh' };
    h.tabs.push(tab);
    h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
      if (message.type === 'clf-browser-repair-state') {
        return { ok: true, protect: true, reason: 'stale_draft', conversationId: null };
      }
      return { ok: true };
    });

    await expect(h.prepareDesktopInputTarget(tab, null)).resolves.toBe(true);

    expect(h.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('leaves a fresh app-owned input alone after the human has taken over its draft', async () => {
    const h = await worker([]);
    const tab = { id: 7, windowId: 80, active: false, url: 'https://chatgpt.com/?cos-input=fresh' };
    h.tabs.push(tab);
    h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
      if (message.type === 'clf-browser-repair-state') {
        return { ok: true, protect: true, reason: 'human_draft', conversationId: null };
      }
      return { ok: true };
    });

    await expect(h.prepareDesktopInputTarget(tab, null)).resolves.toBe(false);

    expect(h.update).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it('moves a queued checkpoint to its existing compacted successor once, including legacy elections', async () => {
    const input = { id: firstId, conversationId: secondId, supersededConversationId: firstId };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-desktop-input', id: firstId, conversationId: secondId }));
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.splice(1, 1, { id: 9, url: `https://chatgpt.com/c/${secondId}` });
    h.sendMessage.mockClear();
    await h.maintain();
    expect(h.sendMessage.mock.calls.some(([id, message]) => id === 9 && message.type === 'clf-desktop-input')).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
    const restarted = await worker([input], undefined, h.localSaved);
    restarted.tabs.push({ id: 9, url: `https://chatgpt.com/c/${secondId}` });
    await restarted.maintain();
    expect(restarted.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it('does not open a missing successor for an already elected checkpoint', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId, supersededConversationId: firstId }], undefined,
      { inputOpenings: { [firstId]: { tab: 7, conversationId: firstId, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  });

  it.each(['closed', 'navigated'])('does not reopen an elected input tab after it is %s, including browser restart', async reason => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input]);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    if (reason === 'closed') h.tabs.length = 0;
    else { h.tabs[0]!.url = 'https://chatgpt.com/'; delete h.tabs[0]!.pendingUrl; }
    await h.maintain(); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    const restarted = await worker([input], undefined, h.localSaved);
    await restarted.maintain();
    expect(restarted.create).not.toHaveBeenCalled();
  });
  it('spends input opening authority before creation and permits a new explicit operation', async () => {
    const inputs = [{ id: firstId, conversationId: null }];
    const h = await worker(inputs);
    h.create.mockImplementationOnce(async () => { throw new Error('Chrome rejected creation'); });
    await expect(h.maintain()).rejects.toThrow('Chrome rejected creation'); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    inputs.splice(0, 1, { id: secondId, conversationId: null });
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not create behind a failed custody write', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.local.set.mockImplementation(async value => {
      if ('inputOpenings' in value) throw new Error('disk full');
      Object.assign(h.localSaved, value);
    });
    await expect(h.maintain()).rejects.toThrow('disk full'); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('restores the pre-create checkpoint without reopening after a crash before tab-id persistence', async () => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: null } } });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 9, url: `https://chatgpt.com/?cos-input=${firstId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(9, expect.objectContaining({ type: 'clf-desktop-input', id: firstId }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('does not confuse a temporarily withheld offer with retired opening authority', async () => {
    const input = { id: firstId, conversationId: null };
    const inputs = [input];
    const h = await worker(inputs);
    await h.maintain(); h.tabs.length = 0;
    inputs.length = 0;
    await h.maintain();
    inputs.push(input);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['unpinned', 'pinned', 'pinned-during-proof'])('respects pinning when retiring a temporary planner (%s)', async mode => {
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, retire: true } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`, pinned: mode === 'pinned' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async () => {
      if (mode === 'pinned-during-proof') h.tabs[0]!.pinned = true;
      return { safe: true } as never;
    });
    await h.maintain();
    if (mode === 'unpinned') expect(h.remove).toHaveBeenCalledWith(7);
    else expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('never opens a helper for passive model observation, including repeated maintenance', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: false };
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels(request, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains model discovery custody when a user closes its elected tab', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    h.tabs.length = 0;
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    // Only a new explicit request can authorize another tab.
    await h.inspectModels({ ...request, nonce: secondId }, true);
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not close a temporary planner when its answer is accepted', async () => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`;
    h.tabs.push({ id: 7, url });
    const sender = { tab: { id: 7 }, documentId: 'planner', frameId: 0, url };
    const owner = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect((await h.desktopInput({ id: firstId, owner: '7:planner:1', lifetime: 'temporary-planner', response: 'Plan complete' }, sender, owner)).ok).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps the completed planner until a newer app-work tab exists, then closes only the planner', async () => {
    const work = { id: secondId, conversationId: null };
    const cleanup = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] };
    const inputs = [cleanup];
    const h = await worker(inputs);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-close-temporary-planner' ? { safe: true } as never : { ok: true });
    await h.maintain(); expect(h.remove).not.toHaveBeenCalled();
    // The existing unrelated chat is not a successor. Opening the queued app input is.
    inputs.unshift(work as typeof cleanup);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.remove.mock.calls).toEqual([[7]]);
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0]!);
  });
  it('closes a finished planner that ChatGPT moved to /c/<id>?temporary-chat=true after Send', async () => {
    // Ported from Chat On Steroids 2.1.17: the routed helper URL drops cos-input, so its elected
    // tab is the only locator, and the page's exact decision proof is the only close authority.
    const work = { id: secondId, conversationId: null };
    const cleanup = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] };
    const h = await worker([work as typeof cleanup, cleanup], undefined, { inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } } });
    const routed = 'https://chatgpt.com/c/f0f00020-2222-4222-8222-222222222222?temporary-chat=true';
    h.tabs.push({ id: 7, url: routed });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: routed }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-close-temporary-planner' ? { safe: true } as never : { ok: true });
    await h.maintain();
    expect(h.remove.mock.calls).toEqual([[7]]);
  });
  it('never closes an ordinary chat through a planner election, even when the page reports it safe', async () => {
    const work = { id: secondId, conversationId: null };
    const cleanup = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] };
    const h = await worker([work as typeof cleanup, cleanup], undefined, { inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } } });
    const ordinary = 'https://chatgpt.com/c/f0f00020-2222-4222-8222-222222222222';
    h.tabs.push({ id: 7, url: ordinary });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: ordinary }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-close-temporary-planner' ? { safe: true } as never : { ok: true });
    await h.maintain();
    expect(h.remove).not.toHaveBeenCalledWith(7);
  });
  it.each(['draft', 'replacement-closed', 'navigation'])('keeps a retiring planner when %s prevents safe handoff', async reason => {
    const work = { id: secondId, conversationId: null };
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-input=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-close-temporary-planner') return { ok: true };
      if (reason === 'replacement-closed') h.tabs.pop();
      if (reason === 'navigation') h.tabs[0]!.url = 'https://chatgpt.com/';
      return { safe: reason !== 'draft' } as never;
    });
    await h.maintain(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('creates a small owned restore size, then minimizes without changing geometry again', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], background: true, browserWindowBounds: { left: -1510, top: 220, width: 800, height: 600 } }) });
    await h.maintain();
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, left: -1510, top: 220, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledExactlyOnceWith(80, { state: 'minimized', focused: false });
  });
  it('reuses an idle conversation without opening or navigating a helper', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog', nonce: firstId }));
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps catalog discovery minimized and unfocused even when foreground chats are preferred', async () => {
    const h = await worker([]);
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, false);
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'minimized', focused: false });
    expect(h.windows.update).toHaveBeenCalledTimes(1);
  });
  it('places an offered worker in its unfocused background window with discard protection', async () => {
    const h = await worker([]);
    let offered = true;
    h.fetch.mockImplementation(async (input) => ({ ok: true, status: 200, json: async () => {
      if (new URL(input).pathname === '/hello') return { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
      const placement = offered ? { id: firstId, background: true, model: 'gpt-5.6-sol', reasoningEffort: 'medium' } : null;
      offered = false;
      return { ok: true, placement, inputs: [], background: true };
    } }));
    await h.maintain();
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'minimized', focused: false });
    expect(h.windows.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(1, { autoDiscardable: false });
    expect(String(h.create.mock.calls[0]?.[0]?.url)).toContain('model=gpt-5.6-sol&reasoning_effort=medium');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('retains the completed exact dedicated catalog for first-message reuse', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    const request = { nonce: secondId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: secondId, tab: 7 });
    await h.inspectModels(request, true);
    await h.inspectModels(null, true);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('retains a sole completed catalog after its draft clears', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    let safe = false;
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    safe = true;
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('preserves a draft on a catalog marker and waits for unreachable old helpers instead of accumulating tabs', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    h.sendMessage.mockRejectedValueOnce(new Error('document loading'));
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockResolvedValue({ ok: true, ready: false });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('hands the retained catalog to the first new input and never reopens it after the user closes it', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    h.saved.modelCatalogOwner = { nonce: secondId, tab: 7 };
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'warm', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-prepare-desktop-input', id: firstId }, { documentId: 'warm' });
    expect(h.update).toHaveBeenCalledWith(7, { active: true });
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    h.tabs.splice(0);
    await h.maintain();
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('reuses a safe unmarked New Chat page for a new input', async () => {
    const url = 'https://chatgpt.com/';
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url, active: true });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain(); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    expect((h.localSaved.inputOpenings as any)[firstId].tab).toBe(7);
  });
  it('never elects a Compact & Resume successor tab for another input, even if its page answers safe', async () => {
    // 2026-09-30: an idle `/?clf=<command>` successor was elected for a fresh input, which typed that
    // input into it and moved it to another chat; the resume stayed not-attempted for good.
    const url = 'https://chatgpt.com/?clf=90a4be7887872f02#clf=90a4be7887872f02';
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url, active: true });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'successor', frameId: 0, url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], reusableConversations: [] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      return { ok: true, ready: true };
    });
    await h.maintain(); await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([tabId, message]) => tabId === 7 &&
      ['clf-input-reuse-state', 'clf-prepare-desktop-input', 'clf-desktop-input'].includes((message as { type: string }).type))).toEqual([]);
    expect(h.tabs.find(tab => tab.id === 7)!.url).toBe(url);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('hard-navigates a reusable completed conversation before offering a fresh input', async () => {
    const oldUrl = `https://chatgpt.com/c/${secondId}`;
    const freshUrl = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: oldUrl, active: true });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'old-conversation', frameId: 0, url: oldUrl }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? { ok: true, safe: true, navigationEpoch: 1 } as never
      : { ok: true } as never);

    await h.maintain();

    expect(h.update).toHaveBeenCalledWith(7, { url: freshUrl });
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'preparing' });
    expect(h.create).not.toHaveBeenCalled();

    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'fresh-input', frameId: 0, url: freshUrl }, { navigationEpoch: 2 });
    await h.maintain();

    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'ready' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each(['pinned', 'pinned-during-proof'])('preserves a %s conversation instead of recycling it for New Chat', async scenario => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    const tab = { id: 7, url: `https://chatgpt.com/c/${secondId}`, pinned: scenario === 'pinned' };
    h.tabs.push(tab);
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: tab.url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true,
      inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') { tab.pinned = true; return { ok: true, safe: true, navigationEpoch: 1 } as never; }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-prepare-desktop-input')).toBe(false);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(tab.url).toContain(`/c/${secondId}`);
  });
  it('bounds a hung reuse observation before electing one fresh tab for the same input', async () => {
    vi.useFakeTimers();
    let resolveReuse: ((value: unknown) => void) | undefined;
    try {
      const h = await worker([{ id: firstId, conversationId: null }]);
      h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: true });
      await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
      h.sendMessage.mockImplementation(async (_id, message) => {
        if (message.type === 'clf-input-reuse-state') return new Promise(resolve => { resolveReuse = resolve; }) as never;
        return { ok: true, ready: true };
      });

      let released = false;
      const firstWake = h.maintain().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      expect(released).toBe(true);
      await firstWake;

      const marked = h.tabs.filter(tab => String(tab.pendingUrl || tab.url || '').includes(`cos-input=${firstId}`));
      expect(marked).toHaveLength(1);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);

      resolveReuse?.({ ok: true, safe: true, navigationEpoch: 1 });
      await Promise.resolve();
      marked[0]!.url = marked[0]!.pendingUrl;
      delete marked[0]!.pendingUrl;
      await h.maintain();
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
        .toEqual([[marked[0]!.id, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    } finally {
      resolveReuse?.({ ok: true, safe: true, navigationEpoch: 1 });
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
  it('bounds a hung preparation receipt without granting fallback or send authority', async () => {
    vi.useFakeTimers();
    let resolvePrepare: ((value: unknown) => void) | undefined;
    try {
      const h = await worker([{ id: firstId, conversationId: null }]);
      h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: true });
      await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
      h.sendMessage.mockImplementation(async (_id, message) => {
        if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
        if (message.type === 'clf-prepare-desktop-input') return new Promise(resolve => { resolvePrepare = resolve; }) as never;
        return { ok: true };
      });

      let released = false;
      const wake = h.maintain().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(15000);
      await Promise.resolve();
      expect(released).toBe(true);
      await wake;
      expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'preparing' });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);

      resolvePrepare?.({ ready: false, fallback: true, preSend: true });
      await Promise.resolve();
      expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'preparing' });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    } finally {
      resolvePrepare?.({ ready: false, fallback: true, preSend: true });
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
  it.each(['unsafe', 'missing', 'stale'])('retains preparing custody when later reuse proof is %s', async proof => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? (proof === 'unsafe' ? { ok: true, safe: false, navigationEpoch: 1 }
        : proof === 'stale' ? { ok: true, safe: true, navigationEpoch: 2 } : undefined) as never
      : { ok: true, ready: true });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'preparing' });
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('ignores a stale conversation registry entry on the exact elected home document', async () => {
    const h = await worker([{ id: firstId, conversationId: null } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, secondId);
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
        return { ready: true } as never;
      }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(1);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'ready' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('still protects a concrete non-reusable conversation during preparing recovery', async () => {
    const h = await worker([{ id: firstId, conversationId: null } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'other-chat', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockResolvedValue({ ok: true, safe: true, navigationEpoch: 1 } as never);
    await h.maintain();
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'preparing' });
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retries the same preparation only after an exact idle proof for its owned document', async () => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
        return { ready: true } as never;
      }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input'))
      .toEqual([[7, { type: 'clf-prepare-desktop-input', id: firstId }, { documentId: 'idle' }]]);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'ready' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('resumes one offer when the exact preparing tab already carries the input marker', async () => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}` });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('continues to an independent repair when the final input offer never resolves', async () => {
    let resolveOffer!: (value: unknown) => void;
    const pendingOffer = new Promise(resolve => { resolveOffer = resolve; });
    let wake: Promise<void> | undefined;
    try {
      const input = { id: firstId, conversationId: secondId };
      const h = await worker([input]);
      h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` }, { id: 8, url: `https://chatgpt.com/c/${firstId}` });
      h.fetch.mockImplementation(async request => ({ ok: true, status: 200, json: async () => new URL(request).pathname === '/hello'
        ? { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
        : { ok: true, inputs: [input], inputOpeningIds: [firstId], repairs: [{ conversationId: firstId, token: 'repair-one' }] } }));
      h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-desktop-input'
        ? pendingOffer as never : { ok: true, ready: true });

      wake = h.maintain();
      await vi.waitFor(() => expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(true));
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
        .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId }]]);
      expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
      expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'ready', conversationId: secondId });
      expect(h.create).not.toHaveBeenCalled();
      resolveOffer({ ok: true });
      await wake;
    } finally {
      resolveOffer({ ok: true });
      await wake;
    }
  });
  it('repairs a conversation before offering its queued input on a later status pass', async () => {
    const input = { id: firstId, conversationId: secondId };
    const h = await worker([input]);
    let repaired = false;
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    h.fetch.mockImplementation(async request => ({ ok: true, status: 200, json: async () => {
      const url = new URL(request);
      if (url.pathname === '/hello') return { app: 'chat-on-steroids', product: 'paradigmeve', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
      if (url.searchParams.has('repaired')) { repaired = true; return { ok: true }; }
      return { ok: true, inputs: [input], inputOpeningIds: [firstId],
        repairs: repaired ? [] : [{ conversationId: secondId, token: 'repair-same' }] };
    } }));
    await h.maintain();
    expect(h.reload).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect((h.localSaved.inputOpenings as any)[firstId]).toBeUndefined();
    expect(h.create).not.toHaveBeenCalled();
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toEqual({ tab: 7, stage: 'ready', conversationId: secondId });
  });
  it('opens one clean chat on the first offer when the existing surface is unavailable', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    const url = 'https://chatgpt.com/#settings';
    h.tabs.push({ id: 7, url });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'unavailable', frameId: 0, url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? { safe: false, navigationEpoch: 1 } as never : { ok: true });
    h.create.mockImplementation(async ({ url: freshUrl, windowId }: { url: string; windowId?: number }) => {
      const tab = { id: 8, pendingUrl: freshUrl, windowId };
      h.tabs.push(tab);
      setTimeout(() => {
        (tab as Tab).url = freshUrl;
        delete (tab as Tab).pendingUrl;
        void h.authorizeDocument({ tab: { id: tab.id }, documentId: 'fresh-input', frameId: 0, url: freshUrl }, { navigationEpoch: 1 });
      }, 0);
      return tab;
    });
    await h.maintain();
    // The offer follows the fresh tab's load on its own, without holding the maintenance flight.
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-desktop-input', id: firstId, conversationId: null }));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs[0]!.url).toBe(url);
    expect(h.tabs[1]!.url).toBe(`https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`);
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-prepare-desktop-input')).toBe(false);
  });
  it.each(['explicit-failure', 'ambiguous', 'closed'])('allows a single pre-send fallback only for %s', async reason => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        if (reason === 'ambiguous') throw new Error('lost response');
        if (reason === 'closed') h.tabs.length = 0;
        return { ready: false, fallback: true, preSend: true } as never;
      }
      return { ok: false };
    });
    await h.maintain(); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(reason === 'explicit-failure' ? 1 : 0);
    h.tabs.length = 0;
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(reason === 'explicit-failure' ? 1 : 0);
  });
  it('delivers follow-up messages into an already open waiting conversation without closing or creating tabs', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain(); await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId });
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(7, { active: true });
  });
  it('does not overwrite a draft to reuse a catalog document', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'draft', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: false, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.maintain();
    expect(h.update.mock.calls.some(([id, patch]) => id === 7 && 'url' in patch)).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('adopts the oldest ready catalog and retires only its exact empty duplicate after restart', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` }, { id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` },
      { id: 9, url: `https://chatgpt.com/c/${firstId}` }, { id: 10, url: 'https://chatgpt.com/?cos-model-catalog=personal' });
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null }, { documentId: 'duplicate' });
    expect(h.remove.mock.calls).toEqual([[8]]);
    await h.inspectModels(null, true);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(['draft', 'navigation', 'document', 'unregistered', 'pinned', 'pinned-during-proof'])('preserves a catalog duplicate with %s uncertainty', async reason => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    h.tabs[1]!.pinned = reason === 'pinned';
    const sender = { tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[1]!.url };
    if (reason !== 'unregistered') await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-tab-close-check') return { ok: true, ready: true };
      if (reason === 'navigation') h.tabs[1] = { id: 8, url: `https://chatgpt.com/c/${secondId}` };
      if (reason === 'pinned-during-proof') h.tabs[1]!.pinned = true;
      if (reason === 'document') await h.authorizeDocument({ ...sender, documentId: 'replacement' }, { navigationEpoch: 1 });
      return { ok: true, safe: reason !== 'draft', conversationId: null, navigationEpoch: 1 } as never;
    });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retires a newly hydrated duplicate on existing maintenance after catalog completion', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'hydrated', frameId: 0, url: h.tabs[1]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockClear();
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels(null, true);
    expect(h.remove.mock.calls).toEqual([[8]]);
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-model-catalog')).toBe(false);
  });
  it('durably replays an exact input ACK after HTTP loss and worker restart without sending text', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    const receipt = { id: firstId, owner: '7:original-document:0', conversationId: 'conversation-a', messageId: 'native-user-a' };
    expect(await h.ackDesktopInput(receipt.id, receipt.owner, receipt.conversationId, receipt.messageId)).toMatchObject({ ok: true, queued: true });
    expect(h.localSaved.commandAckOutbox).toEqual([expect.objectContaining({ kind: 'input', ...receipt })]);
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const requests = restarted.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.[1]?.body))).toEqual(receipt);
    expect(restarted.localSaved.commandAckOutbox).toEqual([]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects a different receipt for the same input and never acknowledges failed durable custody', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    await h.ackDesktopInput(firstId, 'owner', 'conversation-a', 'native-a');
    expect(await h.ackDesktopInput(firstId, 'owner', 'conversation-b', 'native-b')).toMatchObject({ ok: false, error: 'conflicting_send_receipt' });
    h.local.set.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(h.ackDesktopInput(secondId, 'owner', 'conversation-b', 'native-b')).rejects.toThrow('storage unavailable');
  });
  it('journals only a receipt belonging to the current exact document and conversation', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'document-a', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const receipt = { id: firstId, owner: '7:document-a:0', conversationId: firstId, messageId: 'native-a', ack: true };
    h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: false, error: 'stale_send_receipt' });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(0);
    h.tabs[0]!.url = sender.url;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: true });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(1);
  });
  it('returns an acknowledged Schedule send to the unfocused app-owned background window', async () => {
    const h = await worker([]);
    h.saved.chatBackgroundWindow = 80;
    const tab = { id: 7, windowId: 80, active: true, url: `https://chatgpt.com/c/${firstId}` };
    h.tabs.push(tab);
    h.windows.get.mockResolvedValue({ id: 80, state: 'normal', focused: false } as never);
    const sender = { tab: { id: 7 }, documentId: 'schedule-document', frameId: 0, url: tab.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });

    expect(await h.desktopInput({
      id: firstId, owner: '7:schedule-document:1', conversationId: firstId,
      messageId: 'native-schedule-user', purpose: 'schedule', ack: true
    }, sender, source)).toMatchObject({ ok: true });

    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'minimized', focused: false });
  });
  it('never minimizes a focused window or a non-Schedule browser input after ACK', async () => {
    const h = await worker([]);
    h.saved.chatBackgroundWindow = 80;
    const tab = { id: 7, windowId: 80, active: true, url: `https://chatgpt.com/c/${firstId}` };
    h.tabs.push(tab);
    const sender = { tab: { id: 7 }, documentId: 'visible-document', frameId: 0, url: tab.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.windows.get.mockResolvedValue({ id: 80, state: 'normal', focused: true } as never);

    expect(await h.desktopInput({
      id: firstId, owner: '7:visible-document:1', conversationId: firstId,
      messageId: 'native-visible-user', purpose: 'schedule', ack: true
    }, sender, source)).toMatchObject({ ok: true });
    expect(h.windows.update).not.toHaveBeenCalled();

    h.windows.get.mockResolvedValue({ id: 80, state: 'normal', focused: false } as never);
    expect(await h.desktopInput({
      id: secondId, owner: '7:visible-document:1', conversationId: firstId,
      messageId: 'native-ordinary-user', ack: true
    }, sender, source)).toMatchObject({ ok: true });
    expect(h.windows.update).not.toHaveBeenCalled();
  });
  it('binds an exact input project before publishing tool evidence and retains the batch on rejection', async () => {
    const h = await worker([]);
    const conversationId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${conversationId}` });
    const sender = { tab: { id: 7 }, documentId: 'project-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const message = { conversationId, projectInput: { id: firstId, owner: '7:project-document:1' }, entries: [{ conversationId, event: { kind: 'tool_evidence', time: Date.now(), calls: [{ requestId: 'exact-request', tool: 'read' }] } }] };
    const original = h.fetch.getMockImplementation()!;
    let accepted = false;
    h.fetch.mockImplementation(async (url, init) => new URL(url).pathname === '/input/bind'
      ? { ok: true, status: 200, json: async () => ({ ok: accepted }) } : original(url, init));
    expect((await h.events(message, sender, source)).ok).toBe(false);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/events')).toBe(false);
    accepted = true;
    expect((await h.events(message, sender, source)).projectBound).toBe(firstId);
    const routes = h.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(routes.indexOf('/events')).toBeGreaterThan(routes.lastIndexOf('/input/bind'));
    h.fetch.mockClear();
    expect((await h.events({ ...message, projectInput: { id: firstId, owner: '7:another-document:1' } }, sender, source)).ok).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('acknowledges preferences without replaying a change over a newer popup value', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, patch: { overwrite: false, durations: true } };
    await h.applyRequestedBrowserPreferences(request);
    expect(h.localSaved).toMatchObject({ renderStreamEnabled: false, showStreamTimes: true });
    h.localSaved.renderStreamEnabled = true;
    await h.applyRequestedBrowserPreferences(request);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.localSaved.renderStreamEnabled).toBe(true);
    const receipts = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/browser/preferences').map(([, init]) => JSON.parse(String(init?.body)));
    expect(receipts).toEqual([expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } }), expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } })]);
    await h.applyRequestedBrowserPreferences({ nonce: secondId, expiresAt: Date.now() + 60000, patch: {} });
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body)).values).toEqual({ overwrite: true, durations: true });
  });
  it('does not replay a preference write interrupted after its durable reservation', async () => {
    const h = await worker([]);
    h.saved.browserPreferenceReceipt = { nonce: firstId, values: null, error: 'Write was interrupted' };
    await h.applyRequestedBrowserPreferences({ nonce: firstId, expiresAt: Date.now() + 60000, patch: { durations: true } });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ values: null, error: 'Write was interrupted' });
  });
  it('accepts only a requested document observation and keeps the helper open', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'catalog-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect(source.ok).toBe(true);
    const message = { nonce: firstId, models: null, close: true };
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    h.sendMessage.mockImplementation(async (_id: number, request: any) => {
      if (request.type === 'clf-model-catalog-state') return { ok: true, ready: true };
      expect((await h.catalog(message, sender, source)).ok).toBe(true);
      return { ok: true };
    });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    h.remove.mockClear();
    h.tabs[0]!.url = 'https://chatgpt.com/c/some-user-chat';
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
    h.tabs[0]!.url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    await h.authorizeDocument({ ...sender, documentId: 'replacement-document' }, { navigationEpoch: 1 });
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('recovers exact model-catalog custody after the service worker restarts', async () => {
    const first = await worker([]);
    const url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    first.tabs.push({ id: 7, url });
    const sender = { tab: { id: 7 }, documentId: 'catalog-document', frameId: 0, url };
    const source = await first.authorizeDocument(sender, { navigationEpoch: 1 });
    first.saved.modelCatalogTarget = { tab: 7, nonce: firstId, url, documentId: 'catalog-document', navigationEpoch: 1 };

    const restarted = await worker([], undefined, {}, [], first.saved);
    restarted.tabs.push({ id: 7, url });
    await restarted.authorizeDocument(sender, { navigationEpoch: 1 });
    expect(await restarted.catalog({ nonce: firstId, models: null, error: 'picker_unavailable' }, sender, source)).toMatchObject({ ok: true });
    expect(restarted.fetch.mock.calls.some(([input]) => new URL(input).pathname === '/models')).toBe(true);
    expect(restarted.saved.modelCatalogTarget).toBeUndefined();
  });

  it.each([
    ['document', 'replacement-document', 1],
    ['navigation', 'catalog-document', 2]
  ] as const)('rejects restarted model-catalog custody from a stale %s owner', async (_reason, currentDocument, currentEpoch) => {
    const url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    const stored = { modelCatalogTarget: { tab: 7, nonce: firstId, url, documentId: 'catalog-document', navigationEpoch: 1 } };
    const h = await worker([], undefined, {}, [], stored);
    h.tabs.push({ id: 7, url });
    const sender = { tab: { id: 7 }, documentId: currentDocument, frameId: 0, url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: currentEpoch });

    expect(await h.catalog({ nonce: firstId, models: null, error: 'picker_unavailable' }, sender, source)).toMatchObject({ ok: false });
    expect(h.fetch.mock.calls.some(([input]) => new URL(input).pathname === '/models')).toBe(false);
  });

  it('reserves initial catalog opening before Chrome acts and never retries an ambiguous failure', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 120000, allowOpen: true };
    h.windows.create.mockImplementation(async () => {
      expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
      throw new Error('Chrome may already have created the window');
    });
    await h.inspectModels(request, true);
    await h.inspectModels(request, true);
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
  });
  it('opens one owned blank catalog tab without blocking maintenance on DOM inspection', async () => {
    const request = { nonce: firstId, expiresAt: Date.now() + 120000 };
    const h = await worker([], request);
    await h.maintain();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.tabs[0]!.pendingUrl).toBe(`https://chatgpt.com/?cos-model-catalog=${firstId}`);
    let finish!: () => void;
    h.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, ready: true }); }));
    await h.maintain();
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalled());
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    finish();
  });
  it('reuses its own minimized window and never minimizes a user window', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 90, windowId: 3, url: 'https://chatgpt.com/c/user-chat' });
    await Promise.all([h.createChatTab('https://chatgpt.com/?first', true), h.createChatTab('https://chatgpt.com/?second', true)]);
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600, focused: false }));
    expect(h.create.mock.calls.every(([args]) => args.windowId === 80)).toBe(true);
    expect(h.windows.update).toHaveBeenCalledExactlyOnceWith(80, { state: 'minimized', focused: false });
    h.create.mockRejectedValueOnce(new Error('tab failed'));
    await expect(h.createChatTab('https://chatgpt.com/?third', true)).rejects.toThrow('tab failed');
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    h.windows.get.mockRejectedValueOnce(new Error('window closed'));
    await h.createChatTab('https://chatgpt.com/?fourth', true);
    expect(h.windows.create).toHaveBeenCalledTimes(2);
  });
  it('coalesces simultaneous passes while Chrome has not returned the first created tab', async () => {
    const h = await worker([{ id: firstId, conversationId: null }, { id: secondId, conversationId: null }]);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const normalCreate = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(async (args) => { entered(); await held; return normalCreate(args); });
    const one = h.maintain();
    await reached;
    const two = h.maintain();
    expect(two).toBe(one);
    expect(h.create).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.tabs.map(tab => new URL(tab.pendingUrl!).searchParams.get('cos-input'))).toEqual([firstId, secondId]);
    for (const tab of h.tabs) { tab.url = tab.pendingUrl; delete tab.pendingUrl; }
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(2);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-browser-repair-state')).toHaveLength(2);
  });

  it('releases a failed flight without granting another opening after ambiguous Chrome failure', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 50, url: `https://chatgpt.com/?other=cos-input=${firstId}` });
    h.create.mockRejectedValueOnce(new Error('Chrome temporarily refused tab creation'));
    await expect(h.maintain()).rejects.toThrow('temporarily refused');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs).toHaveLength(1);
  });
});

describe('Stop owns one exact existing or newly opened browser document', () => {
  const command = () => ({ id: '1122334455667700', conversationId: firstId, turnId: 'exact-turn', expiresAt: Date.now() + 120000 });
  it('opens once and delivers after the elected new page registers', async () => {
    const h = await worker([]) as any;
    const request = command();
    await Promise.all([h.offerStopTurns([request]), h.offerStopTurns([request])]);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ url: `https://chatgpt.com/c/${firstId}`, active: true });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.localSaved.stopOpenings[request.id]).toMatchObject({ tab: 1, turnId: 'exact-turn', conversationId: firstId });
    h.tabs[0].url = h.tabs[0].pendingUrl; delete h.tabs[0].pendingUrl;
    const source = await h.authorizeDocument({ tab: { id: 1 }, documentId: 'opened-stop', frameId: 0, url: h.tabs[0].url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, firstId);
    await h.offerStopTurns([request]);
    expect(h.sendMessage).toHaveBeenCalledWith(1, { type: 'clf-stop-turn', id: request.id, conversationId: firstId, turnId: request.turnId }, { documentId: 'opened-stop' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['loading', 'unregistered'])('elects an existing %s exact tab instead of opening another', async mode => {
    const h = await worker([]) as any;
    h.tabs.push({ id: 7, [mode === 'loading' ? 'pendingUrl' : 'url']: `https://chatgpt.com/c/${firstId}` });
    const request = command();
    await h.offerStopTurns([request]); await h.offerStopTurns([request]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.localSaved.stopOpenings[request.id].tab).toBe(7);
  });
  it.each(['closed', 'navigated', 'lost-create-reply'])('retains spent opening custody across suspension after %s', async mode => {
    const h = await worker([]) as any;
    const request = command();
    if (mode === 'lost-create-reply') h.create.mockRejectedValueOnce(new Error('ambiguous creation'));
    await h.offerStopTurns([request]);
    expect(h.create).toHaveBeenCalledTimes(1);
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved))) as any;
    if (mode === 'navigated') restarted.tabs.push({ id: 1, url: `https://chatgpt.com/c/${secondId}` });
    await restarted.offerStopTurns([request]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('does not treat query failure or an expired command as permission to open', async () => {
    const h = await worker([]) as any;
    h.query.mockRejectedValueOnce(new Error('Chrome unavailable'));
    await h.offerStopTurns([command()]);
    expect(h.create).not.toHaveBeenCalled();
    await h.offerStopTurns([{ ...command(), expiresAt: Date.now() - 1 }]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('requires durable opening custody before creating a tab', async () => {
    const h = await worker([]) as any;
    h.local.set.mockRejectedValueOnce(new Error('disk failure'));
    await h.offerStopTurns([command()]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('targets only the registered conversation document, never opens a tab, and ignores navigation', async () => {
    const h = await worker([]) as any;
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'stop-document', frameId: 0, url: h.tabs[0].url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, firstId);
    const command = { id: '1122334455667788', conversationId: firstId, turnId: 'exact-turn' };
    h.offerStopTurns([command]);
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-stop-turn', ...command }, { documentId: 'stop-document' }));
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockClear(); h.tabs[0].url = `https://chatgpt.com/c/${secondId}`;
    h.offerStopTurns([{ ...command, id: '1122334455667799' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains exact turn identity in the existing ACK journal across restart', async () => {
    const h = await worker([]) as any;
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await h.ackCommand('1122334455667788', 'sent', null, firstId, null, 'stop-document', null, 'exact-turn');
    expect(h.localSaved.commandAckOutbox[0]).toMatchObject({ turnId: 'exact-turn', conversationId: firstId });
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const ack = restarted.fetch.mock.calls.find(([url]) => new URL(url).pathname === '/commands/ack');
    expect(JSON.parse(String(ack?.[1]?.body))).toMatchObject({ turnId: 'exact-turn', conversationId: firstId, client: 'stop-document' });
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
});

it('releases departed-chat ownership so input claims and model discovery cannot deadlock each other', async () => {
  const inputs: Array<{ id: string; conversationId: string | null }> = [];
  const h = await worker(inputs, { nonce: firstId, expiresAt: Date.now() + 60000 });
  const tab = { id: 7, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(tab);
  const sender = { tab: { id: 7 }, documentId: 'reused-document', frameId: 0 };
  const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
  await h.noteTabConversation(source, secondId);
  // Chrome reports A's departure as New Chat prepares B in the elected tab.
  tab.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
  inputs.push({ id: firstId, conversationId: null });
  let claimed = false, catalogObserved = false;
  h.sendMessage.mockImplementation(async (id, message) => {
    if (message.type === 'clf-model-catalog-state') return { ok: true, ready: true };
    if (message.type === 'clf-model-catalog') {
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.catalog({ nonce: firstId, models: [{ id: 'observed-model', label: 'Observed model', efforts: ['high'] }] }, sender, current);
        catalogObserved = result.ok;
      });
    }
    if (message.type === 'clf-desktop-input') {
      // Real desktop_input IPC uses the same serializeTab queue as releaseTab.
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.desktopInput({ id: firstId, conversationId: null, requiresAuthorization: true }, sender, current);
        claimed = result.ok;
      });
    }
    return { ok: true };
  });
  let released = false;
  const departure = h.serializeTab(7, () => h.releaseTab(7, secondId, sender.documentId, 1))
    .then(() => { released = true; });
  // A bounded observation exposes the circular wait in the old implementation. Durable input now
  // deliberately outranks catalog maintenance, so the first pass must release/claim without also
  // starting the auxiliary model probe in the same browser-opening flight.
  await vi.waitFor(() => { expect(released).toBe(true); expect(claimed).toBe(true); });
  expect(catalogObserved).toBe(false);
  inputs.splice(0);
  await departure; await h.maintain();
  await vi.waitFor(() => expect(catalogObserved).toBe(true));
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/closed')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/input/claim')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/models')).toBe(true);
  expect(h.localSaved.inputOpenings).toMatchObject({ [firstId]: { tab: 7, stage: 'ready' } });
  expect(h.create).not.toHaveBeenCalled();
});
