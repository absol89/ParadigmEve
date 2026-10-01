import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    onboarding: { complete: false },
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    mcp: { connectorName: 'Eve', instructions: '' },
    goal: {
      enabled: false,
      models: { openrouter: ['deepseek/deepseek-v4-flash'], custom: [] },
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const state = {
    config: baseConfig,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(w.document.querySelector('label[for="tunnelId"]')?.textContent).toContain('Eve');
  expect(w.document.getElementById('desktopTunnelId')).toBeNull();
  expect(w.document.getElementById('setupComputerUse')).not.toBeNull();
  expect(w.document.getElementById('tunnelPrivacy')).not.toBeNull();
  expect(w.document.getElementById('apiKeyPrivacy')).not.toBeNull();
  expect(w.document.getElementById('copyTunnelId')).not.toBeNull();
  expect(w.document.getElementById('copyDesktopTunnelId')).toBeNull();
  const setupLinks = [...w.document.querySelectorAll<HTMLElement>('[data-setup-link]')]
    .map((node) => node.getAttribute('data-setup-link'));
  expect(setupLinks).toContain('https://chatgpt.com/#settings/Security?section=developer-mode');
  expect(setupLinks).toContain('https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins');
  expect(setupLinks).toContain('chrome://extensions/');
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('No authentication');
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('Developer mode');
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('icon.png');
  expect(w.document.getElementById('connectorIconFile')).not.toBeNull();
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('Allow low risk actions');
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('Allow all actions');
  expect(w.document.querySelector('[data-step="chatgpt"]')?.textContent).toContain('Choose how much autonomy you want');

  const field = w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(baseConfig.tunnel.tunnelId);
  field.focus();
  field.value = 'tunnel_USER_IS_STILL_TYPING';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('tunnel_USER_IS_STILL_TYPING');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  const allowUnattributed = w.document.getElementById('allowUnattributedCalls') as HTMLInputElement;
  allowUnattributed.focus();
  allowUnattributed.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(allowUnattributed);
  expect(allowUnattributed.checked).toBe(true);

  // The settings sheet used to bypass the dirty-field guard used by Home. An unrelated
  // status push therefore erased this value while the user was still typing it.
  const compactionThreshold = w.document.getElementById('autoCompactTokens') as HTMLInputElement;
  compactionThreshold.focus();
  compactionThreshold.value = '355000';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(compactionThreshold);
  expect(compactionThreshold.value).toBe('355000');

  compactionThreshold.blur();
  const updatedThreshold = structuredClone(state) as any;
  updatedThreshold.config.compaction.autoTokens = 320000;
  stateListener(updatedThreshold);
  expect(compactionThreshold.value).toBe('320000');

  const goalPrompt = w.document.getElementById('goalPrompt') as HTMLTextAreaElement;
  goalPrompt.focus();
  goalPrompt.value = 'USER IS STILL EDITING THIS PROMPT';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(goalPrompt);
  expect(goalPrompt.value).toBe('USER IS STILL EDITING THIS PROMPT');

  // The health card reports the live surface projection rather than a hand-maintained
  // denominator. Tool consolidation/additions should never leave the UI saying "of 9"
  // when nine is no longer the product's actual maximum.
  const withTools = structuredClone(state) as any;
  withTools.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read', 'apply_patch'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    }
  ];
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('Tools available2 total');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');
  expect(w.document.getElementById('connectorCards')!.textContent).toContain('Choose Tunnel, then pick Eve.');
  expect(w.document.getElementById('connectorCards')!.textContent).not.toContain('Computer use Tunnel');
  expect(w.document.querySelectorAll('#connectorCards .connector')).toHaveLength(1);
  expect(w.document.getElementById('desktopTunnelField')).toBeNull();

  const tunnelField = w.document.getElementById('tunnelId') as HTMLInputElement;
  const apiKeyField = w.document.getElementById('apiKey') as HTMLInputElement;
  expect(tunnelField.type).toBe('password');
  expect(apiKeyField.type).toBe('password');
  expect(w.document.querySelector('.setup-privacy-note')?.textContent).toContain('recording');
  expect(w.document.querySelector('.setup-privacy-note')?.textContent).toContain('streaming');
  w.document.getElementById('tunnelPrivacy')!.click();
  expect(tunnelField.type).toBe('text');
  expect(w.document.getElementById('tunnelPrivacy')?.getAttribute('aria-pressed')).toBe('true');
  w.document.getElementById('tunnelPrivacy')!.click();
  expect(tunnelField.type).toBe('password');
  expect(w.localStorage.getItem('paradigmeve.setupPrivacy.tunnel')).toBeNull();
  w.document.getElementById('apiKeyPrivacy')!.click();
  expect(apiKeyField.type).toBe('text');
  w.document.getElementById('apiKeyPrivacy')!.click();
  expect(apiKeyField.type).toBe('password');

  const withMissingMacAccess = structuredClone(withTools) as any;
  withMissingMacAccess.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  withMissingMacAccess.config.readOnly = false;
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('live verdicts from the native backend');
  expect((w.document.getElementById('openDesktopScreen') as HTMLButtonElement).hidden).toBe(true);
  expect((w.document.getElementById('openDesktopAccessibility') as HTMLButtonElement).hidden).toBe(false);

  const withReadOnlyMacAccess = structuredClone(withMissingMacAccess) as any;
  withReadOnlyMacAccess.config.readOnly = true;
  stateListener(withReadOnlyMacAccess);
  expect(accessWarning.hidden).toBe(true);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    mcp: { connectorName: 'Eve', instructions: '' },
    goal: {
      enabled: false,
      models: { openrouter: ['deepseek/deepseek-v4-flash'], custom: [] },
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const theme = w.document.getElementById('themeBtn') as HTMLButtonElement;
  expect(theme.closest('.sidebar-brand')).not.toBeNull();
  expect(theme.previousElementSibling?.tagName).toBe('STRONG');
  expect(w.document.querySelector('header #themeBtn')).toBeNull();
  expect(theme.querySelector('.coffee-surface')).not.toBeNull();
  expect(theme.title).toBe('Switch to dark mode');
  expect(theme.getAttribute('aria-label')).toBe('Switch to dark mode');
  expect(theme.getAttribute('aria-pressed')).toBe('false');

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved,
  // matching a real save that is waiting for bridge/tunnel lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // A second click before the first acknowledgement means "back off". The old handler derived
  // both clicks from state.config.readOnly=false, so both snapshots requested true and the two
  // clicks behaved like one.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();

  // While both are queued, change an unrelated checkbox. It must inherit the latest requested
  // read-only intent rather than the stale acknowledged state.
  const auto = w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(calls[2].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Theme has the same no-form-control shape. Two rapid clicks must request dark then light,
  // even though the first dark save has not answered yet.
  theme.click();
  expect(w.document.documentElement.dataset.theme).toBe('dark');
  expect(theme.title).toBe('Switch to light mode');
  expect(theme.getAttribute('aria-label')).toBe('Switch to light mode');
  expect(theme.getAttribute('aria-pressed')).toBe('true');
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.click();
  expect(w.document.documentElement.dataset.theme).toBe('light');
  expect(theme.title).toBe('Switch to dark mode');
  expect(theme.getAttribute('aria-label')).toBe('Switch to dark mode');
  expect(theme.getAttribute('aria-pressed')).toBe('false');
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * The goal loop's settings panel.
 *
 * Three things are worth pinning here and the rest is layout: the key never travels with the
 * settings, the catalogue is only fetched when somebody asks for it, and an install with no
 * key says so in the words the extension says it in.
 */

interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

async function mountChat(
  overrides: Record<string, unknown> = {},
  models: any[] = [],
  apiOverrides: Record<string, (...args: any[]) => any> = {},
  initialGoal: Record<string, unknown> = {},
  beforeImport?: (window: JSDOM['window']) => void
): Promise<GoalMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { Event: w.Event });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    onboarding: { complete: false },
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    mcp: { connectorName: 'Eve', instructions: '' },
    goal: {
      enabled: false,
      models: { openrouter: ['deepseek/deepseek-v4-flash'], custom: [] },
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
      ...initialGoal
    }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const modelPages: any[] = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel
      // paints from the app's answer rather than from what it just clicked, so a fake that
      // replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setGoalKey: (value: string) => {
        keys.push({ method: 'setGoalKey', value });
        return ok({ ...state, hasGoalKey: value !== '' });
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      listGoalModels: (offset: number) => {
        const page = { models: models.slice(offset, offset + 20), total: models.length, offset };
        modelPages.push(page);
        return ok(page);
      },
      ...apiOverrides
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  beforeImport?.(w);
  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, modelPages, state, push: (next) => listener(next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
it('publishes a slow history read once across navigation while project loading is still pending', async () => {
  let resolveList!: (value: any) => void;
  let resolveProjects!: (value: any) => void;
  const listSessions = vi.fn(() => new Promise(resolve => { resolveList = resolve; }));
  const mounted = await mountChat({}, [], {
    listSessions,
    listProjects: () => new Promise(resolve => { resolveProjects = resolve; })
  });
  const chat = await import('../src/renderer/chat.js');
  chat.chatVisible(true); chat.chatVisible(false); chat.chatVisible(true);
  expect(listSessions).toHaveBeenCalledTimes(1);
  const session = {
    id: 'historical-chat', title: 'Saved history', conversationId: 'historical-conversation', chatIds: ['historical-conversation'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  resolveList({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [], total: 1, nextCursor: null } });
  await settle();
  expect(mounted.window.document.querySelector('[data-id="historical-chat"]')).not.toBeNull();
  resolveProjects({ ok: false, error: 'Project catalog unavailable' });
  await settle();
  expect(mounted.window.document.querySelector('[data-id="historical-chat"]')).not.toBeNull();
  chat.chatVisible(false);
});


it('keeps visible history after a failed older page without retrying in a microtask loop', async () => {
  let resolveOlder!: (value: any) => void;
  const older = vi.fn(() => new Promise(resolve => { resolveOlder = resolve; }));
  const session = {
    id: 'visible-history', title: 'Visible history', conversationId: 'visible-conversation', chatIds: ['visible-conversation'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const mounted = await mountChat({}, [], {
    listSessions: ({ cursor }: any) => cursor ? older() : Promise.resolve({ ok: true, data: {
      sessions: [session], activeId: null, pressure: [], blocked: [], total: 2,
      nextCursor: { updatedAt: 2, id: session.id }
    } })
  });
  // A laid-out pane that is not yet scrollable: fill-until-scrollable must ask for the older page.
  const pane = mounted.window.document.getElementById('sessionList')!.closest('.scroll') as HTMLElement;
  Object.defineProperty(pane, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(pane, 'scrollHeight', { value: 400, configurable: true });
  const chat = await import('../src/renderer/chat.js');
  chat.chatVisible(true);
  await vi.waitFor(() => expect(older).toHaveBeenCalledTimes(1));
  resolveOlder({ ok: false, error: 'History page temporarily unavailable' });
  await settle(); await settle();
  expect(older).toHaveBeenCalledTimes(1);
  expect(mounted.window.document.querySelector('[data-id="visible-history"]')).not.toBeNull();
  chat.chatVisible(false);
});

it('auto-fills older session pages when the first historical page does not create a scrollbar', async () => {
  const session = (id: string, title: string, updatedAt: number) => ({
    id, title, conversationId: `${id}-conversation`, chatIds: [`${id}-conversation`],
    startedAt: 1, updatedAt, endedAt: null, events: 0, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  });
  const newest = session('newest-session', 'Newest session', 2);
  const older = session('older-session', 'Older historical session', 1);
  const calls: Array<{ cursor?: string }> = [];
  const mounted = await mountChat({}, [], {
    listSessions: async (options: { cursor?: string } = {}) => {
      calls.push(options);
      return options.cursor === 'older-page'
        ? { ok: true, data: { sessions: [older], activeId: newest.id, pressure: [], blocked: [], total: 2, nextCursor: null } }
        : { ok: true, data: { sessions: [newest], activeId: newest.id, pressure: [], blocked: [], total: 2, nextCursor: 'older-page' } };
    }
  });
  // A laid-out pane whose first page does not overflow: fill-until-scrollable pages on.
  const pane = mounted.window.document.getElementById('sessionList')!.closest('.scroll') as HTMLElement;
  Object.defineProperty(pane, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(pane, 'scrollHeight', { value: 400, configurable: true });
  (mounted.window.document.getElementById('backToChat') as HTMLButtonElement).click();
  await settle();
  await vi.waitFor(() => expect(calls.some(call => call.cursor === 'older-page')).toBe(true));
  expect(mounted.window.document.querySelector('[data-id="newest-session"]')).not.toBeNull();
  expect(mounted.window.document.querySelector('[data-id="older-session"]')).not.toBeNull();
});

it('does not present historical broker-owner attribution as current ownership after the swarm parks', async () => {
  const session = {
    id: 'prime-session', title: 'Release coordination', conversationId: 'prime-conversation', chatIds: ['prime-conversation'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: ['prime'], origin: null
  };
  const mounted = await mountChat({}, [], {
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: session.id, pressure: [], blocked: [] } })
  });
  (mounted.window.document.getElementById('backToChat') as HTMLButtonElement).click();
  await settle();

  expect(mounted.window.document.querySelector('[data-id="prime-session"] .session-role-badge')).toBeNull();
});

it('shows the configured agent name only for the exact conversation owned by the current swarm', async () => {
  const current = {
    id: 'current-prime', title: 'Current coordination', conversationId: 'current-prime-conversation', chatIds: ['current-prime-conversation'],
    startedAt: 1, updatedAt: 3, endedAt: null, events: 0, userMessages: 1, toolCalls: 1, lastToolCallAt: 2,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: ['prime'], origin: null
  };
  const stale = { ...current, id: 'stale-prime', title: 'Old coordination', conversationId: 'stale-prime-conversation', chatIds: ['stale-prime-conversation'], updatedAt: 2 };
  const mounted = await mountChat({}, [], {
    getSwarm: async () => ({ ok: true, data: {
      enabled: true,
      running: true,
      currentAgentConversationId: current.conversationId,
      retainedHistory: true,
      agents: [{
        id: 'prime', role: 'prime', label: 'Prime', task: 'Coordinates the workers', model: null, reasoningEffort: null,
        state: 'active', createdAt: 1, activatedAt: 1, finishedAt: null, result: null, pending: 0, awaitingAck: 0,
        delivered: 0, conversationId: current.conversationId, detachedAt: null, lastSeenAt: 3, revivable: false,
        sleptAt: null, contextTokens: 0
      }]
    } }),
    listSessions: async () => ({ ok: true, data: { sessions: [current, stale], activeId: current.id, pressure: [], blocked: [] } }),
    getSession: async (id: string) => ({ ok: true, data: {
      summary: [current, stale].find(session => session.id === id) ?? null,
      events: [], total: 0, nextFrom: 1
    } })
  });
  (mounted.window.document.getElementById('backToChat') as HTMLButtonElement).click();
  await settle();

  expect(mounted.window.document.querySelector('[data-id="current-prime"] .session-role-badge')?.textContent).toBe('Eve');
  expect(mounted.window.document.querySelector('[data-id="stale-prime"] .session-role-badge')).toBeNull();
  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('Current coordination');
});

it('follows the selected Prime session when Compact & Resume moves its exact conversation', async () => {
  let swarmListener: (state: any) => void = () => undefined;
  const primeA = {
    id: 'prime-session', title: 'Prime before compaction', conversationId: 'prime-conversation-a', chatIds: ['prime-conversation-a'],
    startedAt: 1, updatedAt: 3, endedAt: null, events: 0, userMessages: 1, toolCalls: 1, lastToolCallAt: 2,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: ['prime'], origin: null
  };
  let rows = [primeA];
  const swarmFor = (conversationId: string) => ({
    enabled: true, running: true, currentAgentConversationId: conversationId, retainedHistory: true,
    agents: [{
      id: 'prime', role: 'prime', label: 'Prime', task: 'Coordinates the workers', model: null, reasoningEffort: null,
      state: 'active', createdAt: 1, activatedAt: 1, finishedAt: null, result: null, pending: 0, awaitingAck: 0,
      delivered: 0, conversationId, detachedAt: null, lastSeenAt: 3, revivable: false,
      sleptAt: null, contextTokens: 0
    }]
  });
  let swarmState = swarmFor(primeA.conversationId);
  const mounted = await mountChat({}, [], {
    getSwarm: async () => ({ ok: true, data: swarmState }),
    listSessions: async () => ({ ok: true, data: { sessions: rows, activeId: rows[0]!.id, pressure: [], blocked: [] } }),
    getSession: async (id: string) => ({ ok: true, data: {
      summary: rows.find(session => session.id === id) ?? null,
      events: [], total: 0, nextFrom: 1
    } }),
    onSwarmChanged: (listener: (state: any) => void) => { swarmListener = listener; return () => undefined; }
  });
  (mounted.window.document.getElementById('backToChat') as HTMLButtonElement).click();
  await settle(); await settle();
  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('Prime before compaction');

  const primeB = {
    ...primeA,
    title: 'Prime after compaction',
    conversationId: 'prime-conversation-b',
    chatIds: ['prime-conversation-a', 'prime-conversation-b'],
    updatedAt: 4
  };
  rows = [primeB];
  swarmState = swarmFor(primeB.conversationId);
  swarmListener(swarmState);
  await settle(); await settle();

  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('Prime after compaction');
  expect(mounted.window.document.querySelector('[data-id="prime-session"] .session-role-badge')?.textContent).toBe('Eve');
});

it('does not yank an unrelated conversation into view when Prime moves elsewhere', async () => {
  let swarmListener: (state: any) => void = () => undefined;
  const prime = {
    id: 'prime-session', title: 'Prime coordination', conversationId: 'prime-conversation-a', chatIds: ['prime-conversation-a'],
    startedAt: 1, updatedAt: 3, endedAt: null, events: 0, userMessages: 1, toolCalls: 1, lastToolCallAt: 2,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: ['prime'], origin: null
  };
  const other = { ...prime, id: 'other-session', title: 'Reference chat', conversationId: 'other-conversation', chatIds: ['other-conversation'], agents: [] };
  let rows = [prime, other];
  const swarmFor = (conversationId: string) => ({
    enabled: true, running: true, currentAgentConversationId: conversationId, retainedHistory: true,
    agents: [{ id: 'prime', role: 'prime', label: 'Prime', task: '', model: null, reasoningEffort: null, state: 'active',
      createdAt: 1, activatedAt: 1, finishedAt: null, result: null, pending: 0, awaitingAck: 0, delivered: 0,
      conversationId, detachedAt: null, lastSeenAt: 3, revivable: false, sleptAt: null, contextTokens: 0 }]
  });
  let swarmState = swarmFor(prime.conversationId);
  const mounted = await mountChat({}, [], {
    getSwarm: async () => ({ ok: true, data: swarmState }),
    listSessions: async () => ({ ok: true, data: { sessions: rows, activeId: prime.id, pressure: [], blocked: [] } }),
    getSession: async (id: string) => ({ ok: true, data: {
      summary: rows.find(session => session.id === id) ?? null,
      events: [], total: 0, nextFrom: 1
    } }),
    onSwarmChanged: (listener: (state: any) => void) => { swarmListener = listener; return () => undefined; }
  });
  (mounted.window.document.getElementById('backToChat') as HTMLButtonElement).click();
  await settle(); await settle();
  (mounted.window.document.querySelector('[data-id="other-session"]') as HTMLButtonElement).click();
  await settle();
  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('Reference chat');

  const movedPrime = { ...prime, conversationId: 'prime-conversation-b', chatIds: ['prime-conversation-a', 'prime-conversation-b'], updatedAt: 4 };
  rows = [movedPrime, other];
  swarmState = swarmFor(movedPrime.conversationId);
  swarmListener(swarmState);
  await settle(); await settle();

  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('Reference chat');
});

it('uses the configured agent name for the Activity owner filter and repaints it when the name changes', async () => {
  const prime = {
    id: 'prime', role: 'prime', label: 'Prime', task: 'Coordinates the workers', model: null, reasoningEffort: null,
    state: 'active', createdAt: 1, activatedAt: 1, finishedAt: null, result: null, pending: 0, awaitingAck: 0,
    delivered: 0, conversationId: 'prime-conversation', detachedAt: null, lastSeenAt: 3, revivable: false,
    sleptAt: null, contextTokens: 0
  };
  const worker = {
    ...prime,
    id: 'worker-1', role: 'worker', label: 'Worker 1', task: 'Audit the Activity UI', conversationId: 'worker-conversation'
  };
  const mounted = await mountChat({}, [], {
    getLog: async () => ({ ok: true as const, data: [
      ...Array.from({ length: 80 }, (_, index) => ({
        time: 1_789_599_000_000 + index,
        level: 'info' as const,
        message: `prime entry ${index + 1}`,
        agent: 'prime'
      })),
      { time: 1_789_599_000_081, level: 'warn' as const, message: 'worker problem', agent: 'worker-1' }
    ] }),
    getSwarm: async () => ({ ok: true, data: {
      enabled: true, running: true, currentAgentConversationId: prime.conversationId, retainedHistory: false,
      agents: [prime, worker]
    } })
  });
  await settle();

  const labels = () => [...mounted.window.document.querySelectorAll<HTMLButtonElement>('#logAgentFilter button')]
    .map(button => button.textContent);
  expect(labels()).toEqual(['All', 'Eve', 'Worker 1']);
  expect(labels()).not.toContain('Prime');

  [...mounted.window.document.querySelectorAll<HTMLButtonElement>('#logAgentFilter button')]
    .find(button => button.textContent === 'Worker 1')!.click();
  expect(mounted.window.document.getElementById('logPageStatus')!.textContent).toBe('1–1 of 1');
  expect(mounted.window.document.getElementById('fullFeed')!.textContent).toContain('workerproblem');

  mounted.state.config.mcp.connectorName = 'Eva';
  mounted.push(structuredClone(mounted.state));
  await settle();
  expect(labels()).toEqual(['All', 'Eva', 'Worker 1']);
});

it('keeps Workspace and Activity log DOM bounded while every retained entry stays reachable by paging', async () => {
  const logs = Array.from({ length: 500 }, (_, index) => ({
    time: 1_789_600_000_000 + index,
    level: index % 111 === 0 ? 'warn' as const : 'info' as const,
    message: `entry ${index + 1}`
  }));
  const mounted = await mountChat({}, [], {
    getLog: async () => ({ ok: true as const, data: logs })
  });
  await vi.waitFor(() => expect(mounted.window.document.getElementById('logPageStatus')!.textContent).toContain('500'));
  const doc = mounted.window.document;
  const home = doc.getElementById('homeFeed')!;
  const full = doc.getElementById('fullFeed')!;
  expect(home.childElementCount).toBe(30);
  expect(full.childElementCount).toBe(60);
  expect(home.textContent).toContain('entry500');
  expect(home.textContent).not.toContain('entry470');
  expect(full.textContent).toContain('entry500');
  expect(doc.getElementById('logPageStatus')!.textContent).toBe('441–500 of 500');
  expect((doc.getElementById('logNewer') as HTMLButtonElement).disabled).toBe(true);

  (doc.getElementById('logOlder') as HTMLButtonElement).click();
  expect(full.childElementCount).toBe(60);
  expect(full.textContent).toContain('entry381');
  expect(full.textContent).toContain('entry440');
  expect(full.textContent).not.toContain('entry500');
  expect(doc.getElementById('logPageStatus')!.textContent).toBe('381–440 of 500');
  expect((doc.getElementById('logNewer') as HTMLButtonElement).disabled).toBe(false);

  for (let page = 0; page < 7; page += 1) (doc.getElementById('logOlder') as HTMLButtonElement).click();
  expect(doc.getElementById('logPageStatus')!.textContent).toBe('1–20 of 500');
  expect(full.textContent).toContain('entry1');
  expect((doc.getElementById('logOlder') as HTMLButtonElement).disabled).toBe(true);
  expect(doc.getElementById('homeProblems')!.hidden).toBe(false);

  doc.querySelector<HTMLButtonElement>('#logFilter [data-filter="bad"]')!.click();
  expect(full.childElementCount).toBe(5);
  expect(full.textContent).toContain('entry1');
  expect(full.textContent).toContain('entry445');
  expect(full.textContent).not.toContain('entry500');
  expect(doc.getElementById('logPageStatus')!.textContent).toBe('1–5 of 5');
  expect((doc.getElementById('logOlder') as HTMLButtonElement).disabled).toBe(true);
  expect((doc.getElementById('logNewer') as HTMLButtonElement).disabled).toBe(true);
});

it('moves the configured agent sticker to New Chat when no owner exists and marks only that fresh send for exact claiming', async () => {
  const sendInput = vi.fn(async (input: any) => ({ ok: false as const, error: `stop:${input.id}` }));
  const mounted = await mountChat({}, [], {
    getSwarm: async () => ({ ok: true, data: {
      enabled: true, running: false, currentAgentConversationId: null, retainedHistory: true, agents: []
    } }),
    sendInput,
    getChatModels: async () => ({ ok: true, data: {
      state: 'ready', requestedAt: 1, observedAt: Date.now(),
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }]
    } })
  });
  const doc = mounted.window.document;
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  await settle();

  const badge = doc.getElementById('newChatAgentBadge')!;
  expect(badge.hidden).toBe(false);
  expect(badge.textContent).toBe('Eve');

  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  expect(input.value).toBe('@Eve ');
  input.value += 'continue as the owner';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: null,
    text: '@Eve continue as the owner',
    claimAgentIdentity: true
  }));
});

it('arms exact replacement only when top-level New Chat sees one ended current Eve owner', async () => {
  const owner = {
    id: 'ended-eve-session', title: 'Old Eve chat', conversationId: 'ended-eve-conversation', chatIds: ['ended-eve-conversation'],
    startedAt: 1, updatedAt: 2, endedAt: 3, events: 1, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0,
    lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: 'completed', activeTurnId: null, agents: ['prime'], origin: null
  };
  const sendInput = vi.fn(async (input: any) => ({ ok: false as const, error: `stop:${input.id}` }));
  const mounted = await mountChat({}, [], {
    getSwarm: async () => ({ ok: true, data: {
      enabled: true, running: false, currentAgentConversationId: owner.conversationId, retainedHistory: false, agents: []
    } }),
    listSessions: async () => ({ ok: true, data: { sessions: [owner], activeId: null, pressure: [], blocked: [] } }),
    sendInput,
    getChatModels: async () => ({ ok: true, data: {
      state: 'ready', requestedAt: 1, observedAt: Date.now(),
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }]
    } })
  });
  const doc = mounted.window.document;
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  await settle();

  // Intent is not ownership: the old row keeps the only visible Eve badge until provider ACK.
  expect(doc.getElementById('newChatAgentBadge')!.hidden).toBe(true);
  expect(doc.querySelector('[data-id="ended-eve-session"] .session-role-badge')?.textContent).toBe('Eve');

  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  expect(input.value).toBe('@Eve ');
  input.value += 'continue here';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: null,
    projectId: null,
    replaceAgentIdentityFrom: owner.conversationId,
    text: '@Eve continue here'
  }));
  expect(sendInput).toHaveBeenCalledWith(expect.not.objectContaining({ claimAgentIdentity: true }));
});

it('keeps a paid fresh Eve composer on ChatGPT native default until the user chooses Sol', async () => {
  const sendInput = vi.fn(async (input: any) => ({ ok: false as const, error: `stop:${input.id}` }));
  const mounted = await mountChat({}, [], {
    sendInput,
    getChatModels: async () => ({ ok: true, data: {
      state: 'ready', requestedAt: 1, observedAt: Date.now(),
      models: [
        { id: 'provider-default', label: 'GPT-4', efforts: ['medium'] },
        { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5-6-thinking'] }
      ]
    } })
  });
  const doc = mounted.window.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');

  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '@Eve use the selected model';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: null,
    text: '@Eve use the selected model',
    model: null,
    reasoningEffort: null
  }));
});

it('keeps a Free or Go fresh Eve composer on ChatGPT native default for the first send', async () => {
  const sendInput = vi.fn(async (input: any) => ({ ok: false as const, error: `stop:${input.id}` }));
  const mounted = await mountChat({}, [], {
    sendInput,
    getChatModels: async () => ({ ok: true, data: {
      state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [], nativeDefault: true
    } })
  });
  const doc = mounted.window.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '@Eve use ChatGPT default';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: null,
    text: '@Eve use ChatGPT default',
    model: null,
    reasoningEffort: null
  }));
});

it('starts the organize tutorial from its card without models and preserves its draft and durable context', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const sent: any[] = [];
  const requestChatModels = vi.fn();
  const mounted = await mountChat({}, [], {
    getPinsLibrary: async () => ({ ok: true, data: { version: 1, collections: [], pins: [], quilts: [
      { id, title: 'organize', prompt: 'Ask for the goal and folder.', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 }
    ] } }),
    getChatModels: async () => ({ ok: true, data: { state: 'unavailable', models: [], error: 'Models could not be fetched' } }),
    requestChatModels,
    sendInput: async (input: any) => { sent.push(structuredClone(input)); return { ok: false, error: 'test delivery stopped' }; }
  });
  const { navigateWorkspace } = await import('../src/renderer/workspace-navigation.js');
  const doc = mounted.window.document;
  doc.getElementById('pinsDestination')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.pins-tab')]
    .find(button => button.textContent?.startsWith('%Hotlinks'))!.click();
  doc.querySelector<HTMLButtonElement>('.quilt-chat-button')!.click();
  await settle();
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  expect(input.value).toBe('Help me get started with %organize.');
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat · %organize');
  expect(doc.getElementById('composerModelLabel')!.textContent).toBe('ChatGPT default');
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ sessionId: null, contextQuiltId: id, text: 'Help me get started with %organize.', model: null, reasoningEffort: null });
  expect(requestChatModels).not.toHaveBeenCalled();
  input.value = 'Organize my Downloads by project.';
  navigateWorkspace({ screen: 'chat' });
  navigateWorkspace({ screen: 'chat', quiltId: id });
  expect(input.value).toBe('Organize my Downloads by project.');
  input.value = '';
  navigateWorkspace({ screen: 'chat' });
  navigateWorkspace({ screen: 'chat', quiltId: id });
  expect(input.value).toBe('');
  doc.getElementById('newChat')!.click();
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat');
});

it('carries a Quilt id into its fresh composer send and clears it on ordinary New Chat', async () => {
  const sent: any[] = [];
  const mounted = await mountChat({}, [], {
    sendInput: async (input: any) => {
      sent.push(structuredClone(input));
      return { ok: false as const, error: `stop:${input.id}` };
    },
    getChatModels: async () => ({ ok: true, data: {
      state: 'ready', requestedAt: 1, observedAt: Date.now(),
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }]
    } })
  });
  const { navigateWorkspace } = await import('../src/renderer/workspace-navigation.js');
  const doc = mounted.window.document;

  navigateWorkspace({ screen: 'chat', quiltId: '22222222-2222-4222-8222-222222222222' });
  await settle();
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'What should I do next?';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sent[0]).toMatchObject({
    sessionId: null,
    contextQuiltId: '22222222-2222-4222-8222-222222222222',
    text: 'What should I do next?'
  });

  (doc.getElementById('newChat') as HTMLButtonElement).click();
  input.value = 'Ordinary question';
  doc.getElementById('composer')!.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sent[1]).toMatchObject({ sessionId: null, text: 'Ordinary question' });
  expect(sent[1]).not.toHaveProperty('contextQuiltId');
});

it('reopens the durable Expenses inbox returned by main instead of starting another chat', async () => {
  const project = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Expenses', path: '/Expenses', createdAt: 1,
    template: { id: 'expenses' as const, version: 1 as const, quiltId: '22222222-2222-4222-8222-222222222222' }
  };
  const session = {
    id: 'expenses-session', title: 'Expenses inbox', projectId: project.id,
    conversationId: 'expenses-conversation', chatIds: ['expenses-conversation'], startedAt: 1, updatedAt: 2,
    endedAt: null, events: 0, userMessages: 1, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const getSession = vi.fn(async () => ({ ok: true, data: { summary: session, events: [], total: 0, nextFrom: 1 } }));
  const mounted = await mountChat({}, [], {
    startExpenses: async () => ({ ok: true, data: { project, session } }),
    getSession
  });

  (mounted.window.document.getElementById('startExpenses') as HTMLButtonElement).click();
  await settle(); await settle();

  expect(getSession).toHaveBeenCalledWith(session.id, expect.objectContaining({ limit: expect.any(Number) }));
  expect((mounted.window.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
});

it('opens a project-scoped Expenses composer only when main reports no established inbox', async () => {
  const project = {
    id: '33333333-3333-4333-8333-333333333333', name: 'Expenses', path: '/Expenses', createdAt: 1,
    template: { id: 'expenses' as const, version: 1 as const, quiltId: '44444444-4444-4444-8444-444444444444' }
  };
  const getSession = vi.fn(async () => ({ ok: true, data: null }));
  const mounted = await mountChat({}, [], {
    startExpenses: async () => ({ ok: true, data: { project, session: null } }),
    getSession
  });

  (mounted.window.document.getElementById('startExpenses') as HTMLButtonElement).click();
  await settle();

  expect(getSession).not.toHaveBeenCalled();
  expect((mounted.window.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Message in Expenses…');
  expect(mounted.window.document.getElementById('chatTitle')?.textContent).toBe('New chat · Expenses');
});

it('uses the debug build gate for agent drivers and saves a custom driver choice', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const prime = doc.getElementById('agentOrchestratorBackend') as HTMLSelectElement;
  const worker = doc.getElementById('agentWorkerBackend') as HTMLSelectElement;

  expect(doc.getElementById('agentBuildFlavor')?.textContent).toBe('debug');
  expect([...prime.options].map(option => [option.value, option.disabled])).toEqual([
    ['gpt-chat', false],
    ['gpt-work', false],
    ['ollama', false],
    ['custom', false]
  ]);

  worker.value = 'custom';
  worker.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.execution).toEqual({
    orchestrator: 'gpt-chat',
    worker: 'custom'
  }));
});

it('keeps the Goal helper model canonicalized across state pushes and user changes', async () => {
  const catalog = {
    state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [
      { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['high'], aliases: ['gpt-5.6-sol', 'gpt-5-6-thinking'] },
      { id: '6', label: 'GPT-6', efforts: ['medium', 'high'], aliases: ['gpt-6'] }
    ]
  };
  const mounted = await mountChat({}, [], {
    getChatModels: async () => ({ ok: true, data: catalog })
  }, {
    helperModel: 'gpt-5.6-sol',
    helperReasoning: 'high'
  });
  await settle();

  const model = mounted.window.document.getElementById('helperModel') as HTMLSelectElement;
  const reasoning = mounted.window.document.getElementById('helperReasoning') as HTMLSelectElement;
  expect(model.value).toBe('5.6');
  expect(reasoning.value).toBe('high');

  // A routine app-state push used to repaint the canonical observed id and then immediately
  // overwrite it with the saved alias. Since no option had that alias as its value, the native
  // select became blank until another interaction happened to repair it.
  mounted.push(structuredClone(mounted.state));
  expect(model.value).toBe('5.6');
  expect(reasoning.value).toBe('high');

  model.value = '6';
  model.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.goal).toMatchObject({
    helperModel: '6',
    helperReasoning: 'high'
  }));
  expect(model.value).toBe('6');
  expect(reasoning.value).toBe('high');
});

it('lets Setup name this installation Eva with Unicode text and carries it into connector guidance', async () => {
  const mounted = await mountChat();
  const next = structuredClone(mounted.state) as any;
  next.config.mcp.connectorName = 'Eva Å';
  next.status.surfaces = [{
    id: 'core', connectorName: 'Eva Å', description: 'Eva Å description', cardSummary: 'Eva Å summary', optional: false,
    available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'off', detail: '',
    lastRequestAt: null, lastToolCallAt: null
  }];
  mounted.push(next);

  const doc = mounted.window.document;
  const name = doc.getElementById('instanceName') as HTMLInputElement;
  expect(name.value).toBe('Eva Å');
  expect(doc.querySelector('[data-step="tunnel"]')!.textContent!.replace(/\s+/g, ' ')).toContain('name it Eva Å');
  expect(doc.querySelector('[data-step="chatgpt"]')!.textContent).toContain('Eva Å');
  expect(doc.getElementById('connectorCards')!.textContent).toContain('Eva Å');

  const manual = structuredClone(next) as any;
  manual.config.tunnel.kind = 'manual';
  mounted.push(manual);
  expect((doc.querySelector('[data-step="tunnel"]') as HTMLElement).hidden).toBe(true);
  expect(name.closest<HTMLElement>('.field')!.hidden).toBe(false);
  expect(name.value).toBe('Eva Å');

  name.value = 'Eva Älv';
  name.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  // The save is queued behind the earlier settings writes and the panel's repaint. A slow CI
  // runner (macOS publish) needed more than waitFor's default second to reach the fake IPC.
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.mcp?.connectorName).toBe('Eva Älv'), { timeout: 10_000 });
});

it('attaches pasted screenshot files with previews while preserving ordinary text paste', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'screenshot.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' }] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, input = w.document.getElementById('chatInput')!;
  const file = new w.File(['image'], 'screenshot.png', { type: 'image/png' });
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  input.dispatchEvent(paste);
  await vi.waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
  const text = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  const overflow = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(overflow, 'clipboardData', { value: { files: Array(20).fill(file) } });
  input.dispatchEvent(overflow);
  expect(overflow.defaultPrevented).toBe(true);
  expect(dropFiles).toHaveBeenCalledTimes(1);
});

it('preserves the selected OpenRouter model through an unchanged custom-provider round trip', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const original = 'z-ai/glm-5.3-flash';
  mounted.state.config.goal = {
    ...mounted.state.config.goal,
    models: { openrouter: [original], custom: [] },
    provider: { kind: 'openrouter', baseUrl: '' }
  };
  mounted.push(mounted.state);
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 5_000 });
  // Repainting custom settings must not replace the hidden OpenRouter picker's model.
  mounted.push({ ...mounted.state, hasCustomProviderKey: false });
  provider.value = 'openrouter'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 5_000 });
  expect(mounted.calls[1].goal).toMatchObject({
    provider: { kind: 'openrouter' },
    models: { openrouter: [original], custom: [] }
  });
  expect(w.document.getElementById('goalModelName')!.textContent).toBe(original);
});

it('uses the OpenRouter default when opened directly on an unrelated custom deployment', async () => {
  const mounted = await mountChat({}, [], {}, {
    models: { openrouter: [DEFAULT_GOAL_MODEL], custom: ['llama3.1'] },
    provider: { kind: 'custom', baseUrl: 'http://localhost:8000/v1' }
  });
  const provider = mounted.window.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'openrouter';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].goal).toMatchObject({
    provider: { kind: 'openrouter' },
    models: { openrouter: [DEFAULT_GOAL_MODEL], custom: ['llama3.1'] }
  });
});

it('saves a custom deployment id and returns to the known OpenRouter model', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].goal.provider.kind).toBe('custom');
  expect(w.document.getElementById('goalCustomPanel')?.hidden).toBe(false);
  const model = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  model.value = 'llama3.1';
  model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 10_000 });
  expect(mounted.calls[1].goal.models.custom[0]).toBe('llama3.1');
  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3), { timeout: 5_000 });
  expect(mounted.calls[2].goal).toMatchObject({
    provider: { kind: 'openrouter' },
    models: { openrouter: ['deepseek/deepseek-v4-flash'], custom: ['llama3.1'] }
  });
});

it('restores each provider model list immediately without overwriting the other provider', async () => {
  const mounted = await mountChat({}, [], {}, {
    provider: { kind: 'openrouter', baseUrl: 'http://localhost:8000/v1' },
    models: {
      openrouter: ['openrouter/primary', 'openrouter/fallback'],
      custom: ['local-primary', 'local-fallback']
    }
  });
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  const customModel = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  const fallbacks = w.document.getElementById('goalFallbackList')!;

  expect(w.document.getElementById('goalModelName')!.textContent).toBe('openrouter/primary');
  expect(fallbacks.textContent).toContain('openrouter/fallback');

  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  // Provider switching repaints before the async settings round trip completes.
  expect(w.document.getElementById('goalCustomPanel')!.hidden).toBe(false);
  expect(customModel.value).toBe('local-primary');
  expect(w.document.querySelector<HTMLInputElement>('[data-goal-fallback-input="1"]')?.value).toBe('local-fallback');
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].goal).toMatchObject({
    provider: { kind: 'custom' },
    models: {
      openrouter: ['openrouter/primary', 'openrouter/fallback'],
      custom: ['local-primary', 'local-fallback']
    }
  });

  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(w.document.getElementById('goalModelName')!.textContent).toBe('openrouter/primary');
  expect(fallbacks.textContent).toContain('openrouter/fallback');
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 10_000 });
  expect(mounted.calls[1].goal.models).toEqual({
    openrouter: ['openrouter/primary', 'openrouter/fallback'],
    custom: ['local-primary', 'local-fallback']
  });
});

it('adds OpenRouter fallbacks from the catalogue and can reorder and remove them', async () => {
  const catalog = [
    { id: 'openrouter/new-fallback', name: 'New fallback', created: 2, contextLength: 128000 }
  ];
  const mounted = await mountChat({}, catalog, {}, {
    provider: { kind: 'openrouter', baseUrl: '' },
    models: {
      openrouter: ['openrouter/primary', 'openrouter/old-fallback'],
      custom: []
    }
  });
  const w = mounted.window;

  (w.document.getElementById('goalAddFallback') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mounted.modelPages).toHaveLength(1));
  await vi.waitFor(() =>
    expect(w.document.querySelector('[data-model="openrouter/new-fallback"]')).not.toBeNull()
  );
  (w.document.querySelector('[data-model="openrouter/new-fallback"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].goal.models.openrouter).toEqual([
    'openrouter/primary',
    'openrouter/old-fallback',
    'openrouter/new-fallback'
  ]);

  (w.document.querySelector('[data-fallback-action="up"][data-fallback-index="2"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 10_000 });
  expect(mounted.calls[1].goal.models.openrouter).toEqual([
    'openrouter/primary',
    'openrouter/new-fallback',
    'openrouter/old-fallback'
  ]);

  (w.document.querySelector('[data-fallback-action="remove"][data-fallback-index="2"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3), { timeout: 10_000 });
  expect(mounted.calls[2].goal.models.openrouter).toEqual([
    'openrouter/primary',
    'openrouter/new-fallback'
  ]);
});

it('stores custom fallback model ids exactly as typed in the ordered persistence payload', async () => {
  const mounted = await mountChat({}, [], {}, {
    provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' },
    models: {
      openrouter: ['openrouter/primary'],
      custom: ['local-primary']
    }
  });
  const w = mounted.window;
  (w.document.getElementById('goalAddFallback') as HTMLButtonElement).click();
  const fallback = w.document.querySelector<HTMLInputElement>('[data-goal-fallback-input="1"]')!;
  expect(fallback).not.toBeNull();
  fallback.value = 'vendor/model:v2';
  fallback.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].goal.models).toEqual({
    openrouter: ['openrouter/primary'],
    custom: ['local-primary', 'vendor/model:v2']
  });
});

it('saves the ChatGPT browser choice from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  const extensionsUrl = w.document.getElementById('browserExtensionsUrl')!;
  const extensionsAction = w.document.getElementById('browserExtensionsAction') as HTMLButtonElement;
  expect([...browser.options].map(option => option.value)).toEqual(['chrome', 'edge', 'brave']);
  expect(browser.value).toBe('chrome'); // older config has no field
  expect(extensionsUrl.textContent).toBe('chrome://extensions/');
  expect(extensionsAction.dataset.setupLink).toBe('chrome://extensions/');
  browser.value = 'edge';
  browser.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 10_000 });
  expect(mounted.calls[0].ui.chatBrowser).toBe('edge');
  expect(browser.value).toBe('edge');
  expect(extensionsUrl.textContent).toBe('edge://extensions/');
  expect(extensionsAction.dataset.setupLink).toBe('edge://extensions/');
  expect(extensionsAction.textContent).toContain('Microsoft Edge');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'brave' } } });
  expect(browser.value).toBe('brave');
  expect(extensionsUrl.textContent).toBe('brave://extensions/');
  expect(extensionsAction.dataset.setupLink).toBe('brave://extensions/');
  expect(extensionsAction.textContent).toContain('Brave Browser');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'chrome' } } });
  expect(browser.value).toBe('chrome');
  expect(extensionsUrl.textContent).toBe('chrome://extensions/');
});

it('shows the current host Desktop tools without rebuilding permission controls on state pushes', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const doc = mounted.window.document;
  const names = () => Array.from(doc.querySelectorAll('[data-group="desktop"] .tool-names code'), node => node.textContent);
  const control = doc.querySelector<HTMLInputElement>('[data-cap="control"]')!;
  const windowsNames = ['list_windows', 'get_window', 'list_apps', 'get_window_state',
    'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
    'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard', 'exec'];
  expect(names()).toEqual(windowsNames);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(names()).toEqual(['observe', 'computer', 'exec']);
  expect(doc.querySelector('[data-cap="control"]')).toBe(control);
  mounted.push(mounted.state);
  expect(names()).toEqual(windowsNames);
  expect(mounted.calls).toHaveLength(0);
});

it('uses one Setup checkbox to enable or disable all Computer use permissions', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const w = mounted.window;
  const checkbox = w.document.getElementById('setupComputerUse') as HTMLInputElement;
  const status = w.document.getElementById('setupComputerUseState')!;

  // The fixture starts with all four desktop capabilities on, so Setup presents one checked box.
  expect(checkbox.checked).toBe(true);
  expect(checkbox.indeterminate).toBe(false);
  expect(status.textContent).toBe('4 permissions');
  expect(w.document.getElementById('desktopTunnelId')).toBeNull();

  checkbox.checked = false;
  checkbox.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false
  });
  expect(status.textContent).toBe('off');
  expect(mounted.calls[0].tunnel.desktopTunnelId).toBe('');

  checkbox.checked = true;
  checkbox.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('exposes the selected settings destination and current Setup step to accessibility clients', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const selectedTab = doc.querySelector<HTMLElement>('nav button.is-sel')!;
  const currentStep = doc.querySelector<HTMLElement>('.step.is-current')!;

  expect(selectedTab.getAttribute('aria-current')).toBe('page');
  expect(currentStep.getAttribute('aria-current')).toBe('step');

  doc.getElementById('workspaceSettings')!.click();
  const usage = doc.querySelector<HTMLButtonElement>('nav button[data-tab="usage"]')!;
  usage.click();
  expect(usage.getAttribute('aria-current')).toBe('page');
  expect(selectedTab.hasAttribute('aria-current')).toBe(false);
});

it('previews any numbered Setup step without changing the real current/completed state', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const current = doc.querySelector<HTMLElement>('.step.is-current')!;
  expect(current.dataset.step).toBe('key');
  expect(current.getAttribute('aria-current')).toBe('step');

  const tunnelPreview = doc.querySelector<HTMLButtonElement>('[data-preview-step="tunnel"]')!;
  tunnelPreview.click();
  expect(doc.querySelector('[data-step="tunnel"]')?.classList.contains('is-preview')).toBe(true);
  expect(doc.querySelector('[data-step="tunnel"]')?.classList.contains('is-current')).toBe(false);
  expect(current.classList.contains('is-current')).toBe(true);
  expect(current.getAttribute('aria-current')).toBe('step');
  expect(tunnelPreview.getAttribute('aria-pressed')).toBe('true');
  expect(doc.getElementById('setupPreviewStatus')!.textContent).toContain('still on step 3');

  doc.querySelector<HTMLButtonElement>('[data-preview-step="folder"]')!.click();
  expect(doc.querySelector('[data-step="folder"]')?.classList.contains('is-preview')).toBe(true);
  expect(doc.querySelector('[data-step="tunnel"]')?.classList.contains('is-preview')).toBe(false);
  expect(current.classList.contains('is-current')).toBe(true);
});

it('keeps coffee/browser chrome fixed to Plans and exposes the Threads settings submenu in both languages', async () => {
  let sidebarWidth = 248;
  const project = {
    id: 'expenses-project', name: 'Receipts 2026', path: 'C:\\Receipts 2026', createdAt: 1,
    template: { id: 'expenses' as const, version: 1 as const, quiltId: 'expenses-thread' }
  };
  const pinsLibrary = {
    version: 1 as const,
    quilts: [
      { id: 'expenses-thread', title: 'Expenses', state: 'pinned' as const, collectionIds: [], createdAt: 1, updatedAt: 3 },
      { id: 'how-thread', title: 'How', state: 'pinned' as const, collectionIds: [], createdAt: 1, updatedAt: 2 },
      { id: 'old-thread', title: 'Old notes', state: 'archived' as const, collectionIds: [], createdAt: 1, updatedAt: 1 }
    ],
    pins: [],
    collections: []
  };
  const openCompanionBrowserTab = vi.fn(async () => ({ ok: true as const, data: null }));
  const openLink = vi.fn(async () => ({ ok: true as const, data: true }));
  const archiveOpenStatic = vi.fn(async () => ({ ok: true as const, data: { ok: true as const } }));
  const mounted = await mountChat({}, [], {
    openCompanionBrowserTab,
    openLink,
    archiveOpenStatic,
    getPinsLibrary: async () => ({ ok: true as const, data: pinsLibrary }),
    getThreadSettingsEntries: async () => ({ ok: true as const, data: [{
      starterId: 'expenses', threadId: 'expenses-thread', title: 'expenses', surface: 'expenses' as const
    }] }),
    startExpenses: async () => ({ ok: true as const, data: { project, session: null } }),
    listProjects: async () => ({ ok: true as const, data: [project] }),
    listSessions: async () => ({ ok: true as const, data: {
      sessions: [], activeId: null, pressure: [], blocked: [], total: 0, nextCursor: null
    } })
  }, {}, (w) => {
    const rect = (left: number, width: number): DOMRect => ({
      x: left, y: 0, left, top: 0, right: left + width, bottom: 40, width, height: 40,
      toJSON: () => ({})
    } as DOMRect);
    const plans = w.document.getElementById('plansDestination') as HTMLButtonElement;
    plans.style.paddingLeft = '9px';
    Object.defineProperty(plans, 'getBoundingClientRect', { configurable: true, value: () => rect(164, 62) });
    const sidebar = w.document.getElementById('sidebar')!;
    Object.defineProperty(sidebar, 'getBoundingClientRect', { configurable: true, value: () => rect(0, sidebarWidth) });
  });
  const w = mounted.window;
  const doc = w.document;
  const sidebar = doc.getElementById('sidebar')!;
  const theme = doc.getElementById('themeBtn') as HTMLButtonElement;
  const quickRow = doc.getElementById('workspaceQuickRow')!;
  const browser = doc.getElementById('eveBrowserTab') as HTMLButtonElement;
  const newChat = doc.getElementById('newChat') as HTMLButtonElement;
  const brand = doc.getElementById('sidebarBrandLink') as HTMLButtonElement;
  const staticArchive = doc.getElementById('openStaticArchiveMenu') as HTMLButtonElement;

  await vi.waitFor(() => expect(sidebar.style.getPropertyValue('--top-nav-anchor-x')).toBe('173px'));
  const anchor = sidebar.style.getPropertyValue('--top-nav-anchor-x');
  sidebarWidth = 420;
  w.dispatchEvent(new w.Event('resize'));
  expect(sidebar.style.getPropertyValue('--top-nav-anchor-x')).toBe(anchor);
  expect(newChat.nextElementSibling).toBe(browser);
  expect(browser.title).toBe('Open new Eve Browser tab');
  browser.click();
  await settle();
  expect(openCompanionBrowserTab).toHaveBeenCalledTimes(1);
  expect(browser.disabled).toBe(false);
  brand.click();
  await settle();
  expect(openLink).toHaveBeenCalledWith('https://github.com/absol89/ParadigmEve');
  staticArchive.click();
  await settle();
  expect(archiveOpenStatic).toHaveBeenCalledTimes(1);
  expect(doc.querySelector('.toast')?.textContent).toBe('Static recovery browser opened.');

  expect(doc.documentElement.dataset.theme).toBe('light');
  theme.click();
  await settle();
  expect(doc.documentElement.dataset.theme).toBe('dark');
  expect(theme.getAttribute('aria-pressed')).toBe('true');
  theme.click();
  await settle();
  expect(doc.documentElement.dataset.theme).toBe('light');

  doc.getElementById('workspaceSettings')!.click();
  const threadNav = doc.getElementById('threadSettingsNav')!;
  const concepts = doc.getElementById('conceptsSettingsNav') as HTMLButtonElement;
  const toggle = doc.getElementById('threadSettingsToggle') as HTMLButtonElement;
  const items = doc.getElementById('threadSettingsItems')!;
  const threadEntries = doc.getElementById('threadSettingsEntries')!;
  const advanced = doc.querySelector<HTMLElement>('.advanced')!;
  const changeSettings = doc.getElementById('eveChangeSettings') as HTMLInputElement;
  const archiveCompleted = doc.getElementById('eveArchiveCompletedWork') as HTMLInputElement;
  const allowOtherChats = doc.getElementById('eveAllowOtherChats') as HTMLInputElement;
  const controlApp = doc.getElementById('eveControlParadigmEve') as HTMLInputElement;
  expect(doc.querySelector('.sidebar-brand')?.hasAttribute('hidden')).toBe(false);
  expect(doc.getElementById('themeBtn')).toBe(theme);
  expect(sidebar.style.getPropertyValue('--top-nav-anchor-x')).toBe(anchor);
  expect(quickRow.hidden).toBe(true);
  expect(advanced.tagName).toBe('DIV');
  expect(advanced.querySelector('summary')).toBeNull();
  expect(advanced.textContent).toContain('Advanced — method, program, startup');
  expect(changeSettings.checked).toBe(false);
  expect(archiveCompleted.checked).toBe(false);
  expect(controlApp.checked).toBe(false);
  expect(threadNav.hidden).toBe(false);
  expect(threadNav.firstElementChild).toBe(concepts);
  expect(concepts.textContent).toBe('# Concepts');
  expect(concepts.getAttribute('aria-label')).toBe('Open Concepts settings');
  expect(toggle.textContent).toBe('% Threads  +');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-label')).toBe('Expand Threads settings');
  expect(items.hidden).toBe(true);
  expect([...doc.querySelectorAll<HTMLButtonElement>('#tabs > button[data-tab]')].map(button => button.dataset.tab)).toEqual([
    'home', 'usage', 'plugins', 'pets', 'setup', 'settings', 'activity'
  ]);

  concepts.click();
  expect(doc.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('concepts-settings');
  expect(doc.querySelector('[data-panel="concepts-settings"]')?.classList.contains('is-active')).toBe(true);
  expect(doc.getElementById('conceptsSettingsHost')?.childElementCount).toBe(2);
  const conceptQuiltRows = doc.getElementById('conceptQuiltRows') as HTMLInputElement;
  const conceptPinPreviewDensity = doc.getElementById('conceptPinPreviewDensity') as HTMLSelectElement;
  const conceptDescriptionSize = doc.getElementById('conceptDescriptionTextSize') as HTMLSelectElement;
  const conceptDescriptionRows = doc.getElementById('conceptDescriptionRows') as HTMLInputElement;
  const conceptPromptSize = doc.getElementById('conceptPromptTextSize') as HTMLSelectElement;
  const conceptPromptRows = doc.getElementById('conceptPromptRows') as HTMLInputElement;
  expect(doc.querySelector('#conceptsSettingsHost > .muted')?.textContent).toBe(
    'Choose how much of each preview is visible. These settings change presentation only; they do not edit your Threads or Quilts.'
  );
  for (const input of [conceptQuiltRows, conceptDescriptionRows, conceptPromptRows]) {
    expect(input.classList.contains('num')).toBe(true);
  }
  expect([
    conceptQuiltRows.value,
    conceptPinPreviewDensity.value,
    conceptDescriptionSize.value,
    conceptDescriptionRows.value,
    conceptPromptSize.value,
    conceptPromptRows.value
  ]).toEqual(['2', '2', 'medium', '2', 'medium', '2']);
  conceptQuiltRows.value = '4';
  conceptPinPreviewDensity.value = '3';
  conceptDescriptionSize.value = 'large';
  conceptDescriptionRows.value = '5';
  conceptPromptSize.value = 'small';
  conceptPromptRows.value = '3';
  conceptQuiltRows.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui).toMatchObject({
    conceptQuiltRows: 4,
    conceptPinPreviewDensity: 3,
    conceptDescriptionTextSize: 'large',
    conceptDescriptionRows: 5,
    conceptPromptTextSize: 'small',
    conceptPromptRows: 3
  });
  expect(concepts.getAttribute('aria-current')).toBe('page');
  doc.querySelector<HTMLButtonElement>('#tabs > button[data-tab="home"]')!.click();

  toggle.click();
  expect(toggle.textContent).toBe('% Threads  -');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(items.hidden).toBe(false);
  expect([...threadEntries.querySelectorAll<HTMLElement>('[data-thread-settings-id]')].map(row => row.textContent)).toEqual([
    '% Expenses  -'
  ]);
  expect(threadEntries.textContent).not.toContain('How');
  expect(threadEntries.textContent).not.toContain('Old notes');
  expect(doc.querySelector('.thread-settings-child')?.textContent).toBe('% Expenses  -');
  (doc.getElementById('startExpenses') as HTMLButtonElement).click();
  await settle();
  doc.getElementById('workspaceSettings')!.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(items.hidden).toBe(false);
  expect(doc.getElementById('expensesFolderLabel')?.textContent).toBe('Receipts 2026');

  controlApp.checked = true;
  controlApp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(changeSettings.checked).toBe(true);
  expect(mounted.calls.at(-1)?.eveAuthority).toEqual({
    allowOtherChats: true,
    changeSettings: true,
    archiveCompletedWork: false,
    controlParadigmEve: true
  });
  changeSettings.checked = false;
  changeSettings.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(controlApp.checked).toBe(false);
  expect(mounted.calls.at(-1)?.eveAuthority).toEqual({
    allowOtherChats: true,
    changeSettings: false,
    archiveCompletedWork: false,
    controlParadigmEve: false
  });
  allowOtherChats.checked = false;
  allowOtherChats.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.eveAuthority?.allowOtherChats).toBe(false);
  archiveCompleted.checked = true;
  archiveCompleted.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.eveAuthority?.archiveCompletedWork).toBe(true);

  const language = doc.getElementById('uiLanguage') as HTMLSelectElement;
  language.value = 'sv-SE';
  language.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(doc.getElementById('plansDestination')?.textContent).toBe('Planer');
  expect(browser.title).toBe('Öppna en ny flik i Eve Browser');
  expect(doc.getElementById('eveAuthorityHeading')?.textContent).toBe('Eves behörighet');
  expect(doc.getElementById('eveAllowOtherChats')?.parentElement?.textContent)
    .toContain('Tillåt Eve i andra ChatGPT-chattar och på andra enheter');
  expect(concepts.textContent).toBe('# Koncept');
  expect(concepts.getAttribute('aria-label')).toBe('Öppna inställningar för Koncept');
  expect(doc.getElementById('conceptsSettingsTitle')?.textContent).toBe('# Koncept');
  expect(doc.querySelector('label[for="conceptQuiltRows"] .setting-text b')?.textContent).toBe('Rader med #Quilt-val');
  expect(toggle.getAttribute('aria-label')).toBe('Fäll ihop inställningar för Threads');
  expect(doc.querySelector('.thread-settings-child')?.textContent).toBe('% Utgifter  -');
  expect(doc.getElementById('expensesFolderLabel')?.textContent).toBe('Receipts 2026');
  expect(sidebar.style.getPropertyValue('--top-nav-anchor-x')).toBe(anchor);

  doc.getElementById('backToChat')!.click();
  expect(doc.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('chat');
  expect(threadNav.hidden).toBe(true);
  expect(quickRow.hidden).toBe(false);
  expect(doc.getElementById('themeBtn')).toBe(theme);
});

it('shows macOS privacy shortcuts beside the Setup Computer use option', async () => {
  const requestDesktopAccessibility = vi.fn(async () => ({ ok: true as const, data: null }));
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true },
    desktopAccess: {
      screen: 'missing',
      accessibility: 'missing',
      checkedAt: 1,
      error: null
    }
  }, [], { requestDesktopAccessibility });
  const doc = mounted.window.document;
  const access = doc.getElementById('setupDesktopAccess')!;

  expect(access.hidden).toBe(false);
  expect(access.textContent).toContain('Screen Recording: missing');
  expect(access.textContent).toContain('Accessibility: missing');
  expect(doc.getElementById('setupOpenDesktopScreen')?.getAttribute('data-link'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  expect(doc.getElementById('setupOpenDesktopAccessibility')?.getAttribute('data-link'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');

  doc.getElementById('setupRequestDesktopAccessibility')!.click();
  await settle();
  expect(requestDesktopAccessibility).toHaveBeenCalledTimes(1);

  const off = structuredClone(mounted.state) as any;
  off.config.capabilities.screen = false;
  off.config.capabilities.control = false;
  mounted.push(off);
  expect(access.hidden).toBe(true);
});

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(true);

  const autoConnect = w.document.getElementById('autoConnect') as HTMLInputElement;
  autoConnect.checked = true;
  autoConnect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].ui.autoConnect).toBe(true);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('uses native menu-bar/Dock wording on macOS instead of Windows tray copy', async () => {
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true }
  });
  const doc = mounted.window.document;

  expect(doc.getElementById('backgroundRunningCopy')!.textContent).toContain('menu bar and Dock');
  expect(doc.getElementById('backgroundRunningCopy')!.textContent).not.toContain('tray');
  expect(doc.getElementById('minimizeToTrayCopy')!.textContent).toBe('Hide the window to the menu bar when closed');
});

it('surfaces the existing root rename API in the folder row', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'test stops before mutation' });
    }
  });
  const doc = mounted.window.document;
  const button = doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]');
  expect(button).not.toBeNull();

  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  input.value = 'New-Repo';
  input.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(renames).toEqual([['repo', 'new-repo']]);
});

it('preserves an in-progress root rename across unrelated state pushes and cancels it if the root disappears', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'rename failed for retry test' });
    }
  });
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();

  const original = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  original.value = 'new-name';
  original.setSelectionRange(3, 7);

  const unrelated = structuredClone(mounted.state) as any;
  unrelated.status.detail = 'unrelated live status push';
  mounted.push(unrelated);

  const preserved = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(preserved).not.toBeNull();
  expect(doc.activeElement).toBe(preserved);
  expect(preserved.value).toBe('new-name');
  expect(preserved.selectionStart).toBe(3);
  expect(preserved.selectionEnd).toBe(7);

  preserved.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name']]);
  const retry = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(retry.value).toBe('new-name');
  retry.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name'], ['repo', 'new-name']]);

  const escape = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  escape.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.querySelector('.root-rename')).toBeNull();

  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();
  expect(doc.querySelector('.root-rename')).not.toBeNull();

  const removed = structuredClone(unrelated) as any;
  removed.config.roots = [];
  mounted.push(removed);
  expect(doc.querySelector('.root-rename')).toBeNull();
  expect(doc.querySelector('.root')).toBeNull();
});

/** Fake OpenRouter catalogue, already in the order the app is expected to keep. */
const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));

it('guides rootless setup from the capabilities that actually need a filesystem root', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const guidedSetup = mounted.window.document.getElementById('guidedSetup') as HTMLButtonElement;
  expect(guidedSetup.disabled).toBe(false);
  expect(guidedSetup.classList.contains('is-ready')).toBe(true);

  const mixed = structuredClone(mounted.state) as any;
  mixed.hasApiKey = true;
  mixed.config.roots = [];
  mixed.config.readOnly = false;
  for (const capability of Object.keys(mixed.config.capabilities)) mixed.config.capabilities[capability] = false;
  mixed.config.capabilities.browse = true;
  mixed.config.capabilities.screen = true;
  mixed.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    }
  ];

  mounted.push(mixed);
  const connect = mounted.window.document.getElementById('connectBtn') as HTMLButtonElement;
  const setupComputerUse = mounted.window.document.getElementById('setupComputerUse') as HTMLInputElement;
  expect(guidedSetup.disabled).toBe(false);
  expect(guidedSetup.classList.contains('is-ready')).toBe(true);
  expect(guidedSetup.textContent).toBe('Choose folder & start guided setup');
  expect(mounted.window.document.getElementById('guidedSetupStatus')!.textContent).toContain('folder picker first');
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');
  expect(setupComputerUse.indeterminate).toBe(true);
  expect(mounted.window.document.getElementById('setupComputerUseState')!.textContent).toBe('1 of 4 permissions');
  expect(mounted.window.document.querySelector('[data-step="folder"]')?.classList.contains('is-current')).toBe(true);

  const commandAndDesktop = structuredClone(mixed) as any;
  commandAndDesktop.config.capabilities.browse = false;
  commandAndDesktop.config.capabilities.command = true;
  mounted.push(commandAndDesktop);
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');

  const desktopOnly = structuredClone(mixed) as any;
  desktopOnly.config.capabilities.browse = false;
  mounted.push(desktopOnly);
  expect(connect.disabled).toBe(false);
  expect(connect.title).toBe('');

  const clipboardOnly = structuredClone(desktopOnly) as any;
  clipboardOnly.config.capabilities.screen = false;
  clipboardOnly.config.capabilities.clipboardRead = true;
  clipboardOnly.status.surfaces[1].tools = ['computer'];
  mounted.push(clipboardOnly);
  expect(connect.disabled).toBe(false);
});

it('lets guided Setup choose the first folder and continues automatically after approval', async () => {
  const running = { running: true, stage: 'browser', detail: 'Opening the dedicated browser.' };
  let pickedState: any = null;
  const addRoot = vi.fn(async () => ({ ok: true as const, data: pickedState }));
  const startGuidedSetup = vi.fn(async () => ({ ok: true as const, data: running }));
  const mounted = await mountChat({}, [], { addRoot, startGuidedSetup });
  const rootless = structuredClone(mounted.state) as any;
  rootless.config.roots = [];
  mounted.push(rootless);
  pickedState = structuredClone(rootless);
  pickedState.config.roots = [{ name: 'work', path: 'C:\\work' }];

  const button = mounted.window.document.getElementById('guidedSetup') as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Choose folder & start guided setup');
  button.click();

  await vi.waitFor(() => expect(startGuidedSetup).toHaveBeenCalledTimes(1));
  expect(addRoot).toHaveBeenCalledTimes(1);
  expect(addRoot.mock.invocationCallOrder[0]).toBeLessThan(startGuidedSetup.mock.invocationCallOrder[0]!);
  expect(button.textContent).toBe('Stop guided setup');
  expect(mounted.window.document.getElementById('wizFolders')!.textContent).toBe('/work');
});

it('stays on Setup with a clear retry state when the first folder choice is cancelled', async () => {
  const addRoot = vi.fn(async () => ({ ok: true as const, data: null }));
  const startGuidedSetup = vi.fn(async () => ({ ok: true as const, data: { running: true, stage: 'browser', detail: 'Opening.' } }));
  const mounted = await mountChat({}, [], { addRoot, startGuidedSetup });
  const rootless = structuredClone(mounted.state) as any;
  rootless.config.roots = [];
  mounted.push(rootless);

  const doc = mounted.window.document;
  (doc.getElementById('guidedSetup') as HTMLButtonElement).click();
  await settle();

  expect(addRoot).toHaveBeenCalledTimes(1);
  expect(startGuidedSetup).not.toHaveBeenCalled();
  expect(doc.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('setup');
  expect(doc.getElementById('guidedSetupStatus')!.textContent).toContain('No folder was added');
  expect(doc.getElementById('guidedSetup')!.textContent).toBe('Choose folder & start guided setup');
});

it('keeps composer state isolated while guided Setup starts, stops, errors and reopens', async () => {
  let setupChanged: (next: any) => void = () => undefined;
  const running = { running: true, stage: 'browser', detail: 'Opening the dedicated browser.' };
  const stopped = { running: false, stage: 'idle', detail: 'Guided setup stopped.' };
  const mounted = await mountChat({ hasApiKey: true }, [], {
    setupStatus: async () => ({ ok: true, data: null }),
    onSetupChanged: (listener: (next: any) => void) => { setupChanged = listener; return () => undefined; },
    startGuidedSetup: async () => ({ ok: true, data: running }),
    stopGuidedSetup: async () => ({ ok: true, data: stopped })
  });
  const doc = mounted.window.document;
  const app = doc.querySelector<HTMLElement>('.app')!;
  const composer = doc.getElementById('composer') as HTMLFormElement;
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'A draft that must survive onboarding';
  input.dispatchEvent(new mounted.window.Event('input'));
  const stable = () => ({
    composerClass: composer.className,
    composerStyle: composer.getAttribute('style'),
    inputClass: input.className,
    inputStyle: input.getAttribute('style'),
    rows: input.rows,
    draft: input.value
  });
  const before = stable();

  expect(app.dataset.screen).toBe('setup');
  const guidedSetup = doc.getElementById('guidedSetup') as HTMLButtonElement;
  expect(guidedSetup.textContent).toBe('Start guided browser setup');
  guidedSetup.click();
  await settle();
  expect(stable()).toEqual(before);
  expect(guidedSetup.textContent).toBe('Stop guided setup');
  expect(doc.getElementById('guidedSetupStop')).toBeNull();

  guidedSetup.click();
  await settle();
  expect(stable()).toEqual(before);
  expect(guidedSetup.textContent).toBe('Start guided browser setup');
  setupChanged({ running: false, stage: 'error', detail: 'Browser setup failed.' });
  expect(stable()).toEqual(before);
  expect(app.dataset.screen).toBe('setup');

  doc.getElementById('backToChat')!.click();
  expect(app.dataset.screen).toBe('chat');
  expect(stable()).toEqual(before);
  doc.getElementById('workspaceSettings')!.click();
  doc.querySelector<HTMLButtonElement>('nav button[data-tab="setup"]')!.click();
  expect(app.dataset.screen).toBe('setup');
  expect(stable()).toEqual(before);
});

it('opens Setup on boot until every required step is checked, but ignores unfinished optional connectors', async () => {
  const incomplete = await mountChat();
  expect(incomplete.window.document.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('setup');
  expect(incomplete.window.document.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('setup');
  expect(Array.from(incomplete.window.document.querySelectorAll('.step-mark .step-number'), node => node.textContent)).toEqual([
    '1', '2', '3', '4', '5', '6'
  ]);

  incomplete.window.close();
  dom = null;
  vi.resetModules();

  const now = Date.now();
  const complete = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected',
      detail: 'Connected.',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234',
      handshakeAt: now,
      lastRequestAt: now,
      lastToolCallAt: now,
      health: null,
      surfaces: [
        {
          id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read'],
          state: 'live', detail: '', lastRequestAt: now, lastToolCallAt: now
        },
        {
          id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['observe'],
          state: 'live', detail: '', lastRequestAt: null, lastToolCallAt: null
        }
      ]
    },
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: now, extensionVersion: '2.0.2' }
  });

  expect(complete.window.document.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('chat');
  expect(complete.window.document.querySelector('[data-step="chatgpt"]')?.classList.contains('is-done')).toBe(true);
});

it('keeps ChatGPT verification open after connector discovery until Core receives a tool call', async () => {
  const now = Date.now();
  const mounted = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected', detail: 'Connected.', publicUrl: null, localUrl: 'http://127.0.0.1:1234',
      handshakeAt: now, lastRequestAt: now, lastToolCallAt: null, health: null,
      surfaces: [{
        id: 'core', connectorName: 'Eve', description: '', cardSummary: '', optional: false,
        available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read'],
        state: 'live', detail: '', lastRequestAt: now, lastToolCallAt: null
      }]
    },
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: now, extensionVersion: '2.1.9' }
  });
  const doc = mounted.window.document;
  const step = doc.querySelector<HTMLElement>('[data-step="chatgpt"]')!;

  expect(step.classList.contains('is-current')).toBe(true);
  expect(step.classList.contains('is-done')).toBe(false);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('wizChatgpt')!.textContent).toMatch(/never run a tool/i);

  const verified = structuredClone(mounted.state) as any;
  verified.hasApiKey = true;
  verified.status = {
    ...(mounted.state as any).status,
    lastToolCallAt: now + 1,
    surfaces: [{ ...(mounted.state as any).status.surfaces[0], lastToolCallAt: now + 1 }]
  };
  verified.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: now, extensionVersion: '2.1.9' };
  mounted.push(verified);

  expect(step.classList.contains('is-done')).toBe(true);
  expect(step.classList.contains('is-current')).toBe(false);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(doc.getElementById('wizChatgpt')!.textContent).toMatch(/whole chain works/i);
});

it('keeps completed and legacy upgrades out of Setup when Eve Browser is temporarily absent', async () => {
  const seed = await mountChat();
  const completedConfig = structuredClone(seed.state.config) as any;
  completedConfig.onboarding = { complete: true };
  seed.window.close(); dom = null; vi.resetModules();

  const restore = vi.fn(async () => ({ ok: true, data: null }));
  const completed = await mountChat({
    config: completedConfig,
    hasApiKey: true,
    status: { ...seed.state.status, state: 'connected' },
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null, extensionVersion: '2.0.2' },
    companionBrowser: { windowOpen: false }
  }, [], { restoreCompanionBrowser: restore });
  const doc = completed.window.document;
  expect(doc.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('chat');
  expect(doc.getElementById('updateText')!.textContent).toContain('Eve Browser is closed');
  expect(doc.getElementById('updateExtension')!.textContent).toBe('Open Eve Browser');
  doc.getElementById('updateExtension')!.click();
  await settle();
  expect(restore).toHaveBeenCalledTimes(1);

  completed.window.close(); dom = null; vi.resetModules();
  const legacyConfig = structuredClone(completedConfig) as any;
  delete legacyConfig.onboarding;
  const legacy = await mountChat({ config: legacyConfig });
  expect(legacy.window.document.querySelector<HTMLElement>('.app')?.dataset.screen).toBe('chat');
});

it('keeps folder access discoverable after setup and navigates without granting access', async () => {
  const addRoot = vi.fn();
  const mounted = await mountChat({ hasApiKey: true }, [], { addRoot });
  const connected = structuredClone(mounted.state);
  connected.status.state = 'connected';
  connected.status.lastRequestAt = Date.now();
  connected.bridge.present = true;
  mounted.push(connected);
  const doc = mounted.window.document;
  const styles = doc.createElement('style');
  styles.textContent = await fs.readFile(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
  doc.head.append(styles);
  doc.querySelector<HTMLButtonElement>('[data-tab="setup"]')!.click();

  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  const manage = doc.getElementById('wizManageFolders')!;
  expect(mounted.window.getComputedStyle(manage.parentElement!).display).not.toBe('none');
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
  manage.click();

  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('home');
  expect(doc.activeElement).toBe(doc.getElementById('addFolder'));
  expect(doc.getElementById('rootList')!.textContent).toContain('/repo');
  expect(addRoot).not.toHaveBeenCalled();
  expect(mounted.calls).toEqual([]);
});

it('requires a live browser only when a browser-backed feature is actually enabled', async () => {
  const mounted = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected',
      detail: 'Connected.',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234',
      handshakeAt: Date.now(),
      lastRequestAt: Date.now(),
      lastToolCallAt: Date.now(),
      health: null,
      surfaces: [
        {
          id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read', 'session'],
          state: 'live', detail: '', lastRequestAt: Date.now(), lastToolCallAt: Date.now()
        }
      ]
    },
    // The token survived, but this process has not heard from the extension. This is the
    // disabled/uninstalled-extension-after-app-restart repro.
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;

  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Authorized');
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('Connected.');

  const live = structuredClone(mounted.state) as any;
  live.hasApiKey = true;
  live.status = (mounted.state as any).status;
  live.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now() };
  mounted.push(live);
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Connected.');

  // Computer use also needs exact browser-chat identity even when recording and agents are off.
  const computerOnly = structuredClone(live) as any;
  computerOnly.config.sessions.record = false;
  computerOnly.config.multiAgent.enabled = false;
  computerOnly.config.capabilities.screen = true;
  computerOnly.config.capabilities.control = false;
  computerOnly.config.capabilities.clipboardRead = false;
  computerOnly.config.capabilities.clipboardWrite = false;
  computerOnly.bridge = { running: true, port: 8765, paired: true, present: false, lastSeenAt: null };
  mounted.push(computerOnly);
  expect(browserStep.hidden).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);

  // Goal is browser-driven too, but it requires a recorded session and cannot run by itself
  // when recording is off. With agents, recording and Computer use all off, goal.enabled alone
  // must not keep setup blocked on an inert bridge.
  const browserFree = structuredClone(live) as any;
  browserFree.config.sessions.record = false;
  browserFree.config.multiAgent.enabled = false;
  browserFree.config.goal.enabled = true;
  browserFree.config.capabilities.screen = false;
  browserFree.config.capabilities.control = false;
  browserFree.config.capabilities.clipboardRead = false;
  browserFree.config.capabilities.clipboardWrite = false;
  browserFree.bridge = { running: false, port: null, paired: true, present: false, lastSeenAt: Date.now() };
  mounted.push(browserFree);
  expect(browserStep.hidden).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('not needed');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).disabled).toBe(true);
  expect(doc.getElementById('chatAutomation')!.title).toMatch(/recording/i);
});

/**
 * "Up to date" is a claim, and a claim needs somebody to have checked.
 *
 * Before GitHub answers, `{latest: null, stage: 'idle'}` means only that nothing has been
 * established - the same record a check that never ran would leave - so the Activity line stays
 * empty and no notification is shown. The timestamp is what turns that silence into an answer.
 */
it('says nothing about being current until the check has actually answered', async () => {
  const mounted = await mountChat({
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.2' }
  });
  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.hidden).toBe(true);
  expect(doc.querySelector('.toast')).toBeNull();

  const checked = structuredClone(mounted.state) as any;
  checked.update.checkedAt = Date.now();
  mounted.push(checked);

  // Green, both versions, and the same sentence as the one notification this window shows.
  expect(line.hidden).toBe(false);
  expect(line.className).toBe('upline is-ok');
  expect(line.textContent).toBe('Up to date: ParadigmEve 2.0.2 · extension 2.0.2');
  expect(doc.querySelector('.toast')!.textContent).toBe(line.textContent);
  // Nothing to act on, so the header bar stays out of the way.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);

  // The news is told once. A later push of the same fact repaints the line and nothing else.
  doc.querySelector('.toast')!.remove();
  mounted.push(structuredClone(checked) as any);
  expect(doc.querySelector('.toast')).toBeNull();
  expect(line.textContent).toBe('Up to date: ParadigmEve 2.0.2 · extension 2.0.2');
});

/**
 * A staged update is not "up to date", and it is not a failure either.
 */
it('reports a staged update in the Activity line and the header bar', async () => {
  const mounted = await mountChat();
  const staged = structuredClone(mounted.state) as any;
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.className).toBe('upline');
  expect(line.textContent).toContain('ParadigmEve 2.0.3 is verified and ready');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  // ...and this is the one state in which there is something to install. Both buttons show,
  // because a tray app closed to the tray may not see the header for days.
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(false);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(false);

  const checking = structuredClone(staged) as any;
  checking.update.stage = 'checking';
  mounted.push(checking);
  expect(line.textContent).toContain('Checking for updates');
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  // Still downloading is not yet installable: there is no verified file to hand over.
  const downloading = structuredClone(staged) as any;
  downloading.update = { ...downloading.update, stage: 'downloading' };
  mounted.push(downloading);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);

  const broken = structuredClone(staged) as any;
  broken.update = { current: '2.0.2', latest: null, stage: 'failed', error: 'latest answered 503', checkedAt: null };
  mounted.push(broken);
  expect(line.className).toBe('upline is-bad');
  expect(line.textContent).toContain('503');
  // A malformed/unreadable private inbox is a diagnostic, not something the user can act on.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * A GitHub Latest release this installation cannot apply by itself is offered as its release
 * page, and only the URL the main process built is ever opened.
 */
it('offers the release page for a newer GitHub release this installation cannot apply', async () => {
  const openLink = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], { openLink });
  const doc = mounted.window.document;
  const manual = structuredClone(mounted.state) as any;
  const releaseUrl = 'https://github.com/absol89/ParadigmEve/releases/tag/v2.0.3';
  manual.update = { current: '2.0.2', latest: '2.0.3', stage: 'idle', error: null, checkedAt: Date.now(), releaseUrl };
  mounted.push(manual);

  const view = doc.getElementById('updateRelease') as HTMLButtonElement;
  expect(doc.getElementById('updateLine')!.textContent).toContain('ParadigmEve 2.0.3 is available');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  expect(view.hidden).toBe(false);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  view.click();
  expect(openLink).toHaveBeenCalledWith(releaseUrl);

  const staged = structuredClone(manual) as any;
  staged.update.stage = 'ready';
  mounted.push(staged);
  expect(view.hidden).toBe(true);

  const local = structuredClone(manual) as any;
  local.update.releaseUrl = null;
  mounted.push(local);
  expect(view.hidden).toBe(true);
});

/**
 * The version difference has a direction, and only one of them is the user's to act on.
 *
 * An extension newer than the app is the ordinary state while an app update is downloading, and
 * the bundled folder is then the older copy: "load the extension folder again" would talk that
 * user into downgrading a working extension. The app-update line already owns being behind.
 */
it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

it('offers everyday Eve Browser recovery while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected'; connected.bridge.running = true; connected.bridge.paired = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Eve Browser isn’t connected');
  expect(doc.getElementById('updateExtension')!.textContent).toBe('Open Eve Browser');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});

it('treats a proven closed Eve Browser window as closed even while Companion presence is still warm', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected';
  connected.bridge.running = true;
  connected.bridge.paired = true;
  connected.bridge.present = true;
  connected.bridge.chatTabOpen = true;
  connected.companionBrowser = { windowOpen: false };
  mounted.push(connected);

  const doc = mounted.window.document;
  expect(doc.getElementById('companionBrowserActionLabel')!.textContent).toBe('Open Eve Browser');
  expect(doc.getElementById('updateText')!.textContent).toContain('Eve Browser is closed');
  expect(doc.getElementById('updateExtension')!.textContent).toBe('Open Eve Browser');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
});

it('keeps plugin connection controls out of general Setup, preserves its tunnel, and opens the explicit ChatGPT connector setup links', async () => {
  const openSetupLink = vi.fn(async () => ({ ok: true, data: true }));
  const openLink = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], { openSetupLink, openLink }); const doc = mounted.window.document;
  const next = structuredClone(mounted.state); next.config.tunnel.pluginsTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  mounted.push(next);
  expect(doc.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  const input = doc.getElementById('tunnelId') as HTMLInputElement;
  input.value = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  input.dispatchEvent(new mounted.window.Event('change')); await settle();
  expect(mounted.calls.at(-1).tunnel.pluginsTunnelId).toBe(next.config.tunnel.pluginsTunnelId);
  const developerModeLink = doc.querySelector<HTMLButtonElement>('[data-panel="setup"] [data-setup-link="https://chatgpt.com/#settings/Security?section=developer-mode"]');
  const createConnectorLink = doc.querySelector<HTMLButtonElement>('[data-panel="setup"] [data-setup-link="https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins"]');
  expect(developerModeLink).not.toBeNull();
  expect(createConnectorLink).not.toBeNull();
  developerModeLink!.click();
  createConnectorLink!.click();
  await settle();
  expect(openSetupLink).toHaveBeenCalledWith('https://chatgpt.com/#settings/Security?section=developer-mode');
  expect(openSetupLink).toHaveBeenCalledWith('https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins');
  expect(openLink).not.toHaveBeenCalled();
});

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('reports stored API credentials without exposing app-wide Goal switches', async () => {
  const mounted = await mountChat();
  expect(mounted.window.document.getElementById('goalEnabled')).toBeNull();
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalKeyState')!.textContent).toContain('A key is stored');
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(false);
});

/**
 * The key goes to the one channel that encrypts it and never to the settings file. This is
 * the whole reason the goal request is made by the app and not by the extension, so it is
 * worth an assertion rather than a comment.
 */
it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

it('keeps secret-key input on secure-storage failure', async () => {
  const failed = await mountChat({}, [], {
    setGoalKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' }),
    setApiKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' })
  });
  const goalFailed = failed.window.document.getElementById('goalKey') as HTMLInputElement;
  goalFailed.value = 'sk-or-v1-retry-me';
  goalFailed.dispatchEvent(new failed.window.Event('blur'));
  const apiFailed = failed.window.document.getElementById('apiKey') as HTMLInputElement;
  apiFailed.value = 'sk-retry-me';
  apiFailed.dispatchEvent(new failed.window.Event('blur'));
  await settle();
  expect(goalFailed.value).toBe('sk-or-v1-retry-me');
  expect(apiFailed.value).toBe('sk-retry-me');
});

it('never lets an older secret save erase a newer value typed while IPC is in flight', async () => {
  let releaseGoal!: (value: any) => void;
  let releaseApi!: (value: any) => void;
  const deferred = await mountChat({}, [], {
    setGoalKey: () => new Promise((resolve) => (releaseGoal = resolve)),
    setApiKey: () => new Promise((resolve) => (releaseApi = resolve))
  });
  const goal = deferred.window.document.getElementById('goalKey') as HTMLInputElement;
  goal.value = 'sk-or-v1-old';
  goal.dispatchEvent(new deferred.window.Event('blur'));
  goal.value = 'sk-or-v1-new';
  const api = deferred.window.document.getElementById('apiKey') as HTMLInputElement;
  api.value = 'sk-old';
  api.dispatchEvent(new deferred.window.Event('blur'));
  api.value = 'sk-new';

  releaseGoal({ ok: true, data: { ...deferred.state, hasGoalKey: true } });
  releaseApi({ ok: true, data: { ...deferred.state, hasApiKey: true } });
  await settle();
  await settle();
  expect(goal.value).toBe('sk-or-v1-new');
  expect(api.value).toBe('sk-new');
});

it('does not turn whitespace in the OpenRouter key field into a remove-key request', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = '   ';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();
  expect(mounted.keys).toEqual([]);
  expect(field.value).toBe('   ');
});

it('opens, saves and restores the editable goal prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('goalPromptPanel')!;
  const edit = doc.getElementById('goalPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('goalPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);

  prompt.value = 'custom gate: continue only explicit missing work. otherwise NO_REPLY.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(prompt.value);

  (doc.getElementById('goalPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
});

/**
 * The catalogue is a network request to somebody else's service, so it happens when a person
 * asks for it and not when the settings tab is opened.
 */
it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * "Load 20 more" is the deliberate way to ask for the next page. Scrolling to the bottom of
 * the list is the way people actually ask, and it did nothing at all: the list simply ended
 * at twenty with four hundred still to come and no sign that there was a button below it.
 *
 * The repaint is the other half. The list is rebuilt whole on every page, and emptying an
 * element scrolls it back to the top — so even once it paged, the reader was thrown back to
 * the newest model, which is the one they had just scrolled away from.
 */
it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose
  // height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

/**
 * A closed picker measures zero in every direction, which reads as "scrolled to the end".
 * Left unguarded, every repaint of the settings sheet would page the whole catalogue in
 * behind a panel nobody has open — hundreds of models, on somebody else's service.
 */
it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

/** Choosing one stores it verbatim: the id is what OpenRouter wants, not a display name. */
it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal.models.openrouter).toEqual(['vendor1/model-1']);
});

/** A provider that cannot be reached says so and changes nothing about what is in use. */
it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});

it('edits a fresh Goal before first send and clears it on an independent New Chat', async () => {
  const sendInput = vi.fn(async () => ({ ok: false, error: 'test delivery stopped' }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }] } }),
    draftGoalOpening: async () => ({ ok: true, data: { reply: 'Generated opening', model: 'fixture' } })
  });
  const w = mounted.window, doc = w.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('sessionControls')!.hidden).toBe(false);
  (doc.querySelector('[data-mode="goal"]') as HTMLButtonElement).click();
  const objective = doc.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input', { bubbles: true }));
  (doc.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Generated opening', sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Start with the existing code';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(objective.value).toBe('');
});
