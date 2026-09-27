import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import type { BuildFlavor } from '../src/shared/build-flavor.js';
import type { LanPeerDiscoveryOptions } from '../src/main/lan-peer-discovery.js';
import type { LanHeartbeatSourceState } from '../src/main/lan-peer-heartbeat.js';
import { defaultConfig } from '../src/main/config.js';
import { startLanPeerRuntime } from '../src/main/lan-peer-runtime.js';

const testIdentity = {
  peerId: Buffer.alloc(32, 0x31).toString('base64url'),
  publicKey: Buffer.alloc(44, 0x32).toString('base64url'),
  sign: () => Buffer.alloc(64, 0x33).toString('base64url')
};

function runtimeHarness(
  config: Config,
  groupKey: Buffer | null = Buffer.alloc(32, 0x7a),
  buildFlavor: BuildFlavor = 'debug'
) {
  let current = config;
  let discoveryOptions: LanPeerDiscoveryOptions | null = null;
  const publish = vi.fn();
  const sendMessage = vi.fn(async () => ({ messageId: '11111111-1111-4111-8111-111111111111', confirmed: true }));
  const stop = vi.fn();
  const startDiscovery = vi.fn((options: LanPeerDiscoveryOptions) => {
    discoveryOptions = options;
    return { peers: () => [], publish, sendMessage, stop };
  });
  const groupKeyRead = vi.fn(async () => groupKey);
  const identityRead = vi.fn(async () => testIdentity);
  const reserveNickname = vi.fn(async () => 'claimed' as const);
  return {
    dependencies: {
      buildFlavor,
      config: () => current,
      groupKey: groupKeyRead,
      identity: identityRead,
      reserveNickname,
      appVersion: '2.1.4-test',
      startDiscovery
    },
    groupKeyRead,
    identityRead,
    reserveNickname,
    startDiscovery,
    publish,
    sendMessage,
    stop,
    setConfig(next: Config) { current = next; },
    options: () => discoveryOptions
  };
}

describe('LAN peer runtime owner', () => {
  it.each(['dev', 'shipping'] as const)('never activates discovery in a %s build', async (buildFlavor) => {
    const config = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(config, Buffer.alloc(32, 0x7a), buildFlavor);
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);

    expect(runtime.running).toBe(false);
    expect(harness.groupKeyRead).not.toHaveBeenCalled();
    expect(harness.identityRead).not.toHaveBeenCalled();
    expect(harness.startDiscovery).not.toHaveBeenCalled();
  });

  it('does not read a key or start discovery while LAN is disabled', async () => {
    const harness = runtimeHarness(defaultConfig());
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);

    expect(runtime.running).toBe(false);
    expect(harness.groupKeyRead).not.toHaveBeenCalled();
    expect(harness.identityRead).not.toHaveBeenCalled();
    expect(harness.startDiscovery).not.toHaveBeenCalled();
  });

  it('fails closed when opt-in has no valid stored group key', async () => {
    const config = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(config, null);
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);

    expect(runtime.running).toBe(false);
    expect(harness.groupKeyRead).toHaveBeenCalledTimes(1);
    expect(harness.identityRead).not.toHaveBeenCalled();
    expect(harness.startDiscovery).not.toHaveBeenCalled();
  });

  it('rechecks opt-in after the asynchronous key read before opening discovery', async () => {
    const enabled = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(enabled);
    harness.dependencies.groupKey = vi.fn(async () => {
      harness.setConfig({ ...enabled, lan: { enabled: false } });
      return Buffer.alloc(32, 0x33);
    });

    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);
    expect(runtime.running).toBe(false);
    expect(harness.startDiscovery).not.toHaveBeenCalled();
  });

  it('reserves the current nickname against the installation fingerprint before opening discovery', async () => {
    const config = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(config);
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);

    expect(runtime.running).toBe(true);
    expect(harness.identityRead).toHaveBeenCalledTimes(1);
    expect(harness.reserveNickname).toHaveBeenCalledWith(Buffer.alloc(32, 0x7a), 'Eve', testIdentity.peerId);
    expect(harness.reserveNickname.mock.invocationCallOrder[0]).toBeLessThan(harness.startDiscovery.mock.invocationCallOrder[0]!);
  });

  it('fails closed before discovery if this group remembers the nickname under another fingerprint', async () => {
    const config = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(config);
    harness.dependencies.reserveNickname = vi.fn(async () => { throw new Error('nickname conflict'); });
    await expect(startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies)).rejects.toThrow(/conflict/i);
    expect(harness.startDiscovery).not.toHaveBeenCalled();
  });

  it('starts with only configured public identity/capacity and sanitized heartbeat state', async () => {
    const base = defaultConfig();
    const config = {
      ...base,
      lan: { enabled: true },
      mcp: { ...base.mcp, connectorName: 'Eva Å' },
      multiAgent: { ...base.multiAgent, maxWorkers: 6 }
    };
    const harness = runtimeHarness(config);
    const heartbeatState = vi.fn((): LanHeartbeatSourceState => ({ lastCompletedAt: 1_700_000_000_000 }));
    const runtime = await startLanPeerRuntime({ heartbeatState }, harness.dependencies);

    expect(runtime.running).toBe(true);
    expect(harness.startDiscovery).toHaveBeenCalledTimes(1);
    expect(harness.options()?.groupKey).toEqual(Buffer.alloc(32, 0x7a));
    const snapshot = harness.options()!.snapshot();
    expect(snapshot).toMatchObject({
      nickname: 'Eva Å',
      peerId: testIdentity.peerId,
      publicKey: testIdentity.publicKey,
      protocol: 2,
      appVersion: '2.1.4-test',
      workerCapacity: 6,
      heartbeat: {
        lastRunAt: 1_700_000_000_000,
        result: 'completed',
        summary: 'Semantic review completed.'
      }
    });
    expect(snapshot.signature).toHaveLength(86);
    expect(Object.keys(snapshot.heartbeat).sort()).toEqual(['lastRunAt', 'result', 'summary']);
  });

  it('reads current capacity/heartbeat facts while keeping its reserved nickname stable until refresh', async () => {
    const config = { ...defaultConfig(), lan: { enabled: true } };
    const harness = runtimeHarness(config);
    let heartbeat: LanHeartbeatSourceState = { pendingUntilAt: 1_700_000_100_000 };
    const runtime = await startLanPeerRuntime({ heartbeatState: () => heartbeat }, harness.dependencies);
    const snapshot = harness.options()!.snapshot;

    expect(snapshot()).toMatchObject({
      nickname: 'Eve',
      workerCapacity: 2,
      heartbeat: { result: 'pending', lastRunAt: 1_700_000_100_000 }
    });

    harness.setConfig({
      ...config,
      mcp: { ...config.mcp, connectorName: 'Eva' },
      multiAgent: { ...config.multiAgent, maxWorkers: 4 }
    });
    heartbeat = {};
    expect(snapshot()).toMatchObject({
      // The live discovery owner may not silently start advertising a name it never reserved.
      // Managed refresh/restart claims the renamed connector name before opening the next socket.
      nickname: 'Eve',
      workerCapacity: 4,
      heartbeat: { result: 'never-run', lastRunAt: null }
    });

    runtime.publish();
    expect(harness.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps peer messaging on the authenticated installation identity and forwards the receive callback', async () => {
    const harness = runtimeHarness({ ...defaultConfig(), lan: { enabled: true } });
    const onMessage = vi.fn(async () => undefined);
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null, onMessage }, harness.dependencies);

    expect(harness.options()?.identity).toMatchObject({ peerId: testIdentity.peerId });
    expect(harness.options()?.identity?.sign).toBe(testIdentity.sign);
    await harness.options()?.onMessage?.({
      messageId: '11111111-1111-4111-8111-111111111111',
      fromPeerId: Buffer.alloc(32, 0x44).toString('base64url'),
      nickname: 'Eva',
      text: 'Peer knowledge only',
      sentAt: 1_700_000_000_000
    });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ nickname: 'Eva', text: 'Peer knowledge only' }));

    await expect(runtime.sendMessage(Buffer.alloc(32, 0x44).toString('base64url'), 'hello')).resolves.toEqual({
      messageId: '11111111-1111-4111-8111-111111111111',
      confirmed: true
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(Buffer.alloc(32, 0x44).toString('base64url'), 'hello');
  });

  it('closes its discovery owner exactly once and refuses later publishes', async () => {
    const harness = runtimeHarness({ ...defaultConfig(), lan: { enabled: true } });
    const runtime = await startLanPeerRuntime({ heartbeatState: () => null }, harness.dependencies);

    runtime.stop();
    runtime.stop();
    runtime.publish();
    expect(runtime.running).toBe(false);
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.publish).not.toHaveBeenCalled();
  });
});
