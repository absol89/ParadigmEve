import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => { page?.window.close(); });
it('reveals the native New Chat control through the compact sidebar before reuse', async () => {
  page = new JSDOM('<button data-testid="open-sidebar-button" aria-expanded="false" aria-controls="stage-popover-sidebar">Menu</button>', { url: 'https://chatgpt.com/c/existing', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const button = page.window.document.querySelector('button')!;
  const click = vi.fn(() => {
    button.setAttribute('aria-expanded', 'true');
    const sidebar = page.window.document.createElement('aside'); sidebar.id = 'stage-popover-sidebar';
    sidebar.innerHTML = '<a data-testid="create-new-chat-button" data-sidebar-item="true" href="/">New Chat</a>';
    page.window.document.body.append(sidebar);
  });
  button.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.newChatControl(() => false)).toBeNull(); expect(click).not.toHaveBeenCalled();
  const control = await api.newChatControl();
  expect(control?.getAttribute('data-testid')).toBe('create-new-chat-button');
  expect(click).toHaveBeenCalledTimes(1);
});
it('switches the observed Work surface to Chat once without relying on translated labels', async () => {
  page = new JSDOM('<button role="radio" data-tpp-toggle-value="chatgpt" aria-checked="false">Unterhaltung</button><button role="radio" data-tpp-toggle-value="work" aria-checked="true">Arbeit</button>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const chat = page.window.document.querySelector('[data-tpp-toggle-value="chatgpt"]')!;
  const click = vi.fn(() => {
    chat.setAttribute('aria-checked', 'true');
    page.window.document.querySelector('[data-tpp-toggle-value="work"]')!.setAttribute('aria-checked', 'false');
  });
  chat.addEventListener('click', click);
  const api = (page.window as any).CLF_DOM;
  expect(await api.prepareChatModelSurface(() => false)).toBe(false); expect(click).not.toHaveBeenCalled();
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  expect(await api.prepareChatModelSurface()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
});
it('recognizes a hydrated Think-only composer as provider-native default without inventing a model', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-footer-actions"><div data-testid="system-hint-reason"><button type="button" aria-pressed="false">Think</button></div></div><div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const failure = vi.fn(), nativeDefault = vi.fn();
  expect(await (page.window as any).CLF_DOM.inspectModelSettings(() => true, failure, nativeDefault)).toBeNull();
  expect(nativeDefault).toHaveBeenCalledTimes(1);
  expect(failure).not.toHaveBeenCalled();
  expect(await (page.window as any).CLF_DOM.selectModelSettings(null, null)).toBe(true);
  const think = page.window.document.querySelector<HTMLButtonElement>('[data-testid="system-hint-reason"] button')!;
  think.addEventListener('click', () => think.setAttribute('aria-pressed', 'true'));
  expect(await (page.window as any).CLF_DOM.selectNativeMode('think')).toBe(true);
});
it('recognizes the current Free composer without the retired Think test id and ignores an unrelated Tools menu', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-footer-actions"><button type="button" aria-haspopup="menu" data-testid="composer-tools">Tools</button></div><div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const failure = vi.fn(), nativeDefault = vi.fn();
  expect(await (page.window as any).CLF_DOM.inspectModelSettings(() => true, failure, nativeDefault)).toBeNull();
  expect(nativeDefault).toHaveBeenCalledTimes(1);
  expect(failure).not.toHaveBeenCalled();
});
it('falls back to provider-native only after bounded picker discovery finds no catalog', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const delays: number[] = [];
  const schedule = page.window.setTimeout.bind(page.window);
  page.window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(Number(delay || 0));
    return schedule(handler, 0, ...args);
  }) as typeof page.window.setTimeout;
  const failure = vi.fn(), nativeDefault = vi.fn();
  expect(await (page.window as any).CLF_DOM.inspectModelSettings(() => true, failure, nativeDefault)).toBeNull();
  expect(delays).toEqual(expect.arrayContaining([15000, 350]));
  expect(delays.indexOf(15000)).toBeLessThan(delays.indexOf(350));
  expect(nativeDefault).toHaveBeenCalledTimes(1);
  expect(failure).not.toHaveBeenCalled();
});
it('activates current Free Think through the native Tools menu and proves the active chip', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-footer-actions"><button type="button" data-testid="composer-tools">Tools</button></div><div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  page.window.eval(domSource);
  const tools = page.window.document.querySelector<HTMLButtonElement>('[data-testid="composer-tools"]')!;
  tools.addEventListener('click', () => {
    if (page.window.document.querySelector('[role="menu"]')) return;
    const menu = page.window.document.createElement('div'); menu.setAttribute('role', 'menu');
    const option = page.window.document.createElement('button'); option.setAttribute('role', 'menuitemradio'); option.textContent = 'Thinking';
    option.addEventListener('click', () => {
      menu.remove();
      const chip = page.window.document.createElement('button'); chip.textContent = 'Think'; chip.setAttribute('aria-label', 'Think, click to remove');
      page.window.document.querySelector('[data-testid="composer-footer-actions"]')!.append(chip);
    });
    menu.append(option); page.window.document.body.append(menu);
  });
  const api = (page.window as any).CLF_DOM;
  expect(await api.selectNativeMode(null)).toBe(true);
  expect(await api.selectNativeMode('think')).toBe(true);
  expect(page.window.document.querySelector('button[aria-label="Think, click to remove"]')).not.toBeNull();
});
it('fails Free Think closed when the native menu exposes no Think control', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-footer-actions"><button type="button" data-testid="composer-tools">Tools</button></div><div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.setTimeout = ((fn: TimerHandler) => { queueMicrotask(() => typeof fn === 'function' && fn()); return 1; }) as typeof page.window.setTimeout;
  page.window.eval(domSource);
  const tools = page.window.document.querySelector<HTMLButtonElement>('[data-testid="composer-tools"]')!;
  tools.addEventListener('click', () => {
    const menu = page.window.document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<button role="menuitemradio">Search</button>'; page.window.document.body.append(menu);
  });
  expect(await (page.window as any).CLF_DOM.selectNativeMode('think')).toBe(false);
});
function fixture(splitPickerOwners = false) {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Denkaufwand</button><button data-testid="send-button">Senden</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const choice = (bucket: number, modelSlug: string, thinkingEffort: string, available = true) => ({ bucket, modelSlug, thinkingEffort,
    availability: { status: available ? 'available' : 'upgrade_required' },
    category: { modelLane: modelSlug.endsWith('pro') ? 'pro' : 'thinking', shortLabel: modelSlug.startsWith('future') ? 'Neues Modell' : modelSlug.endsWith('pro') ? '6 Pro' : '5.6 Sol' } });
  const versions = [{ id: 'latest', displayTextForIntelligence: 'Aktuell', enabled: true }, { id: 'future', displayTextForIntelligence: 'Neues Modell', enabled: true }];
  const selections = [[choice(1, 'gpt-5-6-thinking', 'standard'), choice(2, 'gpt-5-6-thinking', 'extended'), choice(3, 'gpt-6-pro', 'standard', false)],
    [choice(10, 'future-model', 'low'), choice(11, 'future-model', 'ultra')]];
  const state = { bucketSelections: selections[0]!, currentBucket: 2, selectedVersionEntry: versions[0]!, currentSelection: selections[0]![1]! };
  const props = { modelsData: { versions }, composerIntelligencePickerState: state, modelSwitcherDenialsBySlug: {}, conversation: { privateSecret: 'must-never-cross' } };
  const trigger = doc.querySelector('button')!;
  const pickerFiber = () => splitPickerOwners
    ? { memoizedProps: { composerIntelligencePickerState: state }, return: { memoizedProps: { modelsData: props.modelsData }, return: { memoizedProps: { modelSwitcherDenialsBySlug: props.modelSwitcherDenialsBySlug }, return: null } } }
    : { memoizedProps: props, return: null };
  (trigger as any).__reactFiber$test = pickerFiber();
  const actions = vi.fn();
  let frozen = false;
  const render = () => {
    let panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.dataset.testid = 'composer-intelligence-picker-content'; doc.body.append(panel); }
    (panel as any).__reactFiber$test = pickerFiber();
    panel.innerHTML = '<div role="menuitem" aria-expanded="false">Modell auswählen</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Leistung"></div>';
    panel.querySelector('[aria-expanded]')!.addEventListener('click', () => {
      panel.innerHTML = '';
      for (const version of versions) {
        const row = doc.createElement('div'); row.setAttribute('role', 'menuitemradio'); row.textContent = version.displayTextForIntelligence;
        row.addEventListener('keydown', event => { if (event.key !== 'Enter') return; actions('version'); if (frozen) return;
          state.selectedVersionEntry = version; state.bucketSelections = selections[versions.indexOf(version)]!;
          state.currentBucket = state.bucketSelections[0]!.bucket; state.currentSelection = state.bucketSelections[0]!; render(); }); panel.append(row);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      actions('effort'); if (frozen) return;
      const at = state.bucketSelections.findIndex(c => c.bucket === state.currentBucket) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!state.bucketSelections[at]) return;
      state.currentBucket = state.bucketSelections[at]!.bucket; state.currentSelection = state.bucketSelections[at]!; render();
    });
  };
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Enter') render();
    if (event.key === 'Escape') doc.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();
  });
  win.eval(fiberSource); win.eval(domSource);
  return { api: (win as any).CLF_DOM, state, props, selections, actions, freeze: () => { frozen = true; } };
}
it('reads localized nested models and future efforts from account state, excludes locked choices, and restores selection', async () => {
  const f = fixture();
  expect(await f.api.inspectModelSettings()).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'], aliases: ['future-model'] }
  ]);
  expect(f.state.selectedVersionEntry.id).toBe('latest'); expect(f.state.currentBucket).toBe(2);
  // Only restore the original High once; discovery never sweeps every power level.
  expect(f.actions.mock.calls.filter(([action]) => action === 'effort')).toHaveLength(1);
});
it('discovers account models when picker state and model data belong to adjacent React owners', async () => {
  const f = fixture(true);
  expect(await f.api.inspectModelSettings()).toEqual([
    { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] },
    { id: 'future-model', label: 'Neues Modell', efforts: ['low', 'ultra'], aliases: ['future-model'] }
  ]);
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentBucket).toBe(2);
});
it('rejects a mounted composer hidden by Settings while recognizing the visible High picker', async () => {
  const f = fixture(), doc = page.window.document;
  doc.querySelector('button')!.textContent = 'High';
  expect(f.api.composerVisible()).toBe(true);
  const editor = doc.querySelector('#prompt-textarea')!;
  editor.setAttribute('aria-hidden', 'true');
  expect(f.api.composerVisible()).toBe(false);
  editor.removeAttribute('aria-hidden');
  doc.querySelector('form')!.setAttribute('inert', '');
  expect(f.api.composerVisible()).toBe(false);
  doc.querySelector('form')!.removeAttribute('inert');
  expect(f.api.composerVisible()).toBe(true);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.currentBucket).toBe(2);
});
it('confirms the exact model and effort and refuses visible upgrade-only entries', async () => {
  const f = fixture();
  expect(await f.api.selectModelSettings('future-model', 'ultra')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
  expect(await f.api.selectModelSettings('gpt-6-pro', 'pro')).toBe(false);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'future-model', thinkingEffort: 'ultra' });
});
it.each(['5.6', 'gpt-5.6-sol', 'gpt-5-6', 'gpt-5-6-thinking'])('accepts strong current Sol proof without reopening the picker for %s', async requested => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  trigger.setAttribute('data-clf-selected-model', 'gpt-5-6-thinking');
  trigger.setAttribute('data-clf-selected-effort', 'high');
  trigger.setAttribute('data-clf-selected-route', page.window.location.pathname);
  expect(await f.api.selectModelSettings(requested, 'high')).toBe(true);
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
});
it('actively refreshes fresh-document provider proof before opening the picker', async () => {
  const f = fixture();
  expect(f.api.visibleModelSelection()).toBeNull();
  expect(await f.api.selectModelSettings('5.6', 'high')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
});
it('does not treat current-model proof as confirmation when the requested effort differs', async () => {
  const f = fixture(), trigger = page.window.document.querySelector('button')!;
  f.state.currentBucket = f.selections[0]![0]!.bucket;
  f.state.currentSelection = f.selections[0]![0]!;
  const opened = vi.fn();
  trigger.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') opened(); });
  trigger.setAttribute('data-clf-selected-model', 'gpt-5-6-thinking');
  trigger.setAttribute('data-clf-selected-effort', 'medium');
  trigger.setAttribute('data-clf-selected-route', page.window.location.pathname);
  expect(await f.api.selectModelSettings('5.6', 'high')).toBe(true);
  expect(opened).toHaveBeenCalled();
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('reports a bounded diagnostic when no native model picker trigger exists', async () => {
  page = new JSDOM('<form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  page.window.eval(domSource);
  const api = (page.window as any).CLF_DOM;
  expect(await api.selectModelSettings('5.6', 'high')).toBe(false);
  expect(api.modelSelectionFailureReason()).toBe('picker_trigger_missing');
});
it('selects the native labelled model control when ChatGPT renders it as a sibling of the composer form', async () => {
  const f = fixture(), doc = page.window.document;
  const editor = doc.querySelector('#prompt-textarea')!;
  editor.removeAttribute('id'); editor.setAttribute('role', 'textbox');
  const trigger = doc.querySelector('button')!;
  trigger.removeAttribute('aria-haspopup');
  trigger.setAttribute('aria-label', 'Select ChatGPT model');
  const form = doc.querySelector('form')!;
  form.before(trigger);
  expect(form.contains(trigger)).toBe(false);
  expect(await f.api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('uses the alternate shell picker owner and portal without requiring the classic picker test id', async () => {
  page = new JSDOM('<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div><button type="button" data-codex-intelligence-trigger data-selected-reasoning-effort="high">Select ChatGPT model</button><button type="submit">Send</button></form>',
    { url: 'https://chatgpt.com/c/shell-picker', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const medium = { powerSettingIndex: 0, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'medium' };
  const high = { powerSettingIndex: 1, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'high' };
  const props: any = { powerSelections: [medium, high], selectedPowerSelection: high,
    modelListConfig: { options: [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }] }, modelSelectionDisabled: false };
  const trigger = doc.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!;
  const fiber = { memoizedProps: props, return: null };
  (trigger as any).__reactFiber$test = fiber;
  const render = () => {
    const menu = doc.createElement('div'); menu.setAttribute('role', 'menu');
    const panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', '');
    (panel as any).__reactFiber$test = fiber;
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle></div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      props.selectedPowerSelection = event.key === 'ArrowLeft' ? medium : high;
      trigger.setAttribute('data-selected-reasoning-effort', props.selectedPowerSelection.reasoningEffort);
    });
    panel.addEventListener('keydown', (event: any) => { if (event.key === 'Escape') menu.remove(); });
    menu.append(panel); doc.body.append(menu);
  };
  trigger.addEventListener('keydown', (event: any) => { if (event.key === 'Enter' && !doc.querySelector('[data-model-picker-view]')) render(); });
  win.eval(fiberSource); win.eval(domSource);
  const api = (win as any).CLF_DOM;
  // Same-pair sends are confirmed passively and never have to open the menu.
  expect(await api.selectModelSettings('gpt-5-6-thinking', 'high')).toBe(true);
  expect(doc.querySelector('[data-model-picker-view]')).toBeNull();
  // A real change opens the alternate portal, drives its native power control and closes it.
  expect(await api.selectModelSettings('gpt-5-6-thinking', 'medium')).toBe(true);
  expect(props.selectedPowerSelection).toBe(medium);
  expect(doc.querySelector('[data-model-picker-view]')).toBeNull();
});
it('reads GPT-6 Instant and thinking lanes as one family, and names "5.6" in full (ported from Chat On Steroids 2.1.31)', async () => {
  // ChatGPT's picker as observed 2026-10-07: gpt-6 (Instant) and gpt-6-thinking (Medium, High) under one name,
  // and older models by number alone. GPT-5.6 Sol is no longer offered.
  page = new JSDOM('<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div><button type="button" data-codex-intelligence-trigger data-selected-reasoning-effort="high">Select ChatGPT model</button><button type="submit">Send</button></form>',
    { url: 'https://chatgpt.com/c/gpt6-picker', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const lanes = [
    { powerSettingIndex: 0, model: 'gpt-6', modelLabel: 'GPT-6', reasoningEffort: 'none', sliderLabel: 'Instant', labels: { effort: 'Instant' } },
    { powerSettingIndex: 1, model: 'gpt-6-thinking', modelLabel: 'GPT-6', reasoningEffort: 'medium' },
    { powerSettingIndex: 2, model: 'gpt-6-thinking', modelLabel: 'GPT-6', reasoningEffort: 'high' },
    { powerSettingIndex: 3, model: 'gpt-5-6-instant', modelLabel: '5.6', reasoningEffort: 'none', sliderLabel: 'Instant', labels: { effort: 'Instant' } },
    { powerSettingIndex: 4, model: 'gpt-5-6-thinking', modelLabel: '5.6', reasoningEffort: 'high' }
  ];
  const props: any = { powerSelections: lanes, selectedPowerSelection: lanes[2],
    modelListConfig: { options: [{ id: 'gpt-6', label: 'GPT-6', selected: true }] }, modelSelectionDisabled: false };
  const trigger = doc.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!;
  const fiber = { memoizedProps: props, return: null };
  (trigger as any).__reactFiber$test = fiber;
  trigger.addEventListener('keydown', (event: any) => {
    if (event.key !== 'Enter' || doc.querySelector('[data-model-picker-view]')) return;
    const menu = doc.createElement('div'); menu.setAttribute('role', 'menu');
    const panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', '');
    (panel as any).__reactFiber$test = fiber;
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle></div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.addEventListener('keydown', (key: any) => { if (key.key === 'Escape') menu.remove(); });
    menu.append(panel); doc.body.append(menu);
  });
  win.eval(fiberSource); win.eval(domSource);
  const failures: unknown[] = [];
  const models = await (win as any).CLF_DOM.inspectModelSettings(() => true, (reason: unknown) => failures.push(reason), () => {});
  expect(failures).toEqual([]);
  expect(models.find((model: any) => model.id === 'gpt-6')).toEqual({ id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high'], aliases: ['gpt-6', 'gpt-6-thinking'] });
  expect(models.find((model: any) => model.id === 'gpt-5-6')).toMatchObject({ label: 'GPT-5.6', efforts: ['none', 'high'] });
});
it('collapses equivalent intelligence and reasoning controls to one exact shell picker owner', async () => {
  page = new JSDOM('<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div><button type="button" data-codex-intelligence-trigger data-selected-reasoning-effort="high">Select ChatGPT model</button><button type="button" data-composer-navigation-target="reasoning">Reasoning</button><button type="submit">Send</button></form>',
    { url: 'https://chatgpt.com/c/double-shell-picker', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const medium = { powerSettingIndex: 0, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'medium' };
  const high = { powerSettingIndex: 1, model: 'gpt-5-6-thinking', modelLabel: 'GPT-5.6 Sol', reasoningEffort: 'high' };
  const props: any = { powerSelections: [medium, high], selectedPowerSelection: high,
    modelListConfig: { options: [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }] }, modelSelectionDisabled: false };
  const owner = { memoizedProps: props, return: null };
  const intelligence = doc.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!;
  const reasoning = doc.querySelector<HTMLElement>('[data-composer-navigation-target="reasoning"]')!;
  (intelligence as any).__reactFiber$test = owner;
  (reasoning as any).__reactFiber$test = owner;
  const render = () => {
    const menu = doc.createElement('div'); menu.setAttribute('role', 'menu');
    const panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', '');
    (panel as any).__reactFiber$test = owner;
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle></div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      props.selectedPowerSelection = event.key === 'ArrowLeft' ? medium : high;
      intelligence.setAttribute('data-selected-reasoning-effort', props.selectedPowerSelection.reasoningEffort);
    });
    panel.addEventListener('keydown', (event: any) => { if (event.key === 'Escape') menu.remove(); });
    menu.append(panel); doc.body.append(menu);
  };
  intelligence.addEventListener('keydown', (event: any) => { if (event.key === 'Enter' && !doc.querySelector('[data-model-picker-view]')) render(); });
  win.eval(fiberSource); win.eval(domSource);
  const api = (win as any).CLF_DOM;
  expect(await api.selectModelSettings('5.6', 'high')).toBe(true);
  expect(intelligence.getAttribute('data-clf-picker-route')).toBe(win.location.pathname);
  expect(reasoning.hasAttribute('data-clf-picker-route')).toBe(false);
  expect(await api.selectModelSettings('5.6', 'medium')).toBe(true);
  expect(props.selectedPowerSelection).toBe(medium);
});
it('keeps conflicting provider picker owners ambiguous even when both controls share one composer', async () => {
  page = new JSDOM('<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div><button type="button" data-codex-intelligence-trigger>Select ChatGPT model</button><button type="button" data-composer-navigation-target="reasoning">Reasoning</button><button type="submit">Send</button></form>',
    { url: 'https://chatgpt.com/c/conflicting-shell-picker', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value: () => [{}] });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const state = (model: string) => ({ memoizedProps: {
    powerSelections: [{ powerSettingIndex: 0, model, modelLabel: model, reasoningEffort: 'medium' }],
    selectedPowerSelection: { powerSettingIndex: 0, model, modelLabel: model, reasoningEffort: 'medium' },
    modelListConfig: { options: [{ id: model, label: model, selected: true }] }, modelSelectionDisabled: false
  }, return: null });
  (doc.querySelector('[data-codex-intelligence-trigger]') as any).__reactFiber$test = state('gpt-5-6-thinking');
  (doc.querySelector('[data-composer-navigation-target="reasoning"]') as any).__reactFiber$test = state('future-model');
  win.eval(fiberSource); win.eval(domSource);
  const api = (win as any).CLF_DOM;
  expect(await api.selectModelSettings('5.6', 'medium')).toBe(false);
  expect(api.modelSelectionFailureReason()).toBe('picker_trigger_ambiguous');
  expect(doc.querySelectorAll('[data-clf-picker-route]')).toHaveLength(0);
});
it('groups provider family lanes and selects Pro through the same family instead of a separate execution slug', async () => {
  const f = fixture();
  const version = f.props.modelsData.versions[0]!;
  version.id = '5.6'; version.displayTextForIntelligence = 'GPT-5.6 Sol';
  for (const selection of f.selections[0]!) (selection.category as any).modelVersion = '5.6';
  const pro = f.selections[0]![2]!;
  pro.modelSlug = 'gpt-5-6-pro'; pro.availability.status = 'available'; pro.category.shortLabel = '5.6 Pro';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] });
  expect(await f.api.selectModelSettings('5.6', 'pro')).toBe(true);
  expect(f.state.currentSelection.modelSlug).toBe('gpt-5-6-pro');
  // Existing stored family display slugs retain their requested Pro effort too.
  expect(await f.api.selectModelSettings('gpt-5.6-sol', 'pro')).toBe(true);
});
it('reads an already-open version submenu and restores its original exact power', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  (page.window.document.querySelector('[aria-expanded]') as HTMLElement).click();
  expect(page.window.document.querySelectorAll('[role=menuitemradio]')).toHaveLength(2);
  expect(await f.api.inspectModelSettings()).toHaveLength(2);
  expect(f.state.selectedVersionEntry.id).toBe('latest');
  expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended' });
});
it('invalidates mounted selection proof when provider state becomes unrecognized', async () => {
  const f = fixture();
  page.window.document.querySelector('button')!.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const read = async () => {
    await new Promise<void>(resolve => {
      const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-picker-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
      page.window.addEventListener('message', receive as any);
      page.window.postMessage({ source: 'clf-picker-ask', nonce: 'fixture' }, page.window.location.origin);
    });
    return f.api.visibleModelSelection();
  };
  expect(await read()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  f.state.currentSelection.thinkingEffort = 'unknown-provider-value';
  expect(await read()).toBeNull();
});
it.each([false, true])('observes direct Chrome selection with the picker closed and invalidates another route (idless=%s)', async idless => {
  const f = fixture();
  if (idless) {
    const editor = page.window.document.querySelector('#prompt-textarea')!;
    editor.removeAttribute('id');
    editor.setAttribute('role', 'textbox');
  }
  page.window.document.querySelector('[data-testid="composer-trailing-actions"]')!.removeAttribute('data-testid');
  const plus = page.window.document.createElement('button');
  plus.id = 'composer-plus-btn'; plus.setAttribute('aria-haspopup', 'menu');
  page.window.document.querySelector('form')!.append(plus);
  const trigger = page.window.document.querySelector('button')!;
  trigger.textContent = idless ? 'Thinking effortExtra High' : 'Extra High';
  (trigger as any).__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { currentModelId: 'gpt-5-6-thinking' }, return: null } };
  const scan = () => new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => { if (event.data?.source === 'clf-fiber-reply') { page.window.removeEventListener('message', receive as any); resolve(); } };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-fiber-ask', nonce: 'passive-test' }, page.window.location.origin);
  });
  await scan();
  expect(page.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
  expect(f.actions).not.toHaveBeenCalled();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'xhigh' });
  const owner = (trigger as any).__reactFiber$test.return;
  owner.return = { memoizedProps: { currentModelId: 'different-model' }, return: null };
  await scan();
  expect(f.api.visibleModelSelection()).toBeNull();
  owner.return = null;
  await scan();
  page.window.history.pushState({}, '', '/c/other');
  expect(f.api.visibleModelSelection()).toBeNull();
  trigger.textContent = 'Unrecognized effort';
  await scan();
  page.window.history.pushState({}, '', '/');
  expect(f.api.visibleModelSelection()).toBeNull();
});
it('invalidates closed model proof when an idless composer becomes ambiguous', async () => {
  const f = fixture(), doc = page.window.document;
  const editor = doc.querySelector('#prompt-textarea')!;
  editor.removeAttribute('id'); editor.setAttribute('role', 'textbox');
  // One version permits passive account discovery without opening a portal.
  f.props.modelsData.versions.splice(1);
  expect(await f.api.inspectModelSettings()).toHaveLength(1);
  expect(f.api.visibleModelSelection()).toMatchObject({ model: 'gpt-5-6-thinking' });
  const duplicate = doc.createElement('form');
  duplicate.innerHTML = '<div role="textbox" contenteditable="true"></div><button data-testid="send-button">Send</button>';
  doc.body.append(duplicate);
  await new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply') return;
      page.window.removeEventListener('message', receive as any); resolve();
    };
    page.window.addEventListener('message', receive as any);
    page.window.postMessage({ source: 'clf-picker-ask', nonce: 'ambiguous-composer' }, page.window.location.origin);
  });
  expect(f.api.visibleModelSelection()).toBeNull();
});
it.each([false, true])('keeps an explicit model denial unavailable even when picker evidence is split (split=%s)', async split => {
  const f = fixture(split); (f.props.modelSwitcherDenialsBySlug as any)['future-model'] = { reason: 'workspace_policy' };
  expect(await f.api.inspectModelSettings()).toEqual([{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] }]);
});
it('recognizes the provider min effort as Low without invalidating the account catalog', async () => {
  const f = fixture(); f.selections[0]![0]!.thinkingEffort = 'min';
  expect(await f.api.inspectModelSettings()).toContainEqual({ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Sol', efforts: ['low', 'high'], aliases: ['gpt-5-6-thinking'] });
});
it('does not mutate the picker after navigation ownership is lost', async () => {
  const f = fixture(); expect(await f.api.selectModelSettings('future-model', 'ultra', () => false)).toBe(false);
  expect(f.actions).not.toHaveBeenCalled();
});
it('projects an allowlist rather than leaking conversation props through the bridge', async () => {
  const f = fixture(); const replies: unknown[] = [];
  page.window.addEventListener('message', event => { if (event.data?.source === 'clf-picker-reply') replies.push(event.data); });
  await f.api.inspectModelSettings();
  expect(replies.length).toBeGreaterThan(0);
  expect(JSON.stringify(replies)).not.toMatch(/privateSecret|must-never-cross|conversation|modelsData/);
});
