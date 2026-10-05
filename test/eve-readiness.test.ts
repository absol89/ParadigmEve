import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { eveReadiness, type EveReadinessInput } from '../src/main/eve-readiness.js';
import type { BridgeStatus, Config, ConnectionStatus } from '../src/shared/types.js';

const root = { name: 'workspace', path: 'C:\\workspace' };

function config(overrides: Partial<Config> = {}): Config {
  const base = defaultConfig('win32');
  return {
    ...base,
    roots: [root],
    tunnel: { ...base.tunnel, kind: 'manual' },
    sessions: { ...base.sessions, record: false },
    multiAgent: { ...base.multiAgent, enabled: false },
    ui: { ...base.ui, finishTool: false },
    ...overrides
  };
}

function status(
  state: ConnectionStatus['state'] = 'connected',
  requested: number | null = Date.now(),
  called: number | null = requested
): ConnectionStatus {
  return {
    state,
    detail: state === 'connected' ? 'Connected.' : 'Working…',
    publicUrl: null,
    localUrl: 'http://127.0.0.1:1234/mcp/core/token',
    handshakeAt: state === 'connected' ? Date.now() : null,
    lastRequestAt: requested,
    lastToolCallAt: called,
    health: null,
    surfaces: [{
      id: 'core',
      connectorName: 'Eve',
      description: '',
      cardSummary: '',
      optional: false,
      available: true,
      localUrl: 'http://127.0.0.1:1234/mcp/core/token',
      publicUrl: null,
      tools: ['read'],
      state: state === 'connected' ? 'live' : state === 'starting-server' || state === 'connecting-tunnel' ? 'starting' : 'error',
      detail: '',
      lastRequestAt: requested,
      lastToolCallAt: called
    }]
  };
}

function bridge(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    running: true,
    port: 8765,
    paired: true,
    present: true,
    chatTabOpen: true,
    lastSeenAt: Date.now(),
    extensionVersion: '2.1.2',
    ...overrides
  };
}

function input(overrides: Partial<EveReadinessInput> = {}): EveReadinessInput {
  return {
    config: config(),
    secureStorage: { available: true, detail: null },
    hasApiKey: true,
    status: status(),
    bridge: bridge(),
    companionBrowser: { windowOpen: true },
    resolvedBinary: 'C:\\ParadigmEve\\tunnel-client.exe',
    ...overrides
  };
}

describe('Eve readiness projection', () => {
  it('reports ready only from supported execution plus current connection evidence', () => {
    const readiness = eveReadiness(input(), 'win32');
    expect(readiness).toMatchObject({ state: 'ready', nextAction: 'none' });
    expect(readiness.backends).toMatchObject({
      orchestrator: { backend: 'gpt-chat', support: 'supported', readiness: 'unknown' },
      worker: { backend: 'gpt-chat', support: 'supported', readiness: 'unknown' }
    });
  });

  it('reports an in-flight connection as preparing', () => {
    expect(eveReadiness(input({ status: status('starting-server', null) }), 'win32')).toMatchObject({
      state: 'preparing',
      nextAction: 'wait'
    });
  });

  it('offers one safe connection repair when configured prerequisites are complete', () => {
    expect(eveReadiness(input({ status: status('disconnected', null) }), 'win32')).toMatchObject({
      state: 'needs-attention',
      nextAction: 'connect'
    });
  });

  it('offers browser restore only for a previously paired missing Companion', () => {
    const browserConfig = config({ sessions: { ...config().sessions, record: true } });
    expect(eveReadiness(input({
      config: browserConfig,
      bridge: bridge({ present: false, chatTabOpen: false }),
      companionBrowser: { windowOpen: false }
    }), 'win32')).toMatchObject({ state: 'needs-attention', nextAction: 'restore-browser' });

    expect(eveReadiness(input({
      config: browserConfig,
      bridge: bridge({ paired: false, present: false, chatTabOpen: null }),
      companionBrowser: { windowOpen: false }
    }), 'win32')).toMatchObject({ state: 'needs-user', nextAction: 'set-up-companion' });
  });

  it('keeps incomplete onboarding without a first request at verification, not failure', () => {
    const unverified = status('connected', null);
    expect(eveReadiness(input({ status: unverified }), 'win32')).toMatchObject({
      state: 'needs-user',
      nextAction: 'verify-chatgpt',
      summary: 'Finish ChatGPT verification'
    });
  });

  it('keeps discovery-only onboarding at verification until the required app receives a tool call', () => {
    const discovered = status('connected', 100, null);
    expect(eveReadiness(input({ status: discovered }), 'win32')).toMatchObject({
      state: 'needs-user',
      nextAction: 'verify-chatgpt',
      summary: 'Finish ChatGPT verification'
    });

    discovered.lastToolCallAt = 200;
    discovered.surfaces.push({
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'live', detail: '',
      lastRequestAt: 200, lastToolCallAt: 200
    });
    expect(eveReadiness(input({ status: discovered }), 'win32')).toMatchObject({
      state: 'needs-user',
      nextAction: 'verify-chatgpt'
    });

    discovered.surfaces[0]!.lastToolCallAt = 201;
    expect(eveReadiness(input({ status: discovered }), 'win32')).toMatchObject({ state: 'ready', nextAction: 'none' });
  });

  it('surfaces unsupported selected GPT Work/custom as a user boundary without fallback', () => {
    const selected = config({
      onboarding: { complete: true },
      execution: { orchestrator: 'gpt-work', worker: 'custom' }
    });
    const readiness = eveReadiness(input({ config: selected, status: status('connected', null) }), 'win32');
    expect(readiness).toMatchObject({ state: 'needs-user', nextAction: 'select-supported-backends' });
    expect(readiness.backends).toMatchObject({
      orchestrator: { backend: 'gpt-work', readiness: 'unavailable' },
      worker: { backend: 'custom', readiness: 'unavailable' }
    });
  });

  it('keeps a selected Ollama worker unavailable until endpoint and model are explicitly configured', () => {
    const missing = config({
      onboarding: { complete: true },
      execution: { orchestrator: 'gpt-chat', worker: 'ollama' },
      agentRuntime: { ollama: { endpoint: '', model: '' } }
    });
    expect(eveReadiness(input({ config: missing, status: status('connected', null) }), 'win32')).toMatchObject({
      state: 'needs-user',
      nextAction: 'select-supported-backends',
      backends: {
        worker: { backend: 'ollama', support: 'supported', readiness: 'unavailable', reason: 'ollama-worker-config-invalid' }
      }
    });

    const configured = config({
      onboarding: { complete: true },
      execution: { orchestrator: 'gpt-chat', worker: 'ollama' },
      agentRuntime: { ollama: { endpoint: 'http://127.0.0.1:11434/v1', model: 'gemma4:cloud' } }
    });
    expect(eveReadiness(input({ config: configured, status: status('connected', null) }), 'win32')).toMatchObject({
      state: 'ready',
      backends: { worker: { backend: 'ollama', support: 'supported', readiness: 'unknown', reason: null } }
    });
  });

  it('repairs safe transport before surfacing an independently unsupported backend preference', () => {
    const selected = config({
      onboarding: { complete: true },
      execution: { orchestrator: 'gpt-work', worker: 'ollama' }
    });
    expect(eveReadiness(input({ config: selected, status: status('disconnected', null) }), 'win32')).toMatchObject({
      state: 'needs-attention',
      nextAction: 'connect'
    });
  });

  it('does not fail completed onboarding only because the fresh-process request clock is empty', () => {
    const completed = config({ onboarding: { complete: true } });
    expect(eveReadiness(input({ config: completed, status: status('connected', null) }), 'win32')).toMatchObject({
      state: 'ready',
      nextAction: 'none'
    });
  });

  it('keeps missing setup prerequisites ahead of any repair or unsupported backend preference', () => {
    const base = defaultConfig('win32');
    const blocked = config({
      roots: [],
      tunnel: { ...base.tunnel, kind: 'openai', tunnelId: '' },
      execution: { orchestrator: 'gpt-work', worker: 'ollama' }
    });
    expect(eveReadiness(input({ config: blocked, status: status('disconnected', null), hasApiKey: false }), 'win32')).toMatchObject({
      state: 'needs-user',
      nextAction: 'configure-tunnel'
    });
  });
});
