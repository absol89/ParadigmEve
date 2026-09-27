import { REASONING_EFFORTS } from '../shared/session.js';
import { AGENT_BACKEND_IDS, DEFAULT_AGENT_EXECUTION_SETTINGS, DEFAULT_AGENT_RUNTIME_SETTINGS } from '../shared/agent-backends.js';
import { BUILD_FLAVOR, type BuildFlavor } from '../shared/build-flavor.js';
import { configuredChatModelRequest } from '../shared/chat-models.js';
import {
  CONCEPT_PREVIEW_TEXT_SIZES,
  CONCEPT_QUILT_ROWS_MAX,
  CONCEPT_QUILT_ROWS_MIN,
  CONCEPT_TEXT_ROWS_MAX,
  CONCEPT_TEXT_ROWS_MIN,
  DEFAULT_CONCEPT_PREVIEW_SETTINGS
} from '../shared/concept-settings.js';
/**
 * Non-secret settings, stored as one small JSON file in the app's userData folder.
 * No database: there are at most a handful of roots and a dozen booleans.
 *
 * Everything read from disk is re-validated, because a hand-edited or corrupted file
 * must not be able to widen permissions or smuggle in a root that was never approved.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CAPABILITIES,
  CHAT_BROWSERS,
  DEFAULT_CORE_CONNECTOR_NAME,
  DEFAULT_CAPABILITIES,
  MAX_CORE_CONNECTOR_NAME_CHARS,
  GOAL_MODES,
  GOAL_PROVIDERS,
  GOAL_REASONING_LEVELS,
  WRITE_CAPABILITIES,
  type Capabilities,
  DESKTOP_CAPABILITIES,
  type ArtifactSettings,
  type CompactionSettings,
  type Config,
  type EveAuthoritySettings,
  type GoalSettings,
  type LanSettings,
  type MultiAgentSettings,
  type Root,
  type SessionSettings
} from '../shared/types.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS,
  SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS,
  SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS,
  SUPERSEDED_GOAL_SYSTEM_PROMPTS
} from '../shared/goal.js';
import { logError } from './logger.js';
import { RESERVED_ROOT_NAMES } from './sandbox.js';
import { capabilitiesForPlatform } from './platform.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart.
 *
 * Recording starts ON. Everything the app is actually for — the readable timeline, Compact
 * & resume, and agent attribution — reads the recorded history, so an install that starts
 * with it off is an install where the main features silently do nothing. It writes only to
 * this app's own data folder and uploads nothing. Note this changes the default for *new*
 * configs only: an existing config already carries an explicit `record`, and a user who
 * turned it off keeps it off.
 *
 * Existing configs still keep every explicit permission choice. Fresh installs are different:
 * the Home screen is meant to start fully usable, so every tool permission and the agents
 * surface begin enabled. The migration defaults below remain conservative so an upgrade never
 * widens an older config merely because a field did not exist when that config was written.
 */
/**
 * Where the pressure meter turns amber and red.
 *
 * These are measured in *this app's* units — `estimateTokens`, four characters to a token,
 * over the events it kept — and not in whatever ChatGPT counts. The two are not the same
 * number and never will be: the app cannot see the system prompt, the memory, the file
 * attachments or the model's own reasoning, and ChatGPT's counter is private.
 *
 * So the thresholds are calibrated against observed behaviour rather than a published
 * context window. The first pair (180k/200k) was set from the published figure, and a real
 * session then ran past 400k of these units before ChatGPT would take no more — meaning the
 * meter had been demanding a compaction since roughly the halfway mark, for hours, on a
 * chat that was fine. A warning that cries wolf at half the real capacity is a warning
 * people learn to click past, which costs more than having no warning at all.
 *
 * 300k/400k put the amber line where there was still comfortable room to compact and the
 * red line at the point that had actually been seen to fail. The window was later widened
 * to 400k, but that left too little margin for a reliable Compact & Resume handoff. The
 * normal-chat trigger is now capped at 369k, with the red line still derived a third further
 * on (492k). That keeps the automatic handoff comfortably ahead of the observed ceiling.
 * Debug dogfood deliberately uses the older 300k/400k pair so continuity failures surface
 * after less accumulated context while the shipping calibration remains unchanged.
 *
 * All of it remains a setting, because the real ceiling moves with the account, the model
 * and the size of what is attached.
 */
const NORMAL_CONTEXT_WINDOW = 369_000;
const DEBUG_CONTEXT_WINDOW = 300_000;
export function defaultContextWindowForBuild(flavor: BuildFlavor = BUILD_FLAVOR): number {
  return flavor === 'debug' ? DEBUG_CONTEXT_WINDOW : NORMAL_CONTEXT_WINDOW;
}
const DEFAULT_CONTEXT_WINDOW = defaultContextWindowForBuild();
const PREVIOUS_CONTEXT_WINDOW = 400_000;
const PREVIOUS_CONTEXT_LIMIT = Math.round((PREVIOUS_CONTEXT_WINDOW * 4) / 3);
const DEFAULT_SESSIONS: SessionSettings = {
  record: true,
  retainDays: 30,
  advisoryTokens: DEFAULT_CONTEXT_WINDOW,
  // Derived, never typed. The Chat panel writes `limit = threshold × 4/3` on every save,
  // so a default that did not already satisfy that relation would be a state the UI cannot
  // produce: the red line would move the first time anyone opened the panel and saved.
  limitTokens: Math.round((DEFAULT_CONTEXT_WINDOW * 4) / 3)
};

/**
 * Superseded meter defaults, applied only to exact shipped pairs.
 *
 * Changing a source default only helps a fresh install: existing configs spell the old
 * figures out. Exact historical pairs are therefore treated as app-written defaults and
 * moved to the current calibration. Anything else the user typed stays put.
 */
const OLD_TOKEN_DEFAULTS = [
  { advisoryTokens: 180_000, limitTokens: 200_000 },
  { advisoryTokens: 300_000, limitTokens: 400_000 },
  { advisoryTokens: PREVIOUS_CONTEXT_WINDOW, limitTokens: PREVIOUS_CONTEXT_LIMIT }
];
const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line.
  //
  // Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above
  // this number does nothing. That is what makes the advisory line usable as the trigger —
  // the crossing turn still finishes and still writes its handoff, rather than the app
  // waiting for a chat that is already over the line and compacting it on sight.
  auto: true,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens
};
/**
 * Default bound for `download_artifact`.
 *
 * 20 MiB covers generated images, PDFs and small archives without letting one call
 * fill the disk or blow the MCP result budget. Enforced before, during and after
 * the stream (see artifact-fetch/artifact-target), so a lying Content-Length helps nothing.
 */
const DEFAULT_ARTIFACTS: ArtifactSettings = {
  maxFileBytes: 20 * 1024 * 1024
};

/**
 * The goal loop's defaults.
 *
 * Off until explicitly enabled, with ChatGPT as the default response source.
 * API provider/model settings apply only when API is selected; saved choices remain exact.
 */
/**
 * The shipped Goal baseline. Keep the exact OpenRouter model id here rather than a provider
 * fallback or a local alias: changing providers after one failed request would also change the
 * protocol behaviour the Goal loop is validating. Existing user-selected models remain stored
 * verbatim; this value is only the fresh/repair default.
 */
export { DEFAULT_GOAL_MODEL } from '../shared/goal.js';
const DEFAULT_GOAL: GoalSettings = {
  backend: 'chatgpt',
  loopBackend: 'chatgpt',
  impulseMinutes: 0,
  includeToolCalls: false,
  helperModel: null,
  helperReasoning: 'high',
  enabled: false,
  // The mode a fresh install runs the moment somebody flips the switch. Goal, because it is
  // the one that can end by itself: a loop that never stops is a deliberate choice, not a
  // default anybody should discover by turning something on.
  mode: 'goal',
  // Default for the optional API backend only; ChatGPT does not read this block.
  provider: { kind: 'openrouter', baseUrl: '' },
  // OpenRouter keeps the shipped primary. Custom stays empty until the user names a model;
  // inventing an OpenRouter id for a local endpoint would make the first custom request lie.
  models: { openrouter: [DEFAULT_GOAL_MODEL], custom: [] },
  reasoning: 'default',
  prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
  objectivePrompt: DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  loopPrompt: DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
};

function freshGoalDefaults(): GoalSettings {
  return {
    ...DEFAULT_GOAL,
    provider: { ...DEFAULT_GOAL.provider },
    models: {
      openrouter: [...DEFAULT_GOAL.models.openrouter],
      custom: [...DEFAULT_GOAL.models.custom]
    }
  };
}
// Two workers, not three: three concurrent workers reproducibly trips ChatGPT's rate limit
// ("too many requests"), which strands the run rather than making it faster.
const DEFAULT_MULTI_AGENT: MultiAgentSettings = {
  enabled: false,
  maxWorkers: 2,
  allowUnattributedCalls: false,
  // Off: Goal/Loop chats are always recovered, and reopening anything else — a worker, a prime,
  // a plain chat that once called a tool — is the user's choice to make.
  recoverAgentTabs: false
};
/** Fresh installs expose ordinary requested work without making Computer Use ambient. */
const ALL_FIRST_LAUNCH_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, true])
) as Capabilities;
const FIRST_LAUNCH_MULTI_AGENT: MultiAgentSettings = {
  ...DEFAULT_MULTI_AGENT,
  enabled: true,
  // A fresh install should prove which chat is acting rather than relaxing attribution merely
  // because setup is new. Workers stay available; ambiguous callers fail closed until Companion
  // identity is healthy.
  allowUnattributedCalls: false
};
const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

/**
 * Repairs root names from older/hand-edited configs without ever publishing an ambiguous
 * virtual namespace. Reserved names and duplicates are renamed deterministically in input
 * order, preserving the first usable spelling and suffixing later collisions.
 */
function uniqueStoredRoots(roots: Root[]): Root[] {
  const used = new Set<string>();
  const nextFree = (wanted: string): string => {
    const reserved = RESERVED_ROOT_NAMES.has(wanted);
    const base = reserved ? `${wanted}-folder` : wanted;
    let candidate = base.slice(0, 32);
    for (let suffix = 2; RESERVED_ROOT_NAMES.has(candidate) || used.has(candidate); suffix++) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    }
    return candidate;
  };
  return roots.map((root) => {
    const name = nextFree(root.name);
    used.add(name);
    return name === root.name ? root : { ...root, name };
  });
}

/**
 * Migrates configs written before the tools were consolidated.
 *
 * `powershell` and `command` used to be one tool each and are now the single
 * `exec_command`, so a user who had granted only PowerShell keeps the ability they
 * chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never
 * the same permission, and quietly turning one into the other would widen what the user
 * approved. Both keys are removed afterwards so the file stops carrying dead permissions.
 */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

/**
 * The user's own MCP instructions.
 *
 * Empty by default, and deliberately so: the connector instructions are how the app explains
 * its own tools, and inventing text on the user's behalf there would put words the app cannot
 * honour in front of the model.
 */
export const MAX_MCP_INSTRUCTIONS_CHARS = 4000;
const DEFAULT_MCP = { connectorName: DEFAULT_CORE_CONNECTOR_NAME, instructions: '' } as const;
const DEFAULT_LAN: LanSettings = { enabled: false };
const DEFAULT_EVE_AUTHORITY: EveAuthoritySettings = {
  allowOtherChats: true,
  changeSettings: false,
  archiveCompletedWork: false,
  controlParadigmEve: false
};

const configSchema = z.object({
  bridge: z
    .object({ companionFloor: z.string().max(32).optional().default('') })
    .optional()
    .default({ companionFloor: '' }),
  execution: z
    .object({
      // Keep valid unavailable choices exactly as saved. Unknown ids are repaired locally so one
      // future/hand-edited backend cannot force the entire config through conservative recovery.
      orchestrator: z
        .enum(AGENT_BACKEND_IDS)
        .optional()
        .default(DEFAULT_AGENT_EXECUTION_SETTINGS.orchestrator)
        .catch(DEFAULT_AGENT_EXECUTION_SETTINGS.orchestrator),
      worker: z
        .enum(AGENT_BACKEND_IDS)
        .optional()
        .default(DEFAULT_AGENT_EXECUTION_SETTINGS.worker)
        .catch(DEFAULT_AGENT_EXECUTION_SETTINGS.worker)
    })
    .optional()
    .default({ ...DEFAULT_AGENT_EXECUTION_SETTINGS })
    .catch({ ...DEFAULT_AGENT_EXECUTION_SETTINGS }),
  agentRuntime: z
    .object({
      ollama: z
        .object({
          endpoint: z.string().trim().max(2048).optional().default(''),
          model: z.string().trim().max(160).optional().default('')
        })
        .optional()
        .default({ ...DEFAULT_AGENT_RUNTIME_SETTINGS.ollama })
    })
    .optional()
    .default({ ollama: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.ollama } }),
  // Deliberately no schema default: undefined means a legacy config written before this marker.
  // Fresh installs write false explicitly; completed onboarding is promoted to true by IPC only
  // after the live end-to-end checks have succeeded.
  onboarding: z.object({ complete: z.boolean() }).optional(),
  // A config written by hand — or by a build before `/skills` was reserved — must not be
  // able to claim a reserved virtual root. Renamed rather than rejected: a single bad root
  // name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform(uniqueStoredRoots),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    // Optional with an empty default, so a config written before the connector split
    // loads unchanged and simply has no Desktop tunnel yet — which is also the correct
    // state for it, since the user has not created that connector in ChatGPT either.
    desktopTunnelId: z.string().max(128).optional().default(''),
    pluginsTunnelId: z.string().max(128).optional().default(''),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    chatBrowser: z.enum(CHAT_BROWSERS).optional().default('chrome'),
    chatModel: z.string().trim().min(1).max(80).nullable().optional(),
    chatReasoning: z.enum(REASONING_EFFORTS).nullable().optional(),
    developerMode: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['chatgpt', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    backgroundChats: z.boolean().optional().default(true),
    browserOnly: z.boolean().optional().default(false),
    autoRefreshPlugins: z.boolean().optional().default(true),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    conceptQuiltRows: z.number().int().min(CONCEPT_QUILT_ROWS_MIN).max(CONCEPT_QUILT_ROWS_MAX)
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.quiltRows).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.quiltRows),
    conceptPinPreviewDensity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.pinPreviewDensity).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.pinPreviewDensity),
    conceptDescriptionTextSize: z.enum(CONCEPT_PREVIEW_TEXT_SIZES)
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionTextSize).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionTextSize),
    conceptDescriptionRows: z.number().int().min(CONCEPT_TEXT_ROWS_MIN).max(CONCEPT_TEXT_ROWS_MAX)
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionRows).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionRows),
    conceptPromptTextSize: z.enum(CONCEPT_PREVIEW_TEXT_SIZES)
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptTextSize).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptTextSize),
    conceptPromptRows: z.number().int().min(CONCEPT_TEXT_ROWS_MIN).max(CONCEPT_TEXT_ROWS_MAX)
      .optional().default(DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptRows).catch(DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptRows),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional().default(false),
    privacyScreenshots: z.boolean().optional().default(true),
    // Dark is the design the app is drawn for, and a config written before the theme
    // existed has no stored answer to override — so it is the default rather than the
    // fallback. An explicit `light` is somebody's own choice and is never touched.
    theme: z.enum(['light', 'dark']).optional().default('dark')
  }),
  eveAuthority: z
    .object({
      allowOtherChats: z.boolean().optional().default(true),
      changeSettings: z.boolean().optional().default(false),
      archiveCompletedWork: z.boolean().optional().default(false),
      controlParadigmEve: z.boolean().optional().default(false)
    })
    .optional()
    .default({ ...DEFAULT_EVE_AUTHORITY }),
  // Whole sections are optional, so a config written by an older build keeps working
  // and simply gains the new features switched off. The default object is spelled out
  // rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat
      // is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
      maxWorkers: z.number().int().min(1).max(8).optional().default(DEFAULT_MULTI_AGENT.maxWorkers),
      allowUnattributedCalls: z.boolean().optional().default(DEFAULT_MULTI_AGENT.allowUnattributedCalls),
      recoverAgentTabs: z.boolean().optional().default(DEFAULT_MULTI_AGENT.recoverAgentTabs)
    })
    .optional()
    .default({ ...DEFAULT_MULTI_AGENT }),
  artifacts: z
    .object({
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024 * 1024)
        .optional()
        .default(DEFAULT_ARTIFACTS.maxFileBytes)
    })
    .optional()
    .default({ ...DEFAULT_ARTIFACTS }),
  // Model ids are free text from provider listings that change independently of this app.
  // Legacy `goal.model` is accepted only long enough to migrate it into the active provider's
  // ordered list; the transformed Config never retains that field as a second owner.
  goal: z
    .object({
      impulseMinutes: z.number().int().min(0).max(60).optional().default(0).catch(0),
      includeToolCalls: z.boolean().optional().default(false),
      enabled: z.boolean().optional().default(DEFAULT_GOAL.enabled),
      backend: z.enum(['api', 'chatgpt', 'templates']).optional().default('chatgpt'),
      loopBackend: z.enum(['api', 'chatgpt']).optional().default('chatgpt'),
      helperModel: z.string().trim().min(1).max(80).nullable().optional().default(null)
        .transform(model => configuredChatModelRequest(model))
        .catch(null),
      helperReasoning: z.enum(REASONING_EFFORTS).optional().default('high').catch('high'),
      // Repaired rather than rejected for the same reason `reasoning` below is: a config
      // written by a version that knows one more mode than this one must not send every root
      // and permission in the file through conservative recovery over a single word.
      mode: z.enum(GOAL_MODES).optional().default(DEFAULT_GOAL.mode).catch(DEFAULT_GOAL.mode),
      provider: z
        .object({
          // Repaired rather than rejected like `mode` above: a config written by a version
          // that knows one more provider than this one must not invalidate every root and
          // permission in the file over a single word.
          kind: z.enum(GOAL_PROVIDERS).optional().default('openrouter').catch('openrouter'),
          // Stored verbatim and validated at draft time: a URL cannot be repaired the way an
          // enum can, and silently rewriting it would point a key at a host nobody chose.
          baseUrl: z.string().max(2048).optional().default('')
        })
        .optional()
        .default({ ...DEFAULT_GOAL.provider }),
      models: z
        .object({
          openrouter: z.array(z.string().max(160)).max(16).optional().default([]),
          custom: z.array(z.string().max(160)).max(16).optional().default([])
        })
        .optional(),
      // Migration-only input. The transform below removes it from the parsed Config and every
      // subsequent save writes only `models`.
      model: z.string().max(160).optional(),
      // Repaired for the same reason, and one this section is specifically exposed to: the
      // set of levels is a provider's vocabulary, so a config written by a version that
      // knows one more of them than this one does is a config this app will meet. Rejecting
      // it would send the whole file — every root, every permission — through conservative
      // recovery over a word in one field nobody would miss.
      reasoning: z
        .enum(GOAL_REASONING_LEVELS)
        .optional()
        .default(DEFAULT_GOAL.reasoning)
        .catch(DEFAULT_GOAL.reasoning),
      // Existing configs predate the editor, and a hand-edited blank prompt must not turn
      // Goal Mode into an unconstrained continuation model. Both adopt the strong default.
      prompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.prompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.prompt : prompt.trim()))
        .catch(DEFAULT_GOAL.prompt),
      // Repaired exactly like `prompt` above, and for the same reason: a config predating the
      // second editor, or hand-edited to blank, must not leave the goal driver running with no
      // instruction at all. Both fall back to the shipped default rather than to emptiness.
      objectivePrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.objectivePrompt)
        .transform((prompt) =>
          prompt.trim() === '' ? DEFAULT_GOAL.objectivePrompt : prompt.trim()
        )
        .catch(DEFAULT_GOAL.objectivePrompt),
      // The third editor, repaired exactly like the two above. Loop is the mode that cannot
      // stop on its own, so an empty instruction here would be an unconstrained model typing
      // into somebody's chat forever — the one shape this section must never load in.
      loopPrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.loopPrompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.loopPrompt : prompt.trim()))
        .catch(DEFAULT_GOAL.loopPrompt)
    })
    .transform((goal): GoalSettings => {
      const normalize = (items: string[]): string[] => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const raw of items) {
          const model = raw.trim();
          if (!model || seen.has(model)) continue;
          seen.add(model);
          result.push(model);
        }
        return result;
      };
      const legacy = goal.model?.trim() ?? '';
      const hadLists = goal.models !== undefined;
      const openrouter = hadLists
        ? normalize(goal.models?.openrouter ?? [])
        : goal.provider.kind === 'openrouter' && legacy
          ? [legacy]
          : [];
      const custom = hadLists
        ? normalize(goal.models?.custom ?? [])
        : goal.provider.kind === 'custom' && legacy
          ? [legacy]
          : [];
      const { model: _legacyModel, models: _rawModels, ...rest } = goal;
      return {
        ...rest,
        models: {
          // An OpenRouter list is always usable after repair. Custom deliberately stays empty
          // until its endpoint has an explicit model id.
          openrouter: openrouter.length > 0 ? openrouter : [DEFAULT_GOAL_MODEL],
          custom
        }
      };
    })
    .optional()
    .default(freshGoalDefaults()),
  mcp: z
    .object({
      // This is presentation/routing vocabulary, not an executable identifier. Keep Unicode so a
      // second installation can use a human name such as Eva without forcing ASCII/English labels.
      // Control characters are the only forbidden text because this name is also inserted into
      // model instructions and provider-facing metadata.
      connectorName: z
        .string()
        .trim()
        .min(1)
        .max(MAX_CORE_CONNECTOR_NAME_CHARS)
        .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Connector name cannot contain control characters')
        .optional()
        .default(DEFAULT_MCP.connectorName)
        .catch(DEFAULT_MCP.connectorName),
      // Repaired rather than rejected, like the Goal prompts above: this is free text a person
      // typed, and one over-long or malformed field must not send the whole config — every
      // root, every permission — through conservative recovery.
      instructions: z
        .string()
        .optional()
        .default(DEFAULT_MCP.instructions)
        .transform((value) => value.slice(0, MAX_MCP_INSTRUCTIONS_CHARS).trim())
        .catch(DEFAULT_MCP.instructions)
    })
    .optional()
    .default({ ...DEFAULT_MCP })
    .catch({ ...DEFAULT_MCP }),
  // LAN presence is opt-in and has no credential fields. A malformed/unknown LAN section
  // degrades to disabled rather than widening network exposure or invalidating unrelated config.
  lan: z
    .object({ enabled: z.boolean().optional().default(DEFAULT_LAN.enabled) })
    .strict()
    .optional()
    .default({ ...DEFAULT_LAN })
    .catch({ ...DEFAULT_LAN })
});

/**
 * Ordinary Core work stays available from first launch: ChatGPT's app/action permissions decide
 * when an individual write, delete or command needs approval, while ParadigmEve still enforces
 * approved-root and tool invariants. Computer Use remains a separate explicit onboarding choice.
 * Existing configs keep their saved choices, and unsupported hosts still mask capabilities at the
 * platform boundary.
 */
function firstLaunchCapabilities(platform: NodeJS.Platform, release?: string): Capabilities {
  const capabilities = capabilitiesForPlatform({ ...ALL_FIRST_LAUNCH_CAPABILITIES }, platform, release);
  for (const capability of DESKTOP_CAPABILITIES) capabilities[capability] = false;
  return capabilities;
}

export function defaultConfig(platform: NodeJS.Platform = process.platform, release?: string): Config {
  return {
    bridge: { companionFloor: '' },
    execution: { ...DEFAULT_AGENT_EXECUTION_SETTINGS },
    agentRuntime: { ollama: { ...DEFAULT_AGENT_RUNTIME_SETTINGS.ollama } },
    onboarding: { complete: false },
    roots: [],
    capabilities: firstLaunchCapabilities(platform, release),
    readOnly: false,
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
    ui: {
      minimizeToTray: false,
      autoConnect: false,
      startAtLogin: false,
      privacyScreenshots: true,
      theme: 'dark',
      autoRefreshPlugins: true,
      backgroundChats: true,
      browserOnly: false,
      conceptQuiltRows: DEFAULT_CONCEPT_PREVIEW_SETTINGS.quiltRows,
      conceptPinPreviewDensity: DEFAULT_CONCEPT_PREVIEW_SETTINGS.pinPreviewDensity,
      conceptDescriptionTextSize: DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionTextSize,
      conceptDescriptionRows: DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionRows,
      conceptPromptTextSize: DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptTextSize,
      conceptPromptRows: DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptRows
    },
    eveAuthority: { ...DEFAULT_EVE_AUTHORITY },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...FIRST_LAUNCH_MULTI_AGENT },
    artifacts: { ...DEFAULT_ARTIFACTS },
    goal: freshGoalDefaults(),
    mcp: { ...DEFAULT_MCP },
    lan: { ...DEFAULT_LAN }
  };
}

/**
 * Recovery for a config file that exists but cannot be trusted.
 *
 * A missing file is a real first launch and intentionally gets the fully-enabled defaults
 * above. A malformed/corrupt existing file is different: treating damage as consent would
 * widen filesystem/desktop/process access merely because parsing failed. Keep that path on
 * the historical narrow capability set and read-only mode until the user saves settings again.
 */
function conservativeRecoveryConfig(): Config {
  return {
    ...defaultConfig(),
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    eveAuthority: { ...DEFAULT_EVE_AUTHORITY, allowOtherChats: false },
    multiAgent: { ...DEFAULT_MULTI_AGENT },
    // A config file that could not be trusted is not consent to have a second model typing
    // into the user's chat, whatever the unreadable file said.
    goal: freshGoalDefaults()
  };
}

/**
 * Repairs feature combinations that cannot work, without silently widening privacy settings.
 *
 * Goal Mode reads the local session transcript to decide whether another user turn is needed;
 * `/goal/draft` explicitly refuses a chat with no recorded session. Enabling recording behind
 * the user's back would be a privacy surprise, so the only safe repair is to keep recording off
 * and turn Goal off with it. Keeping this at the config boundary covers renderer, extension and
 * hand-edited/older config writers alike.
 */
function enforceFeatureDependencies(config: Config): Config {
  let next = config;
  const authority = config.eveAuthority ?? DEFAULT_EVE_AUTHORITY;
  // Self-window mouse/keyboard input can reach every visible Settings control. Do not persist a
  // state that claims Eve may control this app while settings changes are forbidden: that boundary
  // is not mechanically enforceable with OS-level input. The renderer turns both on together; a
  // hand-edited or future caller that asks for the impossible combination fails narrow here.
  if (authority.controlParadigmEve && !authority.changeSettings) {
    next = {
      ...next,
      eveAuthority: { ...authority, controlParadigmEve: false }
    };
  }
  if (!next.sessions.record && next.goal.enabled) {
    next = { ...next, goal: { ...next.goal, enabled: false } };
  }
  return next;
}

/**
 * Moves any exactly-as-shipped Goal prompt, from any past version, onto the current default.
 *
 * All three prompts — the gate, the driver and the loop — are editable and persisted, so
 * changing a source constant alone would leave an existing untouched install on the old
 * behaviour forever. Exact equality is the fence: any user customization, even a one-character
 * change, is preserved verbatim. Each list is walked rather than compared against one
 * predecessor, so an install that skipped a release still migrates instead of being stranded on
 * a default two generations old.
 */
function adoptCurrentGoalPrompt(config: Config): Config {
  const goal = { ...config.goal };
  if (SUPERSEDED_GOAL_SYSTEM_PROMPTS.includes(goal.prompt)) goal.prompt = DEFAULT_GOAL_SYSTEM_PROMPT;
  if (SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS.includes(goal.objectivePrompt)) {
    goal.objectivePrompt = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
  }
  if (SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS.includes(goal.loopPrompt)) {
    goal.loopPrompt = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
  }
  return { ...config, goal };
}

let configPath = '';
let current: Config = defaultConfig();
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those
// read-modify-write transactions strictly ordered so two fast checkbox/root changes
// cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();

export function initConfigPath(userDataDir: string): void {
  configPath = path.join(userDataDir, 'config.json');
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logError('Settings file was invalid and has been reset to defaults');
      current = conservativeRecoveryConfig();
    } else {
      current = enforceFeatureDependencies(
        adoptCurrentGoalPrompt(
          adoptWiderWindow(adoptAutoCompaction(recalibrateTokens(adoptCurrentContextWindow(parsed.data))))
        )
      );
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      current.roots = current.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Could not read settings: ${(err as Error).message}`);
      current = conservativeRecoveryConfig();
    } else {
      current = defaultConfig();
    }
  }
  return current;
}

/**
 * Moves an untouched shipped tuple onto the current build's window.
 *
 * The config has no provenance bit that can distinguish "the app wrote exactly 400k" from a
 * person deliberately recreating every field of that old default. Requiring the full old meter
 * pair *and* automatic-compaction pair is the narrowest truthful fence available: a custom meter
 * or a custom compaction threshold preserves the other side rather than being guessed away.
 */
function adoptCurrentContextWindow(config: Config): Config {
  const supersededWindows = [
    { advisoryTokens: PREVIOUS_CONTEXT_WINDOW, limitTokens: PREVIOUS_CONTEXT_LIMIT },
    ...(BUILD_FLAVOR === 'debug'
      ? [{ advisoryTokens: NORMAL_CONTEXT_WINDOW, limitTokens: Math.round((NORMAL_CONTEXT_WINDOW * 4) / 3) }]
      : [])
  ];
  const untouched = supersededWindows.some(
    (old) =>
      config.sessions.advisoryTokens === old.advisoryTokens &&
      config.sessions.limitTokens === old.limitTokens &&
      config.compaction.auto === true &&
      config.compaction.autoTokens === old.advisoryTokens
  );
  if (!untouched) return config;
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    },
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/** Applies any superseded pair in OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, untouched pairs only. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  const untouched = OLD_TOKEN_DEFAULTS.some(
    (old) => advisoryTokens === old.advisoryTokens && limitTokens === old.limitTokens
  );
  if (!untouched) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/**
 * What automatic compaction used to default to, for the same one-time move as above.
 *
 * A config written before 1.7.5 spells the old answer out, so raising the default alone
 * would only ever reach a fresh install. A stored pair that is *exactly* the old default
 * was never a decision — it is what the app wrote for itself — so it moves. Anything the
 * user actually chose is left alone, including switching it off on purpose, which is why
 * `auto: true` with the old threshold is not touched: that is somebody's own setting.
 */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/**
 * The 1.8 automatic default, moved with the current window.
 *
 * This is the third time a stored number that was never chosen has had to follow a default,
 * and it is the one case where the file's own rule is uncomfortable. `adoptAutoCompaction`
 * above deliberately leaves `auto: true` at the old threshold alone, on the grounds that
 * switching it on was a decision — but that was written when `auto: false` was the shipped
 * default. Since 1.8 the app writes `auto: true` at 300k for itself, so the two populations
 * are no longer distinguishable in the file, and the larger of them never decided anything.
 *
 * They move. A threshold that is any other number was typed by somebody and stays. The later
 * 400k → 369k move is handled separately by `adoptCurrentContextWindow`, which can require the
 * complete 400k shipped tuple instead of treating every `auto: true, 400k` value as untouched.
 */
const SUPERSEDED_AUTO_DEFAULTS = { auto: true, autoTokens: 300_000 };

function adoptWiderWindow(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== SUPERSEDED_AUTO_DEFAULTS.auto || autoTokens !== SUPERSEDED_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

export function getConfig(): Config {
  return current;
}

/**
 * Read-only mode is enforced here as well as at the tool layer, so the effective
 * capability set can never disagree with what the UI shows.
 */
export function effectiveCapabilities(
  config: Config,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  const live = capabilitiesForPlatform(config.capabilities, platform, release);
  if (!config.readOnly) return live;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new
  // writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...live };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(next: Config): Promise<Config> {
  const parsed = enforceFeatureDependencies(configSchema.parse(next));
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.rename(tmp, configPath);
  // Only publish the new in-memory state after the durable write succeeded. A disk
  // error must not leave the UI believing settings were saved when they were not.
  current = parsed;
  return current;
}

/**
 * Atomically updates settings from the latest committed state.
 *
 * The callback itself runs inside the queue. This matters more than merely queuing the
 * final file write: a root change and a permission change that start at the same time
 * must each see the result of the one ahead of it instead of composing two stale full
 * Config objects and letting the later write silently erase the earlier change.
 */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>,
  afterPublish?: (next: Config, previous: Config) => void | Promise<void>
): Promise<Config> {
  const operation = mutationQueue.then(async () => {
    const previous = current;
    const next = await persistConfig(await update(previous));
    // Keep dependent durable retirement inside the same settings transaction;
    // the next On cannot overtake a published Off's cancellation work.
    await afterPublish?.(next, previous);
    return next;
  });
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
