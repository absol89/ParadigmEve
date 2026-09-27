import type { Config, LanRuntimeStatus } from '../shared/types.js';
import type { LanPeerPresence } from '../shared/lan-peer.js';
import { canonicalLanPeerNickname, lanPeerAnnouncementSigningText, makeLanPeerUnsignedAnnouncement } from '../shared/lan-peer.js';
import { BUILD_FLAVOR, type BuildFlavor } from '../shared/build-flavor.js';
import { getConfig } from './config.js';
import {
  startLanPeerDiscovery,
  type LanPeerDiscovery,
  type LanPeerMessageDelivery,
  type LanPeerReceivedMessage,
  type LanPeerDiscoveryOptions
} from './lan-peer-discovery.js';
import { projectLanHeartbeatHealth, type LanHeartbeatSourceState } from './lan-peer-heartbeat.js';
import { getOrCreateLanPeerIdentity, type LanPeerIdentity } from './lan-peer-identity.js';
import { getLanGroupKey } from './lan-peer-key.js';
import { LanPeerNicknameConflictError, reserveLanPeerNickname } from './lan-peer-reservations.js';
import { APP_VERSION } from './version.js';

export interface LanPeerRuntimeOptions {
  /** Already-sanitized semantic heartbeat facts. Never pass raw debt, receipts, chats or plans. */
  heartbeatState: () => LanHeartbeatSourceState | null;
  onPeers?: (peers: readonly LanPeerPresence[]) => void;
  /** Authenticated peer text. Callers must persist/project it as knowledge, never remote authority. */
  onMessage?: (message: LanPeerReceivedMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface LanPeerRuntime {
  readonly running: boolean;
  publish(): void;
  sendMessage(peerId: string, text: string): Promise<LanPeerMessageDelivery>;
  stop(): void;
}

interface LanPeerRuntimeDependencies {
  buildFlavor: BuildFlavor;
  config: () => Config;
  groupKey: () => Promise<Buffer | null>;
  identity: () => Promise<LanPeerIdentity>;
  reserveNickname: (groupKey: Uint8Array, nickname: string, peerId: string) => Promise<'claimed' | 'owned'>;
  appVersion: string;
  startDiscovery: (options: LanPeerDiscoveryOptions) => LanPeerDiscovery;
}

const DEFAULT_DEPENDENCIES: LanPeerRuntimeDependencies = {
  buildFlavor: BUILD_FLAVOR,
  config: getConfig,
  groupKey: getLanGroupKey,
  identity: getOrCreateLanPeerIdentity,
  reserveNickname: reserveLanPeerNickname,
  appVersion: APP_VERSION,
  startDiscovery: startLanPeerDiscovery
};

const INACTIVE_RUNTIME: LanPeerRuntime = Object.freeze({
  running: false,
  publish() {},
  async sendMessage() { throw new Error('LAN peer messaging is not running'); },
  stop() {}
});

let managedOptions: LanPeerRuntimeOptions | null = null;
let managedRuntime: LanPeerRuntime = INACTIVE_RUNTIME;
let managedPeers: LanPeerPresence[] = [];
const managedListeners = new Set<() => void>();
let managedGeneration = 0;

function emitManagedChange(): void {
  for (const listener of [...managedListeners]) listener();
}

export function lanPeerRuntimeAvailable(buildFlavor: BuildFlavor = BUILD_FLAVOR): boolean {
  return buildFlavor === 'debug';
}

/** Current process-local public runtime state. Secret material never enters this projection. */
export function lanPeerRuntimeStatus(joined: boolean): LanRuntimeStatus {
  return {
    enabled: getConfig().lan.enabled,
    joined,
    running: managedRuntime.running,
    peers: managedPeers.map((peer) => ({ ...peer, heartbeat: { ...peer.heartbeat } }))
  };
}

/** Model-facing debug projection for peer addressing; contains no group key or network endpoint. */
export function lanPeerMessagingStatus(): { running: boolean; peers: LanPeerPresence[] } {
  return {
    running: managedRuntime.running,
    peers: managedPeers.map((peer) => ({ ...peer, heartbeat: { ...peer.heartbeat } }))
  };
}

export function onLanPeerRuntimeChange(listener: () => void): () => void {
  managedListeners.add(listener);
  return () => managedListeners.delete(listener);
}

/**
 * Start or replace the one process-owned discovery runtime. Settings actions call refresh after
 * changing the encrypted key or opt-in, so Create/Join/Off/Forget take effect without a restart.
 */
export async function configureLanPeerRuntime(options: LanPeerRuntimeOptions): Promise<boolean> {
  managedOptions = options;
  return refreshLanPeerRuntime();
}

export async function refreshLanPeerRuntime(): Promise<boolean> {
  const generation = ++managedGeneration;
  managedRuntime.stop();
  managedRuntime = INACTIVE_RUNTIME;
  managedPeers = [];
  const options = managedOptions;
  if (!options) {
    emitManagedChange();
    return false;
  }
  const candidate = await startLanPeerRuntime({
    ...options,
    onMessage: async (message) => {
      if (generation !== managedGeneration || managedOptions !== options) {
        throw new Error('LAN peer runtime changed before message acceptance');
      }
      await options.onMessage?.(message);
    },
    onPeers: (peers) => {
      if (generation !== managedGeneration || managedOptions !== options) return;
      managedPeers = peers.map((peer) => ({ ...peer, heartbeat: { ...peer.heartbeat } }));
      options.onPeers?.(peers);
      emitManagedChange();
    }
  });
  if (generation !== managedGeneration || managedOptions !== options) {
    candidate.stop();
    return managedRuntime.running;
  }
  managedRuntime = candidate;
  emitManagedChange();
  return managedRuntime.running;
}

export function publishLanPeerRuntime(): void {
  managedRuntime.publish();
}

export async function sendLanPeerMessage(target: string, text: string): Promise<{ peer: LanPeerPresence; delivery: LanPeerMessageDelivery }> {
  if (!lanPeerRuntimeAvailable()) throw new Error('LAN peer messaging is available only in debug builds');
  if (!managedRuntime.running) throw new Error('LAN peer messaging is not running');
  const trimmed = target.trim();
  let peer = managedPeers.find((candidate) => candidate.peerId === trimmed && candidate.online);
  if (!peer) {
    let canonical: string;
    try { canonical = canonicalLanPeerNickname(trimmed); }
    catch { throw new Error('LAN peer name is invalid'); }
    peer = managedPeers.find((candidate) => candidate.online && canonicalLanPeerNickname(candidate.nickname) === canonical);
  }
  if (!peer) throw new Error(`No online LAN peer named ${JSON.stringify(trimmed)} is currently authenticated`);
  const delivery = await managedRuntime.sendMessage(peer.peerId, text);
  return { peer: { ...peer, heartbeat: { ...peer.heartbeat } }, delivery };
}

/** Stop discovery immediately while retaining the process-owned options for a later refresh. */
export function pauseLanPeerRuntime(): void {
  managedGeneration += 1;
  managedRuntime.stop();
  managedRuntime = INACTIVE_RUNTIME;
  managedPeers = [];
  emitManagedChange();
}

export function stopLanPeerRuntime(): void {
  pauseLanPeerRuntime();
  managedOptions = null;
}

/**
 * Own one process-lifetime LAN discovery instance without deciding app startup policy.
 *
 * Admission is fail-closed: LAN presence is a debug-only capability for now, and both the current
 * explicit opt-in and a valid dedicated group key are required. The opt-in is re-read after the
 * asynchronous secret lookup so a concurrent Off cannot open a socket from stale settings.
 * Messaging is deliberately narrower than worker routing: one authenticated text packet to one
 * already-present installation, with no remote execution primitive.
 */
export async function startLanPeerRuntime(
  options: LanPeerRuntimeOptions,
  dependencies: LanPeerRuntimeDependencies = DEFAULT_DEPENDENCIES
): Promise<LanPeerRuntime> {
  if (!lanPeerRuntimeAvailable(dependencies.buildFlavor)) return INACTIVE_RUNTIME;
  if (!dependencies.config().lan.enabled) return INACTIVE_RUNTIME;

  const groupKey = await dependencies.groupKey();
  if (!groupKey) return INACTIVE_RUNTIME;

  // Settings may have changed while secure storage was being read. Off always wins.
  if (!dependencies.config().lan.enabled) return INACTIVE_RUNTIME;

  const identity = await dependencies.identity();
  let localNickname = dependencies.config().mcp.connectorName;
  await dependencies.reserveNickname(groupKey, localNickname, identity.peerId);
  const afterReservation = dependencies.config();
  if (!afterReservation.lan.enabled) return INACTIVE_RUNTIME;
  // If the human renamed this installation while the durable reservation write was in flight,
  // reserve the newer name before any packet can advertise it. A further concurrent rename fails
  // closed here and the next managed refresh can retry from the newest config.
  if (afterReservation.mcp.connectorName !== localNickname) {
    localNickname = afterReservation.mcp.connectorName;
    await dependencies.reserveNickname(groupKey, localNickname, identity.peerId);
    if (!dependencies.config().lan.enabled || dependencies.config().mcp.connectorName !== localNickname) return INACTIVE_RUNTIME;
  }

  const reportedConflicts = new Set<string>();

  const discovery = dependencies.startDiscovery({
    groupKey,
    identity: { peerId: identity.peerId, sign: identity.sign },
    snapshot: () => {
      const config = dependencies.config();
      const unsigned = makeLanPeerUnsignedAnnouncement({
        nickname: localNickname,
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        appVersion: dependencies.appVersion,
        workerCapacity: config.multiAgent.maxWorkers,
        heartbeat: projectLanHeartbeatHealth(options.heartbeatState())
      });
      return {
        ...unsigned,
        signature: identity.sign(Buffer.from(lanPeerAnnouncementSigningText(unsigned), 'utf8'))
      };
    },
    acceptPeer: async (announcement) => {
      try {
        await dependencies.reserveNickname(groupKey, announcement.nickname, announcement.peerId);
        return true;
      } catch (error) {
        if (!(error instanceof LanPeerNicknameConflictError)) throw error;
        const conflict = `${announcement.peerId}\u0000${announcement.nickname}`;
        if (!reportedConflicts.has(conflict)) {
          reportedConflicts.add(conflict);
          options.onError?.(error);
        }
        return false;
      }
    },
    onPeers: options.onPeers,
    onMessage: options.onMessage,
    onError: options.onError
  });
  let stopped = false;

  return {
    get running() {
      return !stopped;
    },
    publish() {
      if (!stopped) discovery.publish();
    },
    async sendMessage(peerId, text) {
      if (stopped) throw new Error('LAN peer messaging is stopped');
      return discovery.sendMessage(peerId, text);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      discovery.stop();
    }
  };
}
