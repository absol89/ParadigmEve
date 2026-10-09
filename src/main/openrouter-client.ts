/**
 * OpenRouter as an in-process chat provider beside ChatGPT and Ollama.
 *
 * OpenRouter speaks OpenAI-compatible chat completions, so a chat turn runs through the same local
 * agent loop as Ollama (createOllamaAgentModelRuntime with OpenRouter's headers). It is always a
 * remote service: its route is `openrouter`, it needs consent like any provider switch, and a chat
 * locked to this computer refuses it. The key is the one Settings → Agents & automation already
 * stores for Goal (`openRouterApiKey`); it is sent only to openrouter.ai over HTTPS.
 */

import { getSecret } from './secrets.js';
import { createOllamaAgentModelRuntime } from './ollama-agent-runtime.js';
import type { LocalAgentModelRuntime } from './local-agent-runtime.js';

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const CATALOG_TTL_MS = 10 * 60_000;
const MAX_MODELS = 1000;

export interface OpenRouterModelChoice {
  id: string;
  name: string;
  /** Accepts image input. */
  vision: boolean;
  /** Supports tool calls, so Eve's tools can be offered. */
  tools: boolean;
  contextLength: number | null;
  /** Both prompt and completion are priced at zero right now. */
  free: boolean;
}

let catalog: { at: number; models: OpenRouterModelChoice[] } | null = null;

export async function openRouterKey(): Promise<string | null> {
  return await getSecret('openRouterApiKey');
}

const cleanId = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) ? value : null;

/** OpenRouter's public model list (no key needed), text-answering models only, cached ten minutes. */
export async function listOpenRouterModels(fetchImpl: typeof fetch = globalThis.fetch, now = Date.now()): Promise<OpenRouterModelChoice[]> {
  if (catalog && now - catalog.at < CATALOG_TTL_MS) return catalog.models;
  const response = await fetchImpl(`${OPENROUTER_API_BASE}/models`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`OpenRouter model list failed: HTTP ${response.status}`);
  const payload = await response.json() as { data?: unknown };
  const rows = Array.isArray(payload?.data) ? payload.data.slice(0, MAX_MODELS) : [];
  const models: OpenRouterModelChoice[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, any>;
    const id = cleanId(entry['id']);
    if (!id) continue;
    const architecture = entry['architecture'] && typeof entry['architecture'] === 'object' ? entry['architecture'] : {};
    const inputs: unknown[] = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
    const outputs: unknown[] = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : ['text'];
    if (!outputs.includes('text')) continue;
    const parameters: unknown[] = Array.isArray(entry['supported_parameters']) ? entry['supported_parameters'] : [];
    const pricing = entry['pricing'] && typeof entry['pricing'] === 'object' ? entry['pricing'] : {};
    const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim().slice(0, 120) : id;
    models.push({
      id,
      name,
      vision: inputs.includes('image'),
      tools: parameters.includes('tools'),
      contextLength: Number.isSafeInteger(entry['context_length']) ? entry['context_length'] : null,
      free: String(pricing.prompt) === '0' && String(pricing.completion) === '0'
    });
  }
  catalog = { at: now, models };
  return models;
}

/** What the catalog says about one model; null when the list could not be read or it is unknown. */
export async function openRouterModelInfo(model: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<OpenRouterModelChoice | null> {
  try {
    return (await listOpenRouterModels(fetchImpl)).find((choice) => choice.id === model) ?? null;
  } catch {
    return null;
  }
}

/** The agent-loop transport for OpenRouter: its key, and an app attribution OpenRouter documents. */
export function createOpenRouterAgentModelRuntime(key: string, fetchImpl: typeof fetch = globalThis.fetch): LocalAgentModelRuntime {
  return createOllamaAgentModelRuntime(fetchImpl, {
    label: 'OPENROUTER',
    headers: async (endpoint) => {
      if (endpoint !== OPENROUTER_API_BASE) throw new Error('OpenRouter requests go only to openrouter.ai');
      return {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://github.com/absol89/ParadigmEve',
        'X-Title': 'ParadigmEve'
      };
    }
  });
}

export function resetOpenRouterCatalogForTests(): void {
  catalog = null;
}
