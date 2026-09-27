import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'dpapi'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const {
  LAN_PEER_PRIVATE_KEY_SECRET,
  getOrCreateLanPeerIdentity,
  verifyLanPeerSignature
} = await import('../src/main/lan-peer-identity.js');
const { getSecret, initSecretsPath, resetSecretsCacheForTests, setSecret } = await import('../src/main/secrets.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir('eve-lan-peer-identity-');
  initSecretsPath(dir);
  resetSecretsCacheForTests();
});

afterEach(async () => {
  resetSecretsCacheForTests();
  await removeTempDir(dir);
});

describe('durable LAN peer identity', () => {
  it('creates one canonical Ed25519 identity and restores the same fingerprint after a cold secret read', async () => {
    const first = await getOrCreateLanPeerIdentity();
    const stored = await getSecret(LAN_PEER_PRIVATE_KEY_SECRET);
    expect(stored).not.toBeNull();

    const privateDer = Buffer.from(stored!, 'base64url');
    expect(privateDer.toString('base64url')).toBe(stored);
    const privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
    expect(privateKey.asymmetricKeyType).toBe('ed25519');
    expect((privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).equals(privateDer)).toBe(true);

    const publicSpki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    expect(first.publicKey).toBe(publicSpki.toString('base64url'));
    expect(first.peerId).toBe(createHash('sha256').update(publicSpki).digest('base64url'));
    expect(Buffer.from(first.peerId, 'base64url')).toHaveLength(32);

    resetSecretsCacheForTests();
    const restored = await getOrCreateLanPeerIdentity();
    expect({ peerId: restored.peerId, publicKey: restored.publicKey }).toEqual({ peerId: first.peerId, publicKey: first.publicKey });
  });

  it('single-flights concurrent first use so every caller receives the same installation identity', async () => {
    const identities = await Promise.all(Array.from({ length: 8 }, () => getOrCreateLanPeerIdentity()));
    expect(new Set(identities.map(identity => identity.peerId))).toHaveProperty('size', 1);
    expect(new Set(identities.map(identity => identity.publicKey))).toHaveProperty('size', 1);
  });

  it.each([
    ['non-canonical bytes', 'definitely-not-a-pkcs8-key='],
    ['a valid PKCS#8 key for the wrong algorithm', (() => {
      const { privateKey } = generateKeyPairSync('x25519');
      return (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url');
    })()]
  ])('fails closed on %s without silently rotating the stored identity', async (_label, existing) => {
    await setSecret(LAN_PEER_PRIVATE_KEY_SECRET, existing);
    await expect(getOrCreateLanPeerIdentity()).rejects.toThrow(/identity key is malformed/i);
    expect(await getSecret(LAN_PEER_PRIVATE_KEY_SECRET)).toBe(existing);
  });

  it('signs with the private installation key and verifies fingerprint, SPKI, bytes and canonical signature together', async () => {
    const bytes = Buffer.from('paradigmeve-lan-presence-v1\0Eva', 'utf8');
    const identity = await getOrCreateLanPeerIdentity();
    const signature = identity.sign(bytes);
    expect(verifyLanPeerSignature(identity.peerId, identity.publicKey, bytes, signature)).toBe(true);
    expect(verifyLanPeerSignature(identity.peerId, identity.publicKey, Buffer.from(`${bytes.toString('utf8')}!`), signature)).toBe(false);
    expect(verifyLanPeerSignature(Buffer.alloc(32, 0x44).toString('base64url'), identity.publicKey, bytes, signature)).toBe(false);
    expect(verifyLanPeerSignature(identity.peerId, identity.publicKey, bytes, `${signature}=`)).toBe(false);

    const { publicKey: otherPublicKey } = generateKeyPairSync('ed25519');
    const otherSpki = (otherPublicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
    expect(verifyLanPeerSignature(identity.peerId, otherSpki, bytes, signature)).toBe(false);
  });
});
