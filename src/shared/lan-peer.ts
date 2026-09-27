/** Privacy-bounded status shared between explicitly paired ParadigmEve installations on one LAN. */
export const LAN_PEER_PROTOCOL = 2 as const;
export const LAN_PEER_MESSAGE_PROTOCOL = 1 as const;
export const LAN_PEER_ID_BYTES = 32;
export const LAN_PEER_PUBLIC_KEY_BYTES = 44;
export const LAN_PEER_SIGNATURE_BYTES = 64;
export const LAN_PEER_MESSAGE_MAX_BYTES = 4_096;

export const LAN_HEARTBEAT_RESULTS = [
  'never-run',
  'pending',
  'completed',
  'actionable',
  'dispatched',
  'blocked',
  'failed'
] as const;
export type LanHeartbeatResult = (typeof LAN_HEARTBEAT_RESULTS)[number];

const HEARTBEAT_SUMMARY: Record<LanHeartbeatResult, string> = {
  'never-run': 'No semantic review has completed yet.',
  pending: 'Semantic review is queued or pending.',
  completed: 'Semantic review completed.',
  actionable: 'Semantic review found actionable work.',
  dispatched: 'Semantic review dispatched bounded work.',
  blocked: 'Semantic review is blocked on safe ownership or availability.',
  failed: 'Semantic review needs attention.'
};

export interface LanHeartbeatHealth {
  /** Local epoch milliseconds for the latest known semantic-review run boundary, or null. */
  lastRunAt: number | null;
  result: LanHeartbeatResult;
  /** Always derived from result. Arbitrary user/chat text is not accepted on the LAN wire. */
  summary: string;
}

export interface LanPeerUnsignedAnnouncement {
  /** User-facing installation nickname, normally config.mcp.connectorName (for example Eve/Eva). */
  nickname: string;
  /** SHA-256 of this installation's Ed25519 SPKI public key, canonical base64url. */
  peerId: string;
  /** Ed25519 SPKI DER public key, canonical base64url. Public identity material, not a secret. */
  publicKey: string;
  protocol: typeof LAN_PEER_PROTOCOL;
  appVersion: string;
  /** Configured maximum concurrent worker slots. No worker names/tasks are exposed. */
  workerCapacity: number;
  heartbeat: LanHeartbeatHealth;
  /** Sender clock used only to reject stale/replayed presence. */
  sentAt: number;
}

export interface LanPeerAnnouncement extends LanPeerUnsignedAnnouncement {
  /** Ed25519 signature over the canonical unsigned announcement. */
  signature: string;
}

export interface LanPeerPresence extends Omit<LanPeerAnnouncement, 'sentAt' | 'publicKey' | 'signature'> {
  /** Derived by the receiver from fresh authenticated traffic. */
  online: boolean;
  /** Receiver clock; source IP/port are deliberately not part of the public projection. */
  lastSeenAt: number;
}

export interface LanPeerUnsignedMessage {
  protocol: typeof LAN_PEER_MESSAGE_PROTOCOL;
  kind: 'message';
  /** Random per-delivery id used for dedupe and the authenticated acknowledgement. */
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  /** Authored peer text. It is data for the receiving Eve/Eva, never remote tool authority. */
  text: string;
  sentAt: number;
}

export interface LanPeerMessage extends LanPeerUnsignedMessage {
  signature: string;
}

export interface LanPeerUnsignedAck {
  protocol: typeof LAN_PEER_MESSAGE_PROTOCOL;
  kind: 'ack';
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  sentAt: number;
}

export interface LanPeerAck extends LanPeerUnsignedAck {
  signature: string;
}

export type LanPeerMessagePacket = LanPeerMessage | LanPeerAck;

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/u;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/u;
const FORMAT_TEXT = /\p{Cf}/u;
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Stable LAN name identity. Display spelling remains user-authored, but reservation comparison is
 * Unicode-normalized and case-insensitive so visually equivalent `Eva`/`eva` (and composed vs
 * decomposed accents) cannot become two different installation names. Invisible format controls
 * are refused at the LAN boundary rather than becoming spoofable aliases.
 */
export function canonicalLanPeerNickname(value: string): string {
  const display = value.trim().normalize('NFC');
  if (!display || display.length > 40 || CONTROL_TEXT.test(display) || FORMAT_TEXT.test(display)) {
    throw new Error('LAN peer nickname is invalid');
  }
  return display.toLowerCase();
}

export function normalizeLanPeerNickname(value: string): string {
  const display = value.trim().normalize('NFC');
  canonicalLanPeerNickname(display);
  return display;
}

function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length && own.every((key, index) => key === expected[index]);
}

function canonicalBase64Url(value: unknown, exactBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('=')) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === exactBytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

function safeMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID.test(value);
}

function safeMessageText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= LAN_PEER_MESSAGE_MAX_BYTES;
}

export function lanHeartbeatHealth(lastRunAt: number | null, result: LanHeartbeatResult): LanHeartbeatHealth {
  if (lastRunAt !== null && !safeTime(lastRunAt)) throw new Error('LAN heartbeat last-run time is invalid');
  return { lastRunAt, result, summary: HEARTBEAT_SUMMARY[result] };
}

export function makeLanPeerUnsignedAnnouncement(input: {
  nickname: string;
  peerId: string;
  publicKey: string;
  appVersion: string;
  workerCapacity: number;
  heartbeat: Pick<LanHeartbeatHealth, 'lastRunAt' | 'result'>;
  sentAt?: number;
}): LanPeerUnsignedAnnouncement {
  const nickname = normalizeLanPeerNickname(input.nickname);
  if (!canonicalBase64Url(input.peerId, LAN_PEER_ID_BYTES)) throw new Error('LAN peer fingerprint is invalid');
  if (!canonicalBase64Url(input.publicKey, LAN_PEER_PUBLIC_KEY_BYTES)) throw new Error('LAN peer public key is invalid');
  if (!SAFE_VERSION.test(input.appVersion)) throw new Error('LAN peer app version is invalid');
  if (!Number.isInteger(input.workerCapacity) || input.workerCapacity < 1 || input.workerCapacity > 8) {
    throw new Error('LAN peer worker capacity is invalid');
  }
  const sentAt = input.sentAt ?? Date.now();
  if (!safeTime(sentAt)) throw new Error('LAN peer send time is invalid');
  return {
    nickname,
    peerId: input.peerId,
    publicKey: input.publicKey,
    protocol: LAN_PEER_PROTOCOL,
    appVersion: input.appVersion,
    workerCapacity: input.workerCapacity,
    heartbeat: lanHeartbeatHealth(input.heartbeat.lastRunAt, input.heartbeat.result),
    sentAt
  };
}

/** Exact bytes-to-sign are UTF-8 of this JSON text. Keep field order explicit and versioned. */
export function lanPeerAnnouncementSigningText(value: LanPeerUnsignedAnnouncement): string {
  return JSON.stringify({
    nickname: value.nickname,
    peerId: value.peerId,
    publicKey: value.publicKey,
    protocol: value.protocol,
    appVersion: value.appVersion,
    workerCapacity: value.workerCapacity,
    heartbeat: {
      lastRunAt: value.heartbeat.lastRunAt,
      result: value.heartbeat.result,
      summary: value.heartbeat.summary
    },
    sentAt: value.sentAt
  });
}

export function makeLanPeerAnnouncement(input: {
  nickname: string;
  peerId: string;
  publicKey: string;
  signature: string;
  appVersion: string;
  workerCapacity: number;
  heartbeat: Pick<LanHeartbeatHealth, 'lastRunAt' | 'result'>;
  sentAt?: number;
}): LanPeerAnnouncement {
  const unsigned = makeLanPeerUnsignedAnnouncement(input);
  if (!canonicalBase64Url(input.signature, LAN_PEER_SIGNATURE_BYTES)) throw new Error('LAN peer signature is invalid');
  return { ...unsigned, signature: input.signature };
}

export function parseLanPeerAnnouncement(value: unknown): LanPeerAnnouncement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['nickname', 'peerId', 'publicKey', 'protocol', 'appVersion', 'workerCapacity', 'heartbeat', 'sentAt', 'signature'])) return null;
  if (typeof row.nickname !== 'string') return null;
  try {
    if (normalizeLanPeerNickname(row.nickname) !== row.nickname) return null;
  } catch {
    return null;
  }
  if (!canonicalBase64Url(row.peerId, LAN_PEER_ID_BYTES) ||
      !canonicalBase64Url(row.publicKey, LAN_PEER_PUBLIC_KEY_BYTES) ||
      !canonicalBase64Url(row.signature, LAN_PEER_SIGNATURE_BYTES)) return null;
  if (row.protocol !== LAN_PEER_PROTOCOL) return null;
  if (typeof row.appVersion !== 'string' || !SAFE_VERSION.test(row.appVersion)) return null;
  if (typeof row.workerCapacity !== 'number' || !Number.isInteger(row.workerCapacity) || row.workerCapacity < 1 || row.workerCapacity > 8) return null;
  if (!safeTime(row.sentAt)) return null;
  if (!row.heartbeat || typeof row.heartbeat !== 'object' || Array.isArray(row.heartbeat)) return null;
  const heartbeat = row.heartbeat as Record<string, unknown>;
  if (!exactKeys(heartbeat, ['lastRunAt', 'result', 'summary'])) return null;
  const result = typeof heartbeat.result === 'string' &&
    (LAN_HEARTBEAT_RESULTS as readonly string[]).includes(heartbeat.result)
    ? heartbeat.result as LanHeartbeatResult
    : null;
  if (!result) return null;
  if (heartbeat.lastRunAt !== null && !safeTime(heartbeat.lastRunAt)) return null;
  if (heartbeat.summary !== HEARTBEAT_SUMMARY[result]) return null;
  return {
    nickname: row.nickname,
    peerId: row.peerId,
    publicKey: row.publicKey,
    protocol: LAN_PEER_PROTOCOL,
    appVersion: row.appVersion,
    workerCapacity: row.workerCapacity,
    heartbeat: {
      lastRunAt: heartbeat.lastRunAt as number | null,
      result,
      summary: HEARTBEAT_SUMMARY[result]
    },
    sentAt: row.sentAt,
    signature: row.signature
  };
}

export function makeLanPeerUnsignedMessage(input: {
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  text: string;
  sentAt?: number;
}): LanPeerUnsignedMessage {
  if (!safeMessageId(input.messageId)) throw new Error('LAN peer message id is invalid');
  if (!canonicalBase64Url(input.fromPeerId, LAN_PEER_ID_BYTES) || !canonicalBase64Url(input.toPeerId, LAN_PEER_ID_BYTES)) {
    throw new Error('LAN peer message identity is invalid');
  }
  if (!safeMessageText(input.text)) throw new Error(`LAN peer message must be 1-${LAN_PEER_MESSAGE_MAX_BYTES} UTF-8 bytes`);
  const sentAt = input.sentAt ?? Date.now();
  if (!safeTime(sentAt)) throw new Error('LAN peer message send time is invalid');
  return {
    protocol: LAN_PEER_MESSAGE_PROTOCOL,
    kind: 'message',
    messageId: input.messageId,
    fromPeerId: input.fromPeerId,
    toPeerId: input.toPeerId,
    text: input.text,
    sentAt
  };
}

export function lanPeerMessageSigningText(value: LanPeerUnsignedMessage): string {
  return JSON.stringify({
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    fromPeerId: value.fromPeerId,
    toPeerId: value.toPeerId,
    text: value.text,
    sentAt: value.sentAt
  });
}

export function makeLanPeerMessage(input: LanPeerUnsignedMessage & { signature: string }): LanPeerMessage {
  const unsigned = makeLanPeerUnsignedMessage(input);
  if (!canonicalBase64Url(input.signature, LAN_PEER_SIGNATURE_BYTES)) throw new Error('LAN peer message signature is invalid');
  return { ...unsigned, signature: input.signature };
}

export function parseLanPeerMessage(value: unknown): LanPeerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['protocol', 'kind', 'messageId', 'fromPeerId', 'toPeerId', 'text', 'sentAt', 'signature'])) return null;
  if (row.protocol !== LAN_PEER_MESSAGE_PROTOCOL || row.kind !== 'message') return null;
  if (!safeMessageId(row.messageId) ||
      !canonicalBase64Url(row.fromPeerId, LAN_PEER_ID_BYTES) ||
      !canonicalBase64Url(row.toPeerId, LAN_PEER_ID_BYTES) ||
      !safeMessageText(row.text) ||
      !safeTime(row.sentAt) ||
      !canonicalBase64Url(row.signature, LAN_PEER_SIGNATURE_BYTES)) return null;
  return {
    protocol: LAN_PEER_MESSAGE_PROTOCOL,
    kind: 'message',
    messageId: row.messageId,
    fromPeerId: row.fromPeerId,
    toPeerId: row.toPeerId,
    text: row.text,
    sentAt: row.sentAt,
    signature: row.signature
  };
}

export function makeLanPeerUnsignedAck(input: {
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  sentAt?: number;
}): LanPeerUnsignedAck {
  if (!safeMessageId(input.messageId)) throw new Error('LAN peer acknowledgement id is invalid');
  if (!canonicalBase64Url(input.fromPeerId, LAN_PEER_ID_BYTES) || !canonicalBase64Url(input.toPeerId, LAN_PEER_ID_BYTES)) {
    throw new Error('LAN peer acknowledgement identity is invalid');
  }
  const sentAt = input.sentAt ?? Date.now();
  if (!safeTime(sentAt)) throw new Error('LAN peer acknowledgement time is invalid');
  return {
    protocol: LAN_PEER_MESSAGE_PROTOCOL,
    kind: 'ack',
    messageId: input.messageId,
    fromPeerId: input.fromPeerId,
    toPeerId: input.toPeerId,
    sentAt
  };
}

export function lanPeerAckSigningText(value: LanPeerUnsignedAck): string {
  return JSON.stringify({
    protocol: value.protocol,
    kind: value.kind,
    messageId: value.messageId,
    fromPeerId: value.fromPeerId,
    toPeerId: value.toPeerId,
    sentAt: value.sentAt
  });
}

export function makeLanPeerAck(input: LanPeerUnsignedAck & { signature: string }): LanPeerAck {
  const unsigned = makeLanPeerUnsignedAck(input);
  if (!canonicalBase64Url(input.signature, LAN_PEER_SIGNATURE_BYTES)) throw new Error('LAN peer acknowledgement signature is invalid');
  return { ...unsigned, signature: input.signature };
}

export function parseLanPeerAck(value: unknown): LanPeerAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['protocol', 'kind', 'messageId', 'fromPeerId', 'toPeerId', 'sentAt', 'signature'])) return null;
  if (row.protocol !== LAN_PEER_MESSAGE_PROTOCOL || row.kind !== 'ack') return null;
  if (!safeMessageId(row.messageId) ||
      !canonicalBase64Url(row.fromPeerId, LAN_PEER_ID_BYTES) ||
      !canonicalBase64Url(row.toPeerId, LAN_PEER_ID_BYTES) ||
      !safeTime(row.sentAt) ||
      !canonicalBase64Url(row.signature, LAN_PEER_SIGNATURE_BYTES)) return null;
  return {
    protocol: LAN_PEER_MESSAGE_PROTOCOL,
    kind: 'ack',
    messageId: row.messageId,
    fromPeerId: row.fromPeerId,
    toPeerId: row.toPeerId,
    sentAt: row.sentAt,
    signature: row.signature
  };
}

export function parseLanPeerMessagePacket(value: unknown): LanPeerMessagePacket | null {
  return parseLanPeerMessage(value) ?? parseLanPeerAck(value);
}
