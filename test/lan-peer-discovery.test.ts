import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeLanPeerDatagram,
  decodeLanPeerMessageDatagram,
  encodeLanPeerDatagram,
  encodeLanPeerMessageDatagram,
  lanPeerDirectReplyEligible,
  lanPeerInterfaceAddresses
} from '../src/main/lan-peer-discovery.js';
import { projectLanHeartbeatHealth } from '../src/main/lan-peer-heartbeat.js';
import {
  lanPeerAnnouncementSigningText,
  lanPeerAckSigningText,
  lanPeerMessageSigningText,
  makeLanPeerAck,
  makeLanPeerMessage,
  makeLanPeerUnsignedAck,
  makeLanPeerUnsignedMessage,
  makeLanPeerUnsignedAnnouncement,
  parseLanPeerAnnouncement
} from '../src/shared/lan-peer.js';

const identity = generateKeyPairSync('ed25519');
const publicKey = identity.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const peerId = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url');

function announcement() {
  const unsigned = makeLanPeerUnsignedAnnouncement({
    nickname: 'Eva',
    peerId,
    publicKey,
    appVersion: '2.1.7',
    workerCapacity: 2,
    heartbeat: { lastRunAt: 1_700_000_000_000, result: 'completed' },
    sentAt: 1_700_000_000_123
  });
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(lanPeerAnnouncementSigningText(unsigned), 'utf8'), identity.privateKey).toString('base64url')
  };
}

describe('LAN peer authenticated privacy boundary', () => {
  it('selects RFC1918 LAN interfaces without leaking onto public or overlay/VPN-style addresses', () => {
    const addresses = lanPeerInterfaceAddresses({
      Ethernet: [
        { address: '192.168.10.119', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false }
      ],
      WiFi: [{ address: '10.0.0.8', family: 4, internal: false }],
      Cgnat: [{ address: '100.64.12.3', family: 'IPv4', internal: false }],
      Radmin: [{ address: '26.12.34.56', family: 'IPv4', internal: false }],
      LinkLocal: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
      PublicVpn: [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
    });

    expect(addresses).toEqual(['10.0.0.8', '192.168.10.119']);
  });

  it('only sends authenticated direct replies back to a discovery-port peer on the private LAN', () => {
    expect(lanPeerDirectReplyEligible('192.168.10.119', 42_769)).toBe(true);
    expect(lanPeerDirectReplyEligible('10.0.0.8', 42_769)).toBe(true);
    expect(lanPeerDirectReplyEligible('26.178.158.235', 42_769)).toBe(false);
    expect(lanPeerDirectReplyEligible('100.64.12.3', 42_769)).toBe(false);
    expect(lanPeerDirectReplyEligible('192.168.10.119', 55_000)).toBe(false);
  });

  it('projects heartbeat durability without leaking its key or ownership identifiers', () => {
    const projected = projectLanHeartbeatHealth({
      lastCompletedAt: 1_699_999_000_000,
      pendingUntilAt: 1_700_000_000_000
    });
    expect(projected).toEqual({
      lastRunAt: 1_700_000_000_000,
      result: 'pending',
      summary: 'Semantic review is queued or pending.'
    });
    expect(Object.keys(projected).sort()).toEqual(['lastRunAt', 'result', 'summary']);
  });

  it('projects a completed sanitized source state without accepting receipt identity', () => {
    const projected = projectLanHeartbeatHealth({
      lastCompletedAt: 1_700_000_000_000,
      lastCompletionAt: 1_700_000_000_500
    });
    expect(projected).toEqual({
      lastRunAt: 1_700_000_000_500,
      result: 'completed',
      summary: 'Semantic review completed.'
    });
    expect(Object.keys(projected).sort()).toEqual(['lastRunAt', 'result', 'summary']);
  });

  it('projects an explicit durable dispatched result without accepting authored summary prose', () => {
    const projected = projectLanHeartbeatHealth({
      lastCompletedAt: 1_700_000_000_000,
      lastCompletionAt: 1_700_000_000_500,
      lastCompletionResult: 'dispatched'
    });
    expect(projected).toEqual({
      lastRunAt: 1_700_000_000_500,
      result: 'dispatched',
      summary: 'Semantic review dispatched bounded work.'
    });
    expect(Object.keys(projected).sort()).toEqual(['lastRunAt', 'result', 'summary']);
  });

  it('accepts only the bounded status schema and derives the heartbeat summary', () => {
    const value = announcement();
    expect(value).toMatchObject({
      nickname: 'Eva',
      peerId,
      publicKey,
      protocol: 2,
      appVersion: '2.1.7',
      workerCapacity: 2,
      heartbeat: {
        lastRunAt: 1_700_000_000_000,
        result: 'completed',
        summary: 'Semantic review completed.'
      },
      sentAt: 1_700_000_000_123,
      signature: expect.any(String)
    });
    expect(parseLanPeerAnnouncement(value)).toEqual(value);
  });

  it('rejects extra fields and arbitrary heartbeat prose instead of trying to redact it', () => {
    expect(parseLanPeerAnnouncement({ ...announcement(), privateText: 'authored private context' })).toBeNull();
    expect(parseLanPeerAnnouncement({
      ...announcement(),
      heartbeat: { ...announcement().heartbeat, summary: 'Raw chat text' }
    })).toBeNull();
  });

  it('encrypts/authenticates the status and does not expose the nickname or summary in plaintext', () => {
    const key = randomBytes(32);
    const datagram = encodeLanPeerDatagram(announcement(), key);
    const wireText = datagram.toString('utf8');
    // The nickname is three letters, and the ciphertext is random base64url: about one key in 500
    // contains "Eva" by chance. Assert the structure instead of a substring that can occur by luck.
    expect(Object.keys(JSON.parse(wireText) as Record<string, unknown>).sort()).toEqual(['ciphertext', 'magic', 'nonce', 'protocol', 'tag']);
    expect(wireText).not.toContain('nickname');
    expect(wireText).not.toContain('Semantic review completed.');
    expect(decodeLanPeerDatagram(datagram, key)).toEqual(announcement());
  });

  it('binds the nickname/status claim to the stable Ed25519 installation fingerprint', () => {
    const key = randomBytes(32);
    const value = announcement();
    expect(() => encodeLanPeerDatagram({ ...value, nickname: 'Eve' }, key)).toThrow(/identity is invalid/i);
    expect(() => encodeLanPeerDatagram({ ...value, peerId: Buffer.alloc(32, 0xcc).toString('base64url') }, key))
      .toThrow(/identity is invalid/i);
  });

  it('fails closed for the wrong key or tampered ciphertext', () => {
    const key = randomBytes(32);
    const datagram = encodeLanPeerDatagram(announcement(), key);
    expect(decodeLanPeerDatagram(datagram, randomBytes(32))).toBeNull();

    const wire = JSON.parse(datagram.toString('utf8')) as Record<string, unknown>;
    const ciphertext = String(wire.ciphertext);
    wire.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    expect(decodeLanPeerDatagram(Buffer.from(JSON.stringify(wire), 'utf8'), key)).toBeNull();
  });

  it('encrypts bounded signed peer messages and acknowledgements without exposing authored text', () => {
    const key = randomBytes(32);
    const targetPeerId = Buffer.alloc(32, 0x72).toString('base64url');
    const unsigned = makeLanPeerUnsignedMessage({
      messageId: '11111111-1111-4111-8111-111111111111',
      fromPeerId: peerId,
      toPeerId: targetPeerId,
      text: 'Hi Eve — Eva here.',
      sentAt: 1_700_000_000_500
    });
    const message = makeLanPeerMessage({
      ...unsigned,
      signature: sign(null, Buffer.from(lanPeerMessageSigningText(unsigned), 'utf8'), identity.privateKey).toString('base64url')
    });
    const datagram = encodeLanPeerMessageDatagram(message, key);
    expect(datagram.toString('utf8')).not.toContain('Hi Eve');
    expect(decodeLanPeerMessageDatagram(datagram, key)).toEqual(message);
    expect(decodeLanPeerMessageDatagram(datagram, randomBytes(32))).toBeNull();

    const unsignedAck = makeLanPeerUnsignedAck({
      messageId: message.messageId,
      fromPeerId: peerId,
      toPeerId: targetPeerId,
      sentAt: 1_700_000_000_600
    });
    const ack = makeLanPeerAck({
      ...unsignedAck,
      signature: sign(null, Buffer.from(lanPeerAckSigningText(unsignedAck), 'utf8'), identity.privateKey).toString('base64url')
    });
    expect(decodeLanPeerMessageDatagram(encodeLanPeerMessageDatagram(ack, key), key)).toEqual(ack);
  });
});
