import type { ReasoningEffort } from './session.js';
import type { AgentBackendExecutionStatus, AgentExecutionSettings, AgentRuntimeSettings } from './agent-backends.js';
import type { LanPeerPresence } from './lan-peer.js';
import type { ConceptPinPreviewDensity, ConceptPreviewTextSize } from './concept-settings.js';
import { WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_INPUT_METHODS } from './windows-computer.js';
/** Types shared between the main process and the renderer. No runtime logic here. */

/**
 * One capability per user-facing checkbox. Tools are only registered on the MCP
 * server when their capability is enabled, so a disabled capability is invisible
 * to the model rather than merely refused.
 */
/*
 * Two permissions were removed when the tools were consolidated, because no tool could
 * honour them any more and a checkbox that grants nothing — or worse, less than its
 * label promises — is a lie about the security boundary:
 *
 * - `powershell` and `command` were one tool each. `exec_command` replaced both, and it
 *   runs PowerShell by default, so leaving the pair in place meant "Run executable" was
 *   silently also "Run PowerShell" while the PowerShell checkbox granted nothing at all.
 *   One permission for running commands is what the single tool can actually enforce.
 * - `deleteFolder` had no implementation left: `apply_patch` deletes files, and the patch
 *   format has no way to express removing a directory. Deleting a folder now needs
 *   `exec_command`, which is a permission the user grants deliberately.
 *
 * `config.ts` migrates both keys off existing configs; see the note there.
 */
export const CAPABILITIES = [
  'browse',
  'search',
  'read',
  'metadata',
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'saveArtifact',
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Model-facing Desktop permissions, enabled only on hosts with a native backend. */
export const DESKTOP_CAPABILITIES: readonly Capability[] = [
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
];

/**
 * Capabilities that change something outside this app — files on disk, code that
 * runs, or the desktop itself. Blocked outright by read-only mode.
 *
 * `screen` is not here: looking at the screen changes nothing. `control` is, because
 * driving the mouse and keyboard can do anything the user can.
 */
export const WRITE_CAPABILITIES: readonly Capability[] = [
  'create',
  'edit',
  'move',
  'deleteFile',
  'command',
  'saveArtifact',
  'control',
  'clipboardWrite'
];

export type Capabilities = Record<Capability, boolean>;

/** Host family reported to the renderer. */
export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'other';

export interface PlatformInfo {
  family: PlatformFamily;
  /** Friendly operating-system name for setup/help copy. */
  name: string;
  /** Whether the model-facing Desktop connector can be used on this host. */
  desktopAutomation: boolean;
}

/** Whether this host can protect the credentials/tokens the app persists. */
export interface SecureStorageInfo {
  available: boolean;
  /** Actionable explanation when unavailable; null when the backend is safe to use. */
  detail: string | null;
}

/** Human-facing identity of one ParadigmEve installation's primary ChatGPT connector. */
export const DEFAULT_CORE_CONNECTOR_NAME = 'Eve';
export const MAX_CORE_CONNECTOR_NAME_CHARS = 40;

export interface Root {
  /** Virtual name exposed to the model, e.g. "project" for /project. */
  name: string;
  /** Absolute host path. Never sent to the model. */
  path: string;
}

export type TunnelKind = 'openai' | 'cloudflared' | 'manual';

export interface TunnelSettings {
  kind: TunnelKind;
  /**
   * OpenAI tunnel id for the primary ParadigmEve app, format tunnel_<32 hex>. Not a secret.
   *
   * Named without a surface prefix because it predates the old surface split and every
   * existing config on disk carries it. New setup publishes both ordinary local tools and
   * enabled Computer use tools through this one tunnel.
   */
  tunnelId: string;
  /**
   * Legacy OpenAI tunnel id for the old separate Desktop connector. Empty for new installs.
   *
   * It remains readable/servable so an existing two-app installation is not broken during
   * migration. ChatGPT's custom-app UI addresses one tunnel id and normalises tunnel-client
   * traffic to the `main` channel; one visible app therefore cannot directly branch across
   * two tunnel ids. New setup folds Computer use into `tunnelId` instead.
   */
  desktopTunnelId: string;
  /** Optional shared connector for installed external MCP plugins. */
  pluginsTunnelId?: string;
  /** Optional explicit path to tunnel-client / cloudflared. */
  binaryPath: string;
}

export const CHAT_BROWSERS = ['chrome', 'edge', 'brave'] as const;
export type ChatBrowser = (typeof CHAT_BROWSERS)[number];

export interface UiPrefs {
  /** Maintenance may reuse existing tabs but cannot open helpers or missing chats. */
  browserOnly?: boolean;
  backgroundChats?: boolean;
  /** Opt-in browser automation for changed connector tool schemas. */
  autoRefreshPlugins?: boolean;
  /** Actual app-owned tabs to retain; active work and drafts stay protected. Omitted uses workers + 2. */
  tabsToKeepOpen?: number;
  finishTool?: boolean;
  planBackend?: 'chatgpt' | 'api';
  finishAction?: 'notify' | 'goal';
  finishLeadMinutes?: number;
  developerMode?: boolean;
  minimizeToTray: boolean;
  autoConnect: boolean;
  startAtLogin?: boolean;
  /** Default screenshots to the active window instead of the whole primary monitor. */
  privacyScreenshots: boolean;
  /** Browser for app-originated launches; connected source tabs retain placement ownership. */
  chatBrowser?: ChatBrowser;
  /** Last explicit current-chat picker choice. Null means provider-native ChatGPT default. */
  chatModel?: string | null;
  /** Reasoning paired with chatModel; null when provider-native default is selected. */
  chatReasoning?: ReasoningEffort | null;
  /** Concepts overview: visible Quilt-filter rows before the filter area scrolls. */
  conceptQuiltRows?: number;
  /** Thread/Concept cards: square sticky-Pin mosaic dimension (1, 2, 3, or 4). */
  conceptPinPreviewDensity?: ConceptPinPreviewDensity;
  /** Concepts/compact Thread description preview typography and truncation. */
  conceptDescriptionTextSize?: ConceptPreviewTextSize;
  conceptDescriptionRows?: number;
  /** Compact Thread prompt preview typography and truncation. */
  conceptPromptTextSize?: ConceptPreviewTextSize;
  conceptPromptRows?: number;
  /** Explicit choice, never inherited from the OS: the window looks how you left it. */
  theme: 'light' | 'dark';
}

/**
 * Explicit opt-ins for Eve maintaining ParadigmEve itself.
 *
 * These are separate from ordinary tool capabilities: a user may let Eve edit project files
 * without letting model-driven input touch the ParadigmEve window or housekeeping its own work.
 */
export interface EveAuthoritySettings {
  /** Let other ChatGPT chats/devices using this Eve connector borrow Eve-local authority. */
  allowOtherChats: boolean;
  /** Direct app-settings maintenance, and a required prerequisite for self-window control. */
  changeSettings: boolean;
  /** Archive only completed Eve/worker Plans; never Activity/session retention or Threads. */
  archiveCompletedWork: boolean;
  /** Permit model-driven Computer Use to target ParadigmEve's own application window. */
  controlParadigmEve: boolean;
}

/**
 * Session recording. On by default: unlike the diagnostics log this one writes what
 * happened to disk and keeps it, but the timeline, Compact & resume and the agent
 * features are all reads of that record, so an app with it off is an app with its
 * reason for existing switched off. It stays a switch, and an explicit `false` is
 * never overridden.
 *
 * The same switch starts the local bridge the Chrome extension talks to: recording
 * without the extension only sees our own tool calls, and the extension has nothing
 * to report to if nothing is recording.
 */
export interface SessionSettings {
  record: boolean;
  /** Days of history kept. 0 keeps everything. */
  retainDays: number;
  /** Estimated tokens at which the app starts suggesting a compaction. */
  advisoryTokens: number;
  /** Estimated tokens at which that suggestion becomes urgent. */
  limitTokens: number;
}

/**
 * Automatic Compact & Resume.
 *
 * The whole of it: whether it fires, and at what size. There is no provider to choose and
 * no model to configure, because there is one way a session is compacted — the chat writes
 * its own brief and the app moves the session to a fresh chat carrying it.
 */
export interface CompactionSettings {
  /**
   * Compact without being asked, once a conversation grows past `autoTokens`.
   *
   * On, at the ceiling. Compaction ends the chat someone is working in and opens a fresh
   * one; that is the right trade when the alternative is hitting the ceiling mid-thought.
   */
  auto: boolean;
  /** Estimated recorded tokens at which automatic compaction fires. */
  autoTokens: number;
}

/**
 * The reasoning budget asked of the goal model, in OpenRouter's own vocabulary.
 *
 * `default` sends no `reasoning` block at all, which is what the provider's own default
 * means. Every other value is passed through as `reasoning: { effort }` — a model that has
 * no reasoning mode ignores it, so the setting is safe to leave alone.
 */
export const GOAL_REASONING_LEVELS = ['default', 'minimal', 'low', 'medium', 'high'] as const;
export type GoalReasoning = (typeof GOAL_REASONING_LEVELS)[number];

/**
 * The goal loop: a second model, standing in for the user, that keeps a chat going.
 *
 * When ChatGPT finishes a turn, the recorded conversation — every user message and every
 * final ChatGPT answer, and nothing else — is sent to the configured provider's model with an editable
 * continuation-gate instruction. A completion claim produces `NO_REPLY`; only a concrete
 * requested item the final answer explicitly leaves unfinished becomes a user message.
 *
 * Off by default, and useless without a key for the configured provider: the key is the credential the
 * whole feature runs on, so the UI says so rather than failing quietly at the first turn. A custom
 * keyless local endpoint is the one exception — there is nothing to store for it.
 */
/**
 * Which of the two standing modes the switch runs.
 *
 * One field rather than two booleans, because Goal and Loop are mutually exclusive by
 * construction here: there is nothing to keep in step and no state where both are on. `enabled`
 * stays the master switch it has always been, so everything that only wants to know whether a
 * second model may type into a chat keeps reading exactly that.
 */
export const GOAL_MODES = ['goal', 'loop'] as const;
export type GoalMode = (typeof GOAL_MODES)[number];

export type GoalBackend = 'api' | 'chatgpt' | 'templates';
/**
 * Where the Goal/Loop second model runs when the backend is `api`.
 *
 * `openrouter` is the shipped default: OpenRouter's catalogue, key and routing. `custom`
 * points at any OpenAI-compatible `/chat/completions` endpoint the user runs themselves
 * (Ollama, vLLM, LM Studio, a gateway) and is used with that endpoint's own model id.
 * The other backends (`chatgpt`, `templates`) never read this block.
 */
export const GOAL_PROVIDERS = ['openrouter', 'custom'] as const;
export type GoalProviderKind = (typeof GOAL_PROVIDERS)[number];

export interface GoalProviderSettings {
  kind: GoalProviderKind;
  /**
   * Base URL of a custom provider, e.g. `http://localhost:11434/v1`. Ignored unless
   * kind is `custom`. Stored verbatim; validated when a draft is started, not when saved,
   * so a typo fails loudly at use time rather than silently rewriting the user's text.
   */
  baseUrl: string;
}

/**
 * Ordered API model preferences retained independently for each provider.
 *
 * Index 0 is the primary model; later entries are fallbacks. OpenRouter consumes its list
 * natively in one request. A custom OpenAI-compatible endpoint is tried locally in this order
 * only when provider/model execution fails before a usable completion exists.
 */
export interface GoalModelSettings {
  openrouter: string[];
  custom: string[];
}

export interface GoalSettings {
  /** Optional active-turn Goal impulses; zero disables them. */
  impulseMinutes?: number;
  /** Include bounded recorded tool arguments/results in Goal decision context. */
  includeToolCalls?: boolean;
  /** null leaves ChatGPT on its provider-native default. */
  helperModel?: string | null;
  helperReasoning?: ReasoningEffort;
  backend?: GoalBackend;
  loopBackend?: 'api' | 'chatgpt';
  enabled: boolean;
  /**
   * `goal` stops when the job is done; `loop` never stops on its own.
   *
   * Only consulted while `enabled` is true. A chat driven solely by its own saved objective
   * with the switch off runs as `goal`, because Loop is a thing the user switches on.
   */
  mode: GoalMode;
  provider: GoalProviderSettings;
  /** Provider-owned ordered model lists. The active list is selected by `provider.kind`. */
  models: GoalModelSettings;
  reasoning: GoalReasoning;
  /** Editable continuation-gate instruction sent as the OpenRouter system message. */
  prompt: string;
  /**
   * Editable driver instruction used instead of `prompt` once a chat carries its own goal.
   *
   * Two prompts rather than one switch, because the two jobs disagree about where the finish
   * line comes from: the gate infers it from the conversation, the driver is handed it. Both
   * are editable for the same reason the gate always was — the shipped wording is a starting
   * point, and the person whose chat gets typed into is the one who should own it.
   */
  objectivePrompt: string;
  /**
   * Editable loop instruction, used instead of both of the above while the mode is `loop`.
   *
   * A third prompt rather than a flag on the other two, because the job is a different one:
   * the gate and the driver decide whether to speak, and this one only ever decides what to
   * say. It is combined with a chat's own goal when it has one, exactly as the driver is.
   */
  loopPrompt: string;
}

/**
 * Experimental multi-agent mode. Disabled by default and deliberately hard to turn on
 * by accident: several ChatGPT tabs driving the same filesystem is a real risk.
 */
export interface MultiAgentSettings {
  defaultModel?: string;
  defaultReasoning?: ReasoningEffort | '';
  enabled: boolean;
  /** Upper bound on workers the prime agent may create. */
  maxWorkers: number;
  /** Permit self-contained calls when browser evidence cannot identify their conversation. */
  allowUnattributedCalls: boolean;
  /**
   * Reopen/reload chats that are not Goal/Loop driven — workers, primes, plain chats that have
   * called tools — once when their tab disappears or goes silent. Goal/Loop chats are always
   * recovered, whatever this says.
   */
  recoverAgentTabs: boolean;
}

/** Per-install MCP presentation plus the user's own additions to connector instructions. */
export interface McpSettings {
  /** User-facing name of this installation's primary connector, e.g. Eve or Eva. */
  connectorName: string;
  /** Appended to ParadigmEve instructions (and the legacy Desktop endpoint), or empty for none. */
  instructions: string;
}

/** Local-network peer presence. Credentials remain main-process secrets, never config fields. */
export interface LanSettings {
  /** Explicit opt-in. Startup must not bind or announce while false. */
  enabled: boolean;
}

/** Debug-only renderer projection. Key material is deliberately absent. */
export interface LanRuntimeStatus {
  enabled: boolean;
  joined: boolean;
  running: boolean;
  peers: LanPeerPresence[];
}

export interface ArtifactSettings {
  /** Per-file byte ceiling enforced before, during and after the download stream. */
  maxFileBytes: number;
}

export interface BridgeSettings {
  /** Highest compatible authenticated Companion generation this installation has admitted. */
  companionFloor: string;
}

/** Durable completion of the one-time first-user journey, never a live health signal. */
export interface OnboardingState {
  complete: boolean;
}

export interface Config {
  artifacts: ArtifactSettings;
  bridge: BridgeSettings;
  /** Selected agent execution backends. Goal/Loop provider settings are separate. */
  execution: AgentExecutionSettings;
  /** Dedicated local worker runtime configuration. Never reused as Goal/Loop provider state. */
  agentRuntime: AgentRuntimeSettings;
  /** Undefined only for configs written before the marker existed; fresh installs write false. */
  onboarding?: OnboardingState;
  roots: Root[];
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: TunnelSettings;
  ui: UiPrefs;
  /** Missing only in configs written before the authority controls existed. */
  eveAuthority?: EveAuthoritySettings;
  sessions: SessionSettings;
  compaction: CompactionSettings;
  multiAgent: MultiAgentSettings;
  goal: GoalSettings;
  mcp: McpSettings;
  lan: LanSettings;
}

export type ConnectionState =
  | 'disconnected'
  | 'starting-server'
  | 'connecting-tunnel'
  | 'connected'
  /** Server and tunnel are up, but this PC currently cannot reach OpenAI. */
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

/**
 * What the tunnel program reports about itself, refreshed on the same 15s tick that
 * decides connected-vs-offline. Every field is null when it could not be read, so the
 * UI can say "unknown" instead of inventing a number.
 */
export interface TunnelHealth {
  /** Failed control-plane polls since the tunnel started. */
  pollErrors: number | null;
  uptimeSeconds: number | null;
  /** Where and how it reaches OpenAI, e.g. "api.openai.com · direct". */
  route: string | null;
  /** Whether the tunnel can reach our own local server: "ok" or a failure word. */
  probe: string | null;
  clientVersion: string | null;
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** Short human-readable explanation, safe to display. Never contains secrets. */
  detail: string;
  /** Public URL to paste into ChatGPT, for the cloudflared/manual paths only. */
  publicUrl: string | null;
  /** Loopback URL of the local MCP endpoint, shown for the manual path. */
  localUrl: string | null;
  /**
   * Epoch ms of the last round trip to OpenAI the tunnel actually completed, or null
   * when nothing has been proven yet. This is what separates "we think we are
   * connected" from "we know we were connected N seconds ago".
   */
  handshakeAt: number | null;
  /** Epoch ms of the last request ChatGPT sent to this app, end-to-end proof. */
  lastRequestAt: number | null;
  /**
   * Epoch ms of the last tool ChatGPT actually ran. Requests arriving with no tool
   * call ever following is the signature of Developer mode being off in ChatGPT.
   */
  lastToolCallAt: number | null;
  /** The tunnel's own view of itself, or null when no tunnel is running. */
  health: TunnelHealth | null;
  /**
   * One entry per model-facing surface currently relevant to this installation.
   *
   * New setup has one required ParadigmEve app whose tool list includes enabled Computer-use
   * capabilities. A legacy Desktop row may also appear when an older config still carries its
   * second tunnel id, and Plugins remains independently publishable.
   */
  surfaces: SurfaceStatus[];
}

/** The identifiers of the connectors this app publishes. Mirrors `mcp/surfaces.ts`. */
export type SurfaceId = 'core' | 'desktop' | 'plugins';

export interface SurfaceStatus {
  id: SurfaceId;
  /** Exactly what the user should name the connector in ChatGPT. */
  connectorName: string;
  /** Exactly what the user should paste as its description. */
  description: string;
  /** One line in the app's own voice, for the setup card. */
  cardSummary: string;
  /** False for a connector the app cannot work without. */
  optional: boolean;
  /** Whether this surface can do anything under the current permissions. */
  available: boolean;
  /** Loopback URL of this surface's MCP endpoint, or null when the server is stopped. */
  localUrl: string | null;
  /** Public URL to paste into ChatGPT, when the transport in use produces one. */
  publicUrl: string | null;
  /** Tools this connector will advertise right now. */
  tools: string[];
  state: SurfaceConnectionState;
  /** Short human-readable explanation. Never contains secrets. */
  detail: string;
  /**
   * When ChatGPT last reached *this* surface, and last ran one of its tools.
   *
   * `state` is only ever our side of the wire — whether we published it. These two are the
   * other side: proof ChatGPT reached it and that the model was allowed to call a tool.
   */
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
}

export type SurfaceConnectionState =
  /** Not being published: unavailable, or optional and not configured. */
  | 'off'
  | 'starting'
  | 'live'
  | 'error';

/** One link in the chain from ChatGPT to this PC, as reported by the self-test. */
export interface Check {
  name: string;
  /** Explicit execution state; unknown is never presented as a pass. */
  status: 'pass' | 'fail' | 'skipped' | 'not-run';
  /** Backward-compatible boolean projection used by older renderer/test consumers. */
  ok: boolean | null;
  detail: string;
}

export interface Diagnosis {
  checks: Check[];
  /** One-line verdict for the top of the UI. */
  summary: string;
}

export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Agent that caused this line, in multi-agent mode only. Absent otherwise. */
  agent?: string;
}

/** What the renderer needs to know about the extension bridge, without any secrets. */
export interface BridgeStatus {
  running: boolean;
  port: number | null;
  /** Durable authorization: true once a browser extension has been issued this app's token. */
  paired: boolean;
  /** Live presence: true only while this app process has heard from the extension recently. */
  present: boolean;
  /**
   * Whether the Companion most recently proved at least one ChatGPT tab is currently open.
   * Null/undefined means no current-generation tab census is available, never "closed".
   */
  chatTabOpen?: boolean | null;
  /** Epoch ms of the last message from the extension, or null. */
  lastSeenAt: number | null;
  /**
   * Version of the connected browser extension, learned from its own authenticated requests.
   *
   * This is the only place that fact lives. It is null before an extension has ever spoken to
   * this app process, which is why "no extension version" never means "outdated extension".
   */
  extensionVersion: string | null;
}

/** What the app can prove about ParadigmEve's dedicated Companion browser window. */
export interface CompanionBrowserStatus {
  /**
   * True/false only where the native desktop backend can identify the exact dedicated profile
   * window. Null means the host cannot prove either state and the UI must not guess from a
   * generic Chrome process.
   */
  windowOpen: boolean | null;
}

export type EveReadinessState = 'ready' | 'preparing' | 'needs-attention' | 'needs-user';

export type EveReadinessNextAction =
  | 'none'
  | 'wait'
  | 'choose-folder'
  | 'enable-permissions'
  | 'fix-secure-storage'
  | 'configure-tunnel'
  | 'add-api-key'
  | 'configure-connection'
  | 'select-supported-backends'
  | 'connect'
  | 'restore-browser'
  | 'set-up-companion'
  | 'verify-chatgpt';

/**
 * One projection of whether this installation can execute the selected agent contract now.
 * Every fact comes from an existing owner; this record never starts or repairs anything itself.
 */
export interface EveReadiness {
  state: EveReadinessState;
  nextAction: EveReadinessNextAction;
  summary: string;
  detail: string;
  backends: {
    orchestrator: AgentBackendExecutionStatus;
    worker: AgentBackendExecutionStatus;
  };
}

/**
 * Whether a newer release of this app exists, and what has been done about it.
 *
 * One record for the whole update subsystem — see src/main/update.ts. `latest` is a version
 * only when it is genuinely newer than `current`, so nothing downstream compares versions.
 *
 * `stage` says what this installation is doing about it, and the pair reads as:
 * - `latest === null` — up to date, or nothing checked yet.
 * - `latest` set, `stage: 'idle'` — a newer build exists (in the local private feed or as the
 *   GitHub release marked Latest) but this installation cannot apply it for itself (a Linux
 *   `.deb`, macOS, a development tree, an unsupported arch, or a release without this build's
 *   flavor of artifact).
 * - `downloading` / `ready` — the artifact is being staged, or is verified and ready for the
 *   orderly install handoff.
 * - `failed` — the check or the download stopped; `error` says why, and the next check
 *   tries again. Nothing about the running app is affected either way.
 *
 * `checkedAt` is what separates the two silences: null means the update sources have not
 * been checked yet in this run, and only a timestamp lets the UI say "up to date".
 */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  stage: 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';
  error: string | null;
  /** When the update sources were last checked, as epoch ms. Null until they have been. */
  checkedAt: number | null;
  /**
   * The GitHub page of the offered release when `latest` came from the maintainer's repository.
   * Built by the main process from a fixed repository and a validated tag, never from a response.
   */
  releaseUrl?: string | null;
}

/**
 * Whether `candidate` is a later release than `current`, compared as three numbers.
 *
 * String inequality is not enough: a downgrade published by mistake, or a pre-release tag left
 * as `latest`, would otherwise make this app install an older build over a newer one. It lives
 * here because the renderer asks the same question of the connected extension's version, and two
 * copies of a comparison are two chances to read a version difference the wrong way round.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export type MacOSPermissionState = 'granted' | 'missing' | 'unknown';
export interface MacOSDesktopAccessStatus {
  /** Live preflights from the Swift backend executing inside the Electron process. */
  screen: MacOSPermissionState;
  accessibility: MacOSPermissionState;
  checkedAt: number;
  error: string | null;
}

/**
 * Whether the enabled product surface currently needs the companion browser extension.
 *
 * Recording consumes browser observations, multi-agent uses the browser to open/bind worker
 * chats, and stateful Computer use needs request-id -> conversation proof from the page before
 * indexed/coordinate input can run. Goal and compaction also execute through that bridge, but
 * both depend on a recorded session, so they are not independently viable reasons to require a
 * browser when recording itself is off.
 */
export function browserExtensionRequired(config: Pick<Config, 'sessions' | 'multiAgent' | 'capabilities'>): boolean {
  const computerUse =
    config.capabilities.screen ||
    config.capabilities.control ||
    config.capabilities.clipboardRead ||
    config.capabilities.clipboardWrite;
  return config.sessions.record || config.multiAgent.enabled || computerUse;
}

export interface AppState {
  config: Config;
  status: ConnectionStatus;
  readiness: EveReadiness;
  platform: PlatformInfo;
  /** Only packaged Windows builds may change the login item. */
  loginStartupAvailable?: boolean;
  secureStorage: SecureStorageInfo;
  /** True when an OpenAI control-plane API key is stored. The key itself never leaves the main process. */
  hasApiKey: boolean;
  /** True when an OpenRouter key is stored, which is what the goal loop spends on that provider. Same rule: the key stays here. */
  hasGoalKey: boolean;
  /** True when a custom-provider key is stored. Only meaningful beside a custom endpoint, which may also run keyless. */
  hasCustomProviderKey: boolean;
  /** An Ollama API key is stored (used only for HTTPS endpoints such as https://ollama.com/v1). */
  hasOllamaKey: boolean;
  /** Present only in debug builds. Never includes the LAN group key. */
  lan?: LanRuntimeStatus;
  /** Resolved path of the tunnel binary we would run, or null if we cannot find one. */
  resolvedBinary: string | null;
  /** Version of the tunnel-client copy shipped inside the app, for diagnostics. */
  bundledTunnelVersion: string | null;
  bridge: BridgeStatus;
  /** Runtime state of the dedicated ParadigmEve browser profile, separate from Companion liveness. */
  companionBrowser?: CompanionBrowserStatus;
  update: UpdateStatus;
  /** Present only on macOS once the in-process native backend has reported its live TCC state. */
  desktopAccess?: MacOSDesktopAccessStatus | null;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: false,
  edit: false,
  move: false,
  deleteFile: false,
  command: false,
  saveArtifact: false,
  screen: false,
  control: false,
  clipboardRead: false,
  clipboardWrite: false
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  browse: 'Browse folders',
  search: 'Search files',
  read: 'Read files',
  metadata: 'File metadata',
  create: 'Create files',
  edit: 'Edit files',
  move: 'Move / rename',
  deleteFile: 'Delete files',
  command: 'Run commands',
  saveArtifact: 'Save ChatGPT files',
  screen: 'See the screen',
  control: 'Control mouse and keyboard',
  clipboardRead: 'Read clipboard',
  clipboardWrite: 'Write clipboard'
};

/**
 * One short line per capability, shown under its checkbox when the group is expanded.
 *
 * A clause, not a paragraph. Which MCP tools a permission actually turns on is a separate
 * fact and is listed separately — see capabilityTools — because that list is the part
 * that goes stale when the tool surface is consolidated, and a sentence with the tool name
 * buried in it is a sentence nobody rewrites when the tool is renamed.
 */
export const CAPABILITY_DETAILS: Record<Capability, string> = {
  browse: 'List what is inside an approved folder.',
  search: 'Find files by name or glob, and text inside them.',
  read: 'Read text in ranges, and open local images into vision.',
  metadata: 'Size, dates and line count, without the contents.',
  create: 'Add new files, and the folders they need.',
  edit: 'Exact edits, applied atomically across files.',
  move: 'Move or rename, both ends inside approved folders.',
  deleteFile: 'Permanent — there is no Recycle Bin.',
  command: 'Run anything as you. NOT limited to approved folders.',
  saveArtifact: 'Save images and files ChatGPT generates into an approved folder.',
  screen: 'Screenshots, open windows, and the controls on them.',
  control: 'Moves the pointer, clicks, types and presses keys, as you.',
  clipboardRead: 'Read the current clipboard text.',
  clipboardWrite: 'Replace the clipboard without focus or keystrokes.'
};

/**
 * The MCP tools each permission actually exposes.
 *
 * Kept beside the capability list rather than written into the prose above, so the tool
 * selector shows what this build really registers. `read` carries `view_image` as well as
 * `read`; `find` exists only where running commands is switched off, which is why it is
 * marked rather than listed flatly (see SurfaceRegistrar.findExposed).
 */
const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  browse: ['read'],
  search: ['read', 'find'],
  read: ['read', 'view_image'],
  metadata: ['read'],
  create: ['apply_patch'],
  edit: ['apply_patch'],
  move: ['apply_patch'],
  deleteFile: ['apply_patch'],
  command: ['exec_command', 'write_stdin'],
  saveArtifact: ['download_artifact'],
  screen: ['observe'],
  control: ['computer'],
  clipboardRead: ['computer'],
  clipboardWrite: ['computer']
};

/** Settings use the same Windows method lists as registration, with explicit host identity. */
export function capabilityTools(capability: Capability, platform?: PlatformFamily): readonly string[] {
  if (!DESKTOP_CAPABILITIES.includes(capability)) return CAPABILITY_TOOLS[capability];
  if (platform === 'macos') return CAPABILITY_TOOLS[capability];
  if (platform !== 'windows') return [];
  switch (capability) {
    case 'screen': return WINDOWS_COMPUTER_READ_METHODS;
    case 'control': return WINDOWS_COMPUTER_INPUT_METHODS;
    case 'clipboardRead': return ['read_clipboard'];
    case 'clipboardWrite': return ['write_clipboard'];
    default: return [];
  }
}
