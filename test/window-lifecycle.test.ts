import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  applyLoginStartup,
  isBackgroundLaunch,
  isCompanionBrowserRecoveryLaunch,
  isForcedConnectLaunch,
  supportsLoginStartup,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap,
  shouldOpenCompanionBrowserOnLaunch,
  shouldQuitOnWindowAllClosed
} from '../src/main/window-lifecycle.js';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

describe('native window activation', () => {
  it('enables Electron renderer accessibility after ready and before any BrowserWindow is created', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const ready = source.indexOf('void app.whenReady().then(async () => {');
    const ownershipGuard = source.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const accessibility = source.indexOf('app.setAccessibilitySupportEnabled(true);', ownershipGuard);
    const firstWindow = source.indexOf('createStartupSplash();', accessibility);

    expect(ready).toBeGreaterThan(-1);
    expect(ownershipGuard).toBeGreaterThan(ready);
    expect(accessibility).toBeGreaterThan(ownershipGuard);
    expect(firstWindow).toBeGreaterThan(accessibility);
    expect(source.slice(ownershipGuard, firstWindow)).toContain("process.platform === 'win32' || process.platform === 'darwin'");
  });
  it('uses a presentation-only splash that never delays or outlives the real renderer', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const bootstrap = source.indexOf('void app.whenReady().then(async () => {');
    const theme = source.indexOf('nativeTheme.themeSource = getConfig().ui.theme;', bootstrap);
    const splash = source.indexOf('createStartupSplash();', theme);
    const firstRestoreAfterTheme = source.indexOf('readDurable<GoalObjectivesSnapshot>', theme);
    const create = source.indexOf('function createWindow(): void');
    const ready = source.indexOf("window.once('ready-to-show'", create);
    const close = source.indexOf('closeStartupSplash();', ready);
    const show = source.indexOf('showWindow();', close);
    const splashLoad = source.indexOf('void splash.loadURL(', source.indexOf('function createStartupSplash(): void'));

    expect(splash).toBeGreaterThan(theme);
    expect(splash).toBeLessThan(firstRestoreAfterTheme);
    expect(splashLoad).toBeGreaterThan(-1);
    expect(source.slice(splashLoad - 24, splashLoad)).not.toContain('await');
    expect(close).toBeGreaterThan(ready);
    expect(close).toBeLessThan(show);

    const splashWindow = source.slice(source.indexOf('const splash = new BrowserWindow({'), splashLoad);
    expect(splashWindow).toContain('contextIsolation: true');
    expect(splashWindow).toContain('nodeIntegration: false');
    expect(splashWindow).toContain('sandbox: true');
    expect(splashWindow).toContain('webSecurity: true');
    expect(splashWindow).not.toContain('preload:');
  });

  it('maximizes only on initial presentation and preserves user-sized geometry on reopen', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const present = source.slice(source.indexOf('function showWindow()'), source.indexOf('\nsetFinishNotifier(', source.indexOf('function showWindow()'))).replace('function showWindow(): void', 'function showWindow()');
    const operations: string[] = [];
    const state = { minimized: false };
    const native = { isMinimized: () => state.minimized, isFullScreen: () => false,
      maximize: () => operations.push('maximize'),
      restore: () => operations.push('restore'),
      show: () => operations.push('show'), focus: () => operations.push('focus') };
    const createWindow = vi.fn();
    const context = vm.createContext({ window: native, quitting: false, createWindow });
    vm.runInContext(present + '\nshowWindow();', context);
    expect(operations.splice(0)).toEqual(['show', 'focus']);
    state.minimized = true;
    vm.runInContext('showWindow()', context);
    expect(operations.splice(0)).toEqual(['restore', 'show', 'focus']);
    context.quitting = true;
    vm.runInContext('showWindow()', context);
    expect(operations).toEqual([]);

    let ready!: () => void;
    const startup = source.slice(source.indexOf("  window.once('ready-to-show'"), source.indexOf('  // A renderer that fails', source.indexOf("  window.once('ready-to-show'")));
    const startupOperations: string[] = [];
    const startupState = { fullscreen: false };
    const showWindow = vi.fn(() => startupOperations.push('showWindow'));
    const closeStartupSplash = vi.fn(() => startupOperations.push('closeStartupSplash'));
    const launch = vm.createContext({ window: {
      once: (_event: string, listener: () => void) => { ready = listener; },
      isFullScreen: () => startupState.fullscreen,
      maximize: () => startupOperations.push('maximize')
    }, quitting: false, showWindow, closeStartupSplash });
    vm.runInContext(startup, launch);
    ready();
    expect(startupOperations.splice(0)).toEqual(['closeStartupSplash', 'maximize', 'showWindow']);
    startupState.fullscreen = true;
    ready();
    expect(startupOperations.splice(0)).toEqual(['closeStartupSplash', 'showWindow']);
    launch.quitting = true;
    ready();
    expect(showWindow).toHaveBeenCalledTimes(2);
    expect(closeStartupSplash).toHaveBeenCalledTimes(2);
  });
  it('passively observes on first visible use when there is no saved catalog, never opens a browser tab', async () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const listener = source.slice(source.indexOf("  window.on('show'"), source.indexOf("  window.once('ready-to-show'"));
    let show!: () => void;
    let state = 'ready';
    const start = vi.fn(async () => { state = 'pending'; return {}; });
    const context = vm.createContext({ window: { on: (event: string, callback: () => void) => {
      expect(event).toBe('show'); show = callback;
    } }, quitting: false, getChatModels: () => ({ state }), startChatModelDiscovery: start, logWarn: vi.fn() });
    vm.runInContext(listener, context);
    show(); await Promise.resolve(); expect(start).not.toHaveBeenCalled();
    state = 'unknown';
    show(); await Promise.resolve();
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(false);
    state = 'unavailable';
    show(); await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    state = 'unknown';
    context.quitting = true;
    show();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('never bootstraps shared state from a secondary or already-quitting process', () => {
    expect(ownsAppRuntime(true)).toBe(true);
    expect(ownsAppRuntime(false)).toBe(false);
    expect(shouldBeginAppBootstrap(true, false)).toBe(true);
    expect(shouldBeginAppBootstrap(false, false)).toBe(false);
    expect(shouldBeginAppBootstrap(false, true)).toBe(false);
    expect(shouldBeginAppBootstrap(true, true)).toBe(false);
  });

  it('drops second-instance focus requests until renderer security and IPC startup are ready', () => {
    const show = vi.fn();
    const gate = createWindowActivationGate(show);

    // Electron can emit second-instance after its `ready` event while our async startup is still
    // restoring state. The initial startup path will show a window itself, so this early request
    // must not create one before CSP/permission/IPC setup is complete.
    gate.request();
    expect(show).not.toHaveBeenCalled();

    gate.enable();
    expect(show).not.toHaveBeenCalled();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // `before-quit` closes the gate again while bounded teardown drains. Native activation or a
    // second launch in that window must not resurrect application UI during shutdown.
    gate.disable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);

    // Startup is async. A continuation that resumes after `before-quit` can still execute its
    // old enable() call; shutdown must be a one-way boundary so that stale continuation cannot
    // reactivate Dock/second-instance/tray presentation.
    expect(gate.isDisabled()).toBe(true);
    gate.enable();
    gate.request();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('reopens the app from the macOS Dock activation event', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: vi.fn((event: 'activate', listener: () => void) => listeners.set(event, listener)) };
    const show = vi.fn();
    registerNativeWindowActivation(source, show, 'darwin');

    expect(source.on).toHaveBeenCalledWith('activate', show);
    listeners.get('activate')!();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)('does not add a foreign activation contract on %s', (platform) => {
    const source = { on: vi.fn() };
    registerNativeWindowActivation(source, vi.fn(), platform);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('keeps a macOS app alive after its last window closes, regardless of close-to-tray preference', () => {
    expect(shouldQuitOnWindowAllClosed('darwin', true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed('darwin', false)).toBe(false);
  });

  it.each(['win32', 'linux'] as const)('keeps close-to-tray semantics on %s', (platform) => {
    expect(shouldQuitOnWindowAllClosed(platform, true)).toBe(false);
    expect(shouldQuitOnWindowAllClosed(platform, false)).toBe(true);
  });
});

describe('Windows login startup', () => {
  it('writes only packaged Windows login settings and supports turning the same entry off', () => {
    const app = { isPackaged: true, setLoginItemSettings: vi.fn() };
    applyLoginStartup(app, true, 'win32', 'C:/Program Files/ParadigmEve/ParadigmEve.exe');
    applyLoginStartup(app, false, 'win32', 'C:/Program Files/ParadigmEve/ParadigmEve.exe');
    expect(app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, path: 'C:/Program Files/ParadigmEve/ParadigmEve.exe', args: ['--background'] }],
      [{ openAtLogin: false, path: 'C:/Program Files/ParadigmEve/ParadigmEve.exe', args: ['--background'] }]
    ]);
    for (const platform of ['darwin', 'linux'] as const) applyLoginStartup(app, true, platform);
    app.isPackaged = false;
    applyLoginStartup(app, true, 'win32');
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(supportsLoginStartup('win32', false)).toBe(false);
  });
  it('ignores background second-instance launches while ordinary launches still focus', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.on('second-instance'");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    let received!: (event: unknown, argv: string[]) => void;
    const request = vi.fn();
    const connect = vi.fn();
    const openParadigmEveChromeProfile = vi.fn(async () => undefined);
    const runCompanionBrowserRecovery = vi.fn(() => { void openParadigmEveChromeProfile(); });
    const context = {
      app: { on: (_: string, listener: typeof received) => { received = listener; } },
      windowActivation: { request },
      isBackgroundLaunch,
      isCompanionBrowserRecoveryLaunch,
      isForcedConnectLaunch,
      connect,
      openParadigmEveChromeProfile,
      runCompanionBrowserRecovery,
      logWarn: vi.fn(),
      runtimeReady: false,
      forcedConnectPending: false,
      companionBrowserRecoveryPending: false
    };
    vm.runInNewContext(handler, context);
    received({}, ['app.exe', '--background']);
    expect(request).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    received({}, ['app.exe', '--background', '--connect-on-start']);
    expect(context.forcedConnectPending).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    received({}, ['app.exe', '--background', '--recover-companion-browser']);
    expect(context.companionBrowserRecoveryPending).toBe(true);
    expect(openParadigmEveChromeProfile).not.toHaveBeenCalled();
    context.runtimeReady = true;
    received({}, ['app.exe', '--background', '--connect-on-start', '--recover-companion-browser']);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runCompanionBrowserRecovery).toHaveBeenCalledTimes(1);
    expect(openParadigmEveChromeProfile).toHaveBeenCalledTimes(1);
    received({}, ['app.exe']);
    expect(request).toHaveBeenCalledOnce();
    expect(isBackgroundLaunch(['app.exe', '--background=false'])).toBe(false);
    expect(source).toContain('if (!isBackgroundLaunch(process.argv)) windowActivation.request();');
  });

  it('recognizes the one-shot reconnect flag independently of background launch', () => {
    expect(isForcedConnectLaunch(['app.exe', '--connect-on-start'])).toBe(true);
    expect(isForcedConnectLaunch(['app.exe', '--background', '--connect-on-start'])).toBe(true);
    expect(isForcedConnectLaunch(['app.exe', '--connect-on-start=false'])).toBe(false);
    expect(isBackgroundLaunch(['app.exe', '--connect-on-start'])).toBe(false);
    expect(isCompanionBrowserRecoveryLaunch(['app.exe', '--recover-companion-browser'])).toBe(true);
    expect(isCompanionBrowserRecoveryLaunch(['app.exe', '--background', '--recover-companion-browser'])).toBe(true);
    expect(isCompanionBrowserRecoveryLaunch(['app.exe', '--recover-companion-browser=false'])).toBe(false);
  });

  it('opens the Companion browser by default for foreground launches that need it', () => {
    expect(shouldOpenCompanionBrowserOnLaunch(['app.exe'], true)).toBe(true);
    expect(shouldOpenCompanionBrowserOnLaunch(['app.exe'], false)).toBe(false);
    expect(shouldOpenCompanionBrowserOnLaunch(['app.exe', '--background'], true)).toBe(false);

    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(main).toContain('shouldOpenCompanionBrowserOnLaunch(process.argv, browserExtensionRequired(getConfig()))');
    expect(main).toContain('async function restoreForegroundCompanionBrowser(): Promise<void>');
    expect(main).toContain('openFreshChatWhenEmpty: exactAgent === null');
    expect(main).toContain('if (browserConversationOpen(exactAgent) !== false) return;');
    expect(main).toContain('await openParadigmEveChromeProfile(`https://chatgpt.com/c/${encodeURIComponent(exactAgent)}`);');
    expect(main).toContain('startupBrowserRecovery = restoreForegroundCompanionBrowser().catch((error) =>');
    expect(main).toContain('const exactAgent = currentAgentConversationId();');
    expect(main).toContain('const plan = restartRecoveryPlan;');
    expect(main).toContain('? wakeBrowserUrl(plan.url, true, getConfig().ui.backgroundChats === true, {');
    expect(main).toContain('exactPrime: true,');
    expect(main).toContain('current: () => restartRecoveryPlan === plan && !quitting,');
    expect(main).toContain(': restoreParadigmEveChromeSessionForRecovery()');
    expect(main).toContain('if (companionBrowserRecoveryRunning) return companionBrowserRecoveryRunning;');
    expect(main).toContain('if (companionBrowserRecoveryCompleted) return Promise.resolve();');
    expect(main).toContain('const recoveryConversationId = plan?.exactPrime ? plan.conversationId : null;');
    expect(main.match(/beginCompanionRecoveryAttempt\(/g)).toHaveLength(2);
    expect(main).toContain('beginCompanionRecoveryAttempt(null);');
    expect(main).toContain('beginCompanionRecoveryAttempt(recoveryConversationId);');
    expect(main.match(/beginCompanionRecoveryEvidence\(\);/g)).toHaveLength(1);
    expect(main).toContain('await restoreParadigmEveChromeSessionForRecovery(plan?.exactPrime ? {');
    expect(main).toContain('exactRecoveryUrl: plan.url');
    expect(main).not.toContain('refreshParadigmEveCompanionForRecovery');
    expect(main).toContain('const restarted = await restartParadigmEveChromeForInstallerRecovery();');
    expect(main).toContain('preferRestoredExact: restarted');
    expect(main).toContain('while (!companionRecoveryReady()) {');
    expect(main).not.toContain('refreshParadigmEveCompanionForMaintenance({ ready: companionRecoveryReady })');
    expect(main).toContain('companionBrowserRecoveryCompleted = true;');
    const prepare = main.indexOf('const work = prepareRestartRecovery().then(async (plan) => {');
    const initialFence = main.indexOf('beginCompanionRecoveryAttempt(null);');
    const restart = main.indexOf('const restarted = await restartParadigmEveChromeForInstallerRecovery();');
    const firstFence = main.indexOf('beginCompanionRecoveryAttempt(recoveryConversationId);');
    const evidenceFence = main.indexOf('beginCompanionRecoveryEvidence();');
    const restore = main.indexOf('await restoreParadigmEveChromeSessionForRecovery(plan?.exactPrime ? {');
    const ready = main.indexOf('while (!companionRecoveryReady()) {', restore);
    const completed = main.indexOf('companionBrowserRecoveryCompleted = true;', ready);
    expect(initialFence).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(initialFence);
    expect(firstFence).toBeGreaterThan(prepare);
    expect(restart).toBeGreaterThan(firstFence);
    expect(evidenceFence).toBeGreaterThan(restart);
    expect(restore).toBeGreaterThan(evidenceFence);
    expect(ready).toBeGreaterThan(restore);
    expect(completed).toBeGreaterThan(ready);
    const recoveryBranch = main.indexOf('startupBrowserRecovery = runCompanionBrowserRecovery();');
    const heartbeatAfterRecovery = main.indexOf('startupBrowserRecovery.finally(startReviewHeartbeatMaintenance)');
    expect(recoveryBranch).toBeGreaterThan(-1);
    expect(heartbeatAfterRecovery).toBeGreaterThan(recoveryBranch);
    expect(main).not.toContain('returnParadigmEveChromeToChat');
    expect(main).not.toContain('openParadigmEveChromeProfile(restartRecoveryPlan.url)');
    expect(main).not.toContain('void openParadigmEveChromeProfile().catch((error) =>');
    expect(main).toContain('if (companionBrowserRecoveryRunning === work) companionBrowserRecoveryRunning = null;');
    expect(main).not.toContain("requirePluginRefreshRecovery('core')");
  });

  it('self-reinstall recovery comes back foreground and fences on the current bridge protocol', () => {
    const controller = readFileSync(new URL('../scripts/windows-self-reinstall.ps1', import.meta.url), 'utf8');
    expect(controller).toContain("-ArgumentList @('--connect-on-start', '--recover-companion-browser')");
    expect(controller).not.toContain("-ArgumentList @('--background', '--connect-on-start', '--recover-companion-browser')");
    expect(controller).toContain(`$recovery.bridge -eq ${BRIDGE_PROTOCOL}`);
    expect(controller).toContain("Join-Path $env:TEMP 'ParadigmEve-self-reinstall.lock'");
    expect(controller).toContain('[IO.FileShare]::None');
    expect(controller).toContain('Another ParadigmEve self-reinstall controller is already running');
  });
});
