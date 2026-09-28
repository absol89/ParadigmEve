import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import { readFile } from 'node:fs/promises';

let dom: JSDOM;
it.each(['before-context', 'after-context', 'after-catalog'])('restores the durable composer pair %s without borrowing worker settings', async order => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (value: any) => void;
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models: [] } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; }
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  if (order !== 'before-context') applyComposerSessionModel(null, null);
  if (order === 'after-catalog') receive({ state: 'ready', models: [] });
  applyChatModels({ ui: { chatModel: 'gpt-5.6-sol', chatReasoning: 'high' },
    multiAgent: { defaultModel: '5.6', defaultReasoning: 'medium' }, goal: {} } as Config);
  await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-5.6 Sol · High');
  applyComposerSessionModel('history', { model: '5.6', reasoningEffort: 'medium', observedAt: 1 });
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'medium' });
  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
});

it('keeps a saved paid preference from selecting a paid model on a native-default account', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', nativeDefault: true, models: [] } })
  } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyChatModels({ ui: { chatModel: '5.6', chatReasoning: 'high' }, multiAgent: {}, goal: {} } as Config);
  await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  expect(dom.window.document.querySelectorAll('#composerModelChoices button')).toHaveLength(1);
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
  expect((dom.window.document.getElementById('composerPowerChoices') as HTMLElement).hidden).toBe(true);
});

it('keeps a newer user choice across a late startup config and persists explicit native default', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const save = vi.fn(async () => ({ ok: true, data: null }));
  Object.assign(dom.window, { api: { setChatModelPreference: save,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models: [] } }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyComposerSessionModel(null, null);
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(save).toHaveBeenLastCalledWith('5.6', 'high');
  applyChatModels({ ui: { chatModel: '5.6', chatReasoning: 'medium' }, multiAgent: {}, goal: {} } as Config);
  await Promise.resolve();
  applyComposerSessionModel('history', null); applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  dom.window.document.querySelector<HTMLButtonElement>('#composerModelChoices button')!.click();
  expect(save).toHaveBeenLastCalledWith(null, null);
  applyComposerSessionModel('history', null); applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
});

afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each([true, false])('a model-rejection refresh waits beyond cached availability (still available=%s)', async available => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }];
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', models } }));
  Object.assign(dom.window, { api: { requestChatModels,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }),
    onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel('existing:refresh', { model: 'gpt-6', reasoningEffort: 'high', observedAt: 1 });
  let done = false;
  const result = ensureComposerModel(true).then(value => { done = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(done).toBe(false); expect(requestChatModels).toHaveBeenCalledTimes(1);
  receive({ state: 'ready', models: available ? models : [{ id: 'gpt-6', label: 'GPT-6', efforts: ['medium'] }] });
  expect(await result).toEqual(available ? { model: 'gpt-6', reasoningEffort: 'high' } : null);
});

it('a send requests missing models once and waits for the pushed catalog before selecting', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(async () => ({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }));
  const models = [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high'] }];
  Object.assign(dom.window, { api: { requestChatModels, getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, ensureComposerModel, applyChatModels, applyComposerSessionModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyComposerSessionModel('existing:missing', { model: 'gpt-6', reasoningEffort: 'high', observedAt: 1 });
  const first = ensureComposerModel(), second = ensureComposerModel();
  let resolved = false; void first.then(() => { resolved = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(requestChatModels).toHaveBeenCalledTimes(1); expect(resolved).toBe(false);
  applyChatModels({ multiAgent: {}, goal: {} } as Config);
  expect(await first).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
  expect(await second).toEqual({ model: 'gpt-6', reasoningEffort: 'high' });
});

it('a failed discovery keeps sending unconfirmed and settles its wait', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { requestChatModels: async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: 2, models: [] } }) } });
  const { initChatModels, ensureComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
});

it('keeps shipped Default and Sol usable when model discovery is unavailable', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn(async () => ({ ok: true, data: {
    state: 'unavailable', requestedAt: 1, observedAt: 2, models: [], error: 'Discovery failed'
  } }));
  Object.assign(dom.window, { api: { requestChatModels } });
  const { initChatModels, applyComposerSessionModel, ensureComposerModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyComposerSessionModel(null, null);
  const worker = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
  const helper = dom.window.document.getElementById('helperModel') as HTMLSelectElement;
  for (const select of [worker, helper]) {
    expect([...select.options].map(option => [option.value, option.disabled])).toEqual([
      ['chatgpt-default', false],
      ['5.6', false]
    ]);
    expect(select.textContent).not.toContain('not verified');
  }
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  const composer = dom.window.document.getElementById('composerModel') as HTMLSelectElement;
  composer.value = '5.6'; composer.dispatchEvent(new dom.window.Event('change'));
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(await ensureComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(requestChatModels).not.toHaveBeenCalled();
  expect(await ensureComposerModel(true)).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(requestChatModels).toHaveBeenCalledTimes(1);
});

it('admits an explicit native-default account with null model and reasoning while failures still block', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { requestChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models: [], nativeDefault: true } }) } });
  const { initChatModels, ensureComposerModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toBe('Model choice stays in ChatGPT');
});

it('shows only ChatGPT default and hides the reasoning slider on a Free or Go native surface', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2,
      models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] }], nativeDefault: true } })
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyComposerSessionModel(null, null); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('#composerModelChoices button')];
  expect(buttons.map(button => button.textContent)).toEqual(['ChatGPT default']);
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerModel option')].map(option => option.value)).toEqual(['chatgpt-default']);
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
  expect((dom.window.document.getElementById('composerPowerChoices') as HTMLElement).hidden).toBe(true);
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('ChatGPT default');
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toBe('Model choice stays in ChatGPT');
});

it('does not let an older paid session observation bypass a current Free or Go native surface', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2,
      models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] }], nativeDefault: true } })
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyComposerSessionModel('existing:paid-observation', { model: '5.6', reasoningEffort: 'high', observedAt: 1 });
  applyChatModels({ multiAgent: {}, goal: {} } as Config);
  await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect([...dom.window.document.querySelectorAll<HTMLButtonElement>('#composerModelChoices button')].map(button => button.textContent)).toEqual(['ChatGPT default']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerModel option')].map(option => option.value)).toEqual(['chatgpt-default']);
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBeNull();
});

it.each(['unknown', 'pending', 'unavailable'])('lets an unselected new chat keep the native model when discovery is %s', async state => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const requestChatModels = vi.fn();
  Object.assign(dom.window, { api: { requestChatModels,
    getChatModels: async () => ({ ok: true, data: { state, requestedAt: 1, observedAt: null, models: [], error: 'Account models could not be fetched' } }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, ensureComposerModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(requestChatModels).not.toHaveBeenCalled();
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('ChatGPT default');
  applyComposerSessionModel('existing:1', { model: 'requested-pro', reasoningEffort: 'pro', observedAt: 2 });
  expect(confirmedComposerModel()).toBeNull();
});

it('keeps a fresh unselected chat on native default while refresh retains an older catalog', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: 'stale-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }];
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }),
    requestChatModels: async () => ({ ok: true, data: { state: 'pending', requestedAt: 3, observedAt: 2, models } })
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, ensureComposerModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });

  dom.window.document.getElementById('refreshComposerModels')!.click();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(await ensureComposerModel()).toEqual({ model: null, reasoningEffort: null });

  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  applyComposerSessionModel('existing:1', null);
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
});

it('uses a current native-default account surface instead of stale paid observations in every composer scope', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', models: [], nativeDefault: true } })
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyComposerSessionModel('existing:1', { model: 'requested-pro', reasoningEffort: 'pro', observedAt: 2 });
  applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  applyComposerSessionModel('existing:2', null);
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  applyComposerSessionModel(null, null);
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
});

it('lets an established chat explicitly use ChatGPT default without changing the provider picker', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const observed = { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high'] }
  ] };
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: observed }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } =
    await import('../src/renderer/chat-models.js');
  initChatModels();
  applyChatModels({ multiAgent: {}, goal: {} } as Config);
  await Promise.resolve();
  const observedAt = Date.now();
  applyComposerSessionModel('existing:default-transport', {
    model: '5.6', reasoningEffort: 'high', observedAt
  });
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });

  const useDefault = [...dom.window.document.querySelectorAll<HTMLButtonElement>('#composerModelChoices button')]
    .find(button => button.textContent === 'ChatGPT default')!;
  expect(useDefault).toBeDefined();
  useDefault.click();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });

  // Null transport means "leave ChatGPT's picker alone", so seeing that old provider selection
  // again must not erase the explicit app-side Default choice.
  applyComposerSessionModel('existing:default-transport', {
    model: '5.6', reasoningEffort: 'high', observedAt: observedAt + 10
  });
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
});

it('opening an empty or pending picker requests models immediately without a separate refresh', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const pending = { state: 'pending', requestedAt: 1, observedAt: null, models: [] };
  const requestChatModels = vi.fn(async () => ({ ok: true, data: pending }));
  Object.assign(dom.window, { api: { requestChatModels } });
  const { initChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels();
  const menu = dom.window.document.getElementById('modelMenu') as HTMLDetailsElement;
  menu.open = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requestChatModels).toHaveBeenCalledTimes(1);
  expect(dom.window.document.getElementById('composerPowerTitle')!.textContent).toBe('ChatGPT default');
  menu.open = false;
  await new Promise(resolve => setTimeout(resolve, 0));
  menu.open = true;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requestChatModels).toHaveBeenCalledTimes(2);
});

it('excludes GPT-5.5 everywhere and keeps the composer slider fixed to Sol Medium, High and xhigh', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'old', label: 'GPT-5.5', efforts: ['medium', 'high', 'pro'] },
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] },
    { id: 'future', label: 'GPT-7', efforts: ['high'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('2');
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerModel option')].map(option => option.value)).toEqual(['chatgpt-default', '5.6', 'future']);
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#workerModel option')].some(option => option.value === 'old')).toBe(false);
  expect(dom.window.document.querySelector('.power-dot.locked')?.getAttribute('aria-label')).toBe('xhigh · Pro');
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-5.6 Sol · Medium');
});

it('binds composer selection to the selected session across delayed catalog, user edits and A-B-A navigation', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }];
  let resolve!: (value: unknown) => void;
  Object.assign(dom.window, { api: { getChatModels: () => new Promise(done => { resolve = done; }) } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config);
  const high = { model: 'GPT-5.6 Sol', reasoningEffort: 'high' as const, observedAt: 1 };
  applyComposerSessionModel('session:worker', high);
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  resolve({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  applyComposerSessionModel('session:worker', { ...high, observedAt: 3 });
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
  applyComposerSessionModel('session:other', null);
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'xhigh' });
  applyComposerSessionModel('session:worker', high);
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
  applyComposerSessionModel('session:worker', { ...high, observedAt: Date.now() + 1_000 });
  expect(confirmedComposerModel()?.reasoningEffort).toBe('xhigh');
});

it('never folds observed Pro lanes or unrelated model families into the three-step Sol composer slider', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const { paintContextMeter } = await import('../src/renderer/context-meter.js');
  const config = { multiAgent: {}, goal: {}, sessions: { limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 } } as Config;
  initChatModels(() => paintContextMeter(null, config, confirmedComposerModel()));
  applyChatModels(config); await Promise.resolve();
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect([...dom.window.document.querySelectorAll<HTMLOptionElement>('#composerReasoning option')].map(option => option.value)).not.toContain('pro');
  expect(slider.max).toBe('2');
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  // The meter formats with the machine's locale (400,000 in English, 400 000 with a no-break space in Swedish).
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain(`Auto-compaction at ${new Intl.NumberFormat().format(400_000)} tokens`);
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  expect(dom.window.document.querySelector('.power-dot.locked')?.getAttribute('aria-label')).toBe('xhigh · Pro');
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-5.6 Sol · Medium');
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  // The meter formats with the machine's locale (400,000 in English, 400 000 with a no-break space in Swedish).
  expect(dom.window.document.getElementById('contextMeterInfo')!.textContent).toContain(`Auto-compaction at ${new Intl.NumberFormat().format(400_000)} tokens`);
});

it('replaces loading with the backend failure reason and an enabled retry control', async () => {
  dom = new JSDOM('<span id="composerModelLabel"></span><p id="composerModelStatus"></p><button id="refreshComposerModels"></button>' +
    ['composerModel', 'composerReasoning', 'workerModel', 'workerReasoning', 'helperModel', 'helperReasoning'].map(id => `<select id="${id}"><option value="">Default</option></select>`).join(''));
  const pending = { state: 'pending', requestedAt: 1, observedAt: null, models: [] };
  const failed = { ...pending, state: 'unavailable', error: 'Model discovery timed out. Retry.' };
  const getChatModels = vi.fn(async () => ({ ok: true, data: pending }));
  Object.assign(dom.window, { api: { getChatModels } });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  const config = { multiAgent: {}, goal: {} } as Config;
  applyChatModels(config); await Promise.resolve();
  const retry = dom.window.document.getElementById('refreshComposerModels') as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  getChatModels.mockResolvedValue({ ok: true, data: failed });
  applyChatModels(config); await Promise.resolve();
  expect(retry.disabled).toBe(false); expect(retry.hidden).toBe(false);
  expect(dom.window.document.getElementById('composerModelStatus')!.textContent).toContain('timed out');
});

it('uses observed account choices, preserves unverified defaults, and clears incompatible effort on model change', async () => {
  dom = new JSDOM('<span id="composerModelLabel"></span><p id="chatModelStatus"></p>' +
    ['composerModel', 'composerReasoning', 'workerModel', 'workerReasoning', 'helperModel', 'helperReasoning'].map(id => `<select id="${id}"><option value="">Default</option></select>`).join(''));
  const observed = { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [
    { id: 'first', label: 'GPT-5.6 Sol', efforts: ['high'] }, { id: 'second', label: 'GPT-6', efforts: ['medium'] }
  ] };
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: observed }) } });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  applyChatModels({ multiAgent: { defaultModel: 'unseen', defaultReasoning: 'high' }, goal: {} } as Config);
  await Promise.resolve();
  const select = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
  expect(select('workerModel').value).toBe('unseen');
  expect(select('workerModel').selectedOptions[0]!.disabled).toBe(true);
  expect(select('helperModel').value).toBe('chatgpt-default');
  expect([...select('composerModel').options].map(row => row.value)).toEqual(['chatgpt-default', '5.6', 'second']);
  select('composerModel').value = '5.6'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
  expect([...select('composerReasoning').options].map(row => row.value)).toEqual(['medium', 'high']);
  select('composerReasoning').value = 'high';
  select('composerModel').value = 'second'; select('composerModel').dispatchEvent(new dom.window.Event('change'));
  expect(select('composerReasoning').value).toBe('medium');
  expect([...select('composerReasoning').options].map(row => row.value)).toEqual(['medium']);
});

it('keeps a stable three-step Sol composer while observed extras come and go', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let models = [
    { id: 'other', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'] },
    { id: 'observed-six', label: 'GPT-6', efforts: ['medium', 'high'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  const config = { multiAgent: {}, goal: {} } as Config;
  applyChatModels(config); await Promise.resolve();
  const select = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  expect(dom.window.document.getElementById('composerModelChoices')!.textContent).toContain('ChatGPT default');
  const reload = dom.window.document.getElementById('refreshComposerModels')!;
  expect(reload.querySelector('svg')).not.toBeNull();
  expect(reload.textContent).toBe('');
  expect(reload.getAttribute('aria-label')).toBe('Reload ChatGPT models');
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('2');
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-5.6 Sol \u00b7 High');
  expect(select('composerModel').value).toBe('5.6');
  expect(select('composerReasoning').value).toBe('high');
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('5.6');
  expect(select('composerReasoning').value).toBe('high');
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-5.6 Sol \u00b7 High');
  expect(dom.window.document.querySelector('.power-dot.locked')?.getAttribute('aria-label')).toBe('xhigh · Pro');
  applyChatModels(config); await Promise.resolve();
  expect(dom.window.document.querySelector('#composerPowerChoices input')).toBe(slider);
  models = [{ id: 'actual-pro', label: 'GPT-6 Pro', efforts: ['pro'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  const proSlider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  proSlider.value = '2'; proSlider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('5.6');
  expect(select('composerReasoning').value).toBe('high');
  expect(dom.window.document.getElementById('composerPowerModel')!.textContent).toContain('GPT-5.6 Sol');
  models = [{ id: 'limited-six', label: 'GPT-6', efforts: ['medium'] }];
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  const limitedSlider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  limitedSlider.value = '2'; limitedSlider.dispatchEvent(new dom.window.Event('input'));
  expect(select('composerModel').value).toBe('5.6');
  expect(select('composerReasoning').value).toBe('high');
});

it('keeps exactly Medium, High and xhigh in the composer and excludes GPT-5.5 choices', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'astra', label: 'GPT-6 Astra', efforts: ['high'] },
    { id: 'old', label: 'GPT-5.5', efforts: ['low', 'high', 'pro'] },
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high', 'minimal', 'low', 'medium'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models } }) } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: {}, goal: {} } as Config); await Promise.resolve();
  const doc = dom.window.document;
  const slider = doc.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  expect(slider.max).toBe('2');
  expect(doc.querySelectorAll('.power-dot')).toHaveLength(3);
  const header = doc.querySelector('.power-header')!;
  expect(header.querySelector('.power-icon') === null).toBe(true);
  expect(header.querySelector('#composerPowerTitle')).not.toBeNull();
  expect(header.querySelector('#composerPowerModel')).not.toBeNull();
  expect(header.querySelector('#refreshComposerModels')).not.toBeNull();
  const expected = [['5.6', 'medium'], ['5.6', 'high']];
  for (const [index, [model, reasoningEffort]] of expected.entries()) {
    slider.value = String(index); slider.dispatchEvent(new dom.window.Event('input'));
    expect(confirmedComposerModel()).toEqual({ model, reasoningEffort });
    expect(slider.getAttribute('aria-valuetext')).not.toMatch(/Instant|Minimal/);
  }
  slider.value = '2'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(slider.getAttribute('aria-valuetext')).toBe('GPT-5.6 Sol · High');
  expect(doc.querySelectorAll('.power-dot.locked')).toHaveLength(1);
  expect(doc.querySelector('.power-dot.locked')?.getAttribute('aria-label')).toBe('xhigh · Pro');
  const effort = doc.getElementById('composerReasoning') as HTMLSelectElement;
  const injected = doc.createElement('option'); injected.value = 'none'; effort.append(injected); effort.value = 'none';
  expect(confirmedComposerModel()).toBeNull();
});

it('keeps the trigger consistent with send admission during reload and a removed effort', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let catalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }] };
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: catalog }),
    requestChatModels: async () => ({ ok: true, data: { ...catalog, state: 'pending', requestedAt: 3 } })
  } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = { multiAgent: {}, goal: {} } as Config;
  initChatModels(); applyChatModels(config); await Promise.resolve();
  const label = dom.window.document.getElementById('composerModelLabel')!;
  const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
  slider.value = '1'; slider.dispatchEvent(new dom.window.Event('input'));
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  dom.window.document.getElementById('refreshComposerModels')!.click();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  await Promise.resolve(); await Promise.resolve();
  applyChatModels(config); await Promise.resolve();
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  catalog = { ...catalog, models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['medium'] }] };
  applyChatModels(config); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(label.textContent).toBe('GPT-5.6 Sol · High');
  expect(label.title).toBe(label.textContent);
});
it('paints catalog pushes immediately and refuses late startup reads without refetching on unrelated state', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void, resolve!: (result: any) => void;
  const getChatModels = vi.fn(() => new Promise<any>(done => { resolve = done; }));
  Object.assign(dom.window, { api: { getChatModels, onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  const config = { multiAgent: {}, goal: {} } as Config;
  initChatModels(); applyChatModels(config);
  receive({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] }] });
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  resolve({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } }); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: null, reasoningEffort: null });
  applyChatModels(config); applyChatModels(config);
  expect(getChatModels).toHaveBeenCalledTimes(1);
});
it('maps saved execution slugs to the observed family while preserving Pro reasoning', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2,
    models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'], aliases: ['5.6', 'gpt-5-6-pro'] }] } }) } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: 'gpt-5-6-pro', defaultReasoning: 'pro' }, goal: {} } as Config); await Promise.resolve();
  const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
  expect(model.value).toBe('5.6'); expect(model.options).toHaveLength(2);
  expect((dom.window.document.getElementById('workerReasoning') as HTMLSelectElement).value).toBe('pro');
});
it.each(['5.6', 'gpt-5.6-sol', 'GPT-5.6 Sol', '5.6'])('keeps saved Sol High selected across reordered catalogs: %s', async saved => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let receive!: (catalog: any) => void;
  const models = [
    { id: '6', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro'] },
    { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'], aliases: ['5.6', 'gpt-5-6-pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', models } }), onChatModelsChanged: (listener: typeof receive) => { receive = listener; } } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels(); applyChatModels({ multiAgent: { defaultModel: saved, defaultReasoning: 'high' }, goal: {} } as Config); await Promise.resolve();
  const check = () => {
    const model = dom.window.document.getElementById('workerModel') as HTMLSelectElement;
    expect(model.value).toBe('5.6'); expect(model.selectedOptions[0]!.disabled).toBe(false);
    expect((dom.window.document.getElementById('workerReasoning') as HTMLSelectElement).value).toBe('high');
  };
  check(); receive({ state: 'ready', models: [...models].reverse() }); check();
});

it('restores the persisted current-chat model pair into a fresh New Chat composer', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5.6-sol'] }];
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }),
    setChatModelPreference: vi.fn(async () => ({ ok: true, data: null }))
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyComposerSessionModel(null, null);
  applyChatModels({ ui: { chatModel: 'gpt-5.6-sol', chatReasoning: 'high' }, multiAgent: {}, goal: {} } as Config);
  await Promise.resolve(); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-5.6 Sol · High');
});

it('uses the persisted current-chat pair for an established chat until exact provider state is observed', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5.6-sol'] }];
  Object.assign(dom.window, { api: {
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 2, models } }),
    setChatModelPreference: vi.fn(async () => ({ ok: true, data: null }))
  } });
  const { initChatModels, applyChatModels, applyComposerSessionModel, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
  initChatModels();
  applyComposerSessionModel('session:legacy-without-observation', null);
  applyChatModels({ ui: { chatModel: 'gpt-5.6-sol', chatReasoning: 'medium' }, multiAgent: {}, goal: {} } as Config);
  await Promise.resolve(); await Promise.resolve();
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'medium' });
  expect(dom.window.document.getElementById('composerModelLabel')!.textContent).toBe('GPT-5.6 Sol · Medium');

  applyComposerSessionModel('session:legacy-without-observation', { model: '5.6', reasoningEffort: 'high', observedAt: 3 });
  expect(confirmedComposerModel()).toEqual({ model: '5.6', reasoningEffort: 'high' });
});
