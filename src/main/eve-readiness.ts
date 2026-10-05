import { agentBackendExecutionStatus } from '../shared/agent-backends.js';
import {
  browserExtensionRequired,
  type BridgeStatus,
  type CompanionBrowserStatus,
  type Config,
  type ConnectionStatus,
  type EveReadiness,
  type SecureStorageInfo
} from '../shared/types.js';
import { effectiveCapabilities } from './config.js';
import { normalizeLocalAgentEndpoint } from './local-agent-runtime.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';

export interface EveReadinessInput {
  config: Config;
  secureStorage: SecureStorageInfo;
  hasApiKey: boolean;
  status: ConnectionStatus;
  bridge: BridgeStatus;
  companionBrowser: CompanionBrowserStatus;
  /** Existing tunnel-binary resolution from the same AppState snapshot. */
  resolvedBinary: string | null;
}

function backendStatuses(input: EveReadinessInput): EveReadiness['backends'] {
  const orchestrator = agentBackendExecutionStatus(input.config.execution.orchestrator, undefined, 'orchestrator');
  let worker = agentBackendExecutionStatus(input.config.execution.worker, undefined, 'worker');
  if (worker.backend === 'ollama' && worker.support === 'supported') {
    const settings = input.config.agentRuntime.ollama;
    const endpoint = normalizeLocalAgentEndpoint(settings.endpoint);
    const model = settings.model.trim();
    if (!endpoint || !model) {
      const missing = [!endpoint ? 'a valid endpoint' : null, !model ? 'an Ollama model' : null].filter(Boolean).join(' and ');
      worker = {
        ...worker,
        readiness: 'unavailable',
        reason: 'ollama-worker-config-invalid',
        detail: `Ollama is selected for workers but still needs ${missing} in Agent execution settings.`
      };
    }
  }
  return { orchestrator, worker };
}

function result(
  input: EveReadinessInput,
  state: EveReadiness['state'],
  nextAction: EveReadiness['nextAction'],
  summary: string,
  detail: string
): EveReadiness {
  return {
    state,
    nextAction,
    summary,
    detail,
    backends: backendStatuses(input)
  };
}

function hasUsablePermission(config: Config, platform: NodeJS.Platform): boolean {
  const capabilities = effectiveCapabilities(config, platform);
  const liveCapability = Object.values(capabilities).some(Boolean);
  return liveCapability || config.sessions.record || config.multiAgent.enabled || config.ui.finishTool === true;
}

/**
 * Pure readiness projection over facts already owned by config, connection and Companion state.
 * Inference-provider reachability is intentionally absent: it cannot establish agent execution.
 */
export function eveReadiness(
  input: EveReadinessInput,
  platform: NodeJS.Platform = process.platform
): EveReadiness {
  const instance = input.config.mcp.connectorName;
  if (!hasUsablePermission(input.config, platform)) {
    return result(
      input,
      'needs-user',
      'enable-permissions',
      'ParadigmEve needs permission to do work',
      `Enable at least one local capability, session recording, multi-agent execution, or Session finish before using ${instance} as an executor.`
    );
  }

  if (input.config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(input.config.tunnel.tunnelId)) {
      return result(
        input,
        'needs-user',
        'configure-tunnel',
        'Finish tunnel setup',
        'Add a valid OpenAI Tunnel ID for this ParadigmEve installation.'
      );
    }
    if (!input.secureStorage.available) {
      return result(
        input,
        'needs-user',
        'fix-secure-storage',
        'Secure credential storage is unavailable',
        input.secureStorage.detail ?? 'ParadigmEve cannot safely store the tunnel credential on this computer.'
      );
    }
    if (!input.hasApiKey) {
      return result(
        input,
        'needs-user',
        'add-api-key',
        'Add the tunnel API key',
        'The OpenAI tunnel is configured, but its restricted API key is not stored.'
      );
    }
  }

  if (input.config.tunnel.kind !== 'manual' && input.resolvedBinary === null) {
    return result(
      input,
      'needs-user',
      'configure-connection',
      'Connection runtime is unavailable',
      `ParadigmEve cannot find the ${input.config.tunnel.kind === 'openai' ? 'tunnel client' : 'cloudflared'} needed by the selected connection method.`
    );
  }

  if (input.status.state === 'starting-server' || input.status.state === 'connecting-tunnel') {
    return result(input, 'preparing', 'wait', 'Connection is starting', input.status.detail || 'ParadigmEve is starting the local connection.');
  }

  if (input.status.state === 'offline') {
    return result(
      input,
      'needs-attention',
      'wait',
      'Connection is temporarily offline',
      input.status.detail || 'The tunnel is still running and retrying its route automatically.'
    );
  }

  if (input.status.state === 'auth-failed' || input.status.state === 'tunnel-unavailable') {
    return result(
      input,
      'needs-user',
      'configure-connection',
      'Connection setup needs attention',
      input.status.detail || 'Review the saved connection settings before trying again.'
    );
  }

  if (input.status.state === 'disconnected') {
    return result(
      input,
      'needs-attention',
      'connect',
      'Connection can be restored',
      'The saved prerequisites are complete, so ParadigmEve can make one connection attempt.'
    );
  }

  if (browserExtensionRequired(input.config)) {
    if (!input.bridge.paired) {
      return result(
        input,
        'needs-user',
        'set-up-companion',
        'Connect the Companion browser',
        'This configuration needs exact ChatGPT browser identity, but this installation has not paired a Companion yet.'
      );
    }
    if (
      !input.bridge.running ||
      !input.bridge.present ||
      input.bridge.chatTabOpen === false ||
      input.companionBrowser.windowOpen === false
    ) {
      return result(
        input,
        'needs-attention',
        'restore-browser',
        `${instance} Browser can be restored`,
        'The Companion was paired previously, but its bridge, browser window, or ChatGPT tab is not currently available.'
      );
    }
  }

  // A selected unsupported executor remains a user boundary, but it does not block an
  // independently safe transport/browser repair above. Re-observation after that one repair
  // lands here without ever substituting a different backend for the user's saved choice.
  const backends = backendStatuses(input);
  const unavailable = Object.entries(backends).filter(([, status]) => status.readiness === 'unavailable');
  if (unavailable.length > 0) {
    return result(
      input,
      'needs-user',
      'select-supported-backends',
      'Selected agent backend is unavailable',
      unavailable.map(([role, status]) => `${role}: ${status.detail}`).join(' ')
    );
  }

  if (input.config.onboarding?.complete === false) {
    const required = input.status.surfaces.filter((surface) => surface.available && !surface.optional);
    if (input.status.lastRequestAt === null || required.some((surface) => surface.lastRequestAt === null)) {
      return result(
        input,
        'needs-user',
        'verify-chatgpt',
        'Finish ChatGPT verification',
        'The local connection is ready, but first-run setup is not verified until ChatGPT reaches the required ParadigmEve app.'
      );
    }
    if (required.some((surface) => surface.lastToolCallAt === null)) {
      return result(
        input,
        'needs-user',
        'verify-chatgpt',
        'Finish ChatGPT verification',
        'ChatGPT reached the required ParadigmEve app, but first-run setup is not verified until it invokes a tool there.'
      );
    }
  }

  return result(
    input,
    'ready',
    'none',
    `${instance} is ready`,
    'The selected agent backends are supported and the required local connection and Companion evidence are available.'
  );
}
