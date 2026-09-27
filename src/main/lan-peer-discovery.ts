import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import {
  LAN_PEER_PROTOCOL,
  LAN_PEER_MESSAGE_PROTOCOL,
  LAN_PEER_MESSAGE_MAX_BYTES,
  type LanPeerAnnouncement,
  type LanPeerAck,
  type LanPeerMessagePacket,
  type LanPeerPresence,
  lanPeerAckSigningText,
  lanPeerAnnouncementSigningText,
  lanPeerMessageSigningText,
  makeLanPeerAck,
  makeLanPeerMessage,
  makeLanPeerUnsignedAck,
  makeLanPeerUnsignedMessage,
  parseLanPeerAnnouncement,
  parseLanPeerMessagePacket
} from '../shared/lan-peer.js';
import { verifyLanPeerSignature } from './lan-peer-identity.js';

export const LAN_PEER_MULTICAST_ADDRESS = '239.255.72.69';
export const LAN_PEER_PORT = 42_769;
export const LAN_PEER_ANNOUNCE_MS = 5_000;
export const LAN_PEER_ONLINE_MS = 15_000;

const LAN_PEER_RETAIN_MS = 24 * 60 * 60 * 1000;
const LAN_PEER_MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const LAN_PEER_MAX_DATAGRAM_BYTES = 2_048;
const LAN_PEER_MAX_TRACKED = 64;
const LAN_PEER_MAX_REPLAY_TRACKED = 512;
const LAN_PEER_MAGIC = 'paradigmeve-lan';
const LAN_PEER_MESSAGE_MAGIC = 'paradigmeve-lan-message';
const LAN_PEER_MESSAGE_DATAGRAM_BYTES = 8_192;
const LAN_PEER_MESSAGE_ACK_TIMEOUT_MS = 2_000;
const LAN_PEER_MESSAGE_RETRY_MS = 450;
const LAN_PEER_MAX_RECEIVED_MESSAGES = 512;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const GROUP_KEY_BYTES = 32;

type LanWireEnvelope = {
  magic: typeof LAN_PEER_MAGIC;
  protocol: typeof LAN_PEER_PROTOCOL;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type LanMessageWireEnvelope = {
  magic: typeof LAN_PEER_MESSAGE_MAGIC;
  protocol: typeof LAN_PEER_MESSAGE_PROTOCOL;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type PeerRecord = {
  announcement: LanPeerAnnouncement;
  lastSeenAt: number;
  /** Internal routing metadata only. Never enters AppState or the public presence projection. */
  address: string;
};

export interface LanPeerReceivedMessage {
  messageId: string;
  fromPeerId: string;
  nickname: string;
  text: string;
  sentAt: number;
}

export interface LanPeerMessageDelivery {
  messageId: string;
  confirmed: boolean;
}

export interface LanPeerDiscoveryOptions {
  /** Dedicated 32-byte household/LAN pairing key. Do not reuse the Companion or tunnel credential. */
  groupKey: Uint8Array;
  snapshot: () => LanPeerAnnouncement;
  /** Durable installation identity used to sign peer messages and acknowledgements. */
  identity?: { peerId: string; sign(data: Buffer): string };
  /** Optional authenticated-name admission boundary. Returning false keeps the peer out of public presence. */
  acceptPeer?: (announcement: LanPeerAnnouncement) => boolean | Promise<boolean>;
  /** Called only after group decryption, current-presence routing checks and sender signature verification. */
  onMessage?: (message: LanPeerReceivedMessage) => void | Promise<void>;
  onPeers?: (peers: readonly LanPeerPresence[]) => void;
  onError?: (error: Error) => void;
  now?: () => number;
  announceMs?: number;
  onlineMs?: number;
  port?: number;
  multicastAddress?: string;
}

export interface LanPeerDiscovery {
  peers(): LanPeerPresence[];
  publish(): void;
  sendMessage(peerId: string, text: string): Promise<LanPeerMessageDelivery>;
  stop(): void;
}

type LanInterfaceRow = {
  address: string;
  family: string | number;
  internal: boolean;
};

type LanInterfaceSnapshot = Record<string, readonly LanInterfaceRow[] | undefined>;

function isPrivateLanIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b = -1] = octets;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

/**
 * LAN discovery must not depend on the OS picking one default multicast adapter. Gaming/dev PCs
 * commonly have Ethernet, Wi-Fi, VPN and virtual adapters at once, and Windows can choose a
 * different default than the household LAN. Join/send only on non-loopback RFC1918 IPv4 interfaces;
 * this deliberately excludes overlay/VPN ranges such as Radmin's 26/8 and Tailscale's CGNAT space.
 * TTL 1 remains a second boundary against routed multicast.
 */
export function lanPeerInterfaceAddresses(snapshot: LanInterfaceSnapshot = networkInterfaces()): string[] {
  const addresses = new Set<string>();
  for (const rows of Object.values(snapshot)) {
    for (const row of rows ?? []) {
      if (row.internal) continue;
      if (row.family !== 'IPv4' && row.family !== 4) continue;
      if (!isPrivateLanIpv4(row.address)) continue;
      addresses.add(row.address);
    }
  }
  return [...addresses].sort();
}

export function lanPeerDirectReplyEligible(remoteAddress: string, remotePort: number, port = LAN_PEER_PORT): boolean {
  return remotePort === port && isPrivateLanIpv4(remoteAddress);
}

function requireGroupKey(groupKey: Uint8Array): Buffer {
  const key = Buffer.from(groupKey);
  if (key.length !== GROUP_KEY_BYTES) throw new Error('LAN discovery requires a dedicated 32-byte group key');
  return key;
}

function aad(): Buffer {
  return Buffer.from(`${LAN_PEER_MAGIC}:${LAN_PEER_PROTOCOL}`, 'utf8');
}

function messageAad(): Buffer {
  return Buffer.from(`${LAN_PEER_MESSAGE_MAGIC}:${LAN_PEER_MESSAGE_PROTOCOL}`, 'utf8');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length && own.every((key, index) => key === expected[index]);
}

function decodeBase64Url(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length > 0 && decoded.length <= maxBytes ? decoded : null;
  } catch {
    return null;
  }
}

export function encodeLanPeerDatagram(announcement: LanPeerAnnouncement, groupKey: Uint8Array): Buffer {
  const parsed = parseLanPeerAnnouncement(announcement);
  if (!parsed || !verifyLanPeerAnnouncementIdentity(parsed)) throw new Error('LAN peer announcement identity is invalid');
  const key = requireGroupKey(groupKey);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  cipher.setAAD(aad());
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
  const envelope: LanWireEnvelope = {
    magic: LAN_PEER_MAGIC,
    protocol: LAN_PEER_PROTOCOL,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
  const datagram = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (datagram.length > LAN_PEER_MAX_DATAGRAM_BYTES) throw new Error('LAN peer datagram is too large');
  return datagram;
}

export function decodeLanPeerDatagram(datagram: Uint8Array, groupKey: Uint8Array): LanPeerAnnouncement | null {
  if (datagram.byteLength === 0 || datagram.byteLength > LAN_PEER_MAX_DATAGRAM_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(datagram).toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['magic', 'protocol', 'nonce', 'ciphertext', 'tag'])) return null;
  if (row.magic !== LAN_PEER_MAGIC || row.protocol !== LAN_PEER_PROTOCOL) return null;
  const nonce = decodeBase64Url(row.nonce, AES_GCM_NONCE_BYTES);
  const ciphertext = decodeBase64Url(row.ciphertext, LAN_PEER_MAX_DATAGRAM_BYTES);
  const tag = decodeBase64Url(row.tag, AES_GCM_TAG_BYTES);
  if (!nonce || nonce.length !== AES_GCM_NONCE_BYTES || !ciphertext || !tag || tag.length !== AES_GCM_TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', requireGroupKey(groupKey), nonce, { authTagLength: AES_GCM_TAG_BYTES });
    decipher.setAAD(aad());
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > LAN_PEER_MAX_DATAGRAM_BYTES) return null;
    const parsed = parseLanPeerAnnouncement(JSON.parse(plaintext.toString('utf8')));
    return parsed && verifyLanPeerAnnouncementIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeLanPeerMessageDatagram(packet: LanPeerMessagePacket, groupKey: Uint8Array): Buffer {
  const parsed = parseLanPeerMessagePacket(packet);
  if (!parsed) throw new Error('LAN peer message packet is invalid');
  const key = requireGroupKey(groupKey);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  cipher.setAAD(messageAad());
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
  const envelope: LanMessageWireEnvelope = {
    magic: LAN_PEER_MESSAGE_MAGIC,
    protocol: LAN_PEER_MESSAGE_PROTOCOL,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
  const datagram = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (datagram.length > LAN_PEER_MESSAGE_DATAGRAM_BYTES) throw new Error('LAN peer message datagram is too large');
  return datagram;
}

export function decodeLanPeerMessageDatagram(datagram: Uint8Array, groupKey: Uint8Array): LanPeerMessagePacket | null {
  if (datagram.byteLength === 0 || datagram.byteLength > LAN_PEER_MESSAGE_DATAGRAM_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(datagram).toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['magic', 'protocol', 'nonce', 'ciphertext', 'tag'])) return null;
  if (row.magic !== LAN_PEER_MESSAGE_MAGIC || row.protocol !== LAN_PEER_MESSAGE_PROTOCOL) return null;
  const nonce = decodeBase64Url(row.nonce, AES_GCM_NONCE_BYTES);
  const ciphertext = decodeBase64Url(row.ciphertext, LAN_PEER_MESSAGE_DATAGRAM_BYTES);
  const tag = decodeBase64Url(row.tag, AES_GCM_TAG_BYTES);
  if (!nonce || nonce.length !== AES_GCM_NONCE_BYTES || !ciphertext || !tag || tag.length !== AES_GCM_TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', requireGroupKey(groupKey), nonce, { authTagLength: AES_GCM_TAG_BYTES });
    decipher.setAAD(messageAad());
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > LAN_PEER_MESSAGE_DATAGRAM_BYTES) return null;
    return parseLanPeerMessagePacket(JSON.parse(plaintext.toString('utf8')));
  } catch {
    return null;
  }
}

/** Group encryption proves membership; this signature proves which durable installation spoke. */
export function verifyLanPeerAnnouncementIdentity(announcement: LanPeerAnnouncement): boolean {
  return verifyLanPeerSignature(
    announcement.peerId,
    announcement.publicKey,
    Buffer.from(lanPeerAnnouncementSigningText(announcement), 'utf8'),
    announcement.signature
  );
}

function verifyLanPeerMessagePacketIdentity(packet: LanPeerMessagePacket, publicKey: string): boolean {
  const signingText = packet.kind === 'message'
    ? lanPeerMessageSigningText(packet)
    : lanPeerAckSigningText(packet);
  return verifyLanPeerSignature(
    packet.fromPeerId,
    publicKey,
    Buffer.from(signingText, 'utf8'),
    packet.signature
  );
}

function publicPeers(records: ReadonlyMap<string, PeerRecord>, now: number, onlineMs: number): LanPeerPresence[] {
  return [...records.values()]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.announcement.nickname.localeCompare(right.announcement.nickname))
    .map(({ announcement, lastSeenAt }) => ({
      nickname: announcement.nickname,
      peerId: announcement.peerId,
      protocol: announcement.protocol,
      appVersion: announcement.appVersion,
      workerCapacity: announcement.workerCapacity,
      heartbeat: announcement.heartbeat,
      online: now - lastSeenAt <= onlineMs,
      lastSeenAt
    }));
}

function peerKey(announcement: LanPeerAnnouncement): string {
  // Stable cryptographic installation identity, independent of endpoint/address changes.
  return announcement.peerId;
}

export function startLanPeerDiscovery(options: LanPeerDiscoveryOptions): LanPeerDiscovery {
  const key = requireGroupKey(options.groupKey);
  const now = options.now ?? Date.now;
  const announceMs = Math.max(1_000, options.announceMs ?? LAN_PEER_ANNOUNCE_MS);
  const onlineMs = Math.max(announceMs * 2, options.onlineMs ?? LAN_PEER_ONLINE_MS);
  const port = options.port ?? LAN_PEER_PORT;
  const multicastAddress = options.multicastAddress ?? LAN_PEER_MULTICAST_ADDRESS;
  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
  const interfaceAddresses = lanPeerInterfaceAddresses();
  const activeInterfaceAddresses: string[] = [];
  const records = new Map<string, PeerRecord>();
  const directReplyAt = new Map<string, number>();
  const seenDatagrams = new Map<string, number>();
  const receivedMessages = new Map<string, number>();
  const pendingAcks = new Map<string, { peerId: string; resolve: (confirmed: boolean) => void; timer: NodeJS.Timeout; retries: NodeJS.Timeout[] }>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const reportError = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const directSocket: Socket = createSocket({ type: 'udp4' });
  directSocket.on('error', reportError);
  const notify = () => options.onPeers?.(publicPeers(records, now(), onlineMs));
  const prune = () => {
    const cutoff = now() - LAN_PEER_RETAIN_MS;
    for (const [id, record] of records) if (record.lastSeenAt < cutoff) records.delete(id);
    if (records.size > LAN_PEER_MAX_TRACKED) {
      for (const [id] of [...records.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt).slice(0, records.size - LAN_PEER_MAX_TRACKED)) {
        records.delete(id);
      }
    }
    for (const id of directReplyAt.keys()) if (!records.has(id)) directReplyAt.delete(id);
    const replayCutoff = now() - LAN_PEER_MAX_CLOCK_SKEW_MS;
    for (const [digest, seenAt] of seenDatagrams) if (seenAt < replayCutoff) seenDatagrams.delete(digest);
    if (seenDatagrams.size > LAN_PEER_MAX_REPLAY_TRACKED) {
      for (const [digest] of [...seenDatagrams.entries()].sort((a, b) => a[1] - b[1]).slice(0, seenDatagrams.size - LAN_PEER_MAX_REPLAY_TRACKED)) {
        seenDatagrams.delete(digest);
      }
    }
    for (const [messageId, seenAt] of receivedMessages) if (seenAt < replayCutoff) receivedMessages.delete(messageId);
    if (receivedMessages.size > LAN_PEER_MAX_RECEIVED_MESSAGES) {
      for (const [messageId] of [...receivedMessages.entries()].sort((a, b) => a[1] - b[1]).slice(0, receivedMessages.size - LAN_PEER_MAX_RECEIVED_MESSAGES)) {
        receivedMessages.delete(messageId);
      }
    }
  };
  const publish = () => {
    if (stopped) return;
    try {
      const datagram = encodeLanPeerDatagram(options.snapshot(), key);
      for (const interfaceAddress of activeInterfaceAddresses) {
        try {
          socket.setMulticastInterface(interfaceAddress);
          socket.send(datagram, port, multicastAddress, (error) => { if (error) reportError(error); });
        } catch (error) {
          reportError(error);
        }
      }
    } catch (error) {
      reportError(error);
    }
    prune();
    notify();
  };
  const replyDirect = (address: string) => {
    if (stopped) return;
    try {
      const datagram = encodeLanPeerDatagram(options.snapshot(), key);
      directSocket.send(datagram, port, address, (error) => {
        if (error) reportError(error);
        directSocket.unref();
      });
    } catch (error) {
      reportError(error);
    }
  };

  const localIdentity = (): NonNullable<LanPeerDiscoveryOptions['identity']> => {
    if (!options.identity) throw new Error('LAN peer messaging is unavailable without a durable installation identity');
    return options.identity;
  };
  const sendPacket = (packet: LanPeerMessagePacket, address: string) => {
    if (stopped) throw new Error('LAN peer discovery is stopped');
    if (!isPrivateLanIpv4(address)) throw new Error('LAN peer message target is not on a private IPv4 LAN');
    const datagram = encodeLanPeerMessageDatagram(packet, key);
    socket.send(datagram, port, address, (error) => { if (error) reportError(error); });
  };
  const signedAck = (messageId: string, toPeerId: string): LanPeerAck => {
    const identity = localIdentity();
    const unsigned = makeLanPeerUnsignedAck({ messageId, fromPeerId: identity.peerId, toPeerId });
    return makeLanPeerAck({
      ...unsigned,
      signature: identity.sign(Buffer.from(lanPeerAckSigningText(unsigned), 'utf8'))
    });
  };
  const sendMessage = async (peerId: string, text: string): Promise<LanPeerMessageDelivery> => {
    if (stopped) throw new Error('LAN peer discovery is stopped');
    const record = records.get(peerId);
    if (!record || now() - record.lastSeenAt > onlineMs) throw new Error('LAN peer is not currently online');
    if (!isPrivateLanIpv4(record.address)) throw new Error('LAN peer has no private LAN route');
    const identity = localIdentity();
    if (identity.peerId === peerId) throw new Error('LAN peer cannot message itself');
    if (Buffer.byteLength(text, 'utf8') > LAN_PEER_MESSAGE_MAX_BYTES || text.length === 0) {
      throw new Error(`LAN peer message must be 1-${LAN_PEER_MESSAGE_MAX_BYTES} UTF-8 bytes`);
    }
    const messageId = randomUUID();
    const unsigned = makeLanPeerUnsignedMessage({ messageId, fromPeerId: identity.peerId, toPeerId: peerId, text });
    const packet = makeLanPeerMessage({
      ...unsigned,
      signature: identity.sign(Buffer.from(lanPeerMessageSigningText(unsigned), 'utf8'))
    });
    return await new Promise<LanPeerMessageDelivery>((resolve) => {
      const finish = (confirmed: boolean) => {
        const pending = pendingAcks.get(messageId);
        if (!pending) return;
        clearTimeout(pending.timer);
        for (const retry of pending.retries) clearTimeout(retry);
        pendingAcks.delete(messageId);
        resolve({ messageId, confirmed });
      };
      const timer = setTimeout(() => finish(false), LAN_PEER_MESSAGE_ACK_TIMEOUT_MS);
      timer.unref?.();
      const retries = [LAN_PEER_MESSAGE_RETRY_MS, LAN_PEER_MESSAGE_RETRY_MS * 2].map((delay) => {
        const retry = setTimeout(() => {
          if (pendingAcks.has(messageId)) {
            try { sendPacket(packet, record.address); } catch (error) { reportError(error); }
          }
        }, delay);
        retry.unref?.();
        return retry;
      });
      pendingAcks.set(messageId, { peerId, resolve: finish, timer, retries });
      try {
        sendPacket(packet, record.address);
      } catch (error) {
        reportError(error);
        finish(false);
      }
    });
  };

  socket.on('error', reportError);
  socket.on('message', async (datagram, remote) => {
    const receivedAt = now();
    if (datagram.length === 0 || datagram.length > LAN_PEER_MESSAGE_DATAGRAM_BYTES) return;
    const digest = createHash('sha256').update(datagram).digest('base64url');
    if (seenDatagrams.has(digest)) return;
    const announcement = decodeLanPeerDatagram(datagram, key);
    if (announcement) {
      if (Math.abs(receivedAt - announcement.sentAt) > LAN_PEER_MAX_CLOCK_SKEW_MS) return;
      seenDatagrams.set(digest, receivedAt);
      try {
        if (options.acceptPeer && !(await options.acceptPeer(announcement))) return;
      } catch (error) {
        reportError(error);
        return;
      }
      const id = peerKey(announcement);
      records.set(id, { announcement, lastSeenAt: receivedAt, address: remote.address });
      if (lanPeerDirectReplyEligible(remote.address, remote.port, port)) {
        const lastReplyAt = directReplyAt.get(id) ?? 0;
        if (receivedAt - lastReplyAt >= announceMs) {
          directReplyAt.set(id, receivedAt);
          replyDirect(remote.address);
        }
      }
      prune();
      notify();
      return;
    }

    const packet = decodeLanPeerMessageDatagram(datagram, key);
    if (!packet || Math.abs(receivedAt - packet.sentAt) > LAN_PEER_MAX_CLOCK_SKEW_MS) return;
    const identity = options.identity;
    if (!identity || packet.toPeerId !== identity.peerId || packet.fromPeerId === identity.peerId) return;
    const record = records.get(packet.fromPeerId);
    if (!record || !isPrivateLanIpv4(remote.address) || record.address !== remote.address) return;
    if (!verifyLanPeerMessagePacketIdentity(packet, record.announcement.publicKey)) return;
    seenDatagrams.set(digest, receivedAt);

    if (packet.kind === 'ack') {
      const pending = pendingAcks.get(packet.messageId);
      if (pending?.peerId === packet.fromPeerId) pending.resolve(true);
      return;
    }

    const alreadyDelivered = receivedMessages.has(packet.messageId);
    if (!alreadyDelivered) {
      try {
        await options.onMessage?.({
          messageId: packet.messageId,
          fromPeerId: packet.fromPeerId,
          nickname: record.announcement.nickname,
          text: packet.text,
          sentAt: packet.sentAt
        });
        receivedMessages.set(packet.messageId, receivedAt);
      } catch (error) {
        reportError(error);
        return;
      }
    }
    try {
      sendPacket(signedAck(packet.messageId, packet.fromPeerId), remote.address);
    } catch (error) {
      reportError(error);
    }
    prune();
  });
  socket.bind(port, () => {
    if (stopped) return;
    try {
      if (interfaceAddresses.length === 0) throw new Error('LAN discovery found no usable private IPv4 interface');
      for (const interfaceAddress of interfaceAddresses) {
        try {
          socket.addMembership(multicastAddress, interfaceAddress);
          activeInterfaceAddresses.push(interfaceAddress);
        } catch (error) {
          reportError(error);
        }
      }
      if (activeInterfaceAddresses.length === 0) throw new Error('LAN discovery could not join multicast on any private IPv4 interface');
      socket.setMulticastTTL(1);
      socket.setMulticastLoopback(false);
      publish();
      timer = setInterval(publish, announceMs);
      timer.unref?.();
    } catch (error) {
      reportError(error);
      socket.close();
    }
  });

  return {
    peers: () => publicPeers(records, now(), onlineMs),
    publish,
    sendMessage,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const pending of pendingAcks.values()) {
        clearTimeout(pending.timer);
        for (const retry of pending.retries) clearTimeout(retry);
        pending.resolve(false);
      }
      pendingAcks.clear();
      try {
        socket.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') reportError(error);
      }
      try {
        directSocket.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') reportError(error);
      }
    }
  };
}
