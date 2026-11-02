import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState, Config } from '../src/shared/types.js';
import type { SessionSummary } from '../src/shared/session.js';

vi.mock('../src/renderer/chat-models.js', () => ({ repaintComposerLabel: () => {}, setComposerLabelOverride: () => {} }));
let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('uses one exact-model preference for displayed controls and sends across chats, reloads and Auto resets', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  let config = { ui: { ollamaModelPreferences: { local: { think: false, numCtx: 24576 } } } } as unknown as Config;
  let fail = false;
  const setPreference = vi.fn(async (model: string, patch: { think?: boolean; numCtx?: number | null }) => {
    if (fail) return { ok: false, error: 'Not saved' };
    const prefs = structuredClone(config.ui.ollamaModelPreferences!);
    prefs[model] = { ...prefs[model], ...(patch.think !== undefined ? { think: patch.think } : {}) };
    if (patch.numCtx === null) delete prefs[model]!.numCtx;
    else if (patch.numCtx !== undefined) prefs[model]!.numCtx = patch.numCtx;
    config = { ...config, ui: { ...config.ui, ollamaModelPreferences: prefs } };
    return { ok: true, data: { config } };
  });
  Object.defineProperty(dom.window, 'api', { value: {
    listOllamaModels: async () => ({ ok: true, data: [{ id: 'local', route: 'ollama-local' }, { id: 'cloud', route: 'ollama-cloud' }] }),
    setOllamaModelPreference: setPreference
  } });
  const picker = await import('../src/renderer/chat-provider.js');
  const applyState = vi.fn((state: AppState) => picker.applyOllamaModelPreferences(state.config));
  picker.initChatProvider(applyState);
  picker.applyOllamaModelPreferences(config);
  const old = { provider: { id: 'ollama', model: 'local', think: true, numCtx: 8192 } } as SessionSummary;
  picker.applyComposerProvider('chat-a', old);
  // Send immediately after restore, before opening/refreshing the picker.
  expect(await picker.prepareComposerProvider()).toEqual({ id: 'ollama', model: 'local', think: false, numCtx: 24576 });
  picker.applyComposerProvider('chat-b', old);
  const think = dom.window.document.getElementById('ollamaThink') as HTMLInputElement;
  const ctx = dom.window.document.getElementById('ollamaNumCtx') as HTMLInputElement;
  expect(think.checked).toBe(false);
  expect(ctx.value).toBe('24576');
  think.checked = true;
  think.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(applyState).toHaveBeenCalledTimes(1));
  ctx.value = '';
  ctx.dispatchEvent(new dom.window.Event('change'));
  // Send also waits for an in-flight preference save instead of sending the old count.
  expect(await picker.prepareComposerProvider()).toEqual({ id: 'ollama', model: 'local', think: true });
  expect(applyState).toHaveBeenCalledTimes(2);
  picker.applyComposerProvider('chat-a', old);
  expect(picker.composerProvider()).toEqual({ id: 'ollama', model: 'local', think: true });
  expect(ctx.value).toBe('');
  expect(think.checked).toBe(true);
  // A restored chat cannot reintroduce its historical per-turn context override.
  picker.applyComposerProvider('chat-restored', old);
  expect(picker.composerProvider()).toEqual({ id: 'ollama', model: 'local', think: true });
  fail = true;
  ctx.value = '32768';
  ctx.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(ctx.value).toBe(''));
  expect(picker.composerProvider()).not.toHaveProperty('numCtx');
  picker.applyComposerProvider('remote', { provider: { id: 'ollama', model: 'cloud', think: false, numCtx: 8192 } } as SessionSummary);
  expect(picker.composerProvider()).toEqual({ id: 'ollama', model: 'cloud' });
});
