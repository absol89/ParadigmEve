import { ui, uiText, t, initLanguage } from './i18n.js';
import { paintPluginRefreshReminder } from './plugin-refresh-reminder.js';
import { initUsage, refreshUsage } from './usage.js';
import { initSidebarResize } from './sidebar-resize.js';
import { initPlugins, applyPluginsState } from './plugins.js';
import { initPet } from './pet.js';
import { initPets } from './pets.js';
import { initBrowserPreferences } from './browser-preferences.js';
/**
 * Renderer. No Node, no filesystem, no network — everything goes through window.api.
 *
 * The DOM skeleton lives in index.html; this fills it in and never rebuilds a control
 * the user might be typing into. The permission rows are the one exception: they are
 * generated from CAPABILITIES so a new capability appears without touching markup.
 *
 * Two rules the layout depends on. The window is a fixed frame, so nothing here may
 * change the height of anything outside its own scroll pane — that is why only one
 * permission group is expanded at a time. And the two live numbers tick locally every
 * second, so "verified 8s ago" keeps counting between the 15s reports from the main
 * process instead of freezing at a number that is quietly going stale.
 */

import type { AppApi, SettingsPatch } from '../preload/index.js';
import { requiresApprovedFilesystemRoot } from '../shared/capabilities.js';
import { BUILD_FLAVOR } from '../shared/build-flavor.js';
import {
  AGENT_BACKEND_IDS,
  AGENT_BACKEND_LABELS,
  DEFAULT_AGENT_EXECUTION_SETTINGS,
  agentBackendAvailableInBuild,
  agentBackendsForBuild,
  type AgentBackendId
} from '../shared/agent-backends.js';
import type { AppState, Capability, ChatBrowser, LogEntry, SurfaceStatus } from '../shared/types.js';
import { chatBrowserFamily } from '../shared/chat-browser.js';
import {
  browserExtensionRequired,
  CHAT_BROWSERS,
  isNewer,
  DEFAULT_CORE_CONNECTOR_NAME,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  capabilityTools,
  DESKTOP_CAPABILITIES,
  WRITE_CAPABILITIES
} from '../shared/types.js';
import type { SwarmState } from '../shared/session.js';
import type { SetupAssistantSnapshot } from '../main/setup-assistant.js';
import { $, ago, el, icon, run, shortAgo, toast } from './dom.js';
import { chatApply, chatSettingsPatch, chatVisible, initChat, openChatView } from './chat.js';
import { initWorkspaceLibrary, refreshPinsSurface, refreshPlansSurface } from './workspace-library.js';
import { initWorkspaceNavigation, navigateWorkspace, onWorkspaceNavigation } from './workspace-navigation.js';
import { initScheduleWorkspace } from './schedule-workspace.js';
import { archiveWorkspaceLabel, initArchiveSurface, refreshArchiveSurface } from './archive-surface.js';
import { applyConceptSettings, conceptSettingsPatch, initConceptSettings } from './concept-settings.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;
initLanguage();
ui($('archiveDestination'), 'textContent', archiveWorkspaceLabel);

/** Product browser choices come from one canonical list, not whatever option nodes a packaged
 * renderer happened to retain. Rebuild this small control once at startup so a stale/partial
 * HTML shell cannot silently collapse Eva/Eve back to Chrome-only. */
function initChatBrowserChoices(): void {
  const select = $<HTMLSelectElement>('chatBrowser');
  const selected = select.value;
  const choices = CHAT_BROWSERS.map(browser => {
    const option = document.createElement('option');
    option.value = browser;
    ui(option, 'textContent', () => t(chatBrowserFamily(browser).label));
    return option;
  });
  select.replaceChildren(...choices);
  if (CHAT_BROWSERS.includes(selected as ChatBrowser)) select.value = selected;
}
initChatBrowserChoices();

/**
 * The build decides which agent drivers exist as product choices. Keep every stable id in the
 * control so a config moved between build channels can still show (but not re-select) a driver
 * excluded by this build; runtime execution applies the same gate again before creating work.
 */
function initAgentExecutionControls(): void {
  for (const id of ['agentOrchestratorBackend', 'agentWorkerBackend']) {
    const select = $<HTMLSelectElement>(id);
    select.replaceChildren(...agentBackendsForBuild().map((backend) => {
      const option = document.createElement('option');
      option.value = backend;
      option.textContent = AGENT_BACKEND_LABELS[backend];
      return option;
    }));
  }
  $('agentBuildFlavor').textContent = BUILD_FLAVOR;
}

initAgentExecutionControls();

let lanCreatedJoinKey: string | null = null;

/**
 * This entire Settings section exists only in local debug builds. Shipping/dev renderer bundles
 * compile BUILD_FLAVOR to another literal, so the ordinary product UI never creates these nodes.
 */
function initDebugLanSettings(): void {
  if (BUILD_FLAVOR !== 'debug') return;
  const buildPane = $('agentBuildFlavor').closest<HTMLElement>('.pane');
  if (!buildPane) return;

  const title = el('h2', 'settings-section-title', 'Local network lab');
  title.id = 'debugLanTitle';
  const pane = el('div', 'pane');
  pane.id = 'debugLanSettings';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'debugLanEnabled';
  const toggleRow = el('label', 'setting') as HTMLLabelElement;
  toggleRow.htmlFor = toggle.id;
  const toggleCopy = el('span', 'setting-text');
  toggleCopy.append(el('b', '', 'Discover this Eve on the local network'), el('em', '', 'Encrypted multicast presence for other ParadigmEve debug installs in the same joined group.'));
  toggleRow.append(toggleCopy, toggle);

  const status = el('p', 'muted', 'No LAN group joined.');
  status.id = 'debugLanStatus';
  const peers = el('div');
  peers.id = 'debugLanPeers';

  const joinField = el('div', 'field');
  const joinLabel = document.createElement('label');
  joinLabel.htmlFor = 'debugLanJoinKey';
  joinLabel.textContent = 'Join key';
  const joinInput = document.createElement('input');
  joinInput.id = 'debugLanJoinKey';
  joinInput.type = 'password';
  joinInput.autocomplete = 'off';
  joinInput.spellcheck = false;
  joinInput.placeholder = 'Paste the 43-character key from another Eve';
  joinField.append(joinLabel, joinInput);

  const created = el('div', 'field');
  created.id = 'debugLanCreated';
  created.hidden = true;
  const createdLabel = document.createElement('label');
  createdLabel.htmlFor = 'debugLanCreatedKey';
  createdLabel.textContent = 'New group join key';
  const createdInput = document.createElement('input');
  createdInput.id = 'debugLanCreatedKey';
  createdInput.readOnly = true;
  createdInput.spellcheck = false;
  created.append(createdLabel, createdInput, el('p', 'hint', 'Shown for this window only. Copy it to the other ParadigmEve debug install, then use Join group there.'));

  const actions = el('div', 'step-actions');
  const create = el('button', 'btn btn-solid', 'Create group') as HTMLButtonElement;
  create.id = 'debugLanCreate'; create.type = 'button';
  const join = el('button', 'btn btn-solid', 'Join group') as HTMLButtonElement;
  join.id = 'debugLanJoin'; join.type = 'button';
  const copy = el('button', 'btn', 'Copy join key') as HTMLButtonElement;
  copy.id = 'debugLanCopy'; copy.type = 'button'; copy.hidden = true;
  const forget = el('button', 'btn', 'Forget group') as HTMLButtonElement;
  forget.id = 'debugLanForget'; forget.type = 'button';
  actions.append(create, join, copy, forget);
  pane.append(toggleRow, status, joinField, created, actions, peers);
  buildPane.after(title, pane);

  toggle.addEventListener('change', async () => {
    const result = await run(api.lanAction({ action: 'set-enabled', enabled: toggle.checked }));
    if (result) apply(result.state); else if (state) apply(state);
  });
  create.addEventListener('click', async () => {
    const result = await run(api.lanAction({ action: 'create' }));
    if (!result) return;
    lanCreatedJoinKey = result.joinKey;
    joinInput.value = '';
    apply(result.state);
  });
  join.addEventListener('click', async () => {
    const key = joinInput.value.trim();
    if (!key) return;
    const result = await run(api.lanAction({ action: 'join', key }));
    if (!result) return;
    joinInput.value = '';
    lanCreatedJoinKey = null;
    apply(result.state);
  });
  copy.addEventListener('click', async () => {
    if (lanCreatedJoinKey && await run(api.writeClipboard(lanCreatedJoinKey))) toast('LAN join key copied');
  });
  forget.addEventListener('click', async () => {
    const result = await run(api.lanAction({ action: 'forget' }));
    if (!result) return;
    lanCreatedJoinKey = null;
    joinInput.value = '';
    apply(result.state);
  });
}

initDebugLanSettings();

/** Preserve a saved cross-flavor choice visibly without advertising it as selectable here. */
function ensureVisibleAgentBackend(select: HTMLSelectElement, backend: AgentBackendId): void {
  for (const option of [...select.options]) {
    if (option.dataset.buildExcluded === 'true' && option.value !== backend) option.remove();
  }
  if ([...select.options].some((option) => option.value === backend)) return;
  const option = document.createElement('option');
  option.value = backend;
  option.textContent = AGENT_BACKEND_LABELS[backend];
  option.disabled = !agentBackendAvailableInBuild(backend);
  option.dataset.buildExcluded = 'true';
  select.append(option);
}

/** Same shape the platform uses; mirrored here only to grey out step 2 until it is valid. */
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

interface Group {
  id: string;
  title: string;
  /** Sprite id from index.html. */
  icon: string;
  blurb: string;
  caps: Capability[];
}

const GROUPS: Group[] = [
  {
    id: 'read',
    title: "Look at files",
    icon: 'i-eye',
    blurb: "Read and search inside the folders you approved.",
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: "Change files",
    icon: 'i-pencil',
    blurb: "Create, edit, move, delete and save ChatGPT files, inside those folders only.",
    caps: ['create', 'edit', 'move', 'deleteFile', 'saveArtifact']
  },
  {
    id: 'desktop',
    title: "See and use the desktop",
    icon: 'i-monitor',
    blurb: "Screenshots, the list of open windows, and the mouse and keyboard.",
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: "Run programs",
    icon: 'i-terminal',
    blurb: "Start commands as you. The most powerful setting here.",
    caps: ['command']
  }
];

let state: AppState | null = null;
let guidedSetup: SetupAssistantSnapshot | null = null;
let guidedSetupPickingFolder = false;
let guidedSetupNotice: string | null = null;
let promotingOnboarding = false;
/** Guards against saving while we are writing values into the controls. */
let applying = false;

/**
 * Applies persisted form state without erasing a value the user is currently editing.
 *
 * `state:changed` is primarily a live status push, but it carries the whole config object. A
 * focused field can therefore differ from the last persisted config for several seconds before
 * its `change` event saves it. Only that exact dirty case is protected; an idle/focused-but-clean
 * field still follows persisted state normally.
 */
function applyValue(control: HTMLInputElement | HTMLSelectElement, next: string, previous?: string): void {
  const dirty = document.activeElement === control && previous !== undefined && control.value !== previous;
  if (!dirty) control.value = next;
}

function applyChecked(control: HTMLInputElement, next: boolean, previous?: boolean): void {
  const dirty = document.activeElement === control && previous !== undefined && control.checked !== previous;
  if (!dirty) control.checked = next;
}
/** The one expanded permission group, or null. One at a time keeps the layout still. */
let openGroup: string | null = null;
/** Whether the finished setup steps are unfolded again. Reset on every app start. */
let showAllSteps = false;

const SETUP_STEP_ORDER = ['folder', 'tunnel', 'key', 'connect', 'browser', 'chatgpt'] as const;
type SetupStepName = typeof SETUP_STEP_ORDER[number];
/** A user-selected setup step for review. This never changes the real completion/current step. */
let previewSetupStep: SetupStepName | null = null;

type SetupPrivacySection = 'tunnel' | 'key';
/** Secret values always begin concealed for a fresh renderer, including after a restart. */
const setupSecretVisible: Record<SetupPrivacySection, boolean> = {
  tunnel: false,
  key: false
};

function paintSetupPrivacy(section: SetupPrivacySection): void {
  const visible = setupSecretVisible[section];
  const input = $<HTMLInputElement>(section === 'tunnel' ? 'tunnelId' : 'apiKey');
  const button = $<HTMLButtonElement>(section === 'tunnel' ? 'tunnelPrivacy' : 'apiKeyPrivacy');
  const iconUse = $(section === 'tunnel' ? 'tunnelPrivacyIcon' : 'apiKeyPrivacyIcon');
  const label = section === 'tunnel'
    ? t(visible ? 'Hide Tunnel ID' : 'Show Tunnel ID')
    : t(visible ? 'Hide API key' : 'Show API key');
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', label);
  button.title = label;
  iconUse.setAttribute('href', visible ? '#i-eye-off' : '#i-eye');
}

function toggleSetupPrivacy(section: SetupPrivacySection): void {
  setupSecretVisible[section] = !setupSecretVisible[section];
  paintSetupPrivacy(section);
}

function concealSetupSecrets(): void {
  setupSecretVisible.tunnel = false;
  setupSecretVisible.key = false;
  paintSetupPrivacy('tunnel');
  paintSetupPrivacy('key');
}

function paintSetupPreview(current: SetupStepName | null): void {
  if (previewSetupStep && step(previewSetupStep).hidden) previewSetupStep = null;
  for (const name of SETUP_STEP_ORDER) {
    const node = step(name);
    const selected = previewSetupStep === name;
    node.classList.toggle('is-preview', selected);
    node.querySelector<HTMLButtonElement>('[data-preview-step]')?.setAttribute('aria-pressed', String(selected));
  }

  const status = $('setupPreviewStatus');
  if (!previewSetupStep) {
    ui(status, 'textContent', () => t('Click a step number to preview any step without changing your setup progress.'));
    return;
  }
  const previewNumber = SETUP_STEP_ORDER.indexOf(previewSetupStep) + 1;
  if (current === null) {
    ui(status, 'textContent', () => t('Previewing step {0} of 6. Setup is already complete.', [previewNumber]));
  } else if (current === previewSetupStep) {
    ui(status, 'textContent', () => t('Previewing step {0} of 6. This is also your current setup step.', [previewNumber]));
  } else {
    const currentNumber = SETUP_STEP_ORDER.indexOf(current) + 1;
    ui(status, 'textContent', () => t('Previewing step {0} of 6. Your setup progress is still on step {1}.', [previewNumber, currentNumber]));
  }
}

// ------------------------------------------------------------------- tabs

/**
 * Keep the small sidebar chrome on the top navigation's Plans/Planer text column.
 * Sidebar width is deliberately absent from this calculation: dragging its right edge must not
 * move controls whose visual anchor belongs to the fixed titlebar navigation above it.
 */
function syncSidebarChromeAnchor(): void {
  const plans = $<HTMLButtonElement>('plansDestination');
  const sidebar = $('sidebar');
  const planRect = plans.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  if (planRect.width <= 0) return;
  const planStyle = window.getComputedStyle(plans);
  const padding = Number.parseFloat(planStyle.paddingLeft) || 0;
  sidebar.style.setProperty('--top-nav-anchor-x', `${Math.round(planRect.left + padding - sidebarRect.left)}px`);
}

let threadSettingsExpanded = false;
async function refreshThreadSettingsEntries(): Promise<void> {
  const settingsEntries = await run(api.getThreadSettingsEntries());
  if (!settingsEntries) return;
  const expensesRow = $('expensesThreadSettings');
  const expensesFolder = $('startExpenses');
  const expenses = settingsEntries.find(entry => entry.surface === 'expenses');
  expensesRow.hidden = !expenses;
  expensesFolder.hidden = !expenses;
  if (!expenses) {
    delete expensesRow.dataset.threadSettingsId;
    return;
  }
  expensesRow.dataset.threadSettingsId = expenses.threadId;
  ui(expensesRow, 'textContent', () => `% ${expenses.title === 'expenses' ? t('Expenses') : expenses.title.replace(/^%/u, '')}  -`);
}

function paintThreadSettingsNavigation(): void {
  const concepts = $<HTMLButtonElement>('conceptsSettingsNav');
  const toggle = $<HTMLButtonElement>('threadSettingsToggle');
  const items = $('threadSettingsItems');
  ui(concepts, 'textContent', () => t('# Concepts'));
  ui(concepts, 'aria-label', () => t('Open Concepts settings'));
  toggle.setAttribute('aria-expanded', String(threadSettingsExpanded));
  ui(toggle, 'textContent', () => t(threadSettingsExpanded ? '% Threads  -' : '% Threads  +'));
  ui(toggle, 'aria-label', () => t(threadSettingsExpanded ? 'Collapse Threads settings' : 'Expand Threads settings'));
  items.hidden = !threadSettingsExpanded;
}

paintThreadSettingsNavigation();
void refreshThreadSettingsEntries();
$('threadSettingsToggle').addEventListener('click', () => {
  threadSettingsExpanded = !threadSettingsExpanded;
  paintThreadSettingsNavigation();
});
window.addEventListener('resize', syncSidebarChromeAnchor);
document.addEventListener('change', event => {
  if ((event.target as HTMLElement).closest('[data-language-select]')) queueMicrotask(syncSidebarChromeAnchor);
});
queueMicrotask(syncSidebarChromeAnchor);

function showTab(name: string): void {
  const workspace = name === 'chat' || name === 'pins' || name === 'plans' || name === 'schedule' || name === 'archive';
  const settings = !workspace;
  // Preserve the concrete screen identity. Some CSS is specific to the chat card's
  // Settings view, so labelling Setup/Home as "settings" mutates the hidden composer
  // while onboarding is open and makes its next layout depend on that offscreen state.
  document.querySelector<HTMLElement>('.app')!.dataset.screen = name;
  $('workspaceSettings').hidden = settings;
  $('pinsDestination').classList.toggle('is-active', name === 'pins');
  $('plansDestination').classList.toggle('is-active', name === 'plans');
  $('scheduleDestination').classList.toggle('is-active', name === 'schedule');
  $('archiveDestination').classList.toggle('is-active', name === 'archive');
  $('conceptsSettingsNav').classList.toggle('is-active', name === 'concepts-settings');
  if (name === 'concepts-settings') $('conceptsSettingsNav').setAttribute('aria-current', 'page');
  else $('conceptsSettingsNav').removeAttribute('aria-current');
  if (name === 'usage') void refreshUsage();
  if (name === 'pins') void refreshPinsSurface();
  if (name === 'plans') void refreshPlansSurface();
  if (name === 'archive') void refreshArchiveSurface();
  $('tabs').hidden = !settings;
  $('backToChat').hidden = !settings;
  // Pins, Plans, Schedule and Archive are peer workspace destinations, not an escape hatch from Chat. Keep
  // the conversation list and New chat affordance visible on workspace screens so one
  // click on a conversation returns to the review/harvesting surface.
  document.querySelector<HTMLElement>('.sidebar-sessions')!.hidden = settings;
  $('workspaceQuickRow').hidden = settings;
  $('threadSettingsNav').hidden = !settings;
  if (name === 'settings') openChatView('settings');
  else if (name === 'chat') openChatView('timeline');

  for (const tab of document.querySelectorAll<HTMLElement>('nav button')) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('is-sel', selected);
    if (selected) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === (name === 'settings' ? 'chat' : name));
  }
  // The Conversations sidebar is visible on every workspace destination. Keep its exact
  // session/Prime projection live there too; Pins/Plans/Schedule/Archive must not silently freeze the
  // list and turn the small manual Refresh control into required workflow.
  chatVisible(workspace || name === 'settings');
  // A feed that was appended to while its panel was hidden could not be scrolled then —
  // a hidden element has no scroll height. Pin it now that it has one, so a panel always
  // opens on the newest line rather than on whatever was oldest in the buffer.
  for (const id of FEEDS) stickToNewest(id);
}

$('backToChat').addEventListener('click', () => showTab('chat'));
$('workspaceSettings').addEventListener('click', () => showTab('home'));
$('conceptsSettingsNav').addEventListener('click', () => showTab('concepts-settings'));
$('pinsDestination').addEventListener('click', () => navigateWorkspace({ screen: 'pins' }));
$('plansDestination').addEventListener('click', () => navigateWorkspace({ screen: 'plans' }));
$('scheduleDestination').addEventListener('click', () => navigateWorkspace({ screen: 'schedule' }));
$('archiveDestination').addEventListener('click', () => navigateWorkspace({ screen: 'archive' }));
$('chatSettingsBtn').addEventListener('click', () => showTab('settings'));
$('sessionList').addEventListener('click', event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
  if (row?.dataset.id) navigateWorkspace({ screen: 'chat', sessionId: row.dataset.id });
});
$('newChat').addEventListener('click', () => showTab('chat'));
onWorkspaceNavigation(state => showTab(state.screen));
$('composerFolder').addEventListener('click', () => $('addProject').click());
let zoomFactor = 1;
let zoomEdited = false;
void api.getZoom().then(result => {
  if (zoomEdited || !result.ok || typeof result.data !== 'number' || !Number.isFinite(result.data)) return;
  zoomFactor = result.data;
  $('zoomReset').textContent = `${Math.round(zoomFactor * 100)}%`;
});
async function zoom(next: number): Promise<void> {
  zoomEdited = true;
  const result = await run(api.setZoom(Math.min(1.5, Math.max(.75, next))));
  if (result !== null) { zoomFactor = result; $('zoomReset').textContent = `${Math.round(result * 100)}%`; }
}
$('zoomOut').addEventListener('click', () => void zoom(zoomFactor - .1));
$('zoomIn').addEventListener('click', () => void zoom(zoomFactor + .1));
$('zoomActualSize').addEventListener('click', () => void zoom(1));
$('openStaticArchiveMenu').addEventListener('click', async () => {
  const result = await run(api.archiveOpenStatic());
  if (!result) return;
  toast(result.ok
    ? t('Static recovery browser opened.')
    : t('Static archive could not be opened: {0}', [result.error]));
});
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return;
  event.preventDefault(); void zoom(event.key === '0' ? 1 : zoomFactor + (event.key === '-' ? -.1 : .1));
});
$('tabs').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (button?.dataset.tab) showTab(button.dataset.tab);
});

initWorkspaceLibrary();
initConceptSettings(() => { void save(); });
api.onPinsChanged(() => { void refreshThreadSettingsEntries(); });
initScheduleWorkspace();
initArchiveSurface();

// ------------------------------------------------------------ permissions

/**
 * Builds the permission rows once: a name that expands the group, and a switch that
 * turns the whole group on or off. Expanding scrolls the row just into view rather
 * than pushing the cards below it, because the window cannot grow.
 */
/** The head of a permission row: the expander, its title, and its switch. */
function groupShell(id: string, title: string, iconId: string, box: HTMLInputElement): HTMLElement {
  const root = el('div', 'perm');
  root.dataset.group = id;

  const main = document.createElement('button');
  main.className = 'perm-main';
  main.type = 'button';
  const text = el('span');
  text.append(el('b', '', () => t(title)), el('em', 'group-count'));
  main.append(icon('i-chev', 'ico chev'), icon(iconId), text);
  main.addEventListener('click', () => {
    openGroup = openGroup === id ? null : id;
    paintGroups();
    if (openGroup === id) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const sw = el('span', 'sw');
  sw.append(box, el('i'));

  const head = el('div', 'perm-head');
  head.append(main, sw);
  root.append(head);
  return root;
}

/**
 * The tools this group hands ChatGPT, named exactly as the model sees them.
 *
 * The permission copy used to carry the tool names inside its prose, which is where they
 * went stale: the surface was consolidated to `read` / `apply_patch` / `exec_command` and
 * a sentence in a different file kept describing the old one. Here the names come from
 * capabilityTools, including the host's shared Desktop method lists.
 */
function toolNames(names: readonly string[]): HTMLElement {
  const row = el('div', 'tool-names');
  for (const name of names) row.append(el('code', '', name));
  return row;
}

function buildGroups(): void {
  const permissionGroups = GROUPS.map((group) => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'group-box';
    ui(box, 'title', () => t("Turn everything in \"{0}\" on or off", [t(group.title)]));
    box.addEventListener('change', () => {
      for (const cap of group.caps) {
        const input = capInput(cap);
        if (!input.disabled) input.checked = box.checked;
      }
      void save();
    });
    const root = groupShell(group.id, group.title, group.icon, box);

    const tools = el('div', 'tools');
    for (const cap of group.caps) {
      const label = el('label', 'tool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.cap = cap;
      input.addEventListener('change', () => void save());
      const body = el('span');
      body.append(el('strong', '', () => t(CAPABILITY_LABELS[cap])), el('em', '', () => t(CAPABILITY_DETAILS[cap])));
      label.append(input, body);
      tools.append(label);
    }
    tools.append(toolNames([]));

    root.append(tools);
    return root;
  });

  // Recording and sub-agents are tool surfaces exactly like the file and desktop
  // permissions — `session` and `agents` are two of the nine tools ChatGPT can discover —
  // and they used to be checkboxes buried in a settings pane behind a gear. Every switch
  // that decides what ChatGPT can reach now lives in this one list. Chat settings keeps
  // only the numbers that tune them.
  const record = document.createElement('input');
  record.type = 'checkbox';
  record.id = 'sessRecord';
  ui(record, 'title', () => t("Record this chat locally, and expose the session tool in ChatGPT"));
  record.addEventListener('change', () => void save());
  const recording = groupShell('recording', 'Session recording', 'i-steps', record);
  const recordTools = el('div', 'tools');
  for (const [name, detail] of [
    ['search', 'List recent recordings or find past and concurrent work by text.'],
    ['read', 'Read one explicit recording, continue it, or expand one short T… tool reference.']
  ] as Array<[string, string]>) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', () => t(detail)));
    row.append(body);
    recordTools.append(row);
  }
  recordTools.append(toolNames(['session']));
  recording.append(recordTools);

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = 'homeMaEnabled';
  ui(enabled, 'title', () => t("Expose or hide the sub-agent tools in ChatGPT"));
  // The only multi-agent exposure control there is. Chat settings used to carry a second
  // checkbox for the same flag, which this one had to mirror by hand.
  enabled.addEventListener('change', () => void save());
  const agents = groupShell('agents', 'Sub-agents', 'i-bolt', enabled);

  const tools = el('div', 'tools');
  const agentTools: Array<[string, string]> = [
    ['spawn', 'Open worker ChatGPT conversations for parts of the task, on one shared context.'],
    ['message', 'Steer one worker or several at once, or report back to your agent.'],
    ['status', 'See every worker, and collect messages not yet delivered on a tool result.'],
    ['finish', 'Hand the worker result back to your agent and free that slot.']
  ];
  for (const [name, detail] of agentTools) {
    const row = el('div', 'tool is-static');
    const body = el('span');
    body.append(el('strong', '', name), el('em', '', () => t(detail)));
    row.append(body);
    tools.append(row);
  }
  tools.append(toolNames(['agents']));
  agents.append(tools);

  $('groups').replaceChildren(...permissionGroups, recording, agents);
}

function capInput(cap: Capability): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`[data-cap="${cap}"]`)!;
}

/** Refreshes counts, the tri-state switches, and what read-only mode has locked. */
function paintGroups(): void {
  if (!state) return;
  const { readOnly } = state.config;
  const desktopSupported = state.platform?.desktopAutomation ?? true;

  for (const group of GROUPS) {
    const root = document.querySelector<HTMLElement>(`[data-group="${group.id}"]`)!;
    const supported = group.id !== 'desktop' || desktopSupported;
    root.hidden = !supported;
    if (!supported) {
      for (const cap of group.caps) capInput(cap).disabled = true;
      continue;
    }
    root.classList.toggle('is-open', openGroup === group.id);

    const names = [...new Set(group.caps.flatMap((cap) => capabilityTools(cap, state!.platform?.family)))];
    if (group.id === 'desktop' && names.length > 0) names.push('exec');
    const namesRow = root.querySelector<HTMLElement>('.tool-names')!;
    if (Array.from(namesRow.children, child => child.textContent).join('\n') !== names.join('\n')) {
      namesRow.replaceChildren(...names.map(name => el('code', '', name)));
    }

    const usable = group.caps.filter((cap) => !(readOnly && WRITE_CAPABILITIES.includes(cap)));
    const on = group.caps.filter((cap) => capInput(cap).checked);

    const box = root.querySelector<HTMLInputElement>('.group-box')!;
    box.checked = usable.length > 0 && usable.every((cap) => capInput(cap).checked);
    box.indeterminate = !box.checked && on.length > 0;
    box.disabled = usable.length === 0;

    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => usable.length === 0
        ? t("off in read-only mode")
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? t(on.length === 1 ? '{0} permission' : '{0} permissions', [on.length])
            : t("{0} of {1} permissions", [on.length, group.caps.length]));

    root.classList.toggle('is-on', on.length > 0);
    root.classList.toggle('is-locked', usable.length === 0);
  }

  for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;

  // The two feature groups. apply() already passed both switches through the
  // focused/dirty-field guard. Recopying state here undid that protection and visibly
  // flipped a user's just-clicked toggle back when an unsolicited stale state push
  // arrived before save completed, so this only reads them.
  for (const [id, onText] of [
    ['recording', 'session tool exposed'],
    ['agents', 'agents tool exposed']
  ] as Array<[string, string]>) {
    const root = document.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!root) continue;
    const box = root.querySelector<HTMLInputElement>('.sw input')!;
    root.classList.toggle('is-open', openGroup === id);
    root.classList.toggle('is-on', box.checked);
    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => t(box.checked ? onText : 'off'));
  }
}

function paintDesktopAccess(next: AppState): void {
  const box = $('desktopAccess');
  const access = next.desktopAccess;
  const needsScreen = next.config.capabilities.screen;
  const needsAccessibility = next.config.capabilities.control && !next.config.readOnly;
  if (next.platform?.family !== 'macos' || (!needsScreen && !needsAccessibility) || !access) {
    box.hidden = true;
    return;
  }

  const missing: string[] = [];
  if (needsScreen && access.screen !== 'granted') missing.push(t("Screen Recording: {0}", [access.screen]));
  if (needsAccessibility && access.accessibility !== 'granted') {
    missing.push(t("Accessibility: {0}", [access.accessibility]));
  }
  box.hidden = missing.length === 0;
  if (box.hidden) return;

  ui($('desktopAccessTitle'), 'textContent', () => t("Desktop access needs attention"));
  ui($('desktopAccessDetail'), 'textContent', () => t("{0}. These are live verdicts from the native backend executing inside ParadigmEve. ", [missing.join(' · ')]) +
    t("Grant the missing macOS permission, then fully quit and reopen the app."));
  $<HTMLButtonElement>('openDesktopScreen').hidden =
    !needsScreen || access.screen === 'granted';
  $<HTMLButtonElement>('openDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
  $<HTMLButtonElement>('requestDesktopAccessibility').hidden =
    !needsAccessibility || access.accessibility === 'granted';
}

function paintSetupDesktopAccess(next: AppState): void {
  const box = $('setupDesktopAccess');
  const access = next.desktopAccess;
  const needsScreen = next.config.capabilities.screen;
  const needsAccessibility = next.config.capabilities.control && !next.config.readOnly;
  const enabled = needsScreen || needsAccessibility;
  if (next.platform?.family !== 'macos' || !enabled) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  const screenState = access?.screen ?? 'not checked';
  const accessibilityState = access?.accessibility ?? 'not checked';
  const parts: string[] = [];
  if (needsScreen) parts.push(t("Screen Recording: {0}", [screenState]));
  if (needsAccessibility) parts.push(t("Accessibility: {0}", [accessibilityState]));
  ui(
    $('setupDesktopAccessDetail'),
    'textContent',
    () => `${parts.join(' · ')}. ${t("Grant the missing macOS permission, then fully quit and reopen the app.")}`
  );

  $<HTMLButtonElement>('setupOpenDesktopScreen').hidden = !needsScreen;
  $<HTMLButtonElement>('setupOpenDesktopAccessibility').hidden = !needsAccessibility;
  $<HTMLButtonElement>('setupRequestDesktopAccessibility').hidden =
    !needsAccessibility || access?.accessibility === 'granted';
}

/**
 * How many MCP tools this app can expose in total.
 *
 * Taken from the surfaces the main process reports rather than recomputed from the
 * checkboxes, so this number cannot drift away from what the servers actually register.
 */
function toolsOn(next: AppState): number {
  return next.status.surfaces
    // The legacy Desktop route duplicates Computer-use tools already counted on ParadigmEve.
    .filter((surface) => surface.available && surface.id !== 'desktop')
    .reduce((sum, surface) => sum + surface.tools.length, 0);
}

// ------------------------------------------------------------------ save

// A settings save is a full snapshot, even though the main process applies it as a patch.
// Capture each requested snapshot immediately, but derive it from the latest *requested* state
// rather than only the latest acknowledged state. Then serialize IPC delivery. This handles both
// halves of the race: a later save cannot inherit stale readOnly/theme, and the first save's reply
// cannot repaint a control before the later save has captured what the user changed there.
let settingsSaveQueue: Promise<void> = Promise.resolve();
let requestedSettings: SettingsPatch | null = null;

function save(over: { readOnly?: boolean; theme?: 'light' | 'dark' } = {}): Promise<void> {
  if (applying || !state) return Promise.resolve();

  const previous: AppState['config'] = requestedSettings
    ? { ...state.config, ...requestedSettings }
    : state.config;
  const capabilities = { ...previous.capabilities };
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const capability = input.dataset.cap as Capability;
    // Unsupported hosts hide Desktop automation while preserving any choices stored in this
    // config. A hidden disabled checkbox is presentation,
    // not a user edit: copying its forced-false value into every unrelated settings save
    // would erase those choices merely because the config was opened on another OS.
    if (!(state.platform?.desktopAutomation ?? true) && DESKTOP_CAPABILITIES.includes(capability)) continue;
    capabilities[capability] = input.checked;
  }
  const readOnly = over.readOnly ?? previous.readOnly;
  const chatPatch = chatSettingsPatch(previous);
  const previousMcp = previous.mcp ?? { connectorName: DEFAULT_CORE_CONNECTOR_NAME, instructions: '' };
  const previousExecution = previous.execution ?? DEFAULT_AGENT_EXECUTION_SETTINGS;
  const selectedBackend = (id: string, fallback: AgentBackendId): AgentBackendId => {
    const value = $<HTMLSelectElement>(id).value;
    return (AGENT_BACKEND_IDS as readonly string[]).includes(value) ? value as AgentBackendId : fallback;
  };
  const patch: SettingsPatch = {
    execution: {
      orchestrator: selectedBackend('agentOrchestratorBackend', previousExecution.orchestrator),
      worker: selectedBackend('agentWorkerBackend', previousExecution.worker)
    },
    capabilities,
    readOnly,
    tunnel: {
      kind: $<HTMLSelectElement>('tunnelKind').value as 'openai' | 'cloudflared' | 'manual',
      tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
      // Legacy compatibility only. New setup exposes Computer use through the primary
      // ParadigmEve tunnel, so preserve an older second-tunnel id without showing/editing it.
      desktopTunnelId: previous.tunnel.desktopTunnelId,
      pluginsTunnelId: previous.tunnel.pluginsTunnelId ?? '',
      binaryPath: $<HTMLInputElement>('binaryPath').value.trim()
    },
    ui: {
      chatBrowser: $<HTMLSelectElement>('chatBrowser').value as ChatBrowser,
      chatModel: previous.ui.chatModel,
      chatReasoning: previous.ui.chatReasoning,
      finishTool: $<HTMLInputElement>('finishTool').checked,
      planBackend: $<HTMLSelectElement>('planBackend').value as 'chatgpt' | 'api',
      finishAction: $<HTMLSelectElement>('finishAction').value as 'notify' | 'goal',
      finishLeadMinutes: Number($<HTMLSelectElement>('finishLeadMinutes').value),
      backgroundChats: $<HTMLInputElement>('backgroundChats').checked,
      browserOnly: $<HTMLInputElement>('browserOnly').checked,
      autoRefreshPlugins: $<HTMLInputElement>('autoRefreshPlugins').checked,
      autoConnect: $<HTMLInputElement>('autoConnect').checked,
      startAtLogin: $<HTMLInputElement>('startAtLogin').checked,
      minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
      developerMode: $<HTMLInputElement>('developerMode').checked,
      privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
      ...conceptSettingsPatch(previous.ui),
      theme: over.theme ?? previous.ui.theme
    },
    eveAuthority: {
      allowOtherChats: $<HTMLInputElement>('eveAllowOtherChats').checked,
      changeSettings: $<HTMLInputElement>('eveChangeSettings').checked,
      archiveCompletedWork: $<HTMLInputElement>('eveArchiveCompletedWork').checked,
      controlParadigmEve: $<HTMLInputElement>('eveControlParadigmEve').checked
    },
    ...chatPatch,
    mcp: {
      ...chatPatch.mcp,
      connectorName: $<HTMLInputElement>('instanceName').value.trim() || previousMcp.connectorName
    }
  };
  requestedSettings = patch;

  const work = settingsSaveQueue.then(
    () => saveSnapshot(patch, previous),
    () => saveSnapshot(patch, previous)
  );
  settingsSaveQueue = work.then(
    () => undefined,
    () => undefined
  );
  return work;
}

async function saveSnapshot(patch: SettingsPatch, previous: AppState['config']): Promise<void> {
  const connectorIdentityChanged =
    (previous.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME) !== patch.mcp.connectorName;
  const toolSurfaceChanged =
    previous.sessions.record !== patch.sessions.record ||
    previous.multiAgent.enabled !== patch.multiAgent.enabled ||
    connectorIdentityChanged ||
    // The user's own connector instructions are part of what each server advertises about
    // itself, and ChatGPT reads that once when it loads the tools. Editing them is therefore
    // the same kind of change as adding a tool: it needs the same reconnect to be seen.
    (previous.mcp?.instructions ?? '') !== patch.mcp.instructions ||
    (Object.keys(patch.capabilities) as Capability[]).some((cap) => {
      const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
      const after = patch.capabilities[cap] && !(patch.readOnly && WRITE_CAPABILITIES.includes(cap));
      return before !== after;
    });
  const base: SettingsPatch = {
    execution: previous.execution ?? DEFAULT_AGENT_EXECUTION_SETTINGS,
    capabilities: previous.capabilities,
    readOnly: previous.readOnly,
    tunnel: previous.tunnel,
    ui: previous.ui,
    sessions: previous.sessions,
    compaction: previous.compaction,
    mcp: previous.mcp ?? { connectorName: DEFAULT_CORE_CONNECTOR_NAME, instructions: '' },
    multiAgent: previous.multiAgent,
    goal: previous.goal
  };
  const next = await run(api.saveSettings(patch, base));
  if (next) {
    apply(next);
    if (previous.multiAgent.enabled && !patch.multiAgent.enabled) {
      // A cached snapshot keeps offering the `agents` tool until the connector is
      // reloaded. Say so plainly rather than letting it look sticky.
      toast(t("Multi-agent off. Reconnect the connector in ChatGPT (then start a new chat) to drop the agents tool."));
    } else if (connectorIdentityChanged) {
      toast(t("Connection name saved as {0}. Use that same name for its tunnel and ChatGPT connector, then start a new ChatGPT conversation.", [patch.mcp.connectorName]));
    } else if (toolSurfaceChanged) {
      toast(t("Tools changed. Start a new ChatGPT conversation to guarantee the new tool list is loaded."));
    }
  } else await refresh();
  // Do not erase the desired state of a newer queued save when an older one completes.
  if (requestedSettings === patch) requestedSettings = null;
}

// ---------------------------------------------------------------- helpers

const STATUS_TEXT: Record<AppState['status']['state'], string> = {
  disconnected: "Not connected",
  'starting-server': "Starting",
  'connecting-tunnel': "Connecting",
  connected: "Connected",
  offline: "No internet",
  'auth-failed': "Sign-in failed",
  'tunnel-unavailable': "Tunnel unavailable"
};

const METHOD_HINT: Record<string, string> = {
  openai:
    "ChatGPT reaches this computer through an OpenAI tunnel. Nothing is exposed to the open internet.",
  cloudflared:
    "Creates a temporary public https address with Cloudflare. The address changes on every restart.",
  manual: "This app only listens on localhost. You are responsible for exposing it."
};

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * True while the bridge is up and Disconnect is the meaningful action. Offline
 * counts: the tunnel is still alive and retrying, it just cannot reach OpenAI.
 */
function isRunning(value: AppState['status']['state']): boolean {
  return (
    value === 'connected' ||
    value === 'offline' ||
    value === 'starting-server' ||
    value === 'connecting-tunnel'
  );
}

/** What still has to happen before connecting can work, in the order of the wizard. */
function missingStep(next: AppState): { step: string; text: string } | null {
  const { config } = next;
  // Desktop and clipboard tools can legitimately be rootless. File, patch, and command
  // capabilities still need one user-approved filesystem root before Core can connect safely.
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    return { step: 'folder', text: t("Choose a folder to share — step 1.") };
  }
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) {
      return { step: 'tunnel', text: t("Create a tunnel and paste its ID — step 2.") };
    }
    if (!(next.secureStorage?.available ?? true) && !next.hasApiKey) {
      return { step: 'key', text: next.secureStorage?.detail ?? t("Secure credential storage is unavailable.") };
    }
    if (!next.hasApiKey) {
      return { step: 'key', text: t("Add a restricted API key — step 3.") };
    }
  } else if (!next.resolvedBinary && config.tunnel.kind === 'cloudflared') {
    return { step: 'connect', text: t("cloudflared was not found on this computer.") };
  }
  return null;
}

/**
 * The first required onboarding step that is not complete.
 *
 * Keep this aligned with the wizard checkmarks: optional surfaces never block completion,
 * and the browser step blocks only when an enabled feature actually requires the companion.
 */
function requiredSetupStep(next: AppState): string | null {
  const prerequisite = missingStep(next);
  if (prerequisite) return prerequisite.step;
  // A live tunnel/browser/request clock is runtime health, not durable onboarding authority.
  // Once the end-to-end first run was verified, later outages belong to normal recovery UI.
  if (next.config.onboarding?.complete === true) return null;
  if (next.status.state !== 'connected') return 'connect';
  // Exact request attribution has to be healthy before a ChatGPT tool call is accepted as
  // connector verification. Otherwise an already-open pre-install ChatGPT tab can make the
  // tunnel look complete while every identity-sensitive Computer-use call will fail closed.
  if (browserExtensionRequired(next.config) && !next.bridge.present) return 'browser';
  const requiredUnverified = next.status.surfaces.some(
    (surface) => surface.available && !surface.optional &&
      (surface.lastRequestAt === null || surface.lastToolCallAt === null)
  );
  if (next.status.lastRequestAt === null || requiredUnverified) return 'chatgpt';
  return null;
}

interface RootRenameState {
  targetName: string;
  targetPath: string;
  draft: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
  focused: boolean;
  committing: boolean;
}

let rootRename: RootRenameState | null = null;
let repaintingRoots = false;

/**
 * The rename editor is transient DOM, but the draft is user state. Whole-state pushes repaint
 * the folder list, so capture that state before the old input is detached and recreate the
 * editor only while the exact authoritative root still exists unchanged.
 */
function captureRootRenameInput(input: HTMLInputElement, rename: RootRenameState): void {
  if (rootRename !== rename) return;
  rename.draft = input.value;
  rename.focused = document.activeElement === input;
  if (rename.focused) {
    rename.selectionStart = input.selectionStart;
    rename.selectionEnd = input.selectionEnd;
    rename.selectionDirection = input.selectionDirection;
  }
}

function cancelRootRename(): void {
  rootRename = null;
  if (state) paintRoots(state.config.roots);
}

async function commitRootRename(input: HTMLInputElement, rename: RootRenameState): Promise<void> {
  if (rootRename !== rename || rename.committing) return;
  captureRootRenameInput(input, rename);
  const nextName = rename.draft.trim().toLowerCase();
  if (!nextName || nextName === rename.targetName) {
    cancelRootRename();
    return;
  }

  rename.committing = true;
  input.disabled = true;
  const result = await run(api.renameRoot(rename.targetName, nextName));
  // An authoritative state push can remove or rename the target while IPC is in flight. Never
  // resurrect that cancelled editor when this older request finishes.
  if (rootRename !== rename) return;
  if (result) {
    rootRename = null;
    apply(result);
    return;
  }

  // Failure is retryable user input, not a reason to throw the draft away.
  rename.committing = false;
  paintRoots(state?.config.roots ?? []);
}

function rootRow(root: AppState['config']['roots'][number]): HTMLElement {
  const row = el('div', 'root');
  const renameState =
    rootRename?.targetName === root.name && rootRename.targetPath === root.path ? rootRename : null;
  const name = el('b', '', `/${root.name}`);
  let label: HTMLElement = name;

  if (renameState) {
    const input = document.createElement('input');
    input.className = 'root-rename';
    input.value = renameState.draft;
    input.maxLength = 32;
    input.disabled = renameState.committing;
    ui(input, 'aria-label', () => t("Rename /{0}", [root.name]));
    input.addEventListener('input', () => captureRootRenameInput(input, renameState));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitRootRename(input, renameState);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRootRename();
      }
    });
    input.addEventListener('blur', () => {
      // replaceChildren() may itself blur the old node in a real browser. paintRoots already
      // captured its draft/focus/caret immediately before detaching it, so treating that blur
      // as user intent would both lose focus restoration and accidentally commit on a status push.
      if (repaintingRoots) return;
      captureRootRenameInput(input, renameState);
      void commitRootRename(input, renameState);
    });
    label = input;
  }

  const rename = document.createElement('button');
  rename.className = 'btn';
  rename.type = 'button';
  ui(rename, 'title', () => t("Rename /{0}", [root.name]));
  rename.append(icon('i-pencil'));
  rename.addEventListener('click', () => {
    rootRename = {
      targetName: root.name,
      targetPath: root.path,
      draft: root.name,
      selectionStart: 0,
      selectionEnd: root.name.length,
      selectionDirection: 'none',
      focused: true,
      committing: false
    };
    paintRoots(state?.config.roots ?? []);
  });

  const remove = document.createElement('button');
  remove.className = 'btn';
  remove.type = 'button';
  ui(remove, 'title', () => t("Stop sharing /{0}", [root.name]));
  remove.append(icon('i-trash'));
  remove.addEventListener('click', async () => {
    const result = await run(api.removeRoot(root.name));
    if (result) apply(result);
  });
  const path = el('span', '', root.path);
  path.title = root.path;
  row.append(icon('i-folder'), label, path, rename, remove);
  return row;
}

function paintRoots(roots: AppState['config']['roots']): void {
  const active = document.querySelector<HTMLInputElement>('.root-rename');
  if (active && rootRename) captureRootRenameInput(active, rootRename);

  if (
    rootRename &&
    !roots.some((root) => root.name === rootRename!.targetName && root.path === rootRename!.targetPath)
  ) {
    rootRename = null;
  }

  repaintingRoots = true;
  try {
    $('rootList').replaceChildren(...roots.map(rootRow));
  } finally {
    repaintingRoots = false;
  }

  if (!rootRename?.focused) return;
  const input = document.querySelector<HTMLInputElement>('.root-rename');
  if (!input) return;
  input.focus();
  if (rootRename.selectionStart !== null && rootRename.selectionEnd !== null) {
    input.setSelectionRange(
      rootRename.selectionStart,
      rootRename.selectionEnd,
      rootRename.selectionDirection ?? undefined
    );
  }
}

// ----------------------------------------------------------------- render

/** How the one update sentence reads: nothing to do, something in progress, something wrong. */
type UpdateTone = 'ok' | 'work' | 'bad';

/** The update notification is news, and news is told once per window. */
let announced = false;
let restoringCompanionBrowser = false;

function paintCompanionBrowser(next: AppState): void {
  const action = $<HTMLButtonElement>('companionBrowserAction');
  const label = $('companionBrowserActionLabel');
  const divider = $('companionBrowserDivider');
  // Routine recovery becomes relevant only after a Companion has actually been paired once.
  // Before that, Guided setup remains the one place that explains what the browser is for.
  action.hidden = !next.bridge.paired;
  divider.hidden = action.hidden;
  if (action.hidden) return;

  const windowOpen = next.companionBrowser?.windowOpen ?? null;
  if (restoringCompanionBrowser) {
    ui(label, 'textContent', () => t("Opening…"));
  } else if (windowOpen === false) {
    // Native window evidence is more current than the Companion presence TTL after Chrome exits.
    ui(label, 'textContent', () => t("Open Eve Browser"));
  } else if (next.bridge.chatTabOpen === false) {
    ui(label, 'textContent', () => t("Restore Eve Browser"));
  } else if (next.bridge.present) {
    ui(label, 'textContent', () => t("Show Eve Browser"));
  } else if (windowOpen === true) {
    ui(label, 'textContent', () => t("Reconnect Eve Browser"));
  } else {
    ui(label, 'textContent', () => t("Open Eve Browser"));
  }
  action.disabled = restoringCompanionBrowser;
}

/**
 * Everything this window knows about being current, as one sentence and one tone.
 *
 * Two facts feed it and this owns neither: what the update service found (state.update, which
 * reports a `latest` only when it is genuinely newer, so nothing here compares versions), and
 * the last extension version observed by the bridge. A protocol mismatch can prevent presence,
 * so an observed older version remains actionable until a current companion reports in.
 *
 * Null is the one silence that is not an answer: the update sources have not been
 * checked yet in this run, so "up to date" would be a claim nobody has checked.
 *
 * `notice` is the narrower question of whether the header bar carries the sentence at all. That
 * bar is for what the user can act on - a version to fetch by hand, an extension to reload -
 * while the Activity line reports every state, including the good one.
 */
function updateSummary({ bridge, update, config, status, companionBrowser }: AppState): {
  text: string;
  tone: UpdateTone;
  notice: boolean;
  extensionAction: string | null;
  extensionActionKind: 'setup' | 'browser' | null;
} | null {
  // Only an extension older than this app is the user's to fix. The other direction is an app
  // that has not caught up yet - normal while an update downloads - and telling that user to
  // load the bundled folder again would talk them into downgrading a working extension. The
  // app sentence already owns being behind.
  const stale =
    bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion)
      ? bridge.extensionVersion
      : null;
  // A mismatched companion can fail the protocol gate before it becomes present.
  // Retain its last observed version until a matching companion actually reports in.
  const browserWindowClosed = companionBrowser?.windowOpen === false;
  const missing = !stale && bridge.running && (browserWindowClosed || !bridge.present || bridge.chatTabOpen === false) && isRunning(status.state) && browserExtensionRequired(config);
  if (!stale && !missing && !update.latest && update.stage === 'idle' && !update.checkedAt) return null;

  const lines: string[] = [];
  let tone: UpdateTone = 'work';
  if (update.latest) {
    // `latest` set with a stage of `idle` is the deliberate case: a new version exists and this
    // installation - a Linux .deb, macOS, a development tree, an architecture with no artifact -
    // is not one the app can update by itself. That is when the button matters.
    lines.push(
      update.stage === 'checking'
        ? t("Checking for updates…")
        : update.stage === 'ready'
        ? t("ParadigmEve {0} is verified and ready. Install it now, or it installs the next time you quit.", [update.latest])
        : update.stage === 'downloading'
          ? t("ParadigmEve {0} is being downloaded. Keep working; you can install it when it is verified.", [update.latest])
          : update.stage === 'failed'
            ? t("ParadigmEve {0} could not be prepared: {1}.", [update.latest, update.error ?? t("the download stopped")])
            : t("ParadigmEve {0} is available, but this installation cannot apply it automatically.", [update.latest])
    );
    if (update.stage === 'failed') tone = 'bad';
  } else if (update.stage === 'failed') {
    lines.push(t("Could not check for updates: {0}.", [update.error ?? t("the check stopped")]));
    tone = 'bad';
  } else if (update.stage === 'checking') {
    lines.push(t("Checking for updates…"));
  } else if (!stale && !missing) {
    const extension = bridge.present && bridge.extensionVersion ? t(" · extension {0}", [bridge.extensionVersion]) : '';
    lines.push(t("Up to date: ParadigmEve {0}{1}", [update.current, extension]));
    tone = 'ok';
  }
  if (stale) {
    lines.push(
      t("Update your browser extension: {0} → {1}. ", [stale, update.current]) +
        t("Reload the extension from this app’s folder, then refresh ChatGPT.")
    );
    tone = 'bad';
  }
  if (missing) {
    lines.push(bridge.paired
      ? browserWindowClosed
        ? t("Eve Browser is closed. Open it to reconnect ChatGPT to ParadigmEve.")
        : bridge.chatTabOpen === false
        ? t("Eve Browser is open, but its ChatGPT tab is closed. Restore it to keep using Eve.")
        : t("Eve Browser isn’t connected. Open it to reconnect ChatGPT to ParadigmEve.")
      : t("Eve Browser setup is not finished yet. Finish browser setup to connect ChatGPT to ParadigmEve."));
    tone = 'bad';
  }
  return {
    text: lines.join(' '),
    tone,
    notice: Boolean(update.latest || stale || missing),
    extensionAction: stale
      ? t("Update extension")
      : missing
        ? bridge.paired ? browserWindowClosed ? t("Open Eve Browser") : bridge.chatTabOpen === false ? t("Restore Eve Browser") : t("Open Eve Browser") : t("Finish browser setup")
        : null,
    extensionActionKind: stale || (missing && !bridge.paired) ? 'setup' : missing ? 'browser' : null
  };
}

/** The header bar, the Activity line and the one notification, from that single sentence. */
function paintUpdate(next: AppState): void {
  const summary = updateSummary(next);
  const notice = $('updateNotice');
  const line = $('updateLine');
  if (!summary) {
    notice.hidden = true;
    line.hidden = true;
    $('updateExtension').hidden = true;
    return;
  }
  const { update } = next;
  ui($('updateText'), 'textContent', () => updateSummary(next)?.text ?? '');
  $('updateExtension').hidden = !summary.extensionAction;
  ui($('updateExtension'), 'textContent', () => updateSummary(next)?.extensionAction ?? t("Update extension"));
  // `ready` is the only state with a verified artifact on disk, and therefore the only one in
  // which pressing Install can do anything. Both buttons ask the same question of the same fact.
  const installable = update.stage === 'ready';
  $<HTMLButtonElement>('updateInstall').hidden = !installable;
  $<HTMLButtonElement>('installUpdate').hidden = !installable;
  // A newer GitHub release this installation cannot apply by itself is fetched by hand from its
  // release page. The URL is built by the main process from the one fixed repository.
  $<HTMLButtonElement>('updateRelease').hidden = !(update.latest && update.releaseUrl && update.stage !== 'ready' && update.stage !== 'downloading');
  notice.hidden = !summary.notice;
  ui(line, 'textContent', () => updateSummary(next)?.text ?? '');
  line.className = `upline${summary.tone === 'ok' ? ' is-ok' : summary.tone === 'bad' ? ' is-bad' : ''}`;
  line.hidden = false;
  // One notification per window, on the first answer that is an outcome rather than progress.
  // The Activity line keeps the sentence afterwards, so repeating it as a toast on every state
  // push would be the same news arriving over and over.
  if (!announced && update.stage !== 'checking' && update.stage !== 'downloading') {
    announced = true;
    toast(summary.text);
  }
}

function apply(next: AppState): void {
  applyPluginsState(next);
  const previousState = state;
  state = next;
  applying = true;
  const { config, status } = next;
  const execution = config.execution ?? DEFAULT_AGENT_EXECUTION_SETTINGS;
  const previousExecution = previousState?.config.execution ?? DEFAULT_AGENT_EXECUTION_SETTINGS;

  const connected = status.state === 'connected';
  const offline = status.state === 'offline';
  const busy = status.state === 'starting-server' || status.state === 'connecting-tunnel';
  const failed = status.state === 'auth-failed' || status.state === 'tunnel-unavailable';
  const running = isRunning(status.state);
  const missing = missingStep(next);

  // ---- theme
  const dark = config.ui.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const themeBtn = $('themeBtn');
  ui(themeBtn, 'title', () => dark ? t("Switch to light mode") : t("Switch to dark mode"));
  ui(themeBtn, 'aria-label', () => dark ? t("Switch to light mode") : t("Switch to dark mode"));
  themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');

  // ---- header
  const live = $('live');
  live.className = `live${
    connected ? ' is-connected' : offline ? ' is-offline' : busy ? ' is-busy' : failed ? ' is-error' : ''
  }`;
  ui($('liveState'), 'textContent', () => t(STATUS_TEXT[status.state]));

  const id = config.tunnel.tunnelId;
  ui($('headerSub'), 'textContent', () => config.tunnel.kind === 'openai'
      ? TUNNEL_ID_PATTERN.test(id)
        ? `${id.slice(0, 11)}…${id.slice(-4)}`
        : t("No tunnel yet")
      : (status.publicUrl ?? status.localUrl ?? config.tunnel.kind));

  const connectBtn = $<HTMLButtonElement>('connectBtn');
  connectBtn.classList.toggle('is-running', running);
  ui($('connectLabel'), 'textContent', () => running ? t("Disconnect") : t("Connect"));
  connectBtn.disabled = !running && missing !== null;
  connectBtn.title = !running && missing ? missing.text : '';

  // ---- out of date, app or extension
  paintUpdate(next);
  paintCompanionBrowser(next);
  paintPluginRefreshReminder(next.update.current);

  // ---- health numbers and facts
  paintClock();
  $('facts').replaceChildren(...facts(next));

  // ---- permissions
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const cap = input.dataset.cap as Capability;
    const supported = (next.platform?.desktopAutomation ?? true) || !DESKTOP_CAPABILITIES.includes(cap);
    applyChecked(input, supported && config.capabilities[cap], previousState?.config.capabilities[cap]);
  }
  const setupComputerUse = $<HTMLInputElement>('setupComputerUse');
  const desktopSupported = next.platform?.desktopAutomation ?? true;
  const enabledDesktopCaps = DESKTOP_CAPABILITIES.filter((cap) => config.capabilities[cap]);
  applyChecked(
    setupComputerUse,
    desktopSupported && enabledDesktopCaps.length === DESKTOP_CAPABILITIES.length,
    previousState
      ? DESKTOP_CAPABILITIES.every((cap) => previousState.config.capabilities[cap])
      : undefined
  );
  setupComputerUse.indeterminate = desktopSupported && enabledDesktopCaps.length > 0 && enabledDesktopCaps.length < DESKTOP_CAPABILITIES.length;
  setupComputerUse.disabled = !desktopSupported;
  $('setupComputerUseRow').hidden = !desktopSupported;
  ui($('setupComputerUseState'), 'textContent', () => enabledDesktopCaps.length === 0
    ? t('off')
    : enabledDesktopCaps.length === DESKTOP_CAPABILITIES.length
      ? t('{0} permissions', [DESKTOP_CAPABILITIES.length])
      : t('{0} of {1} permissions', [enabledDesktopCaps.length, DESKTOP_CAPABILITIES.length]));
  applyChecked(
    $<HTMLInputElement>('homeMaEnabled'),
    config.multiAgent.enabled,
    previousState?.config.multiAgent.enabled
  );
  ensureVisibleAgentBackend($<HTMLSelectElement>('agentOrchestratorBackend'), execution.orchestrator);
  ensureVisibleAgentBackend($<HTMLSelectElement>('agentWorkerBackend'), execution.worker);
  applyValue(
    $<HTMLSelectElement>('agentOrchestratorBackend'),
    execution.orchestrator,
    previousExecution.orchestrator
  );
  applyValue(
    $<HTMLSelectElement>('agentWorkerBackend'),
    execution.worker,
    previousExecution.worker
  );
  // Recording is a tool switch like the rest of this list, so it goes through the same
  // dirty-field guard rather than being assigned outright from the Chat panel.
  applyChecked(
    $<HTMLInputElement>('sessRecord'),
    config.sessions.record,
    previousState?.config.sessions.record
  );
  paintGroups();
  paintDesktopAccess(next);
  paintSetupDesktopAccess(next);

  if (BUILD_FLAVOR === 'debug') {
    const lan = next.lan;
    const toggle = document.getElementById('debugLanEnabled') as HTMLInputElement | null;
    const status = document.getElementById('debugLanStatus');
    const peers = document.getElementById('debugLanPeers');
    const created = document.getElementById('debugLanCreated');
    const createdInput = document.getElementById('debugLanCreatedKey') as HTMLInputElement | null;
    const copy = document.getElementById('debugLanCopy') as HTMLButtonElement | null;
    const forget = document.getElementById('debugLanForget') as HTMLButtonElement | null;
    const create = document.getElementById('debugLanCreate') as HTMLButtonElement | null;
    if (toggle && status && peers && created && createdInput && copy && forget && create) {
      applyChecked(toggle, lan?.enabled === true, previousState?.lan?.enabled);
      toggle.disabled = lan?.joined !== true;
      forget.disabled = lan?.joined !== true;
      create.disabled = lan?.joined === true;
      const peerCount = lan?.peers.filter((peer) => peer.online).length ?? 0;
      status.textContent = !lan?.joined
        ? 'No LAN group joined.'
        : `${lan.running ? 'Discovery running' : lan.enabled ? 'Discovery waiting' : 'Discovery off'} · ${peerCount} peer${peerCount === 1 ? '' : 's'} online`;
      peers.replaceChildren(...(lan?.peers ?? []).map((peer) => {
        const row = el('div', 'setting');
        const copy = el('span', 'setting-text');
        copy.append(el('b', '', `${peer.nickname}${peer.online ? ' · online' : ' · offline'}`),
          el('em', '', `ParadigmEve ${peer.appVersion} · ${peer.workerCapacity} workers · ${peer.heartbeat.summary}`));
        row.append(copy);
        return row;
      }));
      created.hidden = !lanCreatedJoinKey;
      copy.hidden = !lanCreatedJoinKey;
      createdInput.value = lanCreatedJoinKey ?? '';
    }
  }

  // ---- folders
  paintRoots(config.roots);
  $('rootsEmpty').hidden = config.roots.length > 0;

  // ---- nav badge
  $('setupBadge').hidden = missing === null;

  // ---- wizard
  const instanceName = config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME;
  applyValue(
    $<HTMLInputElement>('instanceName'),
    instanceName,
    previousState?.config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME
  );
  for (const node of document.querySelectorAll<HTMLElement>('[data-instance-name]')) {
    node.textContent = instanceName;
  }
  if (activitySwarm) paintAgentFilter(activitySwarm);
  applyValue(
    $<HTMLSelectElement>('tunnelKind'),
    config.tunnel.kind,
    previousState?.config.tunnel.kind
  );
  ui($('methodHint'), 'textContent', () => t(METHOD_HINT[config.tunnel.kind] ?? ''));
  applyValue($<HTMLInputElement>('tunnelId'), config.tunnel.tunnelId, previousState?.config.tunnel.tunnelId);
  $<HTMLButtonElement>('copyTunnelId').disabled = !TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId);
  paintSetupPrivacy('tunnel');
  paintSetupPrivacy('key');
  applyValue($<HTMLInputElement>('binaryPath'), config.tunnel.binaryPath, previousState?.config.tunnel.binaryPath);
  const chatBrowser = config.ui.chatBrowser ?? 'chrome';
  applyValue($<HTMLSelectElement>('chatBrowser'), chatBrowser, previousState?.config.ui.chatBrowser ?? 'chrome');
  const browserFamily = chatBrowserFamily(chatBrowser);
  ui($('setupBrowserName'), 'textContent', () => t(browserFamily.label));
  ui($('browserExtensionsUrl'), 'textContent', () => browserFamily.extensionsUrl);
  const browserExtensionsAction = $<HTMLButtonElement>('browserExtensionsAction');
  browserExtensionsAction.dataset.setupLink = browserFamily.extensionsUrl;
  ui(browserExtensionsAction, 'textContent', () => t('Open {0} extensions', [browserFamily.label]));
  $<HTMLSelectElement>('planBackend').value = config.ui.planBackend ?? 'chatgpt';
  applyChecked($<HTMLInputElement>('finishTool'), config.ui.finishTool === true, previousState?.config.ui.finishTool);
  applyValue($<HTMLSelectElement>('finishAction'), config.ui.finishAction ?? 'notify', previousState?.config.ui.finishAction);
  applyValue($<HTMLSelectElement>('finishLeadMinutes'), String(config.ui.finishLeadMinutes ?? 5), String(previousState?.config.ui.finishLeadMinutes ?? 5));
  applyChecked($<HTMLInputElement>('backgroundChats'), config.ui.backgroundChats === true, previousState?.config.ui.backgroundChats);
  applyChecked($<HTMLInputElement>('browserOnly'), config.ui.browserOnly === true, previousState?.config.ui.browserOnly);
  applyChecked($<HTMLInputElement>('autoRefreshPlugins'), config.ui.autoRefreshPlugins === true, previousState?.config.ui.autoRefreshPlugins);
  applyConceptSettings(config.ui);
  $('startAtLoginRow').hidden = next.loginStartupAvailable !== true;
  $<HTMLInputElement>('startAtLogin').disabled = next.loginStartupAvailable !== true;
  applyChecked($<HTMLInputElement>('startAtLogin'), config.ui.startAtLogin === true, previousState?.config.ui.startAtLogin);
  applyChecked($<HTMLInputElement>('autoConnect'), config.ui.autoConnect, previousState?.config.ui.autoConnect);
  applyChecked($<HTMLInputElement>('developerMode'), config.ui.developerMode === true, previousState?.config.ui.developerMode);
  applyChecked(
    $<HTMLInputElement>('minimizeToTray'),
    config.ui.minimizeToTray,
    previousState?.config.ui.minimizeToTray
  );
  applyChecked(
    $<HTMLInputElement>('privacyScreenshots'),
    config.ui.privacyScreenshots,
    previousState?.config.ui.privacyScreenshots
  );
  applyChecked(
    $<HTMLInputElement>('eveAllowOtherChats'),
    config.eveAuthority?.allowOtherChats !== false,
    previousState?.config.eveAuthority?.allowOtherChats
  );
  applyChecked(
    $<HTMLInputElement>('eveChangeSettings'),
    config.eveAuthority?.changeSettings === true,
    previousState?.config.eveAuthority?.changeSettings
  );
  applyChecked(
    $<HTMLInputElement>('eveArchiveCompletedWork'),
    config.eveAuthority?.archiveCompletedWork === true,
    previousState?.config.eveAuthority?.archiveCompletedWork
  );
  applyChecked(
    $<HTMLInputElement>('eveControlParadigmEve'),
    config.eveAuthority?.controlParadigmEve === true,
    previousState?.config.eveAuthority?.controlParadigmEve
  );
  $('privacyScreenshotsSetting').hidden = !(next.platform?.desktopAutomation ?? true);
  if (next.platform?.family === 'macos') {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays available from the menu bar and Dock when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Hide the window to the menu bar when closed"));
  } else {
    ui($('backgroundRunningCopy'), 'textContent', () => t("Leave it running while you use the connector. It stays in the tray when you close the window."));
    ui($('minimizeToTrayCopy'), 'textContent', () => t("Keep running in the tray when closed"));
  }

  const openai = config.tunnel.kind === 'openai';
  const browserRequired = browserExtensionRequired(config);
  step('tunnel').hidden = !openai;
  step('key').hidden = !openai;
  step('browser').hidden = !browserRequired;
  ui($('wizFolders'), 'textContent', () => config.roots.length === 0 ? t("None yet") : config.roots.map((r) => `/${r.name}`).join('  '));
  const secureStorageAvailable = next.secureStorage?.available ?? true;
  const apiKey = $<HTMLInputElement>('apiKey');
  ui(apiKey, 'placeholder', () => next.hasApiKey ? t("•••••••• stored") : 'sk-…');
  apiKey.disabled = !secureStorageAvailable;
  ui($('apiKeyState'), 'textContent', () => !secureStorageAvailable
    ? (next.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : next.hasApiKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it, or use Remove stored API key.")
      : t("Stored with secure OS credential storage. It is never shown again and never leaves this app."));
  $('apiKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('removeApiKey').disabled = !next.hasApiKey || !secureStorageAvailable;

  const wizConnect = $<HTMLButtonElement>('wizConnect');
  ui(wizConnect, 'textContent', () => running ? t("Disconnect") : t("Connect"));
  wizConnect.disabled = connectBtn.disabled;
  ui($('wizStatus'), 'textContent', () => running || failed ? status.detail || t(STATUS_TEXT[status.state]) : '');

  $('chatgptConn').replaceChildren(
    openai
      ? frag("For the connection, choose Tunnel and select ", instanceName, " — the tunnel you made in step 2.")
      : frag("For the connection, paste the URL below into ", "MCP server URL", '.')
  );

  // Says plainly whether the connector has ever reached this app, because a
  // FORBIDDEN inside one ChatGPT conversation is not the same as a broken setup.
  // The middle case is the one that costs hours: ChatGPT connects and reads the tool
  // list, but the model is never allowed to call anything — Developer mode is off.
  // Every connector this app is publishing that ChatGPT has never reached. Computed here
  // because it decides three things at once: the summary line, whether step 5 counts as
  // done, and whether the cards stay on screen after the wizard tidies itself away.
  const unverified = status.surfaces.filter(
    (surface) => surface.id !== 'desktop' && surface.available && surface.lastRequestAt === null
  );
  const required = status.surfaces.filter((surface) => surface.available && !surface.optional);
  const requiredMissingTool = required.filter((surface) => surface.lastToolCallAt === null);
  const requiredIncomplete = required.some(
    (surface) => surface.lastRequestAt === null || surface.lastToolCallAt === null
  );
  const requiredToolCallAt = required.reduce<number | null>((latest, surface) => {
    if (surface.lastToolCallAt === null) return latest;
    return latest === null ? surface.lastToolCallAt : Math.max(latest, surface.lastToolCallAt);
  }, null);
  const chatgptNote = $('wizChatgpt');
  chatgptNote.classList.toggle(
    'is-warn',
    status.lastRequestAt !== null && (requiredMissingTool.length > 0 || unverified.length > 0)
  );
  ui(chatgptNote, 'textContent', () => status.lastRequestAt === null
      ? t("ChatGPT has not called this app yet.")
      : requiredMissingTool.length > 0
        ? t("ChatGPT connected {0} but has never run a tool. Check that the app is enabled under ChatGPT → Plugins; on older ChatGPT versions, also turn Developer mode back on if it says “does not support developer MCPs”.", [ago(status.lastRequestAt)])
        : unverified.length > 0
          ? // Name the still-missing app explicitly instead of reducing it to "something is off".
            t("ChatGPT ran a tool {0}, but {1} has never been called — create it in ChatGPT to use it.", [ago(requiredToolCallAt), unverified
              .map((surface) => `“${surface.connectorName}”`)
              .join(' and ')])
          : t("ChatGPT ran a tool {0} — the whole chain works.", [ago(requiredToolCallAt)]));

  const cards = $('connectorCards');
  // An app the user still has to create is unfinished setup, so its card must survive the
  // tidy collapse instead of disappearing behind "Show all steps".
  cards.classList.toggle('has-unfinished', unverified.length > 0 || requiredMissingTool.length > 0);
  cards.replaceChildren(...connectorCards(next));

  // Step marks: everything before the first unfinished step counts as done.
  const done = new Set<string>();
  if (config.roots.length > 0 || missingStep(next)?.step !== 'folder') done.add('folder');
  if (!openai || TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) done.add('tunnel');
  if (!openai || next.hasApiKey) done.add('key');
  const onboardingComplete = config.onboarding?.complete === true;
  if (connected || onboardingComplete) done.add('connect');
  // The only honest proof the final connector step is finished: ChatGPT has discovered and
  // invoked a recognized tool on every required app after the live Companion prerequisite above.
  // The legacy Desktop compatibility endpoint never blocks the one-app onboarding flow.
  if (onboardingComplete || (status.lastRequestAt !== null && !requiredIncomplete)) done.add('chatgpt');
  // Pairing is durable authorization, not liveness. A token surviving an app restart says
  // only that this extension is allowed to connect; setup is complete when a required browser
  // has actually checked in during this process. If no enabled feature needs the browser,
  // this optional step is hidden and deliberately cannot block the wizard.
  if (!browserRequired || next.bridge.present || onboardingComplete) done.add('browser');
  const current = requiredSetupStep(next) as SetupStepName | null;
  for (const name of SETUP_STEP_ORDER) {
    const node = step(name);
    node.classList.toggle('is-done', done.has(name));
    node.classList.toggle('is-current', name === current);
    if (name === current) node.setAttribute('aria-current', 'step');
    else node.removeAttribute('aria-current');
  }

  // Setup that is finished should stop reading like a to-do list: the instructions
  // collapse away so the page fits without scrolling, and come back on request.
  const allDone = current === null;
  $('wizard').classList.toggle('is-tidy', allDone && !showAllSteps);
  const expand = $<HTMLButtonElement>('wizExpand');
  expand.hidden = !allDone;
  ui(expand, 'textContent', () => showAllSteps ? t("Hide finished steps") : t("Show all steps"));
  paintSetupPreview(current);

  const needsBinary = config.tunnel.kind !== 'manual';
  ui($('binaryState'), 'textContent', () => !needsBinary
    ? t("Not needed for this method.")
    : next.resolvedBinary
      ? t("Using {0}", [next.resolvedBinary])
      : t("Not found. Install it, or choose the file with Browse."));
  ui($('versionLine'), 'textContent', () => next.bundledTunnelVersion
    ? t("Recent activity only — no file contents, no credentials. Bundled tunnel-client {0}.", [next.bundledTunnelVersion])
    : t("Recent activity only. File contents and credentials are never recorded."));

  chatApply(next, previousState?.config);
  paintGuidedSetup(guidedSetup);

  applying = false;

  // Fresh installs write an explicit false marker. Legacy configs have no marker at all and are
  // not forced back into onboarding on upgrade, but the next live end-to-end success promotes
  // either shape to durable completion so future restarts no longer depend on process clocks.
  if (next.config.onboarding?.complete !== true && requiredSetupStep(next) === null && !promotingOnboarding) {
    promotingOnboarding = true;
    void run(api.completeSetup()).then((verified) => {
      if (verified) apply(verified);
    }).finally(() => { promotingOnboarding = false; });
  }
}

const SURFACE_STATE_TEXT: Record<SurfaceStatus['state'], string> = {
  off: "Not published",
  starting: "Connecting…",
  live: "Published",
  error: "Problem"
};

/** One copyable value with its own button, so nothing has to be retyped by hand. */
function copyRow(label: string | (() => string), value: string, what: string): HTMLElement {
  const field = el('div', 'field');
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.value = value;
  const button = el('button', 'btn btn-solid');
  (button as HTMLButtonElement).type = 'button';
  button.append(icon('i-copy'), uiText(() => t("Copy")));
  button.addEventListener('click', async () => {
    const copied = await run(api.writeClipboard(value));
    if (copied) toast(t('{0} copied', [t(what)]));
  });
  const row = el('div', 'row-inline');
  row.append(input, button);
  field.append(el('label', '', label), row);
  return field;
}

/**
 * One onboarding card for ParadigmEve, with the exact strings to paste into ChatGPT.
 *
 * The name and the description are offered as copyable text rather than described in
 * prose, because both are load-bearing: ChatGPT matches on the name to address the
 * connector and reads the description to decide whether to load its tools at all. A
 * connector called "my pc" with a description the user invented is one the model may
 * never reach for, and that failure looks exactly like the app being broken.
 */
function connectorCards(next: AppState): HTMLElement[] {
  const { status, config } = next;
  return status.surfaces
    .filter((surface) => surface.id === 'core')
    .map((surface) => {
    const card = el('div', `connector is-${surface.state}`);

    const head = el('div', 'connector-head');
    head.append(
      el('h4', '', surface.connectorName),
      el('span', 'tag', () => t(surface.optional ? 'optional' : 'required')),
      el('span', `pill is-${surface.state}`, () => t(SURFACE_STATE_TEXT[surface.state]))
    );
    card.append(head, el('p', 'hint', () => t(surface.cardSummary)));

    if (!surface.available) {
      card.append(el('p', 'hint', surface.detail));
      return card;
    }

    card.append(copyRow(() => t("Name"), surface.connectorName, 'Name'));
    card.append(copyRow(() => t("Description"), surface.description, 'Description'));

    // On the OpenAI method the connector is picked from a list of tunnels instead of
    // pasted as a URL, so showing a loopback address there would only mislead.
    const url =
      surface.publicUrl ?? (config.tunnel.kind === 'manual' ? surface.localUrl : null);
    if (url) {
      card.append(copyRow(() => t("MCP server URL"), url, 'URL'));
      card.append(
        el('p', 'hint', () => t("Anyone with this URL can use your enabled tools. Do not share it."))
      );
    } else if (config.tunnel.kind === 'openai') {
      card.append(
        el(
          'p',
          'hint',
          () => surface.id === 'core'
              ? t("Choose Tunnel, then pick {0}.", [config.mcp?.connectorName ?? surface.connectorName])
              : !config.tunnel.pluginsTunnelId
                ? t("Create a tunnel for this app and paste its Tunnel ID in step 2 first.")
                : t("Choose Tunnel, then pick this app’s tunnel.")
        )
      );
    }

    if (surface.detail && surface.state === 'error') card.append(el('p', 'hint is-warn', surface.detail));

    // Published is only half the story. "Live" says this app is serving the connector;
    // it says nothing about whether the user ever created it in ChatGPT.
    if (surface.state === 'live') {
      card.append(
        surface.lastRequestAt === null
          ? el('p', 'hint is-warn', () => t("Not created in ChatGPT yet — ChatGPT has never called this connector."))
          : el(
              'p',
              'hint',
              () => surface.lastToolCallAt === null
                ? t("ChatGPT connected {0} but has not run one of its tools yet.", [ago(surface.lastRequestAt)])
                : t("ChatGPT ran one of its tools {0}.", [ago(surface.lastToolCallAt)])
            )
      );
    }

    if (surface.tools.length > 0) {
      card.append(el('p', 'hint', () => t("Tools: {0}", [surface.tools.join(', ')])));
    }
    return card;
    });
}

/**
 * The Health card's plain-fact list: what is actually happening in the background,
 * in the order you would ask about it. A field the tunnel could not report shows a
 * dash rather than a plausible-looking number.
 */
function facts(next: AppState): HTMLElement[] {
  const { status, config } = next;
  const rows: [string, () => string, boolean?][] = [];
  const health = status.health;

  if (isRunning(status.state)) {
    rows.push(['Route to OpenAI', () => health?.route ?? t('Starting…')]);
    rows.push([
      'Poll errors',
      () => health?.pollErrors === null || health?.pollErrors === undefined
        ? '—'
        : String(health.pollErrors),
      (health?.pollErrors ?? 0) > 0
    ]);
    const probe = health?.probe ?? null;
    rows.push([
      'Tunnel → this app',
      () => probe ?? t('Checking…'),
      probe !== null && probe !== 'ok' && probe !== 'success' && probe !== 'healthy'
    ]);
    rows.push(['Tunnel uptime', () => duration(health?.uptimeSeconds ?? null)]);
    // Requests but no tool call is what an account with Developer mode switched off
    // looks like from here, and it is invisible in every other number on this card.
    if (status.lastRequestAt !== null) {
      rows.push([
        'ChatGPT ran a tool',
        () => status.lastToolCallAt === null ? t("never — check the app under ChatGPT → Plugins") : ago(status.lastToolCallAt),
        status.lastToolCallAt === null
      ]);
    }
    if (health?.clientVersion) rows.push(['Tunnel client', () => health.clientVersion!]);
    if (status.localUrl) rows.push(['Local server', () => status.localUrl!.replace(/^https?:\/\//, '')]);
  } else {
    rows.push(['Route to OpenAI', () => t('not running')]);
  }

  rows.push([
    'Tools available',
    () => t(config.roots.length === 1 ? '{0} total · {1} folder' : '{0} total · {1} folders', [toolsOn(next), config.roots.length])
  ]);

  return rows.map(([label, value, bad]) => {
    const row = el('div', 'fact');
    const code = el('code', bad ? 'is-bad' : '', value);
    // The row is cut to fit, so the full value has to stay reachable somehow.
    ui(code, 'title', value);
    row.append(el('span', '', () => t(label)), code);
    return row;
  });
}

/**
 * Repaints only what ages: the two numbers and the header note. Runs every second so
 * "verified 8s ago" keeps counting between reports instead of freezing.
 */
function paintClock(): void {
  if (!state) return;
  const { status } = state;
  const running = isRunning(status.state);
  const connected = status.state === 'connected';

  const handshake = $('bigHandshake');
  handshake.textContent = shortAgo(status.handshakeAt);
  handshake.className = connected ? '' : status.state === 'offline' ? 'is-bad' : 'is-cold';

  const request = $('bigRequest');
  request.textContent = shortAgo(status.lastRequestAt);
  request.className = status.lastRequestAt === null ? 'is-cold' : '';

  ui($('liveNote'), 'textContent', () => running
    ? status.handshakeAt === null
      ? t("no handshake yet")
      : t("verified {0}", [ago(status.handshakeAt)])
    : '');
}

window.setInterval(paintClock, 1000);

function step(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
}

/** Builds "text <strong>bold</strong> text" without touching innerHTML. */
function frag(before: string, bold: string, after: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(uiText(() => t(before)), el('strong', '', () => t(bold)), uiText(() => t(after)));
  return f;
}

// ------------------------------------------------------------------- log

/**
 * Anything the user might have to act on, counted so problems are never buried.
 *
 * Counted from the rows the feed still holds, not from everything that ever arrived.
 * The feed keeps 500 lines and drops the rest, so a running total drifted away from
 * what the Problems filter could actually show: "4 problems" above an empty list,
 * which reads as the filter being broken rather than as the rows having aged out.
 */
function paintProblems(): void {
  const problems = logEntries.filter(entry => entry.level !== 'info').length;
  for (const id of ['homeProblems', 'logProblems']) {
    const badge = $(id);
    badge.hidden = problems === 0;
    ui(badge, 'textContent', () => t(problems === 1 ? '{0} problem' : '{0} problems', [problems]));
  }
}

/**
 * Splits a log line into a short subject and the rest, so the eye can scan the left
 * column. "tunnel: no such host" and "request POST /mcp → 200" both work.
 */
function splitMessage(message: string): [string, string] {
  const colon = message.indexOf(': ');
  if (colon > 0 && colon <= 24) return [message.slice(0, colon), message.slice(colon + 2)];
  const space = message.indexOf(' ');
  if (space > 0 && space <= 24) return [message.slice(0, space), message.slice(space + 1)];
  return [message, ''];
}

function logRow(entry: LogEntry): HTMLElement {
  const [what, rest] = splitMessage(entry.message);
  const line = el('p', entry.level === 'info' ? '' : 'bad');
  if (entry.agent) line.dataset.agent = entry.agent;
  const time = document.createElement('time');
  time.textContent = new Date(entry.time).toLocaleTimeString();
  line.append(time, el('span', 'what', what), el('span', 'rest', rest));
  return line;
}

const FEEDS = ['homeFeed', 'fullFeed'];
const LOG_ENTRY_LIMIT = 500;
const HOME_FEED_LIMIT = 30;
const ACTIVITY_PAGE_SIZE = 60;
const logEntries: LogEntry[] = [];
let activityPage = 0;
let activityProblemsOnly = false;

/**
 * Whether each feed is following the newest line.
 *
 * Remembered rather than measured on every append, because a feed inside a panel that is
 * not on screen has no geometry to measure: `clientHeight` and `scrollHeight` are both 0,
 * every arriving line looks like it was appended at the bottom, and the pin is written as
 * `scrollTop = 0`. That is exactly what the Activity panel did — every line of a session
 * arrived while Home was showing, so opening Activity landed on the oldest line in the
 * buffer and stayed there. A feed is pinned until the user scrolls it up themselves, and
 * scrolling back to the bottom re-pins it.
 */
const pinned = new Map<string, boolean>(FEEDS.map((id) => [id, true]));

function atBottom(view: HTMLElement): boolean {
  return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
}

/** Puts a feed back on its newest line. Safe on a hidden panel: it is re-applied on show. */
function stickToNewest(id: string): void {
  if (pinned.get(id) === false) return;
  const view = $(id);
  view.scrollTop = view.scrollHeight;
}

for (const id of FEEDS) {
  // Only a real user scroll may unpin. `scroll` also fires for the programmatic pin
  // above, which is harmless: that one always lands at the bottom and re-pins.
  $(id).addEventListener('scroll', () => {
    const view = $(id);
    // A hidden panel reports zeroes; never let that be read as "scrolled away".
    if (view.clientHeight === 0) return;
    pinned.set(id, atBottom(view));
  });
}

function rememberLogLine(entry: LogEntry): void {
  logEntries.push(entry);
  while (logEntries.length > LOG_ENTRY_LIMIT) logEntries.shift();
}

function renderHomeFeed(): void {
  const view = $('homeFeed');
  view.replaceChildren(...logEntries.slice(-HOME_FEED_LIMIT).map(logRow));
  stickToNewest('homeFeed');
}

function activityEntries(): LogEntry[] {
  return logEntries.filter((entry) =>
    (!activityProblemsOnly || entry.level !== 'info')
    && (agentFilter === null || entry.agent === agentFilter));
}

function renderActivityFeed(): void {
  const entries = activityEntries();
  const maxPage = Math.max(0, Math.ceil(entries.length / ACTIVITY_PAGE_SIZE) - 1);
  activityPage = Math.min(activityPage, maxPage);
  const end = entries.length - activityPage * ACTIVITY_PAGE_SIZE;
  const start = Math.max(0, end - ACTIVITY_PAGE_SIZE);
  const page = entries.slice(start, end);
  const view = $('fullFeed');
  view.replaceChildren(...page.map(logRow));
  const status = $('logPageStatus');
  ui(status, 'textContent', () => entries.length === 0
    ? t('No activity yet')
    : t('{0}–{1} of {2}', [start + 1, end, entries.length]));
  const older = $<HTMLButtonElement>('logOlder');
  const newer = $<HTMLButtonElement>('logNewer');
  older.disabled = start === 0;
  newer.disabled = activityPage === 0;
  if (activityPage === 0) stickToNewest('fullFeed');
}

function renderLogFeeds(): void {
  renderHomeFeed();
  renderActivityFeed();
  paintProblems();
}

function addLogLine(entry: LogEntry): void {
  rememberLogLine(entry);
  renderLogFeeds();
}

$('logFilter').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  for (const other of $('logFilter').querySelectorAll('button')) {
    other.classList.toggle('is-sel', other === button);
  }
  activityProblemsOnly = button.dataset.filter === 'bad';
  $('fullFeed').classList.toggle('only-bad', activityProblemsOnly);
  activityPage = 0;
  renderActivityFeed();
  // Hiding most of the rows changes what "the bottom" is, so re-pin rather than leaving
  // the view parked at an offset that now belongs to a line the filter removed.
  stickToNewest('fullFeed');
});

$('logOlder').addEventListener('click', () => {
  const maxPage = Math.max(0, Math.ceil(activityEntries().length / ACTIVITY_PAGE_SIZE) - 1);
  activityPage = Math.min(maxPage, activityPage + 1);
  renderActivityFeed();
});

$('logNewer').addEventListener('click', () => {
  activityPage = Math.max(0, activityPage - 1);
  renderActivityFeed();
});

/**
 * Agent filter for the Activity panel.
 *
 * Only exists while a swarm is running: with no workers there is nothing to separate,
 * and the plain single view is the one people already know. null means "All".
 */
let agentFilter: string | null = null;
let activitySwarm: SwarmState | null = null;

function applyAgentFilter(): void {
  activityPage = 0;
  renderActivityFeed();
}

function paintAgentFilter(swarm: SwarmState): void {
  activitySwarm = swarm;
  const box = $('logAgentFilter');
  if (!swarm.running) {
    box.hidden = true;
    box.replaceChildren();
    if (agentFilter !== null) {
      agentFilter = null;
      applyAgentFilter();
    }
    return;
  }
  // The owning agent first, then workers in creation order — the order the broker reports them.
  const choices: Array<{ id: string | null; label: string }> = [{ id: null, label: t("All") }];
  for (const agent of swarm.agents) {
    choices.push({
      id: agent.id,
      label: agent.role === 'prime'
        ? (state?.config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME)
        : (agent.label || agent.id)
    });
  }
  if (agentFilter !== null && !swarm.agents.some((agent) => agent.id === agentFilter)) {
    agentFilter = null;
  }
  box.replaceChildren(
    ...choices.map((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.classList.toggle('is-sel', choice.id === agentFilter);
      button.addEventListener('click', () => {
        agentFilter = choice.id;
        paintAgentFilter(swarm);
        applyAgentFilter();
      });
      return button;
    })
  );
  box.hidden = false;
  applyAgentFilter();
}

// --------------------------------------------------------------- wiring

async function addFolder(): Promise<AppState | null> {
  const next = await run(api.addRoot());
  if (next) {
    guidedSetupNotice = null;
    apply(next);
  }
  return next;
}

/** Whether a drag carries files at all, which is the only kind the Folders card accepts. */
function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Every dropped entry is offered as a folder; the main process says no to anything else. */
async function dropFolders(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files ?? []);
  for (const file of files) {
    const next = await run(api.addRootPath(file));
    if (next) apply(next);
  }
}

async function toggleConnection(): Promise<void> {
  if (!state) return;
  // Mirrors the button label exactly, so a click always does what it says.
  const next = await run(isRunning(state.status.state) ? api.disconnect() : api.connect());
  if (next) apply(next);
}

/** Runs the main-process self-test and lists a line per link in the chain. */
async function runChecks(): Promise<void> {
  const button = $<HTMLButtonElement>('runChecks');
  button.disabled = true;
  ui($('runChecksLabel'), 'textContent', () => t("Checking…"));
  try {
    const result = await run(api.runDiagnostics());
    if (!result) return;
    $('checksSummary').textContent = result.summary;
    $('checkList').replaceChildren(
      ...result.checks.map((check) => {
        const li = el(
          'li',
          check.status === 'pass'
            ? 'check is-ok'
            : check.status === 'fail'
              ? 'check is-bad'
              : `check is-${check.status}`
        );
        const mark = el(
          'span',
          'check-mark',
          check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : check.status === 'skipped' ? '–' : '…'
        );
        const body = el('div');
        body.append(el('strong', '', check.name), el('p', '', check.detail));
        li.append(mark, body);
        return li;
      })
    );
    $('checksBox').hidden = false;
    $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    button.disabled = false;
    ui($('runChecksLabel'), 'textContent', () => t("Run checks"));
  }
}

$('runChecks').addEventListener('click', () => void runChecks());
$('requestDesktopAccessibility').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('requestDesktopAccessibility');
  button.disabled = true;
  try {
    const next = await run(api.requestDesktopAccessibility());
    if (next) apply(next);
  } finally {
    button.disabled = false;
  }
});
$('setupRequestDesktopAccessibility').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('setupRequestDesktopAccessibility');
  button.disabled = true;
  try {
    const next = await run(api.requestDesktopAccessibility());
    if (next) apply(next);
  } finally {
    button.disabled = false;
  }
});
$('closeChecks').addEventListener('click', () => {
  $('checksBox').hidden = true;
});

$('themeBtn').addEventListener('click', () => {
  if (!state) return;
  // A save can still be waiting on main-process lifecycle work. Toggle from the latest
  // requested value, not merely the last acknowledged state, or two quick clicks both choose
  // the same target and behave like one click.
  const current = requestedSettings?.ui.theme ?? state.config.ui.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  // Applied immediately so the click feels instant; the save confirms it.
  document.documentElement.dataset.theme = next;
  const dark = next === 'dark';
  const label = t(dark ? "Switch to light mode" : "Switch to dark mode");
  $('themeBtn').setAttribute('title', label);
  $('themeBtn').setAttribute('aria-label', label);
  $('themeBtn').setAttribute('aria-pressed', dark ? 'true' : 'false');
  void save({ theme: next });
});

$('readOnlyBtn').addEventListener('click', () => {
  if (!state) return;
  const current = requestedSettings?.readOnly ?? state.config.readOnly;
  void save({ readOnly: !current });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('wizAddFolder').addEventListener('click', () => void addFolder());
$('wizManageFolders').addEventListener('click', () => {
  showTab('home');
  $('foldersCard').scrollIntoView({ block: 'nearest' });
  $('addFolder').focus({ preventScroll: true });
});

// Dropping a file anywhere on an Electron window otherwise navigates the whole window to
// it. Only the Folders card accepts drops, and everything else swallows them.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
{
  const card = $('foldersCard');
  card.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('drop-target');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (dragHasFiles(event)) void dropFolders(event);
  });
}

$('wizExpand').addEventListener('click', () => {
  concealSetupSecrets();
  showAllSteps = !showAllSteps;
  if (!showAllSteps) previewSetupStep = null;
  if (state) apply(state);
});

$('wizard').addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-preview-step]');
  if (!button || button.disabled) return;
  const requested = button.dataset.previewStep;
  if (!SETUP_STEP_ORDER.includes(requested as SetupStepName)) return;
  concealSetupSecrets();
  previewSetupStep = requested as SetupStepName;
  // A completed setup normally folds its instructions. Selecting any numbered step is an
  // explicit request to review those instructions, so unfold them without changing progress.
  showAllSteps = true;
  $('wizard').classList.remove('is-tidy');
  const expand = $<HTMLButtonElement>('wizExpand');
  if (!expand.hidden) ui(expand, 'textContent', () => t('Hide finished steps'));
  paintSetupPreview(state ? requiredSetupStep(state) as SetupStepName | null : null);
  step(previewSetupStep).scrollIntoView({ block: 'nearest' });
});

$('tunnelPrivacy').addEventListener('click', () => toggleSetupPrivacy('tunnel'));
$('apiKeyPrivacy').addEventListener('mousedown', (event) => {
  // Keep a pasted key focused while the user reveals it. Otherwise the existing blur-to-store
  // behavior would securely save and clear the value before the eye click can show it.
  event.preventDefault();
});
$('apiKeyPrivacy').addEventListener('click', () => toggleSetupPrivacy('key'));

async function copyTunnelField(id: 'tunnelId', label: string): Promise<void> {
  const value = $<HTMLInputElement>(id).value.trim();
  if (!TUNNEL_ID_PATTERN.test(value)) return;
  if (await run(api.writeClipboard(value))) toast(`${label} copied`);
}

$('copyTunnelId').addEventListener('click', () => void copyTunnelField(
  'tunnelId',
  `${state?.config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME} Tunnel ID`
));
$('connectorIconFile').addEventListener('click', () => void run(api.showConnectorIcon()));
$<HTMLInputElement>('setupComputerUse').addEventListener('change', () => {
  const on = $<HTMLInputElement>('setupComputerUse').checked;
  for (const capability of DESKTOP_CAPABILITIES) capInput(capability).checked = on;
  paintGroups();
  void save();
});

/**
 * Install the update that is already downloaded.
 *
 * The app quits to do it — that is the only moment an installer can replace files nothing is
 * holding open — so say so before it happens rather than leaving a window that vanishes on a
 * click looking like a crash. Both buttons are the same action; either can be the one pressed.
 */
function installUpdate(): void {
  toast(t("Installing the update. ParadigmEve closes and starts again as the new version."));
  void run(api.installUpdate());
}

function paintGuidedSetup(next: SetupAssistantSnapshot | null): void {
  guidedSetup = next;
  const start = $<HTMLButtonElement>('guidedSetup');
  const status = $('guidedSetupStatus');
  const needsFolder = (state?.config.roots.length ?? 0) === 0;
  const running = next?.running === true;
  const ready = !running && !guidedSetupPickingFolder;
  start.disabled = guidedSetupPickingFolder;
  start.classList.toggle('is-ready', ready);
  ui(start, 'textContent', () => t(
    running
      ? 'Stop guided setup'
      : guidedSetupPickingFolder
        ? 'Choosing folder…'
        : needsFolder
          ? 'Choose folder & start guided setup'
          : 'Start guided browser setup'
  ));
  status.classList.toggle('is-ready', ready && next === null && guidedSetupNotice === null);
  if (guidedSetupPickingFolder) {
    ui(status, 'textContent', () => t('Choose a folder in the picker. Guided setup will continue automatically after you approve it.'));
    status.classList.remove('is-warn');
  } else if (guidedSetupNotice) {
    ui(status, 'textContent', () => t(guidedSetupNotice!));
    status.classList.remove('is-warn');
  } else if (next) {
    ui(status, 'textContent', () => {
      const connectorName = state?.config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME;
      // Main-process setup status is app-authored copy, but two stages interpolate the
      // per-install connector name before the snapshot reaches the renderer. Recover the
      // catalog template here so Swedish can translate the chrome while the user's Unicode
      // connector name remains byte-for-byte unchanged. Unknown/runtime error text falls
      // through t() unchanged.
      const direct = t(next.detail);
      if (direct !== next.detail) return direct;
      const source = connectorName ? next.detail.split(connectorName).join('{0}') : next.detail;
      return t(source, [connectorName]);
    });
    status.classList.toggle('is-warn', next.stage === 'error');
  } else if (needsFolder) {
    ui(status, 'textContent', () => t('Start opens the folder picker first, then continues guided setup automatically in one dedicated Eve Browser profile.'));
    status.classList.remove('is-warn');
  } else {
    ui(status, 'textContent', () => t("ParadigmEve can guide sign-in, the companion, tunnel and ChatGPT connector setup without a separate guide."));
    status.classList.remove('is-warn');
  }
}

$('updateInstall').addEventListener('click', installUpdate);
$('updateRelease').addEventListener('click', () => {
  const url = state?.update.releaseUrl;
  if (url) void window.api.openLink(url).catch((err: Error) => toast(err.message));
});
$('installUpdate').addEventListener('click', installUpdate);
$<HTMLButtonElement>('eveBrowserTab').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('eveBrowserTab');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const next = await run(api.openCompanionBrowserTab());
    if (next) apply(next);
  } finally {
    button.disabled = false;
  }
});
$('companionBrowserAction').addEventListener('click', async () => {
  if (restoringCompanionBrowser || !state) return;
  restoringCompanionBrowser = true;
  paintCompanionBrowser(state);
  try {
    const next = await run(api.restoreCompanionBrowser());
    if (next) apply(next);
  } finally {
    restoringCompanionBrowser = false;
    if (state) paintCompanionBrowser(state);
  }
});
$('connectBtn').addEventListener('click', () => void toggleConnection());
$('wizConnect').addEventListener('click', () => void toggleConnection());
$('guidedSetup').addEventListener('click', async () => {
  if (guidedSetup?.running === true) {
    const next = await run(api.stopGuidedSetup());
    if (next) paintGuidedSetup(next);
    return;
  }

  guidedSetupNotice = null;
  if ((state?.config.roots.length ?? 0) === 0) {
    guidedSetupPickingFolder = true;
    paintGuidedSetup(guidedSetup);
    const withFolder = await addFolder();
    guidedSetupPickingFolder = false;
    if (!withFolder || withFolder.config.roots.length === 0) {
      guidedSetupNotice = 'No folder was added. Setup is still open; choose Start when you are ready.';
      paintGuidedSetup(guidedSetup);
      return;
    }
  }

  const next = await run(api.startGuidedSetup());
  if (next) {
    paintGuidedSetup(next);
  } else {
    guidedSetupNotice = 'Guided setup did not start. Setup is still open; choose Start to try again.';
    paintGuidedSetup(guidedSetup);
  }
});

$('pickBinary').addEventListener('click', async () => {
  const next = await run(api.pickBinary());
  if (next) apply(next);
});


for (const id of ['copyLog', 'copyLogText']) {
  $(id).addEventListener('click', async () => {
    const text = await run(api.getLogText());
    if (text === null) return;
    const copied = await run(api.writeClipboard(text));
    if (copied) toast('Activity copied');
  });
}

$('copyLogJson').addEventListener('click', async () => {
  const text = await run(api.getLogJson());
  if (text === null) return;
  const copied = await run(api.writeClipboard(text));
  if (copied) toast('Activity JSON copied');
});

// The API key is written on blur so it is not saved keystroke by keystroke.
$('apiKey').addEventListener('blur', async () => {
  const input = $<HTMLInputElement>('apiKey');
  const submitted = input.value;
  if (submitted === '') return;
  const next = await run(api.setApiKey(submitted));
  if (next) {
    // Do not erase a newer value typed while safeStorage/IPC was still resolving the previous
    // blur. On failure keep the submitted value too, so the user can retry instead of losing it.
    if (input.value === submitted) input.value = '';
    apply(next);
    toast('API key stored');
  }
});

$('removeApiKey').addEventListener('click', async () => {
  const next = await run(api.setApiKey(''));
  if (next) {
    apply(next);
    toast('API key removed');
  }
});

for (const id of [
  'autoConnect',
  'startAtLogin',
  'minimizeToTray',
  'developerMode',
  'privacyScreenshots',
  'tunnelKind',
  'tunnelId',
  'instanceName',
  'agentOrchestratorBackend',
  'agentWorkerBackend'
]) {
  $(id).addEventListener('change', () => void save());
}

$('eveAllowOtherChats').addEventListener('change', () => void save());
$('eveChangeSettings').addEventListener('change', () => {
  const settings = $<HTMLInputElement>('eveChangeSettings');
  if (!settings.checked) $<HTMLInputElement>('eveControlParadigmEve').checked = false;
  void save();
});
$('eveArchiveCompletedWork').addEventListener('change', () => void save());
$('eveControlParadigmEve').addEventListener('change', () => {
  const control = $<HTMLInputElement>('eveControlParadigmEve');
  if (control.checked) $<HTMLInputElement>('eveChangeSettings').checked = true;
  void save();
});

document.addEventListener('click', (event) => {
  const setupLink = (event.target as HTMLElement).closest<HTMLElement>('[data-setup-link]');
  if (setupLink?.dataset.setupLink) {
    void run(api.openSetupLink(setupLink.dataset.setupLink));
    return;
  }
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) void run(api.openLink(link.dataset.link));
});

$('updateExtension').addEventListener('click', () => {
  if (state && updateSummary(state)?.extensionActionKind === 'browser') {
    $<HTMLButtonElement>('companionBrowserAction').click();
    return;
  }
  showAllSteps = true;
  if (state) apply(state);
  showTab('setup');
  step('browser').hidden = false;
  step('browser').scrollIntoView({ block: 'center', behavior: 'smooth' });
});

api.onStateChanged(apply);
api.onLogEntry(addLogLine);
api.onSwarmChanged(paintAgentFilter);
api.onSetupChanged(paintGuidedSetup);

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();
initSidebarResize();
initUsage();
initPlugins(apply);
// Desktop pets: the overlay is a separate native window; this window only lists and toggles them.
const pets = initPet(() => showTab('pets'));
initPets(pets);
const paintViewPets = (): void => { $('viewPets').setAttribute('aria-pressed', String(pets.isVisible())); };
pets.onChange(paintViewPets);
paintViewPets();
$('viewPets').addEventListener('click', () => pets.toggle());
api.onPetOverlayOpenOwner(screen => showTab(screen === 'pets' ? 'pets' : 'chat'));
initBrowserPreferences();
initWorkspaceNavigation({ screen: 'chat' });
initChat({ save: () => save(), state: () => state });

void (async () => {
  await refresh();
  paintGuidedSetup(await run(api.setupStatus()));
  // Onboarding owns startup until every required step is complete. Optional surfaces do not
  // keep pulling an otherwise configured user back into Setup on later launches.
  // Only a new-version config explicitly marked incomplete owns startup. Older installed configs
  // predate the durable marker, so an app upgrade must not reinterpret a quiet browser/tunnel as
  // "first run" and strand an existing user in Setup.
  const startupState = state as AppState | null;
  showTab(startupState && startupState.config.onboarding?.complete === false && requiredSetupStep(startupState) !== null ? 'setup' : 'chat');
  const entries = await run(api.getLog());
  for (const entry of entries ?? []) rememberLogLine(entry);
  renderLogFeeds();
  const swarm = await run(api.getSwarm());
  if (swarm) paintAgentFilter(swarm);
})();
