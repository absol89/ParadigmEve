import { requestSessionFinishGoal, setFinishNotifier } from './session/finish.js';
/**
 * Main process entry: window, tray, and the security posture for the renderer.
 */

import path from 'node:path';
import { app, Notification, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, screen, session } from 'electron';
import { browserExtensionRequired } from '../shared/types.js';
import { getConfig, initConfigPath, loadConfig } from './config.js';
import { connect, disconnect, getStatus, onStatusChange, shutdownConnection } from './connection.js';
import { registerIpc } from './ipc.js';
import { getChatModels, restoreChatModels, startChatModelDiscovery } from './chat-models.js';
import { flushLogBeforeExit, initLogFile, logError, logInfo, logWarn, snapshotLogOnCrash } from './logger.js';
import { unifiedExecManager } from './codex/manager.js';
import { initSecretsPath } from './secrets.js';
import { pluginManager } from './plugins/manager.js';
import { beginCompanionRecoveryAttempt, beginCompanionRecoveryEvidence, browserChatTabOpen, browserConversationOpen, companionRecoveryReady, onCompanionProtocolMismatch, setBrowserOpener, setCompanionBuild, setBrowserWorkArea, shutdownBridge, startBridge, watchRestartRecovery } from './bridge.js';
import { companionBuild, extensionDir } from './extension-path.js';
import {
  findSessionByConversation,
  flushSessions,
  getSession,
  indexedSessions,
  initSessionStore,
  onSessionProjectionCommit,
  pruneSessions,
  readAsset,
  readEvents
} from './session/store.js';
import { ArchiveRuntime } from './archive/archive-runtime.js';
import { enqueueLanPeerKnowledge } from './session/input.js';
import {
  flushRecorder,
  queueDeterministicAttributionRepair,
  setAgentBinder,
  setAgentConversationLookup
} from './session/recorder.js';
import {
  agentConversation,
  bindConversation,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  repairPrimeConversationAfterRecovery,
  restoreRetiredWorkers,
  restoreSwarm,
  selectedBrokerOwnerConversationId,
  snapshotRetiredWorkers,
  snapshotSwarm,
  type RetiredWorkersSnapshot,
  type SwarmSnapshot
} from './agents.js';
import { flushDurable, initDurableStore, readDurable, readDurableStrict, writeDurableNow, writeDurableSoon } from './durable.js';
import {
  AGENT_IDENTITY_STATE,
  currentAgentConversationId,
  restoreAgentIdentity,
  snapshotAgentIdentity
} from './agent-identity.js';
import { restoreRequestCorrelations } from './session/correlation.js';
import { restoreBlockedChats } from './session/blocked-chats.js';
import { stopComputerHelper } from './computer/index.js';
import {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  type GoalObjectivesSnapshot,
  type GoalRepliesSnapshot,
  type GoalSwitchesSnapshot
} from './goal.js';
import {
  CONTINUATIONS_STATE,
  restoreContinuations,
  setContinuationRecoveryHooks,
  type ContinuationSnapshot
} from './session/continuation.js';
import { startSessionRetentionMaintenance } from './session/retention.js';
import { createRequestCheckInOwner } from './request-checkins.js';
import { createRequestTrailCheckInSource, requestTrailSourceTarget } from './request-trail-checkins.js';
import { startScheduleMaintenance } from './schedule-maintenance.js';
import {
  onChatReviewHeartbeatPublicStatus,
  readChatReviewHeartbeatPublicStatus,
  startChatReviewHeartbeatMaintenance,
  type ChatReviewHeartbeatPublicStatus
} from './chat-review-heartbeat.js';
import { configureLanPeerRuntime, publishLanPeerRuntime, stopLanPeerRuntime } from './lan-peer-runtime.js';
import { runShutdownSequence } from './shutdown.js';
import { applyStagedUpdate, startUpdateChecks } from './update.js';
import { UI_BASE_ZOOM, windowLayoutForWorkArea, titleBarOverlayForTheme } from './window-layout.js';
import { initializeDefaultThreads } from './pins.js';
import { initializeExpensesProjects } from './expenses-project.js';
import { syncVaultManualMirror } from './vault-path.js';
import {
  applyLoginStartup,
  isBackgroundLaunch,
  isCompanionBrowserRecoveryLaunch,
  isForcedConnectLaunch,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap,
  shouldOpenCompanionBrowserOnLaunch,
  shouldQuitOnWindowAllClosed
} from './window-lifecycle.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { connectorIconPath } from './connector-assets.js';
import { browserWindowIconPath } from './window-icon.js';
import { editContextMenuTemplate } from './edit-context-menu.js';
import { startupSplashDocument } from './startup-splash.js';
import { openParadigmEveChromeProfile, refreshParadigmEveCompanionForMaintenance, restartParadigmEveChromeForInstallerRecovery, restoreParadigmEveBrowser, restoreParadigmEveChromeSessionForRecovery } from './setup-assistant.js';
import {
  beginRecoveryRun,
  markRecoveryRunClean,
  queuePrimeRestartRecovery,
  restartRecoveryRequested,
  syncRecoveryAgentMemory,
  type RestartRecoveryPlan
} from './session/recovery-memory.js';
import { configureSelfMaintenanceRuntime } from './self-maintenance.js';
import { claimNativeNotification } from './native-notification-dedupe.js';

// Electron derives userData from package/name casing. Pin the Windows spelling deliberately so
// Settings, logs and the default self-maintenance root all use AppData\Roaming\ParadigmEve.
// Windows resolves the previous lowercase spelling to the same directory, so existing data stays
// in place while every path we publish from this process uses the product's canonical casing.
if (process.platform === 'win32') {
  app.setPath('userData', path.join(app.getPath('appData'), 'ParadigmEve'));
}

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */
const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';

let window: BrowserWindow | null = null;
let startupSplash: BrowserWindow | null = null;
let startupSplashEligible = !isBackgroundLaunch(process.argv);
let tray: Tray | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let stopSessionRetention: (() => void) | null = null;
let stopRequestCheckIns: (() => void) | null = null;
let stopScheduleMaintenance: (() => Promise<void>) | null = null;
let stopChatReviewHeartbeat: (() => void) | null = null;
let stopChatReviewHeartbeatStatus: (() => void) | null = null;
let lanHeartbeatStatus: ChatReviewHeartbeatPublicStatus | null = null;
let lastLanPeerLog = '';
let runtimeReady = false;
let forcedConnectPending = isForcedConnectLaunch(process.argv);
let companionBrowserRecoveryPending = isCompanionBrowserRecoveryLaunch(process.argv);
let companionBrowserRecoveryRunning: Promise<void> | null = null;
let companionBrowserRecoveryCompleted = false;
let companionProtocolRepairAttempted = false;
let companionProtocolRepairInFlight: Promise<void> | null = null;
let restartRecoveryPlan: RestartRecoveryPlan | null = null;
let restartRecoveryPreparing: Promise<RestartRecoveryPlan | null> | null = null;
let restartRecoveryPrepared = false;
let archiveRuntime: ArchiveRuntime | null = null;

function repairCompanionProtocolMismatch(actual: number, expected: number): void {
  if (companionProtocolRepairAttempted || companionProtocolRepairInFlight) return;
  companionProtocolRepairAttempted = true;
  logWarn(`Companion protocol ${actual} is stale; refreshing the dedicated Eve Browser extension to protocol ${expected}.`);
  companionProtocolRepairInFlight = refreshParadigmEveCompanionForMaintenance({
    ready: companionRecoveryReady,
    readyTimeoutMs: 20_000,
  })
    .then(() => {
      logInfo('Companion protocol recovery succeeded; the dedicated Eve Browser is now running the current extension generation.');
    })
    .catch((error) => {
      logWarn(`Companion protocol recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      companionProtocolRepairInFlight = null;
    });
}

function prepareRestartRecovery(): Promise<RestartRecoveryPlan | null> {
  if (restartRecoveryPrepared) return Promise.resolve(restartRecoveryPlan);
  if (restartRecoveryPreparing) return restartRecoveryPreparing;
  // The product-level Eve/Eva identity is the only restart authority. Worker broker history may
  // contain many active or parked families and is never allowed to choose a user-facing owner by
  // title, recency or topology. Null means fail closed; Start New Chat owns replacement instead.
  const exactAgent = currentAgentConversationId();
  const requested = exactAgent
    ? queuePrimeRestartRecovery(exactAgent)
    : Promise.resolve(null);
  const work = requested
    .then((plan) => {
      restartRecoveryPlan = plan;
      // A wake its replacement page never admits escalates once to Compact & Resume.
      if (plan) watchRestartRecovery(plan);
      return plan;
    })
    .catch((error) => {
      restartRecoveryPlan = null;
      logWarn(`could not inspect restart recovery state: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
    .finally(() => {
      restartRecoveryPrepared = true;
      if (restartRecoveryPreparing === work) restartRecoveryPreparing = null;
    });
  restartRecoveryPreparing = work;
  return work;
}

function runCompanionBrowserRecovery(): Promise<void> {
  companionBrowserRecoveryPending = false;
  // The reinstall controller may signal the already-running replacement more than once while it
  // waits for `/recovery`. Coalesce simultaneous nudges and, once the Chrome session
  // restore succeeded, ignore later 30-second controller retries for this process. A failed restore
  // deliberately remains retryable.
  if (companionBrowserRecoveryRunning) return companionBrowserRecoveryRunning;
  if (companionBrowserRecoveryCompleted) return Promise.resolve();
  // A late installer signal can reach an already-running process whose previous Companion proof is
  // still fresh. Block `/recovery` synchronously before the async plan lookup can yield back to the
  // controller; the exact plan conversation, when one exists, replaces this generic fence below.
  beginCompanionRecoveryAttempt(null);
  // A late installer signal can reach an already-running ordinary app. Publish the exact recovery
  // input before any browser action in that case too.
  const work = prepareRestartRecovery().then(async (plan) => {
    const recoveryConversationId = plan?.exactPrime ? plan.conversationId : null;
    // Fence `/recovery` before touching Chrome. This matters when a late installer signal reaches
    // an already-running app whose previous Companion census is still inside the liveness window.
    beginCompanionRecoveryAttempt(recoveryConversationId);
    // Reinstall/update can replace the stable unpacked Companion files while Chrome keeps the old
    // MV3 generation alive. Materialize the current package and restart only the dedicated profile
    // before recovery so Chrome itself loads the new extension generation and restores its durable
    // Eve/worker + human tab session. A profile that was already closed needs only the ordinary
    // restore-last-session launch below.
    try {
      const restarted = await restartParadigmEveChromeForInstallerRecovery();
      // Chrome has now either returned from its profile restart or was previously closed. Open a
      // fresh evidence epoch only at this boundary; in-flight pre-restart requests retain the old
      // generation and `/recovery` remained false for the whole restart interval.
      beginCompanionRecoveryEvidence();
      await restoreParadigmEveChromeSessionForRecovery(plan?.exactPrime ? {
        exactRecoveryUrl: plan.url,
        exactConversationOpen: browserConversationOpen,
        preferRestoredExact: restarted,
      } : undefined);
      const deadline = Date.now() + 15_000;
      while (!companionRecoveryReady()) {
        if (Date.now() >= deadline) throw new Error('the current Companion did not report a live recovery document');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      companionBrowserRecoveryCompleted = true;
    } catch (error) {
      logWarn(`could not restore Companion browser profile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }).finally(() => {
    if (companionBrowserRecoveryRunning === work) companionBrowserRecoveryRunning = null;
  });
  companionBrowserRecoveryRunning = work;
  return work;
}

/**
 * Ordinary foreground startup is deliberately restore-first and non-destructive.
 *
 * The durable Eve/Eva identity may name one exact Prime conversation, but it is not permission to
 * replace whichever restored tab Chrome happens to select. Let Chrome restore its full previous
 * session first, then use the Companion's exact chrome.tabs census to decide whether Prime is
 * already present. Only a positive, repeated absence may open the exact Prime URL as one new tab.
 * Unknown census fails closed so a slow restored Prime can never be duplicated by a startup race.
 */
async function restoreForegroundCompanionBrowser(): Promise<void> {
  const exactAgent = currentAgentConversationId();
  await restoreParadigmEveBrowser(browserChatTabOpen, {
    waitForRestoreOffer: true,
    // When an exact durable owner exists, do not create a generic ChatGPT home tab first. If the
    // restored session proves Prime absent below, the one fallback tab should be Prime itself.
    openFreshChatWhenEmpty: exactAgent === null,
  });
  if (!exactAgent) return;

  const deadline = Date.now() + 10_000;
  let observed = browserConversationOpen(exactAgent);
  while (observed === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    observed = browserConversationOpen(exactAgent);
  }
  if (observed !== false) {
    if (observed === null) logWarn(`Prime startup restore left exact conversation ${exactAgent} census unknown; preserving restored tabs without opening a duplicate`);
    return;
  }

  // One more independently timed census closes the native-restore race. A transition to true means
  // Prime appeared after the first absence; a transition back to unknown also fails closed.
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (browserConversationOpen(exactAgent) !== false) return;
  await openParadigmEveChromeProfile(`https://chatgpt.com/c/${encodeURIComponent(exactAgent)}`);
}

// One instance only: two copies would fight over the tunnel and the config file.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a
  // terminal secondary instance immediately, so neither native activation nor the async bootstrap
  // below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
}

function closeStartupSplash(): void {
  const splash = startupSplash;
  startupSplash = null;
  if (splash && !splash.isDestroyed()) splash.destroy();
}

function createStartupSplash(): void {
  if (!startupSplashEligible || quitting || startupSplash) return;
  startupSplashEligible = false;
  const theme = getConfig().ui.theme;
  const splash = new BrowserWindow({
    width: 560,
    height: 360,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: theme === 'dark' ? '#07111f' : '#f4eadc',
    title: 'ParadigmEve',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true
    }
  });
  startupSplash = splash;
  splash.once('ready-to-show', () => {
    if (startupSplash === splash && !quitting && !splash.isDestroyed()) splash.show();
  });
  splash.on('closed', () => {
    if (startupSplash === splash) startupSplash = null;
  });
  // Do not await this decorative load. The real renderer starts independently below and owns
  // readiness; a slow or failed splash can never delay the workspace.
  void splash.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(startupSplashDocument(theme))}`)
    .catch((error) => {
      logWarn(`startup splash failed to load: ${error instanceof Error ? error.message : String(error)}`);
      if (startupSplash === splash) closeStartupSplash();
    });
}

function createWindow(): void {
  const layout = windowLayoutForWorkArea(screen.getPrimaryDisplay().workArea);
  const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
  window = new BrowserWindow({
    ...layout,
    ...(icon ? { icon } : {}),
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: titleBarOverlayForTheme(getConfig().ui.theme)
    } : {}),
    // Painted before the renderer loads, so a dark window never flashes white.
    backgroundColor: getConfig().ui.theme === 'dark' ? '#0e0e11' : '#ffffff',
    title: 'ParadigmEve',
    webPreferences: {
      zoomFactor: UI_BASE_ZOOM,
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The renderer only ever loads our own local files.
      webSecurity: true
    }
  });

  if (process.platform === 'win32') window.removeMenu();

  // First use discovers the account once. A restored catalog is immediately usable;
  // showing the window again may passively observe an existing ChatGPT tab, but it
  // must not open a browser document without a concrete user operation owning it.
  window.on('show', () => {
    if (!quitting && getChatModels().state === 'unknown') void startChatModelDiscovery(false)
      .catch(error => logWarn(`model discovery on window open: ${error.message}`));
  });
  window.once('ready-to-show', () => {
    // A renderer can finish loading after Cmd+Q has already entered bounded teardown. Never let
    // that late native event make the app visible again while `will-quit` is draining.
    if (!quitting) {
      closeStartupSplash();
      // Newly created windows intentionally start maximized. Keep that startup-only presentation
      // here so later tray/Dock/native activation can show an existing user-sized window without
      // overwriting its geometry.
      if (!window?.isFullScreen()) window?.maximize();
      showWindow();
    }
  });

  // A renderer that fails to load leaves a blank window with no other clue, so
  // record it where the diagnostics panel can show it.
  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
    event.preventDefault();
    window?.setFullScreen(!window.isFullScreen());
  });
  window.webContents.on('context-menu', (_event, params) => {
    const owner = window;
    if (!owner || owner.isDestroyed()) return;
    const template = editContextMenuTemplate(params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: owner });
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    closeStartupSplash();
    logError(`window failed to load (${code}): ${description}`);
  });
  // Renderer errors are otherwise invisible from here. Only errors, and only the
  // message text — never anything the page was working with.
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError(`renderer: ${details.message}`);
  });

  // Nothing in this app should ever open a second window or navigate away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });

  // Electron keeps the object after the window is gone, and every member on it throws from
  // then on. Holding that reference made `getWindow()` answer "yes, there is a window" for
  // the rest of the process, so the renderer pushes and the tray's Open both aimed at a
  // corpse. Dropping it is what makes those paths take their existing null branch.
  window.on('closed', () => {
    window = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  // Defense in depth for every current or future native activation source. The explicit gate
  // below additionally protects the long pre-window startup interval, while this invariant makes
  // a direct caller harmless once `before-quit` has started.
  if (quitting) return;
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

setFinishNotifier((title, body, sessionId, turnId) => {
  if (window?.isFocused() || !Notification.isSupported()) return false;
  if (!claimNativeNotification(`finish:${sessionId}:${turnId}`)) return true;
  const write = (): void => {
    showWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  };
  const notice = new Notification({ title, body, actions: [
    { type: 'button', text: 'Send Automatic Goal' }, { type: 'button', text: 'Write Directly' }
  ] });
  notice.on('click', write);
  notice.on('action', (details) => {
    if (details.actionIndex === 0) void requestSessionFinishGoal(sessionId, turnId).catch(error => logWarn(`Finish goal: ${error.message}`));
    else if (details.actionIndex === 1) write();
  });
  notice.show();
  return true;
});
setBrowserWorkArea(() => screen.getPrimaryDisplay().workArea);

// Electron promises `second-instance` only after its own `ready`, not after our async startup.
// Until CSP/permission handlers and IPC are installed below, a re-launch is only a focus request
// for the initial window that startup is already going to show, so do not construct one early.
const windowActivation = createWindowActivationGate(showWindow);

/** Build the native tray image from encoded PNGs, never platform-dependent bitmap bytes. */
function trayIcon(running: boolean): Electron.NativeImage {
  // Windows tray icons are the product's most persistent visual identity. Use the same approved
  // approved icon the user uploads for the ChatGPT connector instead of reducing ParadigmEve to
  // the old generic green/grey status dot. Connection state still appears in the tooltip and
  // first tray-menu row, so branding does not need to carry two jobs at 16 logical pixels.
  if (process.platform === 'win32') {
    const brandedPath = connectorIconPath();
    if (brandedPath) {
      const source = nativeImage.createFromPath(brandedPath);
      if (!source.isEmpty()) {
        const image = source.resize({ width: 16, height: 16, quality: 'best' });
        const highDpi = source.resize({ width: 32, height: 32, quality: 'best' });
        image.addRepresentation({
          scaleFactor: 2,
          dataURL: `data:image/png;base64,${highDpi.toPNG().toString('base64')}`
        });
        return image;
      }
    }
  }

  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({
      scaleFactor: representation.scaleFactor,
      dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
    });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  // Offline keeps the running icon: the bridge is up, the internet is not.
  const running = connected || offline;
  const label = connected ? 'Connected' : offline ? 'No internet' : 'Not connected';
  tray.setImage(trayIcon(running));
  tray.setToolTip(`ParadigmEve — ${label.toLowerCase()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: windowActivation.request },
      {
        label: running ? 'Disconnect' : 'Connect',
        click: () => void (running ? disconnect() : connect())
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.on('second-instance', (_event, argv) => {
  if (isForcedConnectLaunch(argv)) {
    forcedConnectPending = true;
    if (runtimeReady) void connect();
  }
  if (isCompanionBrowserRecoveryLaunch(argv)) {
    companionBrowserRecoveryPending = true;
    if (runtimeReady) runCompanionBrowserRecovery();
  }
  if (!isBackgroundLaunch(argv)) windowActivation.request();
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a
  // primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  // Electron leaves Chromium renderer accessibility disabled until an assistive client asks for
  // it. ParadigmEve's own Computer Use is one such client, so enable the native/webContents tree
  // before either the splash or main BrowserWindow can exist. Keep unsupported Linux unchanged.
  if (process.platform === 'win32' || process.platform === 'darwin') app.setAccessibilitySupportEnabled(true);
  const userData = app.getPath('userData');
  const installationDirectory = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  configureSelfMaintenanceRuntime({
    setLoginStartup: (enabled) => applyLoginStartup(app, enabled),
    appDataPath: userData,
    installationPath: installationDirectory
  });
  initLogFile(path.join(userData, 'app.log'));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    snapshotLogOnCrash(`${origin}: ${error.stack ?? error.message}`);
  });
  process.on('exit', (code) => {
    if (code !== 0) snapshotLogOnCrash('main process exit code ' + code);
  });
  app.on('render-process-gone', (_event, _contents, details) => {
    const message = 'renderer process gone reason=' + details.reason + ' exitCode=' + details.exitCode;
    logError(message);
    snapshotLogOnCrash(message);
  });
  initConfigPath(userData);
  initSecretsPath(userData);
  initSessionStore(userData);
  archiveRuntime = new ArchiveRuntime({
    archiveRoot: path.join(userData, 'archive'),
    writerVersion: app.getVersion(),
    source: {
      listSessionIds: async () => (await indexedSessions()).map((summary) => summary.id),
      readSession: async (sessionId) => {
        const summary = await getSession(sessionId);
        if (!summary) return null;
        return { summary, events: await readEvents(sessionId) };
      },
      readAsset: async (sessionId, assetId) => await readAsset(sessionId, assetId),
      subscribeCommitted: onSessionProjectionCommit
    },
    onError: (error) => logWarn(`archive projection: ${error.message}`),
    onDiagnostic: (message) => logInfo(`archive diagnostic: ${message}`)
  });
  // Archive is a rebuildable projection of the canonical session store. Start it without making
  // app readiness wait on a large historical scan; subscribe-before-seed inside ArchiveRuntime
  // closes the race with any durable session commits that happen during bootstrap.
  void archiveRuntime.start().then(async () => {
    await archiveRuntime?.drain();
    await archiveRuntime?.rebuildDerived();
  }).catch((error) => logWarn(`could not initialize local chat archive: ${error instanceof Error ? error.message : String(error)}`));
  initDurableStore(userData);
  try { await syncVaultManualMirror(userData); }
  catch (error) { logWarn(`could not synchronize AppData Vault manual: ${error instanceof Error ? error.message : String(error)}`); }
  try { await initializeDefaultThreads(); }
  catch (error) { logWarn(`could not initialize default Threads: ${error instanceof Error ? error.message : String(error)}`); }
  let previousRunUnclean = false;
  try { previousRunUnclean = await beginRecoveryRun(userData); }
  catch (error) { logWarn(`could not mark recovery process lifetime: ${error instanceof Error ? error.message : String(error)}`); }
  await restoreChatModels();
  if (windowActivation.isDisabled()) return;
  await loadConfig();
  try { await initializeExpensesProjects(); }
  catch (error) { logWarn(`could not initialize Expenses projects: ${error instanceof Error ? error.message : String(error)}`); }
  await pluginManager.initialize(userData);
  if (windowActivation.isDisabled()) return;
  try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
  catch (error) { logWarn(`Windows login startup: ${error instanceof Error ? error.message : String(error)}`); }
  // The renderer has its own explicit light/dark palette, so native chrome must follow the same
  // user choice instead of Electron's default `system` theme. On macOS this controls the window
  // frame, application menus and OS dialogs; on Linux/Windows it covers Electron-native UI.
  nativeTheme.themeSource = getConfig().ui.theme;
  // Give foreground launches immediate visual continuity while the remaining durable state is
  // restored. This presentation has no preload or app authority and its load is intentionally not
  // awaited, so bootstrap and the real renderer continue at their existing pace.
  createStartupSplash();
  const savedGoalObjectives = await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalObjectives(savedGoalObjectives);
  const savedGoalSwitches = await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalSwitches(savedGoalSwitches);
  const savedGoalReplies = await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalReplies(savedGoalReplies);
  // Request ownership must exist before either side of the bridge can race in. A request id
  // that was proved yesterday remains the same workflow today even if its ChatGPT tab closed.
  await restoreRequestCorrelations();
  if (windowActivation.isDisabled()) return;
  // And the user's blocks, for the same reason: a chat blocked yesterday is still the rogue
  // turn today, and a block that loads after the first call is a tool the turn already got.
  await restoreBlockedChats();
  if (windowActivation.isDisabled()) return;
  setAgentConversationLookup(agentConversation);
  // The prime's chat is the user's own, so no extension report can name it. It is bound
  // when the recorder manages to place the prime's first call. See recordToolCall.
  setAgentBinder(bindConversation);
  // Before anything can call an agent tool, and before a run is restored: the broker
  // decides whether a previous run has been abandoned partly from which ChatGPT tabs are
  // open, and without this it can only answer "I cannot see" — which it treats, on
  // purpose, as a reason to leave the existing run alone.
  // How a fresh chat opens when no browser page can be asked to place it. The app uses the
  // selected dedicated Eve Browser profile, so app-owned work cannot spill into a normal profile.
  // Wired before any restored command is delivered, so a resume queued yesterday opens as soon
  // as the bridge starts rather than waiting for the user to visit ChatGPT.
  //
  // It is deliberately not how a page-driven Compact & Resume opens chat B. That placement
  // belongs to the browser page that owns source chat A; see bridge.ts::offerPlacement.
  setBrowserOpener(async (url) => {
    await openParadigmEveChromeProfile(url);
  });

  // Persistence is a process-lifetime dependency of the broker, not a feature-toggle
  // dependency. Multi-agent can be enabled from Settings without restarting the process;
  // keeping both sinks wired from startup guarantees the first spawn can cross its durable
  // acceptance barrier even when this launch began with multi-agent disabled.
  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));

  // A multi-agent run outlives this process. Restoring it before the bridge starts
  // means a worker that never joined gets its chat re-requested through the same queue
  // as a fresh one, rather than being stranded with a key nobody has.
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  const retiredWorkers = await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE);
  if (windowActivation.isDisabled()) return;
  restoreRetiredWorkers(retiredWorkers);
  const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE);
  if (windowActivation.isDisabled()) return;
  restoreSwarm(savedSwarm);
  let savedAgentIdentity: unknown = null;
  let agentIdentityReadable = true;
  try {
    savedAgentIdentity = await readDurableStrict<unknown>(AGENT_IDENTITY_STATE);
  } catch (error) {
    // Corruption is not absence. Fail closed instead of treating an unreadable identity file as
    // permission to re-adopt whichever historical broker owner happens to be available today.
    agentIdentityReadable = false;
    logWarn(`could not restore agent identity safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (windowActivation.isDisabled()) return;
  const identityRestore = restoreAgentIdentity(
    agentIdentityReadable ? savedAgentIdentity : { version: 1, conversationId: null, unreadable: true },
    selectedBrokerOwnerConversationId()
  );
  if (identityRestore.persist) await writeDurableNow(AGENT_IDENTITY_STATE, snapshotAgentIdentity());
  if (identityRestore.migrated) {
    logInfo(`agent identity: migrated exact legacy owner ${currentAgentConversationId()}`);
  }
  if (!getConfig().multiAgent.enabled) {
    // A feature toggle is a pause, not Clear swarm. Canonicalize any active incarnation left by
    // a crash into stopped prime-owned history before the bridge exists, then make that safer
    // projection durable. Re-enabling later in this process or after another restart recovers the
    // same exact worker conversations without letting disabled workers consume execution slots.
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
    if (windowActivation.isDisabled()) return;
  }
  // Continuation recovery is after swarm restore because an interrupted durable rebind may
  // have to finish publishing the prime transfer that was frozen in that snapshot.
  setContinuationRecoveryHooks({
    repairPrimeTransfer: repairPrimeConversationAfterRecovery
  });
  const savedContinuations = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
  if (windowActivation.isDisabled()) return;
  await restoreContinuations(savedContinuations);
  if (windowActivation.isDisabled()) return;

  // Strict CSP for our own page. There is no remote content and no inline script.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // From here on a second launch may safely focus/recreate the window: renderer security policy
  // is installed and the renderer's fixed IPC methods already have handlers before it can load.
  // The same quit the tray's Quit performs. It has to go through `quitting` for the window's
  // close-to-tray handler to let go: without it, quitting to install would hide the window and
  // leave the app running, which is exactly the trap the Install button exists to end.
  registerIpc(
    () => window,
    () => {
      quitting = true;
      app.quit();
    },
    archiveRuntime
  );
  try { await syncRecoveryAgentMemory(userData); }
  catch (error) { logWarn(`could not write recovery agent memory: ${error instanceof Error ? error.message : String(error)}`); }
  // This is the publication boundary for restart recovery: only reboot/login, reinstall/update or
  // an unclean prior process may commit recovery text. Ordinary foreground launches do not. The
  // exact durable outbox entry lands before startup is allowed to open/focus any browser surface.
  // There is deliberately no automatic Stop here; persisted activeTurnId alone cannot authorize one.
  if (restartRecoveryRequested(process.argv, previousRunUnclean)) await prepareRestartRecovery();
  windowActivation.enable();
  if (!isBackgroundLaunch(process.argv)) windowActivation.request();
  // macOS `activate` can fire on first launch, so do not wire it at module load where it could
  // create a BrowserWindow before Electron is ready. Once the initial window path is established,
  // Dock activation/re-launch can safely recreate or focus it.
  registerNativeWindowActivation(app, windowActivation.request);

  tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
  tray.on('click', windowActivation.request);
  refreshTray();
  onStatusChange(refreshTray);

  logInfo('app started');

  // The packaged unpacked extension may be current on disk while Chrome still executes an older
  // MV3 service-worker generation. Keep protocol enforcement fail-closed, then repair only the
  // dedicated Eve Browser profile through the existing Companion maintenance owner.
  onCompanionProtocolMismatch(repairCompanionProtocolMismatch);

  // Chrome loads the Companion from the materialized folder. Refresh it before the bridge answers
  // /hello and before any startup path below launches the Companion profile: on 2026-09-26 an
  // unclean-restart launch started Chrome one second before the lazy refresh, so the new build's
  // page code never ran. /status then names this build so a still-running older one reloads
  // once nothing is busy.
  setCompanionBuild(companionBuild(extensionDir()));

  // Historical Unattributed repair may legitimately scan and rewrite a large legacy bucket.
  // It is maintenance, not a prerequisite for showing the app or accepting new exact-id
  // traffic, so never make startup/reload wait behind years of old session history.
  queueDeterministicAttributionRepair();

  // The bridge serves recording and multi-agent mode both: recording needs the
  // Recording and multi-agent both need the Companion, and stateful Computer use needs exact
  // browser-chat identity for indexed/coordinate input. Keep this identical to the settings-save
  // rule in ipc.ts by sharing the predicate instead of duplicating feature checks.
  if (browserExtensionRequired(getConfig())) {
    void startBridge();
  }
  // Retention governs recordings already stored on disk, independent of whether recording is
  // currently enabled. The tray app can stay alive for days, so run once now and keep a coarse
  // maintenance timer rather than making expiry depend on the next process restart.
  stopSessionRetention = startSessionRetentionMaintenance({
    retainDays: () => getConfig().sessions.retainDays,
    prune: pruneSessions,
    onRemoved: (removed) => logInfo(`removed ${removed} session(s) past the retention window`),
    onError: (err) => logError(`session pruning failed: ${err.message}`)
  });
  if (Notification.isSupported()) {
    const requestCheckInSource = createRequestTrailCheckInSource({
      onError: error => logWarn(`request check-in source: ${error.message}`)
    });
    const requestCheckIns = createRequestCheckInOwner({
      source: requestCheckInSource,
      notify: notification => {
        if (!claimNativeNotification(
          `request:${notification.kind}:${notification.links.originalRequest}:${notification.links.currentState}`
        )) return;
        const notice = new Notification({ title: notification.title, body: notification.body });
        notice.on('click', () => {
          showWindow();
          const source = requestTrailSourceTarget(notification.links.originalRequest);
          if (!source || !window) return;
          const target = window.webContents;
          const open = (): void => { if (!target.isDestroyed()) target.send('session:write', source.sessionId, source.eventSeq); };
          if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
        });
        notice.show();
      }
    });
    requestCheckIns.start();
    stopRequestCheckIns = () => requestCheckIns.stop();
    logInfo('request check-in notifications started from the durable Request Trail');
  } else {
    // Leave Request Trail claims untouched so a later supported runtime can recover the missed
    // meaningful event instead of recording delivery that could never have happened.
    logWarn('request check-in notifications are unavailable on this platform');
  }
  stopScheduleMaintenance = startScheduleMaintenance({
    onRun: (result) => {
      if (result.admitted.length) logInfo(`schedule maintenance admitted ${result.admitted.length} due occurrence(s)`);
      for (const failure of result.failed) logWarn(`schedule maintenance could not admit ${failure.occurrenceId}: ${failure.error}`);
    },
    onError: (error) => logWarn(`schedule maintenance failed: ${error.message}`)
  });
  try {
    lanHeartbeatStatus = await readChatReviewHeartbeatPublicStatus();
  } catch (error) {
    // Heartbeat-state corruption must not broaden LAN data or prevent app startup. The heartbeat
    // owner will report/repair its own state; presence stays at the safe never-run projection.
    lanHeartbeatStatus = null;
    logWarn(`LAN heartbeat status is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  stopChatReviewHeartbeatStatus = onChatReviewHeartbeatPublicStatus((status) => {
    lanHeartbeatStatus = status;
    publishLanPeerRuntime();
  });
  const lanRunning = await configureLanPeerRuntime({
    heartbeatState: () => lanHeartbeatStatus,
    onMessage: async (message) => {
      // A LAN peer can contribute authenticated knowledge to this installation's one human-facing
      // Eve/Eva conversation, but never gains remote execution authority. The queued wrapper in
      // session/input.ts makes that boundary explicit to the model before any authored peer text.
      const conversationId = currentAgentConversationId();
      if (!conversationId) throw new Error('LAN peer knowledge has no exact installation-agent conversation');
      const target = await findSessionByConversation(conversationId, { requireUnique: true });
      if (!target) throw new Error('LAN peer knowledge has no recorded installation-agent session');
      await enqueueLanPeerKnowledge(target.id, message);
      logInfo(`LAN peer knowledge accepted from ${message.nickname}`);
    },
    onPeers: (peers) => {
      // Presence logging is intentionally limited to the same public allowlist as the LAN wire.
      // No source IP, conversation/session identity, Plan text, paths or authored summary enters it.
      const signature = peers.map((peer) =>
        `${peer.nickname}|${peer.protocol}|${peer.appVersion}|${peer.workerCapacity}|${peer.online ? 'online' : 'offline'}|${peer.heartbeat.result}`
      ).join(',');
      if (signature === lastLanPeerLog) return;
      lastLanPeerLog = signature;
      logInfo(signature ? `LAN peers: ${signature}` : 'LAN peers: none');
    },
    onError: (error) => logWarn(`LAN discovery: ${error.message}`)
  });
  if (lanRunning) logInfo(`LAN discovery enabled for ${getConfig().mcp.connectorName}`);
  else if (getConfig().lan.enabled) logWarn('LAN discovery is enabled but no valid secure LAN group key is available; no socket was opened');
  let lastChatReviewHeartbeatStatus = '';
  const startReviewHeartbeatMaintenance = () => {
    if (stopChatReviewHeartbeat) return;
    logInfo('chat review heartbeat maintenance started; semantic cadence is 22 minutes');
    stopChatReviewHeartbeat = startChatReviewHeartbeatMaintenance({
      onQueued: (result) => logInfo(`chat review heartbeat queued for ${result.conversationId ?? result.sessionId ?? 'Eve'}`),
      onResult: (result) => {
        const status = `${result.status}:${result.reason ?? ''}`;
        if (status === lastChatReviewHeartbeatStatus) return;
        const previous = lastChatReviewHeartbeatStatus;
        lastChatReviewHeartbeatStatus = status;
        if (result.status === 'no-coordinator') {
          const reason = result.reason === 'debt-owner-unavailable'
            ? 'the durable review owner is not currently available'
            : result.reason === 'no-successor'
              ? 'the prior review owner retired and no exact successor is currently available'
              : 'no exact Eve/Eva coordinator is currently available';
          if (result.reason === 'no-fresh-coordinator') {
            logWarn(`chat review heartbeat paused: ${reason}; review state was not advanced`);
          } else if (result.staleIdentity) {
            // The heartbeat never guesses a chat. When the saved identity is what it cannot use,
            // say so plainly: that is the one thing a person can repair.
            logWarn(
              `chat review heartbeat waiting: ${reason}; the saved Eve/Eva identity names chat ${result.staleIdentity}, ` +
                'whose session is closed (no open tab) or is not an ordinary chat. If Eve now works in another chat, ' +
                'point the identity there. Durable review state was preserved'
            );
          } else {
            logInfo(`chat review heartbeat waiting: ${reason}; durable review state was preserved`);
          }
        } else if (previous.startsWith('no-coordinator:')) {
          logInfo(`chat review heartbeat resumed with status ${result.status}`);
        }
      },
      onError: (error) => logWarn(`chat review heartbeat could not run: ${error.message}`)
    });
  };

  runtimeReady = true;
  if (getConfig().ui.autoConnect || forcedConnectPending) {
    forcedConnectPending = false;
    void connect();
  }
  let startupBrowserRecovery: Promise<unknown> | null = null;
  if (companionBrowserRecoveryPending) {
    startupBrowserRecovery = runCompanionBrowserRecovery();
  } else if (restartRecoveryRequested(process.argv, previousRunUnclean)) {
    // Always preserve Chrome's own previous session on an explicit/crash recovery launch. Only an
    // exact Prime proven by restored swarm + local session authority gets an immediate URL tab;
    // ambiguous ownership still restores the session but never guesses a coordinator.
    startupBrowserRecovery = restoreParadigmEveChromeSessionForRecovery(
      restartRecoveryPlan?.exactPrime ? {
        exactRecoveryUrl: restartRecoveryPlan.url,
        exactConversationOpen: browserConversationOpen,
      } : undefined
    ).catch((error) =>
      logWarn(`could not restore Chrome session for restart recovery: ${error instanceof Error ? error.message : String(error)}`)
    );
  } else if (shouldOpenCompanionBrowserOnLaunch(process.argv, browserExtensionRequired(getConfig()))) {
    // Ordinary foreground restart is restore-first too. If durable Eve/Eva identity exists, the
    // exact Prime is opened only after the restored Companion twice proves it absent; existing
    // human/worker tabs are never repurposed and an unknown census never creates a duplicate.
    startupBrowserRecovery = restoreForegroundCompanionBrowser().catch((error) =>
      logWarn(`could not open Companion browser profile on startup: ${error instanceof Error ? error.message : String(error)}`)
    );
  }
  // The heartbeat's first tick must observe post-recovery session/identity state. Starting it before
  // installer/crash restoration is exactly how a healthy Eva was reported as coordinator-less while
  // her Companion browser was still being restarted.
  if (startupBrowserRecovery) void startupBrowserRecovery.finally(startReviewHeartbeatMaintenance);
  else startReviewHeartbeatMaintenance();

  // Never awaited: an unreachable GitHub, a slow download or a broken release must not delay a
  // window that is already on screen. Everything it learns arrives through the ordinary state
  // push, every failure ends inside it, and its own timer keeps it running for a tray app that
  // is never restarted.
  startUpdateChecks();
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  // From this point `will-quit` owns a bounded teardown. A Dock click/relaunch arriving while
  // that sequence drains must not recreate or reveal a window after the tray has disappeared.
  windowActivation.disable();
  closeStartupSplash();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // macOS convention: closing the last window is not quitting the application. The Dock/menu
  // bar stay alive and `activate` recreates it. Windows/Linux retain the explicit close-to-tray
  // preference; Cmd+Q / app.quit bypasses this event and still enters the shutdown sequence.
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be
  // allowed to exit normally: preventing that quit and flushing/stopping the primary's shared
  // stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopSessionRetention?.();
  stopSessionRetention = null;
  stopRequestCheckIns?.();
  stopRequestCheckIns = null;
  const scheduleMaintenanceDrain = stopScheduleMaintenance?.() ?? Promise.resolve();
  stopScheduleMaintenance = null;
  stopChatReviewHeartbeat?.();
  stopChatReviewHeartbeat = null;
  stopChatReviewHeartbeatStatus?.();
  stopChatReviewHeartbeatStatus = null;
  stopLanPeerRuntime();
  tray?.destroy();
  tray = null;

  void runShutdownSequence(
    [
      // Phase 1: stop both listeners from admitting work and let accepted requests drain.
      // The budget has to clear the drains it contains, or it would silently defeat them:
      // the bridge force-closes wedged localhost sockets at 15s and the MCP endpoint forces
      // its own drain at 30s. This is the outer bound on both, not a competing one.
      { name: 'admission/drain', budgetMs: 40_000, run: () => [scheduleMaintenanceDrain, shutdownConnection(), shutdownBridge()] },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopComputerHelper(), pluginManager.close()]
      },
      // Phase 3: recorder work can enqueue both session projections and named durable state.
      { name: 'recorder flush', budgetMs: 10_000, run: () => [flushRecorder()] },
      // These are independent writers. One rejection must never skip the other flush.
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushSessions(), flushDurable()] },
      // Archive is a read-only projection. Finalize it only after canonical session writers are
      // durable, then publish the static recovery view from that exact settled projection.
      {
        name: 'archive projection',
        budgetMs: 15_000,
        run: () => [archiveRuntime ? (async () => {
          await archiveRuntime!.drain();
          await archiveRuntime!.rebuildDerived();
          await archiveRuntime!.dispose();
        })() : Promise.resolve()]
      },
      // After local writers are durable, hand any staged update to the platform installer. The
      // recovery marker stays set through this handoff so a process killed here is recoverable.
      // Nothing is staged unless it downloaded whole and matched the release's published SHA-256;
      // applying it cannot fail loudly - see update.ts.
      { name: 'update handoff', budgetMs: 5_000, run: () => [applyStagedUpdate()] },
      // Clear crash evidence only after every normal teardown phase has at least reached its
      // bounded completion point. A process killed during update/reinstall handoff leaves the
      // marker behind so the replacement launch still enters exact recovery.
      { name: 'recovery marker', budgetMs: 2_000, run: () => [markRecoveryRunClean()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the
      // continuation that ends this sequence is dropped by Electron, and the app is left
      // running with nothing to click and the single-instance lock still held.
      exit: () => {
        // The sequence has just logged its completion; a phase inside it would flush too early.
        void flushLogBeforeExit().finally(() => {
          shutdownComplete = true;
          app.exit(0);
        });
      }
    }
  );
});

// Belt and braces: no web contents anywhere in this app may open a window or
// navigate. External links go through the vetted allowlist in ipc.ts instead.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});
