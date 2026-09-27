import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  listWindows: vi.fn(),
  findUi: vi.fn(),
  act: vi.fn(),
  extensionDir: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('../src/main/computer/index.js', () => ({
  listWindows: mocked.listWindows,
  findUi: mocked.findUi,
  act: mocked.act,
}));

const userData = 'C:\\Users\\example\\AppData\\Roaming\\ParadigmEve';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('../src/main/browser.js', () => ({
  findPreferredBrowser: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  selectedChatBrowser: () => 'chrome',
  WINDOWS_UNTHROTTLED_CHAT_FLAGS: [
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  ],
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: mocked.extensionDir }));
vi.mock('../src/main/tunnel/index.js', () => ({ TUNNEL_ID_PATTERN: /^tunnel_[0-9a-f]{32}$/ }));

class FakeChromeProcess extends EventEmitter {
  pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
  unref(): void { /* ChildProcess parity. */ }
}

const setupModule = import('../src/main/setup-assistant.js');
let appDom: JSDOM | null = null;
let appHtml = '';

const baseConfig = {
  onboarding: { complete: false },
  roots: [{ name: 'repo', path: 'C:\\repo' }],
  readOnly: true,
  capabilities: {
    browse: true, search: true, read: true, metadata: true,
    create: false, edit: false, move: false, deleteFile: false, command: false,
    screen: false, control: false, clipboardRead: false, clipboardWrite: false,
  },
  tunnel: {
    kind: 'openai',
    tunnelId: `tunnel_${'a'.repeat(32)}`,
    desktopTunnelId: '',
    pluginsTunnelId: '',
    binaryPath: '',
  },
  ui: {
    minimizeToTray: true,
    autoConnect: false,
    privacyScreenshots: false,
    theme: 'dark',
    backgroundChats: true,
  },
  sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
  compaction: { auto: true, autoTokens: 300000 },
  multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
  mcp: { connectorName: 'Eve', instructions: '' },
  goal: {
    enabled: false,
    model: DEFAULT_GOAL_MODEL,
    reasoning: 'default' as const,
    prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
  },
};

function authorityProjection(document: Document): Array<{ step: string; done: boolean; current: boolean; ariaCurrent: string | null }> {
  return [...document.querySelectorAll<HTMLElement>('#wizard [data-step]')].map((node) => ({
    step: node.dataset.step ?? '',
    done: node.classList.contains('is-done'),
    current: node.classList.contains('is-current'),
    ariaCurrent: node.getAttribute('aria-current'),
  }));
}

function uniqueElements(values: Array<Element | null | undefined>): Element[] {
  return [...new Set(values.filter((value): value is Element => Boolean(value)))];
}

function presentationFingerprint(document: Document): string {
  const clone = document.getElementById('wizard')!.cloneNode(true) as HTMLElement;
  for (const step of clone.querySelectorAll<HTMLElement>('[data-step]')) {
    step.classList.remove('is-done', 'is-current');
    step.removeAttribute('aria-current');
  }
  return clone.outerHTML;
}

function activateStepPreview(document: Document, stepName: string, scrolled: Element[]): boolean {
  const target = document.querySelector<HTMLElement>(`#wizard [data-step="${stepName}"]`)!;
  const before = presentationFingerprint(document);
  const beforeScroll = scrolled.length;
  const beforeFocus = document.activeElement;
  const candidates = uniqueElements([
    ...target.querySelectorAll<HTMLElement>('[data-setup-preview], button[aria-controls], [role="button"][aria-controls]'),
    target.querySelector('.step-mark'),
    target.querySelector('.step-heading'),
    target.querySelector('h3'),
    target,
  ]);

  for (const candidate of candidates) {
    candidate.dispatchEvent(new appDom!.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const changed = presentationFingerprint(document) !== before;
    const scrolledToStep = scrolled.slice(beforeScroll).some((node) => node === target || target.contains(node));
    const focusedWithinStep = document.activeElement !== beforeFocus && target.contains(document.activeElement);
    if (changed || scrolledToStep || focusedWithinStep) return true;
  }
  return false;
}

function guideSecretControl(document: Document, inputId: 'tunnelId' | 'apiKey'): HTMLElement | null {
  const subject = inputId === 'tunnelId' ? /tunnel/i : /api\s*key|key/i;
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find((control) => {
    const controlled = control.getAttribute('aria-controls')?.split(/\s+/) ?? [];
    if (controlled.includes(inputId)) return true;
    const label = `${control.getAttribute('aria-label') ?? ''} ${control.getAttribute('title') ?? ''} ${control.textContent ?? ''}`;
    return subject.test(label) && /show|hide|reveal|visibility/i.test(label);
  }) ?? null;
}

function guidePhaseControl(document: Document, phase: number): HTMLElement | null {
  const phaseId = `phase${phase}`;
  const attributes = ['data-phase', 'data-preview-phase', 'data-guide-phase', 'data-step', 'data-guide-step'];
  return [...document.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((control) => {
    if ((control.getAttribute('aria-controls')?.split(/\s+/) ?? []).includes(phaseId)) return true;
    return attributes.some((attribute) => {
      const value = control.getAttribute(attribute);
      return value === String(phase) || value === phaseId;
    });
  }) ?? null;
}

beforeAll(async () => {
  appHtml = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
});

beforeEach(async () => {
  const setup = await setupModule;
  await setup.stopSetupAssistant();
  mocked.extensionDir.mockReset();
  mocked.extensionDir.mockReturnValue('C:\\Users\\example\\AppData\\Local\\ParadigmEve\\extension');
  mocked.spawn.mockReset();
  mocked.spawn.mockImplementation(() => {
    const child = new FakeChromeProcess();
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  mocked.listWindows.mockReset();
  mocked.listWindows.mockResolvedValue({
    windows: [{ id: 77, processId: 4242, title: 'ParadigmEve · Guided setup - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' }],
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  mocked.findUi.mockReset();
  mocked.findUi.mockResolvedValue({ window: 77, snapshotId: 1, elements: [] });
  mocked.act.mockReset();
  mocked.act.mockResolvedValue({ cursor: null, clipboard: [], completedCount: 1, routes: [] });
});

afterAll(async () => {
  appDom?.window.close();
  const setup = await setupModule;
  await setup.stopSetupAssistant();
});

describe('desktop Setup privacy and preview navigation', () => {
  it('masks Tunnel ID and API key by default and eye controls only change presentation', async () => {
    appDom = new JSDOM(appHtml, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = appDom.window;
    const apiCalls: Array<{ name: PropertyKey; args: unknown[] }> = [];
    const scrolled: Element[] = [];
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
      HTMLButtonElement: w.HTMLButtonElement,
    });
    Object.defineProperty(w.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) { scrolled.push(this); },
    });

    const state = {
      config: structuredClone(baseConfig),
      status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
      hasApiKey: false,
      hasGoalKey: false,
      resolvedBinary: null,
      bundledTunnelVersion: null,
      bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
      update: { current: '2.2.1', latest: null, stage: 'idle', error: null, checkedAt: null },
    };
    const ok = (data: unknown) => Promise.resolve({ ok: true, data });
    let stateListener: (next: unknown) => void = () => undefined;
    const api = new Proxy({
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: (next: unknown) => void) => { stateListener = fn; return () => undefined; },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
    } as Record<PropertyKey, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          apiCalls.push({ name: prop, args });
          return ok(null);
        };
      },
    });
    Object.defineProperty(w, 'api', { value: api, configurable: true });

    await import('../src/renderer/main.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
    stateListener(structuredClone(state));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tunnel = w.document.getElementById('tunnelId') as HTMLInputElement;
    const key = w.document.getElementById('apiKey') as HTMLInputElement;
    const tunnelEye = w.document.getElementById('tunnelPrivacy') as HTMLButtonElement;
    const keyEye = w.document.getElementById('apiKeyPrivacy') as HTMLButtonElement;
    expect(tunnelEye, 'Tunnel ID needs an eye visibility control').not.toBeNull();
    expect(keyEye, 'API key needs an eye visibility control').not.toBeNull();
    expect(tunnel.type, 'Tunnel ID must fail closed before any reveal click').toBe('password');
    expect(key.type, 'API key must fail closed before any reveal click').toBe('password');

    tunnel.value = baseConfig.tunnel.tunnelId;
    key.value = `sk-${'private'.repeat(6)}`;
    const secretValues = [tunnel.value, key.value];
    const beforeAuthority = authorityProjection(w.document);
    apiCalls.length = 0;

    tunnelEye.click();
    keyEye.click();
    expect(tunnel.type).toBe('text');
    expect(key.type).toBe('text');
    expect([tunnel.value, key.value]).toEqual(secretValues);
    expect(authorityProjection(w.document)).toEqual(beforeAuthority);
    expect(apiCalls, 'revealing a secret is local presentation, not a settings/authority mutation').toEqual([]);

    tunnelEye.click();
    keyEye.click();
    expect(tunnel.type).toBe('password');
    expect(key.type).toBe('password');
    expect([tunnel.value, key.value]).toEqual(secretValues);
    expect(authorityProjection(w.document)).toEqual(beforeAuthority);
    expect(apiCalls).toEqual([]);

    tunnelEye.click();
    keyEye.click();
    expect(tunnel.type).toBe('text');
    expect(key.type).toBe('text');

    apiCalls.length = 0;
    const authorityBeforePreview = authorityProjection(w.document);
    expect(activateStepPreview(w.document, 'chatgpt', scrolled), 'clicking step 6 should visibly preview/navigate to it').toBe(true);
    expect(tunnel.type, 'preview navigation must re-mask a revealed Tunnel ID').toBe('password');
    expect(key.type, 'preview navigation must re-mask a revealed API key').toBe('password');
    expect(authorityProjection(w.document), 'previewing step 6 must not mark it complete or current').toEqual(authorityBeforePreview);
    expect(apiCalls, 'preview navigation must not save settings or mutate backend setup state').toEqual([]);

    expect(activateStepPreview(w.document, 'folder', scrolled), 'a completed earlier step should be clickable for back-navigation').toBe(true);
    expect(authorityProjection(w.document), 'back-navigation must keep completion authority unchanged').toEqual(authorityBeforePreview);
    expect(apiCalls).toEqual([]);
  });
});

describe('browser setup guide privacy and preview navigation', () => {
  it('masks both secrets, toggles them locally, warns about recording exposure, and previews steps without posting authority', async () => {
    const setup = await setupModule;
    const pending = setup.startSetupAssistant({
      coreConnectorName: 'ParadigmEve',
      coreConnectorDescription: 'Keep using ChatGPT naturally while ParadigmEve handles local files and tasks.',
      connectorIconPath: 'C:\\Program Files\\ParadigmEve\\resources\\connector\\icon.png',
      companionPresent: () => true,
    });
    const stopped = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled());
    const args = mocked.spawn.mock.calls[0]?.[1] as string[];
    const guideUrl = args.at(-1)!;
    const html = await fetch(guideUrl).then((response) => response.text());
    expect(html, 'the browser guide should explain why secrets start hidden for screen sharing/recording/streaming').toMatch(/screen\s*shar|record|stream/i);

    const posted: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const opened: string[] = [];
    const guide = new JSDOM(html, {
      url: guideUrl,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          value: async (input: RequestInfo | URL, init?: RequestInit) => {
            posted.push({ input, init });
            throw new Error('preview/presentation controls must not POST');
          },
        });
        Object.defineProperty(window, 'open', {
          configurable: true,
          value: (url: string | URL | undefined) => {
            if (url) opened.push(String(url));
            return null;
          },
        });
      },
    });
    const document = guide.window.document;
    const tunnel = document.getElementById('tunnelId') as HTMLInputElement;
    const key = document.getElementById('apiKey') as HTMLInputElement;
    expect(tunnel.type, 'Tunnel ID in the browser guide must start masked').toBe('password');
    expect(key.type, 'API key in the browser guide must start masked').toBe('password');

    const tunnelEye = guideSecretControl(document, 'tunnelId');
    const keyEye = guideSecretControl(document, 'apiKey');
    expect(tunnelEye, 'browser guide Tunnel ID needs an eye visibility control').not.toBeNull();
    expect(keyEye, 'browser guide API key needs an eye visibility control').not.toBeNull();
    const authorityBeforePrivacy = setup.setupAssistantSnapshot();
    tunnelEye!.click();
    keyEye!.click();
    expect(tunnel.type).toBe('text');
    expect(key.type).toBe('text');
    expect(posted).toEqual([]);
    expect(opened).toEqual([]);
    expect(setup.setupAssistantSnapshot()).toEqual(authorityBeforePrivacy);
    tunnelEye!.click();
    keyEye!.click();
    expect(tunnel.type).toBe('password');
    expect(key.type).toBe('password');
    expect(posted).toEqual([]);
    expect(setup.setupAssistantSnapshot()).toEqual(authorityBeforePrivacy);

    const phaseSix = guidePhaseControl(document, 6);
    const phaseOne = guidePhaseControl(document, 1);
    expect(phaseSix, 'guide needs a local step-6 preview control').not.toBeNull();
    expect(phaseOne, 'guide needs a local step-1 back-navigation control').not.toBeNull();
    const authorityBeforePreview = setup.setupAssistantSnapshot();
    tunnelEye!.click();
    keyEye!.click();
    expect(tunnel.type).toBe('text');
    expect(key.type).toBe('text');
    phaseSix!.click();
    // Journey step 6 is the ChatGPT-app page. The guide also has a pre-journey welcome/sign-in
    // phase, so its implementation phase is #phase7 rather than a second source of step truth.
    expect(document.getElementById('phase7')?.classList.contains('active')).toBe(true);
    expect(tunnel.type, 'guide step navigation must re-mask a revealed Tunnel ID').toBe('password');
    expect(key.type, 'guide step navigation must re-mask a revealed API key').toBe('password');
    expect(posted, 'previewing a future guide step must not POST setup progress').toEqual([]);
    expect(setup.setupAssistantSnapshot()).toEqual(authorityBeforePreview);
    phaseOne!.click();
    expect(document.getElementById('phase1')?.classList.contains('active')).toBe(true);
    expect(posted).toEqual([]);
    expect(setup.setupAssistantSnapshot()).toEqual(authorityBeforePreview);

    guide.window.close();
    await setup.stopSetupAssistant();
    expect(await stopped).toBeInstanceOf(setup.SetupAssistantStoppedError);
  });
});
