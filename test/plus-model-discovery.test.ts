import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChatModels,
  observeChatModels,
  pendingChatModelRequest,
  requestChatModels,
  resetChatModelsForTests,
  restoreChatModels
} from '../src/main/chat-models.js';

const saved = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => saved.value,
  writeDurableSoon: (_name: string, value: unknown) => { saved.value = structuredClone(value); }
}));

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const solCatalog = [{
  id: '5.6',
  label: 'GPT-5.6 Sol',
  efforts: ['none', 'high'],
  aliases: ['gpt-5-6-thinking']
}];

let page: JSDOM | undefined;

beforeEach(() => {
  resetChatModelsForTests();
  saved.value = null;
  vi.useRealTimers();
});

afterEach(() => {
  page?.window.close();
  page = undefined;
  vi.useRealTimers();
});

function plusComposer(options: { hydratePickerAfterMs?: number; initialBucket?: number } = {}) {
  page = new JSDOM(
    '<form><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-testid="composer-trailing-actions"><button data-testid="send-button">Send</button></div></form>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' }
  );
  const win = page.window;
  const doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', {
    value() { return this.hidden ? [] : [{}]; }
  });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', {
    data,
    source: win as unknown as Window,
    origin: win.location.origin
  })));

  const choices = [
    {
      bucket: 1,
      modelSlug: 'gpt-5-6-thinking',
      thinkingEffort: 'standard',
      availability: { status: 'available' },
      category: { modelLane: 'auto', shortLabel: '5.6 Sol', modelVersion: '5.6' }
    },
    {
      bucket: 2,
      modelSlug: 'gpt-5-6-thinking',
      thinkingEffort: 'extended',
      availability: { status: 'available' },
      category: { modelLane: 'thinking', shortLabel: '5.6 Sol', modelVersion: '5.6' }
    }
  ];
  const versions = [{ id: '5.6', displayTextForIntelligence: 'GPT-5.6 Sol', enabled: true }];
  const initial = choices.find(choice => choice.bucket === (options.initialBucket ?? 1)) ?? choices[0]!;
  const pickerActions = vi.fn();
  const state = {
    bucketSelections: choices,
    currentBucket: initial.bucket,
    selectedVersionEntry: versions[0],
    currentSelection: initial
  };
  const props = {
    modelsData: { versions },
    composerIntelligencePickerState: state,
    modelSwitcherDenialsBySlug: {}
  };

  const renderPicker = () => {
    let panel = doc.querySelector('[data-testid="composer-intelligence-picker-content"]') as HTMLElement | null;
    if (!panel) {
      panel = doc.createElement('div');
      panel.dataset.testid = 'composer-intelligence-picker-content';
      doc.body.append(panel);
    }
    (panel as any).__reactFiber$plus = { memoizedProps: props, return: null };
    panel.innerHTML = '<div role="menuitem" aria-expanded="false">Model</div>' +
      '<div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight" aria-label="Power"></div>';
    panel.querySelector('[aria-expanded]')!.addEventListener('click', () => {
      pickerActions('versions');
      panel!.innerHTML = '';
      for (const version of versions) {
        const row = doc.createElement('div');
        row.setAttribute('role', 'menuitemradio');
        row.textContent = version.displayTextForIntelligence;
        row.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          pickerActions('version');
          state.selectedVersionEntry = version;
          state.bucketSelections = choices;
          state.currentBucket = choices[0]!.bucket;
          state.currentSelection = choices[0]!;
          renderPicker();
        });
        panel!.append(row);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: Event) => {
      const key = (event as KeyboardEvent).key;
      pickerActions('effort');
      const from = choices.findIndex(choice => choice.bucket === state.currentBucket);
      const next = choices[from + (key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      state.currentBucket = next.bucket;
      state.currentSelection = next;
      renderPicker();
    });
  };

  const hydratePicker = () => {
    if (doc.querySelector('[data-plus-model-trigger]')) return;
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.textContent = initial.bucket === 2 ? 'High' : 'Auto';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('data-plus-model-trigger', '');
    (trigger as any).__reactFiber$plus = { memoizedProps: props, return: null };
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Enter') { pickerActions('open'); renderPicker(); }
      if (event.key === 'Escape') doc.querySelector('[data-testid="composer-intelligence-picker-content"]')?.remove();
    });
    doc.querySelector('[data-testid="composer-trailing-actions"]')!.prepend(trigger);
  };

  win.eval(fiberSource);
  win.eval(domSource);
  if (options.hydratePickerAfterMs === undefined) hydratePicker();
  else win.setTimeout(hydratePicker, options.hydratePickerAfterMs);

  return { api: (win as any).CLF_DOM, state, pickerActions };
}

describe('fresh Plus account model discovery', () => {
  it('discovers provider-present Sol High from untouched New Chat before any native picker interaction', async () => {
    const f = plusComposer({ initialBucket: 2 });

    expect(page!.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
    expect(page!.window.document.querySelector('[data-plus-model-trigger]')?.textContent).toBe('High');
    expect(f.state.currentSelection).toMatchObject({
      modelSlug: 'gpt-5-6-thinking',
      thinkingEffort: 'extended',
      category: { modelLane: 'thinking', modelVersion: '5.6' }
    });

    expect(await f.api.inspectModelSettings()).toEqual(solCatalog);
    expect(page!.window.document.querySelector('[data-testid="composer-intelligence-picker-content"]')).toBeNull();
    expect(f.pickerActions).not.toHaveBeenCalled();
    expect(f.api.visibleModelSelection()).toEqual({ model: 'gpt-5-6-thinking', reasoningEffort: 'high' });
  });

  it('does not classify a paid composer as native-default before its Sol picker finishes hydrating', async () => {
    const f = plusComposer({ hydratePickerAfterMs: 1_000 });
    const nativeDefault = vi.fn();

    expect(await f.api.inspectModelSettings(() => true, () => {}, nativeDefault)).toEqual(solCatalog);
    expect(nativeDefault).not.toHaveBeenCalled();
  });

  it('discovers Sol while the native composer is on Auto/default, then lets Eve select Sol High', async () => {
    const f = plusComposer();

    expect(await f.api.inspectModelSettings()).toEqual(solCatalog);
    expect(f.state.currentSelection).toMatchObject({ modelSlug: 'gpt-5-6-thinking', category: { modelLane: 'auto' } });

    expect(await f.api.selectModelSettings('5.6', 'high')).toBe(true);
    expect(f.state.currentSelection).toMatchObject({
      modelSlug: 'gpt-5-6-thinking',
      thinkingEffort: 'extended',
      category: { modelLane: 'thinking' }
    });
  });

  it('replaces native-default with a later Sol refresh, rejects the stale reply, and restores Sol after reconnect', async () => {
    vi.useFakeTimers();
    requestChatModels();
    expect(observeChatModels({ nonce: pendingChatModelRequest()!.nonce, models: null, nativeDefault: true })).toBe(true);
    expect(getChatModels()).toMatchObject({ state: 'ready', models: [], nativeDefault: true });

    requestChatModels();
    const stale = pendingChatModelRequest()!;
    vi.advanceTimersByTime(120_001);
    requestChatModels();
    const current = pendingChatModelRequest()!;
    expect(current.nonce).not.toBe(stale.nonce);
    expect(observeChatModels({ nonce: stale.nonce, models: solCatalog })).toBe(false);
    expect(observeChatModels({ nonce: current.nonce, models: solCatalog })).toBe(true);
    expect(getChatModels()).toMatchObject({ state: 'ready', models: solCatalog, nativeDefault: false });

    resetChatModelsForTests();
    await restoreChatModels();
    expect(getChatModels()).toMatchObject({ state: 'ready', models: solCatalog });
  });
});
