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

export const TRANSCRIPTION_CLOUD_PROVIDERS = ['groq'] as const;
export type TranscriptionCloudProvider = (typeof TRANSCRIPTION_CLOUD_PROVIDERS)[number];

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
  gpu: { enabled: true, priority: 1 },
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

export function isTranscriptionPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= TRANSCRIPTION_PRIORITY_MIN && value <= TRANSCRIPTION_PRIORITY_MAX;
}

/**
 * Why these settings cannot be saved, or null when they can. Kept in shared code so the
 * settings form and the main-process save boundary give the same answer.
 */
export function transcriptionSettingsIssue(settings: TranscriptionSettings, hasCloudKey: boolean): string | null {
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
  if (settings.cloud.enabled && !hasCloudKey) return 'Store a cloud API key before enabling Cloud.';
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
