import { createHash } from 'node:crypto';
import { canonicalLanPeerNickname, normalizeLanPeerNickname } from '../shared/lan-peer.js';
import { readDurableStrict, writeDurableNow } from './durable.js';

const STATE = 'lan-peer-reservations';
const STATE_VERSION = 1 as const;
const GROUP_KEY_BYTES = 32;
const HASH_BYTES = 32;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

type Reservation = {
  peerId: string;
  nickname: string;
};

type GroupReservations = {
  names: Record<string, Reservation>;
};

type ReservationState = {
  version: typeof STATE_VERSION;
  groups: Record<string, GroupReservations>;
};

export class LanPeerNicknameConflictError extends Error {
  readonly nickname: string;
  constructor(nickname: string) {
    super(`LAN nickname ${JSON.stringify(nickname)} is already reserved by another ParadigmEve installation.`);
    this.name = 'LanPeerNicknameConflictError';
    this.nickname = nickname;
  }
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}

function emptyState(): ReservationState {
  return { version: STATE_VERSION, groups: {} };
}

function validPeerId(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64URL_32.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === HASH_BYTES && Buffer.from(value, 'base64url').toString('base64url') === value;
  } catch {
    return false;
  }
}

function parseState(value: unknown): ReservationState {
  if (value === null) return emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LAN nickname reservations are malformed');
  const row = value as Record<string, unknown>;
  if (row.version !== STATE_VERSION || !row.groups || typeof row.groups !== 'object' || Array.isArray(row.groups)) {
    throw new Error('LAN nickname reservations are malformed');
  }
  if (Object.keys(row).some((key) => key !== 'version' && key !== 'groups')) throw new Error('LAN nickname reservations are malformed');
  const groups: Record<string, GroupReservations> = {};
  for (const [groupId, groupValue] of Object.entries(row.groups as Record<string, unknown>)) {
    if (!validPeerId(groupId) || !groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) {
      throw new Error('LAN nickname reservations are malformed');
    }
    const group = groupValue as Record<string, unknown>;
    if (Object.keys(group).length !== 1 || !group.names || typeof group.names !== 'object' || Array.isArray(group.names)) {
      throw new Error('LAN nickname reservations are malformed');
    }
    const names: Record<string, Reservation> = {};
    for (const [canonical, reservationValue] of Object.entries(group.names as Record<string, unknown>)) {
      if (!reservationValue || typeof reservationValue !== 'object' || Array.isArray(reservationValue)) {
        throw new Error('LAN nickname reservations are malformed');
      }
      const reservation = reservationValue as Record<string, unknown>;
      if (Object.keys(reservation).sort().join(',') !== 'nickname,peerId' ||
          !validPeerId(reservation.peerId) || typeof reservation.nickname !== 'string') {
        throw new Error('LAN nickname reservations are malformed');
      }
      let normalized: string;
      try { normalized = normalizeLanPeerNickname(reservation.nickname); }
      catch { throw new Error('LAN nickname reservations are malformed'); }
      if (canonicalLanPeerNickname(normalized) !== canonical) throw new Error('LAN nickname reservations are malformed');
      names[canonical] = { peerId: reservation.peerId, nickname: normalized };
    }
    groups[groupId] = { names };
  }
  return { version: STATE_VERSION, groups };
}

async function loadState(): Promise<ReservationState> {
  return parseState(await readDurableStrict<unknown>(STATE));
}

function requireGroupKey(groupKey: Uint8Array): Buffer {
  const bytes = Buffer.from(groupKey);
  if (bytes.length !== GROUP_KEY_BYTES) throw new Error('LAN nickname reservation requires a 32-byte group key');
  return bytes;
}

export function lanPeerGroupId(groupKey: Uint8Array): string {
  return createHash('sha256')
    .update('paradigmeve-lan-group-id\0', 'utf8')
    .update(requireGroupKey(groupKey))
    .digest('base64url');
}

/**
 * Reserve one human name for one cryptographic installation inside this LAN group.
 *
 * A peer may deliberately rename itself; its old alias is released only when this same peer id
 * claims the new name. A different peer id can never overwrite an existing reservation.
 */
export function reserveLanPeerNickname(
  groupKey: Uint8Array,
  nickname: string,
  peerId: string
): Promise<'claimed' | 'owned'> {
  return serial(async () => {
    const display = normalizeLanPeerNickname(nickname);
    const canonical = canonicalLanPeerNickname(display);
    if (!validPeerId(peerId)) throw new Error('LAN peer fingerprint is invalid');
    const groupId = lanPeerGroupId(groupKey);
    const state = await loadState();
    const existing = state.groups[groupId]?.names[canonical];
    if (existing && existing.peerId !== peerId) throw new LanPeerNicknameConflictError(display);

    if (existing?.peerId === peerId && existing.nickname === display) return 'owned';

    const currentNames = { ...(state.groups[groupId]?.names ?? {}) };
    // One installation has one current LAN nickname. A deliberate rename releases only aliases
    // that were owned by this exact cryptographic identity, never another installation's claim.
    for (const [name, reservation] of Object.entries(currentNames)) {
      if (reservation.peerId === peerId && name !== canonical) delete currentNames[name];
    }
    currentNames[canonical] = { peerId, nickname: display };
    await writeDurableNow(STATE, {
      ...state,
      groups: { ...state.groups, [groupId]: { names: currentNames } }
    } satisfies ReservationState);
    return existing ? 'owned' : 'claimed';
  });
}

export function forgetLanPeerReservations(groupKey: Uint8Array): Promise<void> {
  return serial(async () => {
    const groupId = lanPeerGroupId(groupKey);
    const state = await loadState();
    if (!state.groups[groupId]) return;
    const groups = { ...state.groups };
    delete groups[groupId];
    await writeDurableNow(STATE, { ...state, groups } satisfies ReservationState);
  });
}

/** Read-only test/status seam. The fingerprint is public identity material, never the group key. */
export function lanPeerNicknameReservation(
  groupKey: Uint8Array,
  nickname: string
): Promise<Reservation | null> {
  return serial(async () => {
    const state = await loadState();
    const reservation = state.groups[lanPeerGroupId(groupKey)]?.names[canonicalLanPeerNickname(nickname)];
    return reservation ? { ...reservation } : null;
  });
}

export function resetLanPeerReservationsForTests(): void {
  queue = Promise.resolve();
}
