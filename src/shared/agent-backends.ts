import { BUILD_FLAVOR, type BuildFlavor } from './build-flavor.js';

/** Stable product vocabulary for agent execution backends. */
export const AGENT_BACKEND_IDS = ['gpt-chat', 'gpt-work', 'ollama', 'custom'] as const;
export type AgentBackendId = (typeof AGENT_BACKEND_IDS)[number];

/** Exact labels shown anywhere this backend vocabulary is presented. */
export const AGENT_BACKEND_LABELS = {
  'gpt-chat': 'GPT Chat',
  'gpt-work': 'GPT Work',
  ollama: 'Ollama',
  custom: 'Custom OpenAI-compatible'
} as const satisfies Record<AgentBackendId, string>;

/**
 * Product capability policy for each compiled build flavor. This is also the renderer's
 * visibility authority: a backend absent here must not be offered by that flavor.
 */
export const AGENT_BACKENDS_BY_BUILD_FLAVOR = {
  debug: ['gpt-chat', 'gpt-work', 'ollama', 'custom'],
  dev: ['gpt-work', 'ollama', 'custom'],
  shipping: ['gpt-work', 'ollama']
} as const satisfies Record<BuildFlavor, readonly AgentBackendId[]>;

export function agentBackendsForBuild(flavor: BuildFlavor = BUILD_FLAVOR): readonly AgentBackendId[] {
  return AGENT_BACKENDS_BY_BUILD_FLAVOR[flavor];
}

export function agentBackendAvailableInBuild(
  backend: AgentBackendId,
  flavor: BuildFlavor = BUILD_FLAVOR
): boolean {
  return (agentBackendsForBuild(flavor) as readonly AgentBackendId[]).includes(backend);
}

export interface AgentExecutionSettings {
  orchestrator: AgentBackendId;
  worker: AgentBackendId;
}

/** Dedicated local-agent runtime settings. Kept separate from Goal/Loop provider inference. */
export interface AgentRuntimeSettings {
  ollama: {
    endpoint: string;
    model: string;
  };
}

export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  ollama: { endpoint: '', model: '' }
};

export function defaultAgentExecutionSettings(flavor: BuildFlavor = BUILD_FLAVOR): AgentExecutionSettings {
  const backend: AgentBackendId = flavor === 'debug' ? 'gpt-chat' : 'gpt-work';
  return { orchestrator: backend, worker: backend };
}

export const DEFAULT_AGENT_EXECUTION_SETTINGS: AgentExecutionSettings = defaultAgentExecutionSettings();

/**
 * Build support answers whether this app contains a real agent executor for the backend.
 * Runtime readiness is separate and may only become `ready` from execution-specific evidence.
 * A reachable inference endpoint or model catalogue is never that evidence.
 */
export const AGENT_EXECUTION_SUPPORT = ['supported', 'unsupported'] as const;
export type AgentExecutionSupport = (typeof AGENT_EXECUTION_SUPPORT)[number];
export const AGENT_EXECUTION_READINESS = ['unknown', 'ready', 'unavailable'] as const;
export type AgentExecutionReadiness = (typeof AGENT_EXECUTION_READINESS)[number];

export const AGENT_EXECUTION_UNAVAILABLE_REASONS = [
  'backend-excluded-by-build-flavor',
  'gpt-work-executor-unavailable',
  'ollama-orchestrator-unavailable',
  'ollama-worker-config-invalid',
  'ollama-agent-runtime-unavailable',
  'custom-agent-runtime-unavailable'
] as const;
export type AgentExecutionUnavailableReason = (typeof AGENT_EXECUTION_UNAVAILABLE_REASONS)[number];

export interface AgentBackendExecutionStatus {
  backend: AgentBackendId;
  label: (typeof AGENT_BACKEND_LABELS)[AgentBackendId];
  support: AgentExecutionSupport;
  readiness: AgentExecutionReadiness;
  reason: AgentExecutionUnavailableReason | null;
  detail: string | null;
}

/**
 * Executor availability for one selected backend. Build-flavor exclusion is checked first;
 * an included backend may still be unavailable because its executor is not implemented yet.
 */
export function agentBackendExecutionStatus(
  backend: AgentBackendId,
  flavor: BuildFlavor = BUILD_FLAVOR,
  role: 'orchestrator' | 'worker' = 'worker'
): AgentBackendExecutionStatus {
  if (!agentBackendAvailableInBuild(backend, flavor)) {
    return {
      backend,
      label: AGENT_BACKEND_LABELS[backend],
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'backend-excluded-by-build-flavor',
      detail: `${AGENT_BACKEND_LABELS[backend]} agent execution is excluded from ${flavor} builds.`
    };
  }
  if (backend === 'gpt-chat') {
    return {
      backend,
      label: AGENT_BACKEND_LABELS[backend],
      support: 'supported',
      readiness: 'unknown',
      reason: null,
      detail: null
    };
  }
  if (backend === 'gpt-work') {
    return {
      backend,
      label: AGENT_BACKEND_LABELS[backend],
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'gpt-work-executor-unavailable',
      detail: 'GPT Work is allowed by this build flavor, but its agent executor is not implemented yet.'
    };
  }
  if (backend === 'ollama') {
    if (role === 'worker') {
      return {
        backend,
        label: AGENT_BACKEND_LABELS[backend],
        support: 'supported',
        readiness: 'unknown',
        reason: null,
        detail: null
      };
    }
    return {
      backend,
      label: AGENT_BACKEND_LABELS[backend],
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'ollama-orchestrator-unavailable',
      detail:
        'Ollama is available as a worker executor, but ParadigmEve still requires the owning agent/orchestrator to run through ChatGPT.'
    };
  }
  return {
    backend,
    label: AGENT_BACKEND_LABELS[backend],
    support: 'unsupported',
    readiness: 'unavailable',
    reason: 'custom-agent-runtime-unavailable',
    detail: 'No custom OpenAI-compatible agent executor/runtime is implemented yet.'
  };
}
