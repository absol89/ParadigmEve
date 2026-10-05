import type { ChatModelCatalog } from '../shared/chat-models.js';
import type { TaskProgress } from '../shared/task-progress.js';
import type { BrowserPreferences } from '../shared/browser-preferences.js';
import type { SessionControlsView } from '../main/bridge.js';
import type { InputAttachment } from '../shared/input.js';
import type { UsageOverview } from '../shared/usage.js';
import type { PetLibraryState, PetOverlayControlState, PetRuntimeAsset } from '../shared/pets.js';
import type { InputArgs, InputEntry } from '../main/session/input.js';
import type { ProviderSwitchPreview } from '../main/session/provider-history.js';
import type {
  ArchiveRendererOpenResult,
  ArchiveRendererRebuildResult,
  ArchiveRendererStatus
} from '../shared/archive-renderer.js';
import type { LocalProject } from '../shared/projects.js';
import type { PlanCreate, PlanLibrary, PlanPatch, PlanView } from '../shared/plans.js';
import type { ScheduleReadProjection } from '../shared/schedule-projection.js';
import type { StarterThreadEntry, ThreadSettingsEntry } from '../shared/default-threads.js';
import type {
  CreatePinInput,
  CreatePinResult,
  Pin,
  PinsLibrarySnapshot,
  Quilt,
  QuiltCollection,
  QuiltState
} from '../shared/pins.js';
import type { PluginSnapshot, PluginInstallRequest, PluginConfigPatch } from '../shared/plugins.js';
import type { SetupAssistantSnapshot } from '../main/setup-assistant.js';
import type {
  EveCronEditableEntry,
  EveCronUiCreateRequest,
  EveCronUiUpdateRequest,
  UserScheduleEditableInput,
  UserScheduleEditableRecord
} from '../shared/schedule-mutations.js';
/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry } from '../shared/types.js';
import type {
  Handoff,
  ReasoningEffort,
  SessionEvent,
  SessionSummary,
  ClearAgentResult,
  SwarmState,
  TokenPressure
} from '../shared/session.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

export interface SettingsPatch {
  /** Optional for backward-compatible callers; the current renderer sends its visible driver choices. */
  execution?: Config['execution'];
  /** Dedicated local worker runtime settings; intentionally separate from Goal/Loop providers. */
  agentRuntime?: Config['agentRuntime'];
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: Config['tunnel'];
  ui: Config['ui'];
  eveAuthority?: Config['eveAuthority'];
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
  mcp: Config['mcp'];
}

/** One page of the model catalogue, as the model picker asks for it. */
export interface GoalModelPage {
  models: Array<{ id: string; name: string; created: number; contextLength: number }>;
  total: number;
}

export interface LanActionResult {
  state: AppState;
  /** Returned only by the explicit Create action and never included in ordinary AppState. */
  joinKey: string | null;
}

export interface SessionList {
  sessions: SessionSummary[];
  activeId: string | null;
  /** ChatGPT conversation ids the user has blocked from using local tools. */
  blocked: string[];
  pressure: Array<TokenPressure & { id: string }>;
  /** Total retained sessions, not merely the current IPC page. */
  total: number;
  nextCursor: SessionListCursor | null;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
  /** First sequence not represented by this response; pass back as `from` for live deltas. */
  nextFrom: number;
}

const api = {
  openLegalNotices: () => call<void>('plugins:legalNotices'),
  pluginsSnapshot: () => call<PluginSnapshot>('plugins:snapshot'),
  pluginsInstall: (request: PluginInstallRequest) => call<PluginSnapshot>('plugins:install', request),
  pluginsConfigure: (id: string, patch: PluginConfigPatch) => call<PluginSnapshot>('plugins:configure', { id, patch }),
  pluginsRestart: (id: string) => call<PluginSnapshot>('plugins:restart', { id }),
  pluginsAuthenticate: (id: string) => call<PluginSnapshot>('plugins:authenticate', { id }),
  pluginsCancelAuthentication: (id: string) => call<PluginSnapshot>('plugins:cancelAuthentication', { id }),
  pluginsUpdate: (id: string) => call<PluginSnapshot>('plugins:update', { id }),
  pluginsUninstall: (id: string) => call<PluginSnapshot>('plugins:uninstall', { id }),
  pluginsSetEnabled: (id: string, enabled: boolean) => call<PluginSnapshot>('plugins:enabled', { id, enabled }),
  pluginsSetToolEnabled: (id: string, name: string, enabled: boolean) => call<PluginSnapshot>('plugins:tool', { id, name, enabled }),
  pluginsImportBundle: () => call<string | null>('plugins:importBundle'),
  onPluginsChanged: (listener: (snapshot: PluginSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: PluginSnapshot): void => listener(snapshot);
    ipcRenderer.on('plugins:changed', wrapped);
    return () => ipcRenderer.removeListener('plugins:changed', wrapped);
  },
  chooseFiles: () => call<InputAttachment[]>('sessions:files'),
  dropFiles: async (files: File[]): Promise<Reply<InputAttachment[]>> => {
    if (!files.length || files.length > 20) return { ok: false, error: 'Attach up to 20 files per message' };
    try {
      const sources = [];
      for (const file of files) {
        const path = webUtils.getPathForFile(file);
        if (!path && file.size > 12 * 1024 * 1024) return { ok: false, error: 'Pasted images must be 12 MB or smaller' };
        sources.push(path || { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      return await call<InputAttachment[]>('sessions:dropFiles', { files: sources });
    } catch { return { ok: false, error: 'Could not read the attachment' }; }
  },
  attachText: (text: string) => call<InputAttachment>('sessions:attachText', { text }),
  getUsage: () => call<UsageOverview>('usage:get'),
  petsList: () => call<PetLibraryState>('pets:list'),
  petsOverlayState: () => call<PetOverlayControlState>('pets:overlayState'),
  petsSetOverlayVisible: (visible: boolean) => call<PetOverlayControlState>('pets:overlayVisible', { visible }),
  petsImport: () => call<PetLibraryState | null>('pets:import'),
  petsSetEnabled: (id: string, enabled: boolean) => call<PetLibraryState>('pets:enabled', { id, enabled }),
  petsSetFavorite: (id: string, favorite: boolean) => call<PetLibraryState>('pets:favorite', { id, favorite }),
  petsDelete: (id: string) => call<PetLibraryState>('pets:delete', { id }),
  setUiLanguage: (language: 'en' | 'sv-SE' | 'es-419') => call<boolean>('ui:setLanguage', { language }),
  petsRename: (id: string, name: string) => call<PetLibraryState>('pets:rename', { id, name }),
  petsAsset: (id: string, preview = false) => call<PetRuntimeAsset>('pets:asset', { id, preview }),
  onPetOverlayStateChanged: (listener: (state: PetOverlayControlState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetOverlayControlState): void => listener(state);
    ipcRenderer.on('pet-overlay:stateChanged', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:stateChanged', wrapped);
  },
  onPetOverlayOpenOwner: (listener: (screen: 'chat' | 'pets') => void): (() => void) => {
    const wrapped = (_event: unknown, screen: 'chat' | 'pets'): void => listener(screen);
    ipcRenderer.on('pet-overlay:openOwner', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:openOwner', wrapped);
  },
  getState: () => call<AppState>('state:get'),
  repairReadiness: () => call<AppState>('readiness:repair'),
  saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
  lanAction: (request:
    | { action: 'create' }
    | { action: 'join'; key: string }
    | { action: 'set-enabled'; enabled: boolean }
    | { action: 'forget' }
  ) => call<LanActionResult>('lan:action', request),
  addRoot: () => call<AppState>('roots:add'),
  /** A folder dropped on the window; only the preload can learn a dropped File's path. */
  addRootPath: (file: File) => call<AppState>('roots:addPath', { path: webUtils.getPathForFile(file) }),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  setApiKey: (value: string) => call<AppState>('secret:set', { value }),
  // The goal loop's own credential. Same channel, named slot; the value only ever goes in.
  setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
  // The same, for a custom provider endpoint. Optional: keyless local servers need nothing stored.
  setCustomProviderKey: (value: string) => call<AppState>('secret:set', { value, key: 'customProviderApiKey' }),
  setOllamaKey: (value: string) => call<AppState>('secret:set', { value, key: 'ollamaApiKey' }),
  listOllamaModels: () => call<Array<{ id: string; route: 'chatgpt' | 'ollama-local' | 'ollama-cloud'; cloud: boolean; installed: boolean; vision?: boolean }>>('ollama:models'),
  providerPreview: (id: string, provider: { id: 'ollama'; model: string } | null, traceId?: string) =>
    call<ProviderSwitchPreview>('sessions:providerPreview', { id, provider, ...(traceId ? { traceId } : {}) }),
  providerSwitchMark: (id: string, step: string, ms: number) => call<boolean>('diagnostics:providerSwitchMark', { id, step, ms }),
  setSessionLocalOnly: (id: string, localOnly: boolean) => call<SessionSummary | null>('sessions:setLocalOnly', { id, localOnly }),
  listGoalModels: (offset: number) => call<GoalModelPage>('goal:models', { offset }),
  pickBinary: () => call<AppState>('binary:pick'),
  connect: () => call<AppState>('connection:connect'),
  disconnect: () => call<AppState>('connection:disconnect'),
  runDiagnostics: () => call<Diagnosis>('diagnostics:run'),
  requestDesktopAccessibility: () => call<AppState>('desktop:requestAccessibility'),
  getLog: () => call<LogEntry[]>('log:get'),
  getLogText: () => call<string>('log:text'),
  getLogJson: () => call<string>('log:json'),
  writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
  openLink: (url: string) => call<boolean>('link:open', { url }),
  /** Opens only the destination stored on this exact durable Thread; renderer never supplies a filesystem path. */
  openThreadDestination: (threadId: string) => call<boolean>('pins:openDestination', { threadId }),
  openSetupLink: (url: string) => call<boolean>('setup:openLink', { url }),
  showConnectorIcon: () => call<boolean>('setup:showConnectorIcon'),
  // Applies the update this app has already downloaded and verified: the app quits, the
  // installer runs, and the app comes back as the new version. It takes no argument because
  // there is nothing here to choose - the main process knows what is staged.
  installUpdate: () => call<boolean>('update:install'),

  // Sessions, compaction and the browser bridge. Everything here is read-only or a
  // named action; there is still no channel that takes a path or a command.
  listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
    call<SessionList>('sessions:list', options ?? {}),
  listProjects: () => call<LocalProject[]>('projects:list'),
  addProject: () => call<LocalProject | null>('projects:add'),
  startExpenses: (language: 'en' | 'sv-SE' | 'es-419') => call<{ project: LocalProject; session: SessionSummary | null } | null>('projects:startExpenses', { language }),
  removeProject: (id: string) => call<LocalProject>('projects:remove', { id }),
  linkNativeProject: (id: string, value: string | null) => call<LocalProject>('projects:linkNative', { id, value }),
  listPlans: () => call<PlanLibrary>('plans:list'),
  readScheduleProjection: () => call<ScheduleReadProjection>('schedule:read'),
  archiveStatus: () => call<ArchiveRendererStatus>('archive:status'),
  archiveRebuild: () => call<ArchiveRendererRebuildResult>('archive:rebuild'),
  archiveOpenStatic: () => call<ArchiveRendererOpenResult>('archive:openStatic'),
  ensureSessionPlan: (id: string) => call<PlanView | null>('plans:ensureSession', { id }),
  createPlan: (input: PlanCreate) => call<PlanView>('plans:create', input),
  updatePlan: (id: string, patch: PlanPatch, expectedUpdatedAt: number) =>
    call<PlanView>('plans:update', { id, patch, expectedUpdatedAt }),
  archivePlan: (id: string) => call<PlanView>('plans:archive', { id }),
  cancelPlan: (id: string) => call<PlanView>('plans:cancel', { id }),
  sendPlanRevision: (id: string, revision: number) => call<PlanView>('plans:send', { id, revision }),
  onPlansChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('plans:changed', wrapped);
    return () => ipcRenderer.removeListener('plans:changed', wrapped);
  },
  listEveCronEntries: () => call<EveCronEditableEntry[]>('schedule:eve:list'),
  createEveCronEntry: (input: EveCronUiCreateRequest) => call<EveCronEditableEntry>('schedule:eve:create', input),
  updateEveCronEntry: (input: EveCronUiUpdateRequest) => call<EveCronEditableEntry>('schedule:eve:update', input),
  setEveCronEntryState: (id: string, state: 'enabled' | 'paused', expectedUpdatedAt: number) =>
    call<EveCronEditableEntry>('schedule:eve:setState', { id, state, expectedUpdatedAt }),
  getUserSchedule: () => call<UserScheduleEditableRecord | null>('schedule:user:get'),
  replaceUserSchedule: (schedule: UserScheduleEditableInput, expectedUpdatedAt: number | null) =>
    call<UserScheduleEditableRecord>('schedule:user:replace', { schedule, expectedUpdatedAt }),
  onScheduleChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('schedule:changed', wrapped);
    return () => ipcRenderer.removeListener('schedule:changed', wrapped);
  },
  getPinsLibrary: () => call<PinsLibrarySnapshot>('pins:snapshot'),
  getThreadSettingsEntries: () => call<ThreadSettingsEntry[]>('pins:settingsEntries'),
  getStarterThread: (starterId: string) => call<StarterThreadEntry | null>('pins:starterThread', { starterId }),
  createPin: (input: CreatePinInput) => call<CreatePinResult>('pins:create', input),
  removePin: (pinId: string) => call<boolean>('pins:remove', { pinId }),
  setPinSticky: (pinId: string, sticky: boolean) => call<Pin>('pins:setSticky', { pinId, sticky }),
  createQuilt: (title: string, collectionIds: string[] = [], description?: string) =>
    call<Quilt>('pins:createQuilt', { title, collectionIds, ...(description ? { description } : {}) }),
  createThread: (input: { title: string; description?: string; prompt?: string; link?: string; collectionNames?: string[] }) =>
    call<Quilt>('pins:createThread', input),
  deleteQuilt: (quiltId: string) => call<boolean>('pins:deleteQuilt', { quiltId }),
  createCollection: (name: string) => call<QuiltCollection>('pins:createCollection', { name }),
  updateQuilt: (quiltId: string, title: string, description: string, collectionNames: string[], link?: string) =>
    call<Quilt>('pins:updateQuilt', { quiltId, title, description, collectionNames, ...(link !== undefined ? { link } : {}) }),
  setQuiltPrompt: (quiltId: string, prompt: string) => call<Quilt>('pins:setQuiltPrompt', { quiltId, prompt }),
  setQuiltState: (quiltId: string, state: QuiltState) => call<Quilt>('pins:setQuiltState', { quiltId, state }),
  setQuiltCollections: (quiltId: string, collectionIds: string[]) =>
    call<Quilt>('pins:setQuiltCollections', { quiltId, collectionIds }),
  onPinsChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('pins:changed', wrapped);
    return () => ipcRenderer.removeListener('pins:changed', wrapped);
  },
  getSessionImage: (id: string, assetId: string) => call<string | null>('sessions:image', { id, assetId }),
  getSessionImageThumbnail: (id: string, assetId: string) => call<string | null>('sessions:imageThumbnail', { id, assetId }),
  getSession: (id: string, options?: { from?: number; before?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  stopSessionTurn: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:stopTurn', { id, expectedTurnId }),
  releaseSessionFinish: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:releaseFinish', { id, expectedTurnId }),
  generateFinishGoal: (id: string, expectedTurnId: string) => call<string>('sessions:generateFinishGoal', { id, expectedTurnId }),
  getChatModels: () => call<ChatModelCatalog>('chatModels:get'),
  setChatModelPreference: (model: string | null, reasoningEffort: ReasoningEffort | null) =>
    call<AppState>('chatModels:preference', { model, reasoningEffort }),
  browserPreferences: (patch: Partial<BrowserPreferences> = {}) => call<BrowserPreferences>('browser:preferences', patch),
  openCompanionBrowserTab: () => call<AppState>('browser:openCompanionTab'),
  restoreCompanionBrowser: () => call<AppState>('browser:restoreCompanion'),
  requestChatModels: () => call<ChatModelCatalog>('chatModels:request'),
  onChatModelsChanged: (listener: (catalog: ChatModelCatalog) => void): (() => void) => {
    const wrapped = (_event: unknown, catalog: ChatModelCatalog): void => listener(catalog);
    ipcRenderer.on('chatModels:changed', wrapped);
    return () => ipcRenderer.removeListener('chatModels:changed', wrapped);
  },
  getSessionControls: (id: string) => call<SessionControlsView>('sessions:controls', { id }),
  setSessionAutomation: (id: string, automation: SessionControlsView['automation']) => call<SessionControlsView>('sessions:automation', { id, automation }),
  setSessionObjective: (id: string, text: string, mode: 'goal' | 'loop') => call<SessionControlsView>('sessions:objective', { id, text, mode }),
  compactSession: (id: string) => call<SessionControlsView>('sessions:compact', { id }),
  cancelSessionCompaction: (id: string) => call<SessionControlsView>('sessions:cancelCompaction', { id }),
  draftTaskPlan: (text: string, backend: 'api' | 'chatgpt', requestId?: string) => call<string[]>('sessions:plan', { text, backend, requestId }),
  sendInput: (input: InputArgs) => call<InputEntry>('sessions:send', input),
  retryInputBrowser: (id: string) => call<InputEntry | null>('sessions:retryBrowser', { id }),
  listInputs: () => call<InputEntry[]>('sessions:outbox'),
  listPausedHelpers: () => call<Array<{ id: string; sourceSessionId: string }>>('sessions:pausedHelpers'),
  retryHelper: (id: string, sourceSessionId: string) => call<boolean>('sessions:retryHelper', { id, sourceSessionId }),
  editQueuedInput: (id: string, text: string, afterTurn?: boolean) => call<boolean>('sessions:editInput', { id, text, afterTurn }),
  reorderQueuedInputs: (sessionId: string, ids: string[]) => call<boolean>('sessions:reorderInputs', { sessionId, ids }),
  cancelInput: (id: string) => call<boolean>('sessions:cancelInput', { id }),
  setInputAutomation: (id: string, mode: 'off' | 'goal' | 'loop') => call<boolean>('sessions:inputAutomation', { id, mode }),
  setZoom: (factor: number) => call<number>('window:zoom', { factor }),
  getZoom: () => call<number>('window:getZoom'),
  openSessionChat: (id: string) => call<boolean>('sessions:openChat', { id }),
  // Stops a chat this app cannot stop in the page: every tool call it has already been proved
  // to own is refused until it is released. Returns the whole blocked set, so one press
  // repaints without a second read.
  setSessionBlocked: (id: string, blocked: boolean) => call<string[]>('sessions:block', { id, blocked }),
  deleteSession: (id: string) => call<boolean>('sessions:delete', { id }),
  getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId }),

  unpairExtension: () => call<AppState>('bridge:unpair'),
  // The renderer can ask where the extension is and ask for it to be opened, but the
  // path it gets back is only ever displayed: the open happens in the main process
  // against a folder the renderer never chose.
  extensionPath: () => call<string | null>('bridge:extensionPath'),
  openExtensionFolder: () => call<string>('bridge:openExtensionFolder'),
  setupStatus: () => call<SetupAssistantSnapshot>('setup:status'),
  completeSetup: () => call<AppState>('setup:complete'),
  startGuidedSetup: (language: 'en' | 'sv-SE' | 'es-419') => call<SetupAssistantSnapshot>('setup:start', { language }),
  stopGuidedSetup: () => call<SetupAssistantSnapshot>('setup:stop'),
  onSetupChanged: (listener: (snapshot: SetupAssistantSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: SetupAssistantSnapshot): void => listener(snapshot);
    ipcRenderer.on('setup:changed', wrapped);
    return () => ipcRenderer.removeListener('setup:changed', wrapped);
  },

  getSwarm: () => call<SwarmState>('swarm:get'),
  resetSwarm: () => call<SwarmState>('swarm:reset'),
  // Clearing the prime ends the run; clearing a worker frees that slot. Which of the two
  // happened comes back in the result — the renderer does not decide it.
  clearAgent: (id: string, runId?: string) => call<ClearAgentResult>('swarm:clearAgent', { id, runId }),

  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on('state:changed', wrapped);
    return () => ipcRenderer.removeListener('state:changed', wrapped);
  },
  onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
    const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  },
  onSessionChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('session:changed', wrapped);
    return () => ipcRenderer.removeListener('session:changed', wrapped);
  },
  onWriteSession: (listener: (id: string, eventSeq?: number) => void): (() => void) => {
    const wrapped = (_event: unknown, id: string, eventSeq?: number): void => listener(id, eventSeq);
    ipcRenderer.on('session:write', wrapped);
    return () => ipcRenderer.removeListener('session:write', wrapped);
  },
  onTaskProgress: (listener: (progress: TaskProgress) => void): (() => void) => {
    const wrapped = (_event: unknown, progress: TaskProgress): void => listener(progress);
    ipcRenderer.on('task:progress', wrapped);
    return () => ipcRenderer.removeListener('task:progress', wrapped);
  },
  cancelTaskRequest: (requestId: string) => call<boolean>('tasks:cancel', { requestId }),
  draftGoalOpening: (text: string, mode: 'goal' | 'loop', requestId: string) =>
    call<{ reply: string; model: string }>('sessions:goalOpening', { text, mode, requestId }),
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
