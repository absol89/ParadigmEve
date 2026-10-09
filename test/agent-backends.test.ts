import { describe, expect, it } from 'vitest';
import {
  AGENT_BACKEND_IDS,
  AGENT_BACKEND_LABELS,
  AGENT_EXECUTION_READINESS,
  AGENT_EXECUTION_SUPPORT,
  agentBackendAvailableInBuild,
  agentBackendsForBuild,
  defaultAgentExecutionSettings,
  agentBackendExecutionStatus
} from '../src/shared/agent-backends.js';

describe('agent execution backend contract', () => {
  it('keeps the exact stable ids and user-facing labels', () => {
    expect(AGENT_BACKEND_IDS).toEqual(['gpt-chat', 'gpt-work', 'ollama', 'openrouter', 'custom']);
    expect(AGENT_BACKEND_LABELS).toEqual({
      'gpt-chat': 'GPT Chat',
      'gpt-work': 'GPT Work',
      ollama: 'Ollama',
      openrouter: 'OpenRouter',
      custom: 'Custom OpenAI-compatible'
    });
  });

  it('uses one exact backend capability matrix for debug, dev, and shipping', () => {
    expect(agentBackendsForBuild('debug')).toEqual(['gpt-chat', 'gpt-work', 'ollama', 'openrouter', 'custom']);
    expect(agentBackendsForBuild('dev')).toEqual(['gpt-work', 'ollama', 'openrouter', 'custom']);
    expect(agentBackendsForBuild('shipping')).toEqual(['gpt-work', 'ollama', 'openrouter']);
    expect(agentBackendAvailableInBuild('gpt-chat', 'debug')).toBe(true);
    expect(agentBackendAvailableInBuild('gpt-chat', 'dev')).toBe(false);
    expect(agentBackendAvailableInBuild('custom', 'dev')).toBe(true);
    expect(agentBackendAvailableInBuild('custom', 'shipping')).toBe(false);
  });

  it('defaults debug to GPT Chat and non-debug builds to GPT Work', () => {
    expect(defaultAgentExecutionSettings('debug')).toEqual({ orchestrator: 'gpt-chat', worker: 'gpt-chat' });
    expect(defaultAgentExecutionSettings('dev')).toEqual({ orchestrator: 'gpt-work', worker: 'gpt-work' });
    expect(defaultAgentExecutionSettings('shipping')).toEqual({ orchestrator: 'gpt-work', worker: 'gpt-work' });
  });

  it('keeps build support separate from runtime readiness', () => {
    expect(AGENT_EXECUTION_SUPPORT).toEqual(['supported', 'unsupported']);
    expect(AGENT_EXECUTION_READINESS).toEqual(['unknown', 'ready', 'unavailable']);
    expect(agentBackendExecutionStatus('gpt-chat')).toEqual({
      backend: 'gpt-chat',
      label: 'GPT Chat',
      support: 'supported',
      readiness: 'unknown',
      reason: null,
      detail: null
    });
  });

  it('keeps Ollama worker execution role-scoped without promoting transport reachability to ready', () => {
    expect(agentBackendExecutionStatus('gpt-work')).toMatchObject({
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'gpt-work-executor-unavailable'
    });
    expect(agentBackendExecutionStatus('ollama', 'debug', 'worker')).toMatchObject({
      support: 'supported',
      readiness: 'unknown',
      reason: null,
      detail: null
    });
    expect(agentBackendExecutionStatus('ollama', 'debug', 'orchestrator')).toMatchObject({
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'ollama-orchestrator-unavailable',
      detail: expect.stringContaining('worker executor')
    });
    expect(agentBackendExecutionStatus('custom')).toMatchObject({
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'custom-agent-runtime-unavailable'
    });
  });

  it('refuses a backend excluded from the compiled flavor before executor readiness matters', () => {
    expect(agentBackendExecutionStatus('gpt-chat', 'shipping')).toMatchObject({
      backend: 'gpt-chat',
      support: 'unsupported',
      readiness: 'unavailable',
      reason: 'backend-excluded-by-build-flavor',
      detail: expect.stringContaining('shipping')
    });
    expect(agentBackendExecutionStatus('custom', 'shipping')).toMatchObject({
      reason: 'backend-excluded-by-build-flavor'
    });
  });
});
