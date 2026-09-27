import { beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({
  config: {} as any,
  status: {} as any,
  apiKey: true,
  browserPresent: true,
  cloudflared: true,
  writes: 0
}));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => live.config,
  updateConfig: async (change: (config: any) => any) => {
    live.writes += 1;
    live.config = change(live.config);
    return live.config;
  }
}));
vi.mock('../src/main/connection.js', () => ({ getStatus: () => live.status }));
vi.mock('../src/main/bridge.js', () => ({ browserPresent: () => live.browserPresent }));
vi.mock('../src/main/secrets.js', () => ({ hasSecret: async () => live.apiKey }));
vi.mock('../src/main/tunnel/locate.js', () => ({
  locateBinary: () => live.cloudflared ? 'C:\\tools\\cloudflared.exe' : null
}));

const { onboardingReady, promoteOnboardingIfReady } = await import('../src/main/onboarding.js');

function readyConfig(): any {
  return {
    onboarding: { complete: false },
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    tunnel: { kind: 'openai', tunnelId: `tunnel_${'a'.repeat(32)}`, binaryPath: '' },
    sessions: { record: true },
    multiAgent: { enabled: false },
    readOnly: false,
    capabilities: {
      read: true, metadata: true, browse: false, edit: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    }
  };
}

function readyStatus(): any {
  return {
    state: 'connected',
    lastRequestAt: 100,
    lastToolCallAt: 101,
    surfaces: [{ id: 'core', available: true, optional: false, lastRequestAt: 100, lastToolCallAt: 101 }]
  };
}

beforeEach(() => {
  live.config = readyConfig();
  live.status = readyStatus();
  live.apiKey = true;
  live.browserPresent = true;
  live.cloudflared = true;
  live.writes = 0;
});

describe('durable onboarding completion', () => {
  it('refuses completion until configuration, connector discovery and first-tool evidence are present', async () => {
    live.apiKey = false;
    expect(await onboardingReady()).toBe(false);
    live.apiKey = true;
    live.browserPresent = false;
    expect(await onboardingReady()).toBe(false);
    live.browserPresent = true;
    live.status = {
      ...readyStatus(),
      lastRequestAt: null,
      lastToolCallAt: null,
      surfaces: [{ id: 'core', available: true, optional: false, lastRequestAt: null, lastToolCallAt: null }]
    };
    expect(await onboardingReady()).toBe(false);
    expect(await promoteOnboardingIfReady()).toBe(false);
    expect(live.writes).toBe(0);

    // Discovery alone proves the connector can be reached, not that the model can invoke it.
    live.status = {
      ...readyStatus(),
      lastToolCallAt: null,
      surfaces: [{ id: 'core', available: true, optional: false, lastRequestAt: 100, lastToolCallAt: null }]
    };
    expect(await onboardingReady()).toBe(false);
    expect(await promoteOnboardingIfReady()).toBe(false);
    expect(live.writes).toBe(0);
  });

  it('persists completion once after the first recognized tool call on the required app', async () => {
    expect(await promoteOnboardingIfReady()).toBe(true);
    expect(live.config.onboarding).toEqual({ complete: true });
    expect(live.writes).toBe(1);

    // Once durable, a later closed browser/disconnected tunnel is runtime recovery, not setup.
    live.browserPresent = false;
    live.status = { ...readyStatus(), state: 'disconnected', lastRequestAt: null };
    expect(await promoteOnboardingIfReady()).toBe(true);
    expect(live.writes).toBe(1);
  });

  it('does not require a user Workspace folder before fresh-install help can verify the connector', async () => {
    live.config = { ...readyConfig(), roots: [] };
    expect(await onboardingReady()).toBe(true);
  });

  it('requires request and tool-call evidence on every enabled non-optional surface', async () => {
    live.status = {
      ...readyStatus(),
      surfaces: [
        { id: 'core', available: true, optional: false, lastRequestAt: 100, lastToolCallAt: 101 },
        { id: 'other-required', available: true, optional: false, lastRequestAt: null, lastToolCallAt: null },
        { id: 'optional', available: true, optional: true, lastRequestAt: null, lastToolCallAt: null }
      ]
    };
    expect(await onboardingReady()).toBe(false);
    live.status.surfaces[1].lastRequestAt = 101;
    expect(await onboardingReady()).toBe(false);
    live.status.surfaces[1].lastToolCallAt = 102;
    expect(await onboardingReady()).toBe(true);
  });

  it('does not let an optional or overall tool clock satisfy missing required-surface tool proof', async () => {
    live.status = {
      ...readyStatus(),
      lastToolCallAt: 300,
      surfaces: [
        { id: 'core', available: true, optional: false, lastRequestAt: 100, lastToolCallAt: null },
        { id: 'optional', available: true, optional: true, lastRequestAt: 200, lastToolCallAt: 300 }
      ]
    };
    expect(await onboardingReady()).toBe(false);
  });
});
