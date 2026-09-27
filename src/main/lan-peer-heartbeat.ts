import { lanHeartbeatHealth, type LanHeartbeatHealth } from '../shared/lan-peer.js';

/** Sanitized owner-side facts. Raw heartbeat debt/receipt identity must be removed before this seam. */
export interface LanHeartbeatSourceState {
  pendingUntilAt?: number;
  lastCompletedAt?: number;
  lastCompletionAt?: number;
  lastCompletionResult?: 'completed' | 'dispatched' | 'blocked' | 'failed';
}

/**
 * Privacy boundary from sanitized semantic-heartbeat facts to LAN presence.
 *
 * The raw heartbeat owner must remove opaque keys and exact session/conversation/request identity
 * before constructing `LanHeartbeatSourceState`. This module intentionally cannot import or accept
 * that raw debt/receipt shape. The LAN side receives only a timestamp, a small result enum and the
 * fixed summary derived from that enum.
 */
export function projectLanHeartbeatHealth(state: LanHeartbeatSourceState | null): LanHeartbeatHealth {
  if (!state) return lanHeartbeatHealth(null, 'never-run');
  if (state.pendingUntilAt !== undefined) return lanHeartbeatHealth(state.pendingUntilAt, 'pending');
  if (state.lastCompletionAt !== undefined) return lanHeartbeatHealth(state.lastCompletionAt, state.lastCompletionResult ?? 'completed');
  if (state.lastCompletedAt !== undefined) return lanHeartbeatHealth(state.lastCompletedAt, 'completed');
  return lanHeartbeatHealth(null, 'never-run');
}
