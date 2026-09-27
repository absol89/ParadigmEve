import { browserExtensionRequired } from '../shared/types.js';
import { browserPresent } from './bridge.js';
import { getStatus } from './connection.js';
import { getConfig, updateConfig } from './config.js';
import { hasSecret } from './secrets.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import { locateBinary } from './tunnel/locate.js';

/**
 * Authoritative one-time onboarding completion gate.
 *
 * Runtime browser/tunnel health is deliberately not the durable completion fact. This function
 * is strict only while onboarding is incomplete: it requires the configured prerequisites, the
 * live tunnel, the owned Companion when required, and both discovery plus a recognized ChatGPT
 * tool invocation on every required published surface.
 */
export async function onboardingReady(): Promise<boolean> {
  const config = getConfig();
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId) || !await hasSecret('openaiApiKey')) return false;
  } else if (config.tunnel.kind === 'cloudflared') {
    if (!locateBinary('cloudflared', config.tunnel.binaryPath)) return false;
  }

  const status = getStatus();
  if (status.state !== 'connected') return false;
  if (browserExtensionRequired(config) && !browserPresent()) return false;
  const required = status.surfaces.filter((surface) => surface.available && !surface.optional);
  if (
    status.lastRequestAt === null ||
    required.some((surface) => surface.lastRequestAt === null || surface.lastToolCallAt === null)
  ) return false;
  return true;
}

/** Persist completion exactly once after the authoritative evidence is satisfied. */
export async function promoteOnboardingIfReady(): Promise<boolean> {
  if (getConfig().onboarding?.complete === true) return true;
  if (!await onboardingReady()) return false;
  await updateConfig((config) => config.onboarding?.complete
    ? config
    : { ...config, onboarding: { complete: true } });
  return true;
}
