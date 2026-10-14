/**
 * Where meeting and interview audio is transcribed.
 *
 * Three avenues, each with an on/off switch and an integer priority. Among the enabled avenues
 * that are actually usable on this machine right now, the lowest priority number runs first;
 * the others are the ordered fallbacks. Speaker separation is not covered here: it always runs
 * locally, whichever avenue writes the words.
 *
 * Cloud uploads the recording's audio to a third party, so it is off by default and can only be
 * enabled while its API key is stored in the OS credential store. Removing the key switches it off.
 */

export const TRANSCRIPTION_AVENUES = ['gpu', 'local', 'cloud'] as const;
export type TranscriptionAvenue = (typeof TRANSCRIPTION_AVENUES)[number];

export const TRANSCRIPTION_CLOUD_PROVIDERS = ['groq', 'openai'] as const;
export type TranscriptionCloudProvider = (typeof TRANSCRIPTION_CLOUD_PROVIDERS)[number];
export type TranscriptionRuntimeProvider = 'local' | TranscriptionCloudProvider;

/** What actually transcribed the words, read back from the engine's own provenance. */
export type TranscriptionAsrBackend = 'cpu' | 'vulkan' | 'metal' | TranscriptionCloudProvider;

export interface TranscriptionJob {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  avenue?: TranscriptionAvenue;
  provider?: TranscriptionRuntimeProvider;
  /** Set only from the finished transcript's provenance, never from the avenue that was tried. */
  backend?: TranscriptionAsrBackend;
  /** GPU device name when backend is 'vulkan'. */
  device?: string;
  /** Avenues that failed before the one that produced the transcript, with the reason. */
  fallbacks?: Array<{ avenue: TranscriptionAvenue; reason: string }>;
  stage?: string;
  transcript?: unknown;
  error?: string;
}

/**
 * Whether the GPU avenue can run on this computer, from the engine's ggml-probe (which runs a
 * real compute check on each GPU). Nothing else may enable the GPU avenue.
 *  - usable: a Vulkan GPU passed the compute check
 *  - device-unavailable: the Vulkan build is installed but no GPU/runtime passed
 *  - cpu-only-build: no Vulkan build is installed
 *  - unknown: not probed yet, or the probe could not run
 */
export interface TranscriptionGpuCapability {
  status: 'usable' | 'device-unavailable' | 'cpu-only-build' | 'unknown';
  device: string | null;
  reason: string | null;
}

export const UNKNOWN_GPU_CAPABILITY: TranscriptionGpuCapability = {
  status: 'unknown', device: null, reason: 'Not checked yet.'
};

/** Interpret `ldw gpu-probe` output. Anything unexpected is "unknown", never "usable". */
export function parseGpuProbe(text: string): TranscriptionGpuCapability {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.schema !== 'ldw.gpu-probe/1') throw new Error('schema');
    const status = value.status;
    const reason = typeof value.reason === 'string' ? value.reason.slice(0, 300) : null;
    const selected = value.selected && typeof value.selected === 'object' ? value.selected as Record<string, unknown> : null;
    const device = selected && typeof selected.description === 'string' ? selected.description.slice(0, 120)
      : selected && typeof selected.name === 'string' ? selected.name.slice(0, 120) : null;
    if (status === 'usable' && device) return { status, device, reason: null };
    if (status === 'device-unavailable' || status === 'cpu-only-build') return { status, device: null, reason };
  } catch {
    // fall through
  }
  return { status: 'unknown', device: null, reason: 'The GPU probe returned an unexpected result.' };
}

export const TRANSCRIPTION_PRIORITY_MIN = 1;
export const TRANSCRIPTION_PRIORITY_MAX = 99;

export interface TranscriptionAvenueSettings {
  enabled: boolean;
  /** Whole number; lower runs first. */
  priority: number;
}

export interface TranscriptionSettings {
  gpu: TranscriptionAvenueSettings;
  local: TranscriptionAvenueSettings;
  cloud: TranscriptionAvenueSettings & { provider: TranscriptionCloudProvider };
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  gpu: { enabled: false, priority: 1 },
  local: { enabled: true, priority: 2 },
  cloud: { enabled: false, priority: 3, provider: 'groq' }
};

export function cloneTranscriptionSettings(settings: TranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS): TranscriptionSettings {
  return {
    gpu: { ...settings.gpu },
    local: { ...settings.local },
    cloud: { ...settings.cloud }
  };
}

/** Whether clearing a credential invalidates the actively selected Cloud avenue. */
export function transcriptionCloudKeyRemoved(settings: TranscriptionSettings, key: string): boolean {
  return settings.cloud.enabled && (settings.cloud.provider === 'groq'
    ? key === 'transcriptionGroqApiKey' : key === 'openaiApiKey');
}

export function isTranscriptionPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= TRANSCRIPTION_PRIORITY_MIN && value <= TRANSCRIPTION_PRIORITY_MAX;
}

/**
 * Why these settings cannot be saved, or null when they can. Kept in shared code so the
 * settings form and the main-process save boundary give the same answer.
 */
export function transcriptionSettingsIssue(settings: TranscriptionSettings, hasCloudKey: boolean, hasOpenAiKey = false,
  gpuUsable = false): string | null {
  for (const avenue of TRANSCRIPTION_AVENUES) {
    if (!isTranscriptionPriority(settings[avenue].priority)) {
      return `Priorities must be whole numbers from ${TRANSCRIPTION_PRIORITY_MIN} to ${TRANSCRIPTION_PRIORITY_MAX}.`;
    }
  }
  const enabled = TRANSCRIPTION_AVENUES.filter((avenue) => settings[avenue].enabled);
  if (enabled.length === 0) return 'Enable at least one transcription option.';
  const priorities = enabled.map((avenue) => settings[avenue].priority);
  if (new Set(priorities).size !== priorities.length) {
    return 'Each enabled option needs a different priority number.';
  }
  if (settings.cloud.enabled && !(settings.cloud.provider === 'openai' ? hasOpenAiKey : hasCloudKey)) return 'Store a cloud API key before enabling Cloud.';
  if (settings.gpu.enabled && !gpuUsable) return 'GPU transcription is not available on this computer.';
  return null;
}

/**
 * Enabled avenues in the order they should be tried, lowest priority number first.
 * `available` describes this machine at run time (for example: no usable GPU, engine not
 * installed, no stored cloud key); unavailable avenues are skipped, never reordered.
 */
export function transcriptionOrder(
  settings: TranscriptionSettings,
  available: Readonly<Record<TranscriptionAvenue, boolean>>
): TranscriptionAvenue[] {
  return TRANSCRIPTION_AVENUES
    .filter((avenue) => settings[avenue].enabled && available[avenue])
    .sort((left, right) => settings[left].priority - settings[right].priority);
}
