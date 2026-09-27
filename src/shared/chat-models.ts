import type { ReasoningEffort } from './session.js';

export const CHATGPT_DEFAULT_MODEL_ID = 'chatgpt-default';
// Stable app-facing identity for the GPT-5.6 Sol family. Reasoning level is selected
// independently (Medium/High); do not encode a reasoning lane into the model id.
export const CHATGPT_SOL_MODEL_ID = '5.6';
const CHATGPT_SOL_COMPAT_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5-6-thinking',
  CHATGPT_SOL_MODEL_ID,
  'gpt-5.6 sol',
  'chatgpt 5.6 sol'
]);
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|gpt-?6(?:\.0)?-pro|gpt-?6-astra)$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[] };

/** Stable app settings choices. Discovery may add browser knowledge, but these do not depend on it. */
export const CHATGPT_SETTINGS_MODELS: readonly ChatModelOption[] = [
  { id: CHATGPT_DEFAULT_MODEL_ID, label: 'ChatGPT default', efforts: [] },
  { id: CHATGPT_SOL_MODEL_ID, label: 'GPT-5.6 Sol', efforts: ['medium', 'high'], aliases: ['gpt-5.6-sol', 'gpt-5-6-thinking'] }
];

/** Convert stored/app-facing compatibility ids into the provider request identity. */
export function configuredChatModelRequest(model: string | null | undefined): string | null {
  const value = (model ?? '').trim();
  if (!value || value === CHATGPT_DEFAULT_MODEL_ID) return null;
  return CHATGPT_SOL_COMPAT_IDS.has(value.toLowerCase()) ? CHATGPT_SOL_MODEL_ID : value;
}

export function configuredChatSettingsModel(model: string | null | undefined): string {
  const value = (model ?? '').trim();
  if (!value || value === CHATGPT_DEFAULT_MODEL_ID) return CHATGPT_DEFAULT_MODEL_ID;
  return configuredChatModelRequest(value) === CHATGPT_SOL_MODEL_ID ? CHATGPT_SOL_MODEL_ID : value;
}

export function configuredChatModelLabel(model: string | null | undefined): string {
  const requested = configuredChatModelRequest(model);
  if (requested === null) return 'ChatGPT default';
  if (requested === CHATGPT_SOL_MODEL_ID) return 'GPT-5.6 Sol';
  return requested;
}
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^gpt-?\d+(?:[.-]\d+)?-pro$/.test(normalized);
}
/** Keep the selected generation intact; Pro is already a complete model label. */
export function chatModelDisplayLabel(label: string, effort: ReasoningEffort, effortLabel: string): string {
  if (effort === 'pro') return /\bpro$/i.test(label) ? label : `${label.replace(/\s+Sol$/i, '')} Pro`;
  return `${label} · ${effortLabel}`;
}
export type ChatModelCatalog = {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: ChatModelOption[];
  /** ChatGPT exposes no selectable model picker on this account surface.
   * Sends must leave model and reasoning unset so the provider can use its native default. */
  nativeDefault?: boolean;
  error?: string;
};
