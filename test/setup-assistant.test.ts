import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), listWindows: vi.fn(), findUi: vi.fn(), act: vi.fn(), extensionDir: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('../src/main/computer/index.js', () => ({ listWindows: mocked.listWindows, findUi: mocked.findUi, act: mocked.act }));

let chromePath: string | null = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const bravePath = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
let selectedBrowser: 'chrome' | 'edge' | 'brave' = 'chrome';
let extensionPath: string | null = 'C:\\Users\\example\\AppData\\Local\\ParadigmEve\\extension';
const userData = 'C:\\Users\\example\\AppData\\Roaming\\ParadigmEve';

vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('../src/main/browser.js', () => ({
  findPreferredBrowser: (_platform?: unknown, _env?: unknown, _home?: unknown, _exists?: unknown, browser = 'chrome') =>
    browser === 'edge' ? edgePath : browser === 'brave' ? bravePath : chromePath,
  selectedChatBrowser: () => selectedBrowser,
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
  unref(): void { /* parity with ChildProcess */ }
}

const modulePromise = import('../src/main/setup-assistant.js');

// These fixtures model the Windows setup flow: UI Automation refs, Windows window identities and Chrome paths. Pin the platform so macOS/Linux runners exercise the same Windows branch the fixtures describe;
// the modules under test read process.platform at call time, never at import.
const hostPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true }); });

const validTunnel = `tunnel_${'a'.repeat(32)}`;
const validKey = `sk-${'b'.repeat(32)}`;
const baseOptions = {
  coreConnectorName: 'ParadigmEve',
  coreConnectorDescription: 'Keep using ChatGPT naturally while ParadigmEve handles local files, tasks and enabled Computer use capabilities.',
  connectorIconPath: 'C:\\Program Files\\ParadigmEve\\resources\\connector\\icon.png',
  companionPresent: () => true,
};

let chromeProcesses: FakeChromeProcess[] = [];

function newChromeProcess(): FakeChromeProcess {
  const process = new FakeChromeProcess();
  chromeProcesses.push(process);
  queueMicrotask(() => process.emit('spawn'));
  return process;
}

async function waitForGuideUrl(): Promise<string> {
  await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled());
  const args = mocked.spawn.mock.calls[0]?.[1] as string[];
  return args.at(-1)!;
}

function actionUrl(guideUrl: string): string {
  return guideUrl.replace('/welcome/', '/action/');
}

async function guideAction(
  guideUrl: string,
  payload: Record<string, unknown>,
  options: { origin?: boolean } = { origin: true },
): Promise<Response> {
  const origin = new URL(guideUrl).origin;
  return fetch(actionUrl(guideUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.origin === false ? {} : { Origin: origin }),
    },
    body: JSON.stringify(payload),
  });
}

async function completeFlow<T>(pending: Promise<T>, guideUrl: string, apiKey = validKey): Promise<T> {
  expect((await guideAction(guideUrl, { action: 'start' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'signed-in' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'companion-done' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'api-key', apiKey })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'core-app-start' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'core-app-done' })).status).toBe(200);
  return pending;
}

async function reachApiKeyStep(guideUrl: string): Promise<void> {
  expect((await guideAction(guideUrl, { action: 'start' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'signed-in' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'companion-done' })).status).toBe(200);
  expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(200);
}

beforeEach(async () => {
  const setup = await modulePromise;
  await setup.stopSetupAssistant();
  chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  selectedBrowser = 'chrome';
  extensionPath = 'C:\\Users\\example\\AppData\\Local\\ParadigmEve\\extension';
  mocked.extensionDir.mockReset();
  mocked.extensionDir.mockImplementation(() => extensionPath);
  chromeProcesses = [];
  mocked.spawn.mockReset();
  mocked.spawn.mockImplementation(() => newChromeProcess());
  mocked.listWindows.mockReset();
  mocked.listWindows.mockResolvedValue({
    windows: [{
      id: 77,
      processId: 4242,
      title: 'ParadigmEve · Guided setup - Google Chrome',
      process: 'chrome',
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      state: 'foreground',
    }],
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  mocked.act.mockReset();
  mocked.act.mockResolvedValue({ cursor: null, clipboard: [], completedCount: 5, routes: [] });
  mocked.findUi.mockReset();
  mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
    window: options.window ?? 77,
    snapshotId: 1,
    elements: options.query === 'Address and search bar'
      ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
      : [],
  }));
});

afterEach(async () => {
  const setup = await modulePromise;
  await setup.stopSetupAssistant();
});

describe('ParadigmEve setup browser', () => {
  it('focuses an already-open Eve Browser without launching another profile', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    await expect(setup.restoreParadigmEveBrowser()).resolves.toBeUndefined();
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([{ type: 'focus', window: 77 }], { window: 77 });
  });

  it.each([
    ['edge', 'VendorEdge.setupbrowserprofileedge.Default', 'msedge', edgePath, 'VendorEdge.Default', bravePath, 'brave'],
    ['brave', 'VendorBrave.setupbrowserprofilebrave.Default', 'brave', bravePath, 'VendorBrave.Default', edgePath, 'msedge'],
  ] as const)('accepts only the exact dedicated %s Windows profile identity', async (
    browser,
    appUserModelId,
    processName,
    processPath,
    wrongAppUserModelId,
    wrongProcessPath,
    wrongProcess,
  ) => {
    const setup = await modulePromise;
    selectedBrowser = browser;
    const window = (overrides: Record<string, unknown>) => ({
      id: 77,
      app: appUserModelId,
      appUserModelId,
      processPath,
      title: 'Eve Browser',
      process: processName,
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      state: 'open',
      ...overrides,
    });
    mocked.listWindows.mockResolvedValue({ windows: [window({})], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    await expect(setup.paradigmeEveBrowserWindowOpen()).resolves.toBe(true);

    mocked.listWindows.mockResolvedValue({ windows: [window({ app: wrongAppUserModelId, appUserModelId: wrongAppUserModelId })], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    await expect(setup.paradigmeEveBrowserWindowOpen()).resolves.toBe(false);

    mocked.listWindows.mockResolvedValue({ windows: [window({ processPath: wrongProcessPath })], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    await expect(setup.paradigmeEveBrowserWindowOpen()).resolves.toBe(false);

    mocked.listWindows.mockResolvedValue({ windows: [window({ process: wrongProcess })], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    await expect(setup.paradigmeEveBrowserWindowOpen()).resolves.toBe(false);

    mocked.listWindows.mockResolvedValue({ windows: [window({ appUserModelId: undefined })], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    await expect(setup.paradigmeEveBrowserWindowOpen()).resolves.toBe(false);
  });

  it('keeps an existing Eve Browser single-window when the Companion proves a ChatGPT tab is open', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    await expect(setup.restoreParadigmEveBrowser(() => true)).resolves.toBeUndefined();
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([{ type: 'focus', window: 77 }], { window: 77 });
  });

  it('opens one ChatGPT tab in the existing Eve Browser when the exact tab census is empty', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    await expect(setup.restoreParadigmEveBrowser(() => false)).resolves.toBeUndefined();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const args = mocked.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain(`--user-data-dir=${path.join(userData, 'setup-browser-profile')}`);
    expect(args.at(-1)).toBe('https://chatgpt.com/');
    expect(mocked.act).not.toHaveBeenCalledWith([{ type: 'focus', window: 77 }], { window: 77 });
  });

  it('can restore the dedicated browser without opening a generic ChatGPT tab when an exact Prime fallback owns startup', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    await expect(setup.restoreParadigmEveBrowser(() => false, {
      waitForRestoreOffer: false,
      openFreshChatWhenEmpty: false,
    })).resolves.toBeUndefined();
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('restores a missing ChatGPT tab without requiring Windows foreground focus', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.act.mockRejectedValue(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'));

    await expect(setup.restoreParadigmEveBrowser(() => false)).resolves.toBeUndefined();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(mocked.act).not.toHaveBeenCalled();
    expect((mocked.spawn.mock.calls[0]?.[1] as string[]).at(-1)).toBe('https://chatgpt.com/');
  });

  it('lets Chrome native Restore own recovery instead of opening a replacement from a stale empty census', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 7,
      elements: options.query === 'Restore pages'
        ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Restore'
          ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await expect(setup.restoreParadigmEveBrowser(() => false)).resolves.toBeUndefined();
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 77 });
  });

  it('coalesces concurrent restore clicks into one dedicated-profile launch', async () => {
    const setup = await modulePromise;
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValueOnce({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValue({
        windows: [
          { id: 88, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 88,
      snapshotId: 8,
      elements: options.query === 'Restore pages'
        ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Restore'
          ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await Promise.all([setup.restoreParadigmEveBrowser(() => false), setup.restoreParadigmEveBrowser(() => false)]);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const args = mocked.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain(`--user-data-dir=${path.join(userData, 'setup-browser-profile')}`);
    expect(args).toContain('--restore-last-session');
    expect(args).not.toContain('https://chatgpt.com/');
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 88 });
  });

  it('refreshes the unpacked Companion through Chrome UI in the dedicated profile only', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 12, app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', title: 'Normal Chrome', process: 'chrome', x: 0, y: 0, width: 800, height: 600, state: 'foreground' },
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 9,
      elements: options.query === 'Address and search bar'
        ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Update'
          ? [{ ref: 'update-ref', name: 'Update', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await expect(setup.refreshParadigmEveCompanionForMaintenance()).resolves.toBeUndefined();
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.findUi).toHaveBeenCalledWith({ window: 77, query: 'Address and search bar', role: 'edit', maxResults: 5 });
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: 'chrome://extensions/' },
      { type: 'keypress', keys: ['alt', 'enter'] },
      { type: 'wait', ms: 600 },
    ], { window: 77 });
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string }>)).not.toContainEqual({ type: 'type', text: 'chrome://extensions/' });
    expect(mocked.findUi).toHaveBeenCalledWith({ window: 77, query: 'Update', role: 'button', maxResults: 10 });
    expect(mocked.act.mock.calls.at(-1)?.[0]).toEqual([
      { type: 'ui_action', ref: 'update-ref', action: 'invoke' },
      { type: 'wait', ms: 750 },
      { type: 'keypress', keys: ['ctrl', 'w'] },
    ]);
  });

  it('materializes the current Companion then restarts only the already-open dedicated Chrome profile', async () => {
    const setup = await modulePromise;
    mocked.listWindows
      .mockResolvedValueOnce({
        windows: [
          { id: 12, app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', title: 'Normal Chrome', process: 'chrome', x: 0, y: 0, width: 800, height: 600, state: 'foreground' },
          { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      })
      .mockResolvedValue({
        windows: [
          { id: 12, app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', title: 'Normal Chrome', process: 'chrome', x: 0, y: 0, width: 800, height: 600, state: 'foreground' },
          { id: 88, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).resolves.toBe(true);
    expect(mocked.extensionDir).toHaveBeenCalledTimes(1);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: 'chrome://restart/' },
      { type: 'keypress', keys: ['enter'] },
    ], { window: 77 });
    expect(mocked.act.mock.calls.some((call) => call[1]?.window === 12)).toBe(false);
  });

  it('reacquires the dedicated browser and retries only a recovery FOCUS_FAILED before restart navigation', async () => {
    const setup = await modulePromise;
    const window = (id: number, state: 'foreground' | 'open' = 'open') => ({
      id, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome',
      x: 0, y: 0, width: 1200, height: 800, state,
    });
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [window(77, 'foreground')], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValueOnce({ windows: [window(78, 'foreground')], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValue({ windows: [window(88)], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    mocked.act
      .mockRejectedValueOnce(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'))
      .mockResolvedValue({ cursor: null, clipboard: [], completedCount: 3, routes: [] });

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).resolves.toBe(true);
    expect(mocked.act.mock.calls[0]).toEqual([[
      { type: 'focus', window: 77 },
      { type: 'wait', ms: 100 },
    ], { window: 77 }]);
    expect(mocked.act.mock.calls[1]).toEqual([[
      { type: 'focus', window: 78 },
      { type: 'wait', ms: 100 },
    ], { window: 78 }]);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: 'chrome://restart/' },
      { type: 'keypress', keys: ['enter'] },
    ], { window: 78 });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('retries installer recovery when the same dedicated browser window temporarily loses foreground ownership', async () => {
    const setup = await modulePromise;
    const target = {
      id: 4457634,
      app: 'Chrome.setupbrowserprofile.Default',
      title: 'ChatGPT - Google Chrome',
      process: 'chrome',
      x: 0, y: 0, width: 1200, height: 800,
      state: 'open' as const,
    };
    const replacement = { ...target, id: 4457635 };
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [target], screen })
      .mockResolvedValueOnce({ windows: [target], screen })
      .mockResolvedValue({ windows: [replacement], screen });
    mocked.act
      .mockRejectedValueOnce(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 4457634 but foreground is 2818630 after asking Windows to activate it. Another window is holding focus; click it away or retry.'))
      .mockResolvedValue({ cursor: null, clipboard: [], completedCount: 3, routes: [] });

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).resolves.toBe(true);
    const focusCalls = mocked.act.mock.calls.filter((call) =>
      (call[0] as Array<{ type: string }>).some((step) => step.type === 'focus'));
    expect(focusCalls.slice(0, 2).map((call) => call[1]?.window)).toEqual([4457634, 4457634]);
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('bounds recovery focus retries and never falls back to launching another browser window', async () => {
    const setup = await modulePromise;
    const target = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    mocked.listWindows.mockResolvedValue({ windows: [target], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    mocked.act.mockRejectedValue(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'));

    await expect(setup.restartParadigmEveChromeForInstallerRecovery(1_000)).rejects.toThrow(/FOCUS_FAILED/);
    const focusCalls = mocked.act.mock.calls.filter((call) =>
      (call[0] as Array<{ type: string }>).some((step) => step.type === 'focus'));
    expect(focusCalls).toHaveLength(5);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>))
      .not.toContainEqual(expect.objectContaining({ type: 'set_value' }));
  });

  it.each([
    ['edge', 'VendorEdge.setupbrowserprofileedge.Default', 'msedge', edgePath, 'edge://restart/'],
    ['brave', 'VendorBrave.setupbrowserprofilebrave.Default', 'brave', bravePath, 'brave://restart/'],
  ] as const)('uses the selected %s family-native restart URL for installer recovery', async (
    browser,
    appUserModelId,
    processName,
    processPath,
    restartUrl,
  ) => {
    const setup = await modulePromise;
    selectedBrowser = browser;
    const browserWindow = (id: number) => ({
      id,
      app: appUserModelId,
      appUserModelId,
      process: processName,
      processPath,
      title: 'ChatGPT - Eve Browser',
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      state: 'open',
    });
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [browserWindow(77)], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValue({ windows: [browserWindow(88)], screen: { x: 0, y: 0, width: 1920, height: 1080 } });

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).resolves.toBe(true);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: restartUrl },
      { type: 'keypress', keys: ['enter'] },
    ], { window: 77 });
  });

  it('materializes the current Companion but does not restart a dedicated profile that is already closed', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } });

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).resolves.toBe(false);
    expect(mocked.extensionDir).toHaveBeenCalledTimes(1);
    expect(mocked.act).not.toHaveBeenCalled();
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('fails installer browser recovery before restart when the current Companion cannot be materialized', async () => {
    const setup = await modulePromise;
    extensionPath = null;

    await expect(setup.restartParadigmEveChromeForInstallerRecovery()).rejects.toThrow(/could not be materialized/i);
    expect(mocked.extensionDir).toHaveBeenCalledTimes(1);
    expect(mocked.listWindows).not.toHaveBeenCalled();
    expect(mocked.act).not.toHaveBeenCalled();
  });

  it('fails closed when the dedicated Chrome profile never returns after installer restart', async () => {
    vi.useFakeTimers();
    try {
      const setup = await modulePromise;
      mocked.listWindows.mockResolvedValue({
        windows: [
          { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      const pending = setup.restartParadigmEveChromeForInstallerRecovery(1_000);
      const rejected = expect(pending).rejects.toThrow(/did not return after installer recovery restarted it/i);

      await vi.advanceTimersByTimeAsync(1_200);
      await rejected;
      expect(mocked.extensionDir).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for current live Companion proof after Chrome Update before maintenance succeeds', async () => {
    vi.useFakeTimers();
    try {
      const setup = await modulePromise;
      mocked.listWindows.mockResolvedValue({
        windows: [
          { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
        window: options.window ?? 77,
        snapshotId: 9,
        elements: options.query === 'Address and search bar'
          ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : options.query === 'Update'
            ? [{ ref: 'update-ref', name: 'Update', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
            : [],
      }));
      let checks = 0;
      const pending = setup.refreshParadigmEveCompanionForMaintenance({
        ready: () => ++checks >= 3,
        readyTimeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toBeUndefined();
      expect(checks).toBe(3);
      expect(mocked.act.mock.calls.at(-1)?.[0]).toEqual([
        { type: 'ui_action', ref: 'update-ref', action: 'invoke' },
        { type: 'wait', ms: 750 },
        { type: 'keypress', keys: ['ctrl', 'w'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call Companion maintenance successful when Chrome Update never yields live proof', async () => {
    vi.useFakeTimers();
    try {
      const setup = await modulePromise;
      mocked.listWindows.mockResolvedValue({
        windows: [
          { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
        window: options.window ?? 77,
        snapshotId: 9,
        elements: options.query === 'Address and search bar'
          ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : options.query === 'Update'
            ? [{ ref: 'update-ref', name: 'Update', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
            : [],
      }));
      const pending = setup.refreshParadigmEveCompanionForMaintenance({
        ready: () => false,
        readyTimeoutMs: 250,
      });
      const rejected = expect(pending).rejects.toThrow(/current live ChatGPT document/i);

      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(mocked.act.mock.calls.at(-1)?.[0]).toEqual([
        { type: 'ui_action', ref: 'update-ref', action: 'invoke' },
        { type: 'wait', ms: 750 },
        { type: 'keypress', keys: ['ctrl', 'w'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Chrome native Restore pages without navigating away from the restored session', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 9,
      elements: options.query === 'Restore pages'
        ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Restore'
          ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await expect(setup.restoreParadigmEveChromeSessionForRecovery()).resolves.toMatchObject({ id: 77 });
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 77 });
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>))
      .not.toContainEqual(expect.objectContaining({ type: 'set_value' }));
  });

  it('boots the exact proven Prime in the first Eve tab before invoking native Restore', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 12, app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', title: 'Normal Chrome', process: 'chrome', x: 0, y: 0, width: 800, height: 600, state: 'foreground' },
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 19,
      elements: options.query === 'Address and search bar'
        ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Restore pages'
          ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : options.query === 'Restore'
            ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
            : [],
    }));
    const exact = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';

    const exactConversationOpen = vi.fn(async () => true);
    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, exactConversationOpen })).resolves.toMatchObject({ id: 77, restoredPages: true });
    expect(mocked.spawn).not.toHaveBeenCalled();
    const calls = mocked.act.mock.calls;
    expect(calls).toContainEqual([[
      { type: 'focus', window: 77 },
      { type: 'wait', ms: 100 },
    ], { window: 77 }]);
    expect(calls).toContainEqual([[
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: exact },
      { type: 'keypress', keys: ['enter'] },
      { type: 'wait', ms: 300 },
    ], { window: 77 }]);
    expect(calls).toContainEqual([[
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 77 }]);
    const primeCall = calls.findIndex((call) => (call[0] as Array<{ type: string; text?: string }>).some((step) => step.type === 'set_value' && step.text === exact));
    const restoreCall = calls.findIndex((call) => (call[0] as Array<{ type: string; ref?: string }>).some((step) => step.type === 'ui_action' && step.ref === 'restore-button'));
    expect(primeCall).toBeGreaterThan(-1);
    expect(restoreCall).toBeGreaterThan(primeCall);
    expect(exactConversationOpen).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(mocked.act.mock.calls.some((call) => call[1]?.window === 12)).toBe(false);
  });

  it('reacquires after FOCUS_FAILED while booting exact Prime without opening a fallback tab or window', async () => {
    const setup = await modulePromise;
    const first = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    const second = { ...first, id: 78 };
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [first], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValueOnce({ windows: [second], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValue({ windows: [second], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    mocked.act
      .mockRejectedValueOnce(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'))
      .mockResolvedValue({ cursor: null, clipboard: [], completedCount: 4, routes: [] });
    const exact = 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999';

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 78, restoredPages: false });
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: exact },
      { type: 'keypress', keys: ['enter'] },
      { type: 'wait', ms: 300 },
    ], { window: 78 });
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; keys?: string[] }>))
      .not.toContainEqual(expect.objectContaining({ type: 'keypress', keys: ['alt', 'enter'] }));
  });

  it('opens the exact Prime through the running dedicated profile when Windows keeps refusing focus', async () => {
    // Live 2026-09-26/27: every background restart logged FOCUS_FAILED and the queued Eve wake
    // never posted. Handing the running profile the URL needs no foreground.
    const setup = await modulePromise;
    const target = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' as const };
    mocked.listWindows.mockResolvedValue({ windows: [target], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    mocked.act.mockRejectedValue(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'));
    const exact = 'https://chatgpt.com/c/12121212-1212-4121-8121-121212121212';
    const exactConversationOpen = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, exactConversationOpen, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 77 });
    expect(mocked.spawn).toHaveBeenCalledOnce();
    const args = mocked.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain(`--user-data-dir=${path.join(userData, 'setup-browser-profile')}`);
    expect(args.at(-1)).toBe(exact);
    expect(args).not.toContain('--restore-last-session');
  });

  it('opens no second tab when the Companion already reports the exact Prime after focus is refused', async () => {
    const setup = await modulePromise;
    const target = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'ChatGPT - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' as const };
    mocked.listWindows.mockResolvedValue({ windows: [target], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    mocked.act.mockRejectedValue(new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. FOCUS_FAILED: requested 77 but foreground is 12'));
    const exact = 'https://chatgpt.com/c/13131313-1313-4131-8131-131313131313';

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, exactConversationOpen: async () => true, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 77 });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('recommits the same exact Prime after the URL was staged but Enter lost focus', async () => {
    const setup = await modulePromise;
    const first = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    mocked.listWindows.mockResolvedValue({ windows: [first], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    const exact = 'https://chatgpt.com/c/77777777-7777-4777-8777-777777777777';
    let navigationAttempts = 0;
    mocked.act.mockImplementation(async (actions: Array<{ type: string }>) => {
      if (actions.some((step) => step.type === 'set_value')) {
        navigationAttempts += 1;
        if (navigationAttempts === 1) {
          throw new Error('PARTIAL_BATCH: completed_count=2 failed_index=2 routes=uia+uia. FOCUS_FAILED: requested 77 but foreground is 12');
        }
      }
      return { cursor: null, clipboard: [], completedCount: actions.length, routes: [] };
    });

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 77, restoredPages: false });
    const writes = mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>).filter((step) =>
      step.type === 'set_value' && step.text === exact);
    expect(writes).toHaveLength(2);
    expect(navigationAttempts).toBe(2);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; keys?: string[] }>))
      .not.toContainEqual(expect.objectContaining({ type: 'keypress', keys: ['alt', 'enter'] }));
  });

  it('dismisses the old window draft when recovery succeeds in a reacquired replacement window', async () => {
    const setup = await modulePromise;
    const first = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    const second = { ...first, id: 78, title: 'ChatGPT - Google Chrome' };
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [first], screen })
      .mockResolvedValueOnce({ windows: [second], screen })
      .mockResolvedValue({ windows: [second], screen });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 31,
      elements: options.query === 'Address and search bar'
        ? [{
            ref: options.window === 78 ? 'omnibox-second' : 'omnibox-first',
            name: 'Address and search bar',
            role: 'Edit',
            automationId: '',
            enabled: true,
            offscreen: false,
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            imageBounds: null,
            imageCenter: null,
          }]
        : [],
    }));
    const exact = 'https://chatgpt.com/c/66666666-6666-4666-8666-666666666666';
    let navigationAttempts = 0;
    mocked.act.mockImplementation(async (actions: Array<{ type: string }>) => {
      if (actions.some((step) => step.type === 'set_value')) {
        navigationAttempts += 1;
        if (navigationAttempts === 1) {
          throw new Error('PARTIAL_BATCH: completed_count=2 failed_index=2 routes=uia+uia. FOCUS_FAILED: requested 77 but foreground is 12');
        }
      }
      return { cursor: null, clipboard: [], completedCount: actions.length, routes: [] };
    });

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 78, restoredPages: false });
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-first', action: 'focus' },
      { type: 'keypress', keys: ['escape'] },
    ], { window: 77 });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('dismisses a staged omnibox URL when recovery cannot safely commit it', async () => {
    const setup = await modulePromise;
    const target = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    mocked.listWindows.mockResolvedValue({ windows: [target], screen: { x: 0, y: 0, width: 1920, height: 1080 } });
    const exact = 'https://chatgpt.com/c/88888888-8888-4888-8888-888888888888';
    mocked.act.mockImplementation(async (actions: Array<{ type: string }>) => {
      if (actions.some((step) => step.type === 'set_value')) {
        throw new Error('PARTIAL_BATCH: completed_count=2 failed_index=2 routes=uia+uia. HELPER_ERROR: Enter dispatch failed');
      }
      return { cursor: null, clipboard: [], completedCount: actions.length, routes: [] };
    });

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, waitForRestoreOffer: false }))
      .rejects.toThrow(/Enter dispatch failed/);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'keypress', keys: ['escape'] },
    ], { window: 77 });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('restores from the blank recovery window when Prime already returned in a separate window', async () => {
    const setup = await modulePromise;
    const blank = { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' as const };
    const prime = { id: 88, app: 'Chrome.setupbrowserprofile.Default', title: 'Prime - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'open' as const };
    mocked.listWindows.mockResolvedValue({
      windows: [blank, prime],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 29,
      elements: options.window === blank.id && options.query === 'Restore pages'
        ? [{ ref: 'restore-notice-blank', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.window === blank.id && options.query === 'Restore'
          ? [{ ref: 'restore-button-blank', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));
    const exact = 'https://chatgpt.com/c/55555555-5555-4555-8555-555555555555';
    const exactConversationOpen = vi.fn(async () => true);

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({
      exactRecoveryUrl: exact,
      exactConversationOpen,
      preferRestoredExact: true,
    })).resolves.toMatchObject({ id: blank.id, restoredPages: true });

    expect(exactConversationOpen).toHaveBeenCalledWith('55555555-5555-4555-8555-555555555555');
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button-blank', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: blank.id });
    const actions = mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>);
    expect(actions).not.toContainEqual(expect.objectContaining({ type: 'set_value', text: exact }));
    expect(actions).not.toContainEqual({ type: 'focus', window: blank.id });
  });

  it('keeps the exact Prime fallback when native Restore UIA is absent and rejects non-exact recovery URLs', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    const exact = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, waitForRestoreOffer: false }))
      .resolves.toMatchObject({ id: 77, restoredPages: false });
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>))
      .toContainEqual({ type: 'set_value', ref: 'omnibox-ref', text: exact });

    mocked.act.mockClear();
    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: 'https://example.com/c/not-prime' }))
      .rejects.toThrow(/not one proven ChatGPT conversation/);
    expect(mocked.act).not.toHaveBeenCalled();
  });

  it('waits for the omnibox, boots Prime once, then restores pages without opening a second Prime tab', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    let addressChecks = 0;
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 30 + addressChecks,
      elements: options.query === 'Address and search bar'
        ? (++addressChecks <= 4 ? [] : [{ ref: 'omnibox-after-restore', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }])
        : options.query === 'Restore pages'
          ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : options.query === 'Restore'
            ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
            : [],
    }));
    const exact = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';

    await expect(setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, exactConversationOpen: async () => true })).resolves.toMatchObject({ restoredPages: true });
    expect(addressChecks).toBe(5);
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>))
      .toContainEqual({ type: 'set_value', ref: 'omnibox-after-restore', text: exact });
    const primeWrites = mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>).filter((step) => step.type === 'set_value' && step.text === exact);
    expect(primeWrites).toHaveLength(1);
  });

  it('leaves native Restore for later when the exact Prime has not checked in yet', async () => {
    vi.useFakeTimers();
    try {
      const setup = await modulePromise;
      mocked.listWindows.mockResolvedValue({
        windows: [
          { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
        window: options.window ?? 77,
        snapshotId: 44,
        elements: options.query === 'Address and search bar'
          ? [{ ref: 'omnibox-ref', name: 'Address and search bar', role: 'Edit', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : options.query === 'Restore pages'
            ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
            : options.query === 'Restore'
              ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
              : [],
      }));
      const exact = 'https://chatgpt.com/c/44444444-4444-4444-8444-444444444444';
      const pending = setup.restoreParadigmEveChromeSessionForRecovery({ exactRecoveryUrl: exact, exactConversationOpen: async () => false });
      await vi.advanceTimersByTimeAsync(10_500);
      await expect(pending).resolves.toMatchObject({ restoredPages: false });
      expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; text?: string }>))
        .toContainEqual({ type: 'set_value', ref: 'omnibox-ref', text: exact });
      expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; ref?: string }>))
        .not.toContainEqual({ type: 'ui_action', ref: 'restore-button', action: 'invoke' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a delayed native Restore pages offer in an already-open recovery window', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    let noticeChecks = 0;
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 9 + noticeChecks,
      elements: options.query === 'Restore pages'
        ? (++noticeChecks < 3
          ? []
          : [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }])
        : options.query === 'Restore'
          ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await expect(setup.restoreParadigmEveChromeSessionForRecovery()).resolves.toMatchObject({ id: 77 });
    expect(noticeChecks).toBe(3);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 77 });
    expect(mocked.act.mock.calls.flatMap((call) => call[0] as Array<{ type: string; keys?: string[] }>))
      .not.toContainEqual(expect.objectContaining({ type: 'keypress', keys: ['ctrl', 'shift', 't'] }));
  });

  it('keeps polling when the Restore pages notice appears before its native Restore button', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [
        { id: 77, app: 'Chrome.setupbrowserprofile.Default', title: 'New Tab - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
      ],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    let buttonChecks = 0;
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 77,
      snapshotId: 20 + buttonChecks,
      elements: options.query === 'Restore pages'
        ? [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
        : options.query === 'Restore'
          ? (++buttonChecks < 3 ? [] : [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }])
          : [],
    }));

    await expect(setup.restoreParadigmEveChromeSessionForRecovery()).resolves.toMatchObject({ id: 77 });
    expect(buttonChecks).toBe(3);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 77 });
  });

  it('launches a closed dedicated Chrome profile, waits for its delayed native restore offer, and sends no ChatGPT URL', async () => {
    const setup = await modulePromise;
    mocked.listWindows
      .mockResolvedValueOnce({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } })
      .mockResolvedValue({
        windows: [
          { id: 88, app: 'Chrome.setupbrowserprofile.Default', title: 'Restored chat - Google Chrome', process: 'chrome', x: 0, y: 0, width: 1200, height: 800, state: 'foreground' },
        ],
        screen: { x: 0, y: 0, width: 1920, height: 1080 },
      });
    let noticeChecks = 0;
    mocked.findUi.mockImplementation(async (options: { window?: number; query?: string }) => ({
      window: options.window ?? 88,
      snapshotId: 30 + noticeChecks,
      elements: options.query === 'Restore pages'
        ? (++noticeChecks < 3
          ? []
          : [{ ref: 'restore-notice', name: "Restore pages? Chrome didn't shut down correctly.", role: 'text', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }])
        : options.query === 'Restore'
          ? [{ ref: 'restore-button', name: 'Restore', role: 'button', automationId: '', enabled: true, offscreen: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, imageBounds: null, imageCenter: null }]
          : [],
    }));

    await expect(setup.restoreParadigmEveChromeSessionForRecovery()).resolves.toMatchObject({ id: 88 });
    expect(noticeChecks).toBe(3);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const args = mocked.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--restore-last-session');
    expect(args).not.toContain('https://chatgpt.com/');
    expect(args.some((arg) => arg.startsWith('https://chatgpt.com/c/'))).toBe(false);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'restore-button', action: 'invoke' },
      { type: 'wait', ms: 750 },
    ], { window: 88 });
  });

  it('fails closed when installed Chrome cannot be found', async () => {
    const setup = await modulePromise;
    chromePath = null;
    await expect(setup.startSetupAssistant(baseOptions)).rejects.toThrow(/Chrome \/ Chromium was not found/);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'error', running: false });
  });

  it('publishes preflight failure, opens no guide or Chrome, and can retry cleanly', async () => {
    const setup = await modulePromise;
    const preflight = vi.fn(async () => { throw new Error('Companion bridge startup failed'); });

    await expect(setup.startSetupAssistant({ ...baseOptions, preflight })).rejects.toThrow('Companion bridge startup failed');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(setup.setupAssistantSnapshot()).toMatchObject({
      stage: 'error',
      running: false,
      error: 'Companion bridge startup failed',
    });

    const retry = setup.startSetupAssistant(baseOptions);
    const retryUrl = await waitForGuideUrl();
    expect((await guideAction(retryUrl, { action: 'stop' })).status).toBe(200);
    await expect(retry).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('owns duplicate Start and Stop while preflight is still pending, then permits retry', async () => {
    const setup = await modulePromise;
    let releasePreflight!: () => void;
    const preflight = vi.fn((_signal: AbortSignal) => {
      return new Promise<void>((resolve) => { releasePreflight = resolve; });
    });
    const pending = setup.startSetupAssistant({ ...baseOptions, preflight });
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(1));

    await expect(setup.startSetupAssistant(baseOptions)).rejects.toThrow(/already running/i);
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'starting', running: true });

    const stopping = setup.stopSetupAssistant();
    expect(preflight.mock.calls[0]?.[0].aborted).toBe(true);
    releasePreflight();
    await stopping;
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'stopped', running: false });

    const retry = setup.startSetupAssistant(baseOptions);
    const retryUrl = await waitForGuideUrl();
    expect((await guideAction(retryUrl, { action: 'stop' })).status).toBe(200);
    await expect(retry).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('closes the guide and Chrome process when Chrome fails during spawn', async () => {
    const setup = await modulePromise;
    mocked.spawn.mockImplementationOnce(() => {
      const process = new FakeChromeProcess();
      chromeProcesses.push(process);
      queueMicrotask(() => process.emit('error', new Error('Chrome launch was rejected')));
      return process;
    });

    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    await expect(pending).rejects.toThrow('Chrome launch was rejected');
    expect(chromeProcesses[0]?.killed).toBe(true);
    expect(setup.setupAssistantSnapshot()).toMatchObject({
      stage: 'error',
      running: false,
      error: 'Chrome launch was rejected',
    });
    await expect(fetch(guideUrl)).rejects.toThrow();
  });

  it('keeps setup alive when a clean Chrome launcher hands off to the already-running dedicated profile', async () => {
    const setup = await modulePromise;
    mocked.listWindows.mockResolvedValue({
      windows: [{
        id: 88,
        app: 'Chrome.setupbrowserprofile.Default',
        processId: 9001,
        title: 'ParadigmEve · Guided setup - Google Chrome',
        process: 'chrome',
        x: 0,
        y: 0,
        width: 1200,
        height: 800,
        state: 'foreground',
      }],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    mocked.spawn.mockImplementationOnce(() => {
      const process = new FakeChromeProcess();
      chromeProcesses.push(process);
      queueMicrotask(() => {
        process.emit('spawn');
        process.exitCode = 0;
        process.emit('exit', 0, null);
      });
      return process;
    });

    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    await vi.waitFor(() => expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'chatgpt-signin', running: true, error: null }));
    expect((await guideAction(guideUrl, { action: 'stop' })).status).toBe(200);
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('keeps the entire provider flow in ordinary Chrome with the dedicated profile', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const [executable, args, options] = mocked.spawn.mock.calls[0] as [string, string[], Record<string, unknown>];

    expect(executable).toBe(chromePath);
    expect(args).toContain(`--user-data-dir=${path.join(userData, 'setup-browser-profile')}`);
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
    expect(args.at(-1)).toBe(guideUrl);
    expect(args.some((arg) => arg.startsWith('--remote-debugging-'))).toBe(false);
    expect(args).not.toContain('--enable-automation');
    expect(args).not.toContain('--no-sandbox');
    expect(args.some((arg) => arg.startsWith('--load-extension='))).toBe(false);
    expect(options).toMatchObject({ stdio: 'ignore', windowsHide: false });

    const guideResponse = await fetch(guideUrl);
    expect(new URL(guideUrl).hostname).toBe('127.0.0.1');
    expect(guideResponse.headers.get('cache-control')).toBe('no-store');
    expect(guideResponse.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = guideResponse.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    const html = await guideResponse.text();
    expect(html).toContain('Keep the conversation. Lose the busywork.');
    expect(html).toContain('typing, dictating or speaking naturally');
    expect(html).toContain('Longer tasks can keep working while this PC is on');
    expect(html).toContain('provider pages remain ordinary Google Chrome / Chromium');
    expect(html).not.toMatch(/Playwright|debugging port/);
    expect(html).toContain('OPEN OPENAI TUNNELS');
    expect(html).toContain('OPEN OPENAI API KEYS');
    expect(html).toContain('class="yes launch" id="openTunnels"');
    expect(html).toContain('class="yes launch" id="openApiKeys"');
    expect(html).toContain('YES — Open ChatGPT Plugins');
    expect(html).toContain('Create MCP App');
    expect(html).toContain('older ChatGPT versions only');
    expect(html).toContain('OPEN DEVELOPER MODE');
    expect(html).toContain('OPEN CREATE CONNECTOR');
    expect(html).toContain('OPEN EXTENSIONS PAGE');
    expect(html).toContain('OPEN FRESH CHATGPT TAB');
    expect(html.indexOf('id="openBrowserExtensions"')).toBeLessThan(html.indexOf('id="openTunnels"'));
    expect(html).toContain('https://chatgpt.com/#settings/Security?section=developer-mode');
    expect(html).toContain('https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins');
    expect(html).toContain('data-paradigmeve-art="goddess-emblem"');
    expect(html.match(/data-guide-step="[1-6]"/g)).toHaveLength(6);
    expect(html).toContain('click steps 1–6 at any time to preview what comes next or revisit an earlier step');
    expect(html).toContain('Future-step controls stay locked until the required earlier actions are complete.');
    expect(html).toContain('Preview only — finish the earlier setup steps before using the controls on this page.');
    expect(html).not.toContain('playwright');

    await expect(completeFlow(pending, guideUrl)).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'complete', running: true, error: null });
  });

  it.each([
    ['edge', edgePath, 'setup-browser-profile-edge', 'Microsoft Edge', 'edge://extensions/'],
    ['brave', bravePath, 'setup-browser-profile-brave', 'Brave Browser', 'brave://extensions/'],
  ] as const)('uses the selected %s family for the dedicated profile, guide and extensions action', async (
    browser,
    executable,
    profileName,
    label,
    extensionsUrl,
  ) => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant({ ...baseOptions, browser });
    const guideUrl = await waitForGuideUrl();
    const [spawnedExecutable, args] = mocked.spawn.mock.calls[0] as [string, string[]];
    expect(spawnedExecutable).toBe(executable);
    expect(args).toContain(`--user-data-dir=${path.join(userData, profileName)}`);
    const html = await fetch(guideUrl).then((response) => response.text());
    expect(html).toContain(`dedicated ParadigmEve ${label} profile`);
    expect(html).toContain(extensionsUrl);

    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });
    // A Settings change after this run starts cannot retarget its owned browser/profile.
    selectedBrowser = browser === 'edge' ? 'brave' : 'edge';
    expect((await guideAction(guideUrl, { action: 'open-extensions' })).status).toBe(200);
    expect(mocked.act).toHaveBeenCalledWith(expect.arrayContaining([
      { type: 'set_value', ref: 'omnibox-ref', text: extensionsUrl },
    ]), { window: 77 });

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('shows explicit 1/2/3 copy-paste instructions for tunnel, API key, one ParadigmEve app and Companion', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());

    expect(html).toContain('1 / 3 · Create Tunnel');
    expect(html).toContain('2 / 3 · Add the details');
    expect(html).toContain('3 / 3 · Copy Tunnel ID');
    expect(html.indexOf('id="openTunnels"')).toBeLessThan(html.indexOf('2 / 3 · Add the details'));
    expect(html.indexOf('id="openApiKeys"')).toBeLessThan(html.indexOf('2 / 3 · Restrict it'));
    expect(html).not.toContain('data-copy="tunnelName"');
    expect(html).toContain('Name it <strong>ParadigmEve</strong>');
    expect(html).toContain('+ Create New Secret Key');
    expect(html).toContain('Choose any relevant or default project.');
    expect(html).toContain('Computer use is part of this same ParadigmEve connection, so there is no second tunnel or API key.');
    expect(html).not.toContain('optional <strong>Computer use</strong> tunnel');
    expect(html).toContain('Copy app name');
    expect(html).toContain('Copy description');
    expect(html).toContain('No authentication');
    expect(html).toContain('select the <strong>ParadigmEve</strong> tunnel');
    expect(html).toContain('Upload the icon');
    expect(html).toContain('Copy icon folder');
    expect(html).toContain(path.dirname(baseOptions.connectorIconPath));
    expect(html).not.toContain(`<div class="copyvalue" id="connectorIconPath">${baseOptions.connectorIconPath}</div>`);
    expect(html).toContain('It enables the custom ParadigmEve app');
    expect(html).toContain('keep the suggested name');
    expect(html).toContain('Allow low risk actions');
    expect(html).toContain('Allow all actions');
    expect(html).toContain('Choose how much autonomy you want');
    expect(html).toContain('commands, file changes, or computer-control actions');
    expect(html).toContain('Tunnels: Read');
    expect(html).toContain('Tunnels: Use');
    expect(html).toContain('chrome://extensions/');
    expect(html).toContain('same dedicated ParadigmEve Google Chrome / Chromium profile');
    expect(html).not.toContain('<h1>ParadigmEve is ready</h1>');
    expect(html).toMatch(/run one .*tool/i);
    expect(html).toContain(extensionPath);
    expect(html).toContain(baseOptions.coreConnectorName);
    expect(html).toContain(baseOptions.coreConnectorDescription);

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('masks tunnel and API credentials by default and explains recording-safe reveal behavior and ownership', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());

    expect(html).toContain('id="tunnelId" type="password" data-secret-label="Tunnel ID"');
    expect(html).toContain('data-secret-toggle="tunnelId" aria-label="Show Tunnel ID"');
    expect(html).toContain('data-copy-input="tunnelId"');
    expect(html).toContain('id="apiKey" type="password" data-secret-label="API key"');
    expect(html).toContain('data-secret-toggle="apiKey" aria-label="Show API key"');
    expect(html).toContain('data-copy-input="apiKey"');
    expect(html).toContain('clears the field after the app securely stores the key');
    expect(html).toContain("await post({action:'api-key',apiKey:input.value});input.value='';unlock(5);show(6)");
    expect(html).toContain('the stored key is never read back into the page');
    expect(html).toContain('Recording or livestreaming?');
    expect(html).toContain('Tunnel ID and API key stay masked by default and re-mask when you change steps.');
    expect(html).toContain('Hide it again before recording, streaming, screen sharing');
    expect(html).toContain('the ParadigmEve app owns encrypted credential storage and local permission enforcement.');
    expect(html).toContain("for(const input of document.querySelectorAll('[data-secret-label]'))input.type='password'");

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('previews a future numbered step without enabling its actions or posting setup state', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: guideUrl });
    try {
      const document = dom.window.document;
      const apiStep = document.querySelector<HTMLButtonElement>('[data-guide-step="4"]')!;
      apiStep.click();

      expect(document.getElementById('phase5')?.classList.contains('active')).toBe(true);
      expect(document.getElementById('phase5')?.classList.contains('preview')).toBe(true);
      expect(document.getElementById('previewNotice')?.hidden).toBe(false);
      expect(document.querySelector<HTMLInputElement>('#apiKey')?.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('#saveApiKey')?.disabled).toBe(true);
      expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'chatgpt-signin', running: true });

      document.querySelector<HTMLButtonElement>('[data-guide-step="1"]')!.click();
      expect(document.getElementById('phase1')?.classList.contains('active')).toBe(true);
      expect(document.getElementById('previewNotice')?.hidden).toBe(true);
    } finally {
      dom.window.close();
    }

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('keeps preview navigation presentation-only and rejects skipped setup authority transitions', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();

    const skippedConnect = await guideAction(guideUrl, { action: 'signed-in' });
    expect(skippedConnect.status).toBe(409);
    expect(await skippedConnect.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect chatgpt/i),
    });

    expect((await guideAction(guideUrl, { action: 'start' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'signed-in' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'companion-done' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'api-key', apiKey: validKey })).status).toBe(200);

    const skippedDeveloperMode = await guideAction(guideUrl, { action: 'core-app-done' });
    expect(skippedDeveloperMode.status).toBe(409);
    expect(await skippedDeveloperMode.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ChatGPT Plugins/),
    });

    expect((await guideAction(guideUrl, { action: 'core-app-start' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'core-app-done' })).status).toBe(200);
    await expect(pending).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
  });

  it('uses a Unicode per-install connector name for the tunnel and ChatGPT app while keeping ParadigmEve product copy', async () => {
    const setup = await modulePromise;
    const options = { ...baseOptions, coreConnectorName: 'Eva Å' };
    const pending = setup.startSetupAssistant(options);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());

    expect(html).toContain('Name it <strong>Eva Å</strong>');
    expect(html).toContain('Add Eva Å to ChatGPT');
    expect(html).toContain('custom Eva Å app');
    expect(html).toContain('select the <strong>Eva Å</strong> tunnel');
    expect(html).toContain('Settings → Plugins → Eva Å → Permissions');
    expect(html).toContain('ParadigmEve Companion');
    expect(html).toContain('dedicated ParadigmEve Google Chrome / Chromium profile');

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('honors the first NO before any provider navigation can be requested', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const stopped = pending.catch((error: unknown) => error);
    const guideUrl = await waitForGuideUrl();
    const spawnArgs = mocked.spawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs.some((arg) => /^https:\/\//.test(arg))).toBe(false);
    expect((await guideAction(guideUrl, { action: 'stop' })).status).toBe(200);
    expect(await stopped).toBeInstanceOf(setup.SetupAssistantStoppedError);
    expect(chromeProcesses[0]?.killed).toBe(true);
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'stopped', running: false });
  });

  it('captures tunnel then key immediately and commits credentials before Core-app creation', async () => {
    const setup = await modulePromise;
    const timeline: string[] = [];
    const onCredentials = vi.fn(async () => { timeline.push('credentials'); });
    const pending = setup.startSetupAssistant({ ...baseOptions, onCredentials });
    const guideUrl = await waitForGuideUrl();

    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });
    await guideAction(guideUrl, { action: 'companion-done' });
    timeline.push('tunnel');
    await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel });
    timeline.push('key');
    await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    timeline.push('core-app');
    await guideAction(guideUrl, { action: 'core-app-start' });

    expect(onCredentials).toHaveBeenCalledWith({ tunnelId: validTunnel, apiKey: validKey });
    expect(timeline).toEqual(['tunnel', 'key', 'credentials', 'core-app']);
    await guideAction(guideUrl, { action: 'core-app-done' });
    await expect(pending).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
  });

  it('keeps a failed credential handoff visible and retryable without advancing the guide', async () => {
    const setup = await modulePromise;
    const onCredentials = vi.fn()
      .mockRejectedValueOnce(new Error('Secure credential storage is temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const pending = setup.startSetupAssistant({ ...baseOptions, onCredentials });
    const guideUrl = await waitForGuideUrl();
    await reachApiKeyStep(guideUrl);

    const failed = await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ ok: false, error: 'Secure credential storage is temporarily unavailable' });
    expect(setup.setupAssistantSnapshot()).toMatchObject({
      stage: 'error',
      running: true,
      error: 'Secure credential storage is temporarily unavailable',
    });
    expect((await guideAction(guideUrl, { action: 'core-app-start' })).status).toBe(409);

    expect((await guideAction(guideUrl, { action: 'api-key', apiKey: validKey })).status).toBe(200);
    expect(onCredentials).toHaveBeenCalledTimes(2);
    expect(setup.setupAssistantSnapshot()).toMatchObject({ stage: 'credentials', running: true, error: null });
    expect((await guideAction(guideUrl, { action: 'core-app-start' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'core-app-done' })).status).toBe(200);
    await expect(pending).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
  });

  it('redacts submitted credentials from a downstream setup failure before status or guide response', async () => {
    const setup = await modulePromise;
    const onCredentials = vi.fn(async () => {
      throw new Error(`failed for ${validTunnel} using ${validKey}`);
    });
    const pending = setup.startSetupAssistant({ ...baseOptions, onCredentials });
    const guideUrl = await waitForGuideUrl();
    await reachApiKeyStep(guideUrl);

    const failed = await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    expect(failed.status).toBe(500);
    const body = JSON.stringify(await failed.json());
    expect(body).not.toContain(validTunnel);
    expect(body).not.toContain(validKey);
    expect(body).toContain('[redacted]');
    const snapshot = JSON.stringify(setup.setupAssistantSnapshot());
    expect(snapshot).not.toContain(validTunnel);
    expect(snapshot).not.toContain(validKey);

    expect((await guideAction(guideUrl, { action: 'stop' })).status).toBe(200);
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('rejects a duplicate guide action while a credential handoff is still running', async () => {
    const setup = await modulePromise;
    let releaseCredentials!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const onCredentials = vi.fn(async () => {
      markStarted();
      await new Promise<void>((resolve) => { releaseCredentials = resolve; });
    });
    const pending = setup.startSetupAssistant({ ...baseOptions, onCredentials });
    const guideUrl = await waitForGuideUrl();
    await reachApiKeyStep(guideUrl);

    const first = guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    await started;
    const duplicate = await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ ok: false, error: expect.stringMatching(/still finishing/i) });
    expect(onCredentials).toHaveBeenCalledTimes(1);

    releaseCredentials();
    expect((await first).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'core-app-start' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'core-app-done' })).status).toBe(200);
    await expect(pending).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
  });

  it('keeps the API key in a loopback POST body and never renders, navigates or logs it', async () => {
    const setup = await modulePromise;
    const secret = `sk-${'Z'.repeat(40)}`;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());
    expect(html).toContain('id="apiKey" type="password"');
    expect(html).toContain("body:JSON.stringify(payload)");
    expect(html).not.toContain(secret);

    await completeFlow(pending, guideUrl, secret);
    expect(setup.setupAssistantSnapshot().detail).not.toContain(secret);
    for (const call of mocked.spawn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
  });

  it('rejects invalid local values without advancing the provider flow', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });
    await guideAction(guideUrl, { action: 'companion-done' });

    const invalidTunnel = await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: 'tunnel_not-valid' });
    expect(invalidTunnel.status).toBe(400);
    expect(await invalidTunnel.json()).toMatchObject({ ok: false });
    const earlyKey = await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    expect(earlyKey.status).toBe(409);

    expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(200);
    const invalidKey = await guideAction(guideUrl, { action: 'api-key', apiKey: 'sk-short' });
    expect(invalidKey.status).toBe(400);

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('requires the per-run loopback origin for guide actions', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    const rejected = await guideAction(guideUrl, { action: 'start' }, { origin: false });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ ok: false });
    expect((await guideAction(guideUrl, { action: 'stop' })).status).toBe(200);
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('escapes copied metadata in the guide and never exposes it as active markup', async () => {
    const setup = await modulePromise;
    const options = {
      coreConnectorName: 'ParadigmEve & Core',
      coreConnectorDescription: 'Files < terminal > "safe"',
      connectorIconPath: 'C:\\Program Files\\ParadigmEve\\resources\\connector\\icon.png',
      companionPresent: () => true,
    };
    const pending = setup.startSetupAssistant(options);
    const guideUrl = await waitForGuideUrl();
    const html = await fetch(guideUrl).then((response) => response.text());
    expect(html).toContain('ParadigmEve &amp; Core');
    expect(html).toContain('Files &lt; terminal &gt; &quot;safe&quot;');
    expect(html).not.toContain('Files < terminal > "safe"');
    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('opens Setup-page provider links only in ordinary Chrome with the dedicated profile', async () => {
    const setup = await modulePromise;
    await setup.openSetupAssistantLink('https://chatgpt.com/');
    await setup.openSetupAssistantLink('https://platform.openai.com/settings/organization/api-keys');
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    const [executable, args] = mocked.spawn.mock.calls[0] as [string, string[]];
    expect(executable).toBe(chromePath);
    expect(args).toContain(`--user-data-dir=${path.join(userData, 'setup-browser-profile')}`);
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
    expect(args).toContain('https://chatgpt.com/');
    expect(args.some((arg) => arg.startsWith('--remote-debugging-'))).toBe(false);
    expect(args).not.toContain('--enable-automation');

    await setup.openSetupAssistantLink('https://chatgpt.com/#settings/Security?section=developer-mode');
    await setup.openSetupAssistantLink('https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins');
    await expect(setup.openSetupAssistantLink('chrome://extensions/')).rejects.toThrow(/Start Guided setup first/i);
    expect(mocked.spawn).toHaveBeenCalledTimes(4);
    await expect(setup.openSetupAssistantLink('https://example.com/')).rejects.toThrow(/not allowed/i);
  });

  it('opens Chrome extensions from the guide in the same dedicated setup profile', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });

    expect((await guideAction(guideUrl, { action: 'open-extensions' })).status).toBe(200);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(mocked.listWindows).toHaveBeenCalledTimes(1);
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'focus', window: 77 },
      { type: 'wait', ms: 100 },
    ], { window: 77 });
    expect(mocked.act).toHaveBeenCalledWith([
      { type: 'ui_action', ref: 'omnibox-ref', action: 'focus' },
      { type: 'set_value', ref: 'omnibox-ref', text: 'chrome://extensions/' },
      { type: 'keypress', keys: ['alt', 'enter'] },
    ], { window: 77 });
    expect(mocked.findUi).toHaveBeenCalledWith({ window: 77, query: 'Address and search bar', role: 'edit', maxResults: 5 });

    await guideAction(guideUrl, { action: 'companion-done' });
    await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel });
    await guideAction(guideUrl, { action: 'api-key', apiKey: validKey });
    await guideAction(guideUrl, { action: 'core-app-start' });
    await guideAction(guideUrl, { action: 'core-app-done' });
    await expect(pending).resolves.toEqual({ tunnelId: validTunnel, apiKey: validKey });
  });

  it('opens Chrome extensions in an already-running dedicated profile after launcher handoff', async () => {
    const setup = await modulePromise;
    const pending = setup.startSetupAssistant(baseOptions);
    const guideUrl = await waitForGuideUrl();
    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });
    mocked.listWindows.mockResolvedValue({
      windows: [{
        id: 91,
        app: 'Chrome.setupbrowserprofile.Default',
        processId: 9002,
        title: 'ChatGPT - Google Chrome',
        process: 'chrome',
        x: 0,
        y: 0,
        width: 1200,
        height: 800,
        state: 'foreground',
      }],
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    expect((await guideAction(guideUrl, { action: 'open-extensions' })).status).toBe(200);
    expect(mocked.act).toHaveBeenCalledWith(expect.any(Array), { window: 91 });

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });

  it('does not treat an installed Companion as complete until it has checked in live', async () => {
    const setup = await modulePromise;
    let present = false;
    const pending = setup.startSetupAssistant({ ...baseOptions, companionPresent: () => present });
    const guideUrl = await waitForGuideUrl();
    await guideAction(guideUrl, { action: 'start' });
    await guideAction(guideUrl, { action: 'signed-in' });

    const missing = await guideAction(guideUrl, { action: 'companion-done' });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/fresh ChatGPT tab/i),
    });
    expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(409);

    present = true;
    expect((await guideAction(guideUrl, { action: 'companion-done' })).status).toBe(200);
    expect((await guideAction(guideUrl, { action: 'tunnel-id', tunnelId: validTunnel })).status).toBe(200);

    await guideAction(guideUrl, { action: 'stop' });
    await expect(pending).rejects.toBeInstanceOf(setup.SetupAssistantStoppedError);
  });
});
