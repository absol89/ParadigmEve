import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const workflow = source.slice(source.indexOf('let pluginRefreshFlight = null;'), source.indexOf('async function catalogProbe('));

it('keeps one operation on its original tab after marker loss, worker restart, and user closure', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const saved: Record<string, unknown> = {};
  let tab: { id: number; url: string } | null = null;
  const create = vi.fn(async (url: string) => (tab = { id: 8, url }));
  const update = vi.fn(async (_id: number, patch: { url: string }) => { if (tab) tab.url = patch.url; return tab; });
  const storage = { session: { get: async () => saved, set: async (next: object) => { Object.assign(saved, next); } } };
  const start = () => {
    const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab: create,
      call: async () => ({ ok: true, data: { requests: [{ id, appId: null }] } }),
      chrome: { storage, tabs: { query: async () => tab ? [tab] : [], get: async () => { if (!tab) throw Error('closed'); return tab; }, update, sendMessage: async () => ({ ok: true }) } } });
    vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context); return context;
  };
  await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
  tab!.url = 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic';
  await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(8, { url: `https://chatgpt.com/?eve-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic` });
  tab = null;
  await start().run([{}], true); await start().run([{}], true);
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not create a plugin helper in browser-only mode', async () => {
  const create = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab: create,
    call: async () => ({ ok: true, data: { requests: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] } }),
    chrome: { storage: { session: { get: async () => ({}) } }, tabs: { query: async () => [] } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true, true);
  expect(create).not.toHaveBeenCalled();
});

it.each(['pinned', 'navigating'])('never retargets a %s tab from a stale refresh owner record', async mode => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const tab = { id: 8, url: 'https://chatgpt.com/settings/plugins-settings', pinned: mode === 'pinned',
    ...(mode === 'navigating' ? { pendingUrl: 'https://chatgpt.com/settings/plugins-settings' } : {}) };
  const update = vi.fn();
  const sendMessage = vi.fn();
  const createChatTab = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab,
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => ({ pluginRefreshOwner: { id, tab: 8 } }), set: vi.fn() } },
      tabs: { query: async () => [tab], get: async () => tab, update, sendMessage } }
  });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], false);
  expect(update).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(createChatTab).not.toHaveBeenCalled();
});

it.each(['pinned', 'navigating'])('does not reuse or retarget a discovered %s helper when owner storage is missing', async mode => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const tab = { id: 8, url: `https://chatgpt.com/?cos-plugin-refresh=${id}#settings/Plugins`,
    pinned: mode === 'pinned', ...(mode === 'navigating' ? { pendingUrl: `https://chatgpt.com/plugins/plugin_asdk_app_elsewhere?eve-plugin-refresh=${id}` } : {}) };
  const update = vi.fn();
  const sendMessage = vi.fn();
  const createChatTab = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab,
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => ({}), set: vi.fn() } },
      tabs: { query: async () => [tab], get: async () => tab, update, sendMessage } }
  });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], false);
  expect(update).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(createChatTab).not.toHaveBeenCalled();
});

it('starts a read-only enrolled recheck on the marked installed-app list without bypassing its link proof', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const request = { id, appId: 'asdk_app_synthetic', surface: 'core', verifyOnly: true, observeOnly: true };
  const list = `https://chatgpt.com/settings/plugins-settings?eve-plugin-refresh=${id}`;
  const tab = { id: 8, url: list, pinned: false };
  const createChatTab = vi.fn(async () => tab);
  const update = vi.fn();
  const sendMessage = vi.fn();
  const saved: Record<string, unknown> = {};
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab,
    call: async () => ({ ok: true, data: { requests: [request] } }),
    chrome: { storage: { session: { get: async () => saved, set: async (next: object) => Object.assign(saved, next) } },
      tabs: { query: async () => (saved.pluginRefreshOwner ? [tab] : []), get: async () => tab, update, sendMessage } }
  });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  expect(createChatTab).toHaveBeenCalledExactlyOnceWith(list, true);
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 8, verifyOnly: true });
  await context.run([{}], true);
  expect(update).not.toHaveBeenCalled(); // Do not leap to /plugins/ before content proves ID/surface.
  expect(sendMessage).toHaveBeenCalledWith(8, { type: 'clf-plugin-refresh', request });
});

it.each([true, false])('does not reclaim a different plugin page from a stale %s owner record', async hasOwner => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const tab = { id: 8, url: `https://chatgpt.com/plugins/plugin_asdk_app_other?eve-plugin-refresh=${id}`, pinned: false };
  const update = vi.fn();
  const sendMessage = vi.fn();
  const createChatTab = vi.fn();
  const saved = hasOwner ? { pluginRefreshOwner: { id, tab: 8 } } : {};
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab,
    call: async () => ({ ok: true, data: { requests: [{ id, appId: 'asdk_app_synthetic' }] } }),
    chrome: { storage: { session: { get: async () => saved, set: vi.fn() } },
      tabs: { query: async () => [tab], get: async () => tab, update, sendMessage } }
  });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], false);
  expect(update).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(createChatTab).not.toHaveBeenCalled();
});

it('records browser creation failure before claim and retries the same obligation', async () => {
  const request = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', appId: 'asdk_app_synthetic' };
  const call = vi.fn(async (_path: string, init: { body: string }) => JSON.parse(init.body).action === 'pending'
    ? { ok: true, data: { requests: [request] } } : { ok: true });
  const createChatTab = vi.fn().mockRejectedValueOnce(new Error('window size rejected')).mockResolvedValueOnce({ id: 8 });
  const context = vm.createContext({ call, createChatTab, URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], chrome: { storage: { session: { get: async () => ({}), set: async () => {} } }, tabs: { query: async () => [] } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  const actions = call.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(actions).toEqual([{ action: 'pending' }, { action: 'fail', id: request.id, error: 'The background plugin refresh tab could not be created' }]);
  await context.run([{}], true);
  expect(createChatTab).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.map(([, init]) => JSON.parse(init.body).action)).toEqual(['pending', 'fail', 'pending']);
});

it('reloads an existing helper once before post-click verification and never creates a second tab', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const request = { id, appId: 'asdk_app_synthetic', verifyOnly: true };
  const saved: Record<string, any> = { pluginRefreshOwner: { id, tab: 8 } };
  const tab = { id: 8, url: `https://chatgpt.com/?eve-plugin-refresh=${id}#settings/Plugins/plugin_asdk_app_synthetic`, pinned: false };
  const update = vi.fn(async (_id: number, patch: { url: string }) => { tab.url = patch.url; return tab; });
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const storage = { session: { get: async () => saved, set: async (next: object) => { Object.assign(saved, next); } } };
  const createChatTab = vi.fn();
  const context = vm.createContext({ URL, setTimeout, clearTimeout, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], createChatTab,
    call: async () => ({ ok: true, data: { requests: [request] } }),
    chrome: { storage, tabs: { query: async () => [tab], get: async () => tab, update, sendMessage } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);

  await context.run([{}], true);
  expect(update).toHaveBeenCalledExactlyOnceWith(8, { url: tab.url });
  expect(saved.pluginRefreshOwner).toEqual({ id, tab: 8, verifyOnly: true });
  expect(sendMessage).not.toHaveBeenCalled();
  await context.run([{}], true);
  expect(update).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(createChatTab).not.toHaveBeenCalled();
});
