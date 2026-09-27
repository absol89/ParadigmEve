import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject
} from 'node:crypto';
import { getSecret, setSecret } from './secrets.js';

export const LAN_PEER_PRIVATE_KEY_SECRET = 'lanPeerPrivateKey' as const;

export type LanPeerIdentity = {
  /** SHA-256 of the canonical Ed25519 SPKI DER, encoded as unpadded base64url. */
  peerId: string;
  /** Canonical Ed25519 SubjectPublicKeyInfo DER, encoded as unpadded base64url. */
  publicKey: string;
  /** Sign exact protocol bytes synchronously after the identity has been loaded once. */
  sign(bytes: Uint8Array): string;
};

const PEER_ID_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

let identityLoadInFlight: Promise<KeyObject> | null = null;

function decodeCanonicalBase64url(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length > 0 && decoded.toString('base64url') === value ? decoded : null;
}

function malformedStoredIdentity(): Error {
  return new Error('Stored LAN peer identity key is malformed; refusing to replace the installation identity');
}

function parsePrivateKey(value: string): KeyObject {
  const encoded = decodeCanonicalBase64url(value);
  if (!encoded) throw malformedStoredIdentity();
  try {
    const privateKey = createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw malformedStoredIdentity();
    const canonical = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    if (!canonical.equals(encoded)) throw malformedStoredIdentity();
    return privateKey;
  } catch {
    throw malformedStoredIdentity();
  }
}

function parsePublicKey(value: string): { key: KeyObject; spki: Buffer } | null {
  const spki = decodeCanonicalBase64url(value);
  if (!spki) return null;
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    const canonical = key.export({ format: 'der', type: 'spki' }) as Buffer;
    return canonical.equals(spki) ? { key, spki } : null;
  } catch {
    return null;
  }
}

function identityFromPrivateKey(privateKey: KeyObject): LanPeerIdentity {
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    peerId: createHash('sha256').update(spki).digest('base64url'),
    publicKey: spki.toString('base64url'),
    sign: (bytes: Uint8Array) => signBytes(null, Buffer.from(bytes), privateKey).toString('base64url')
  };
}

async function loadOrCreatePrivateKey(): Promise<KeyObject> {
  const stored = await getSecret(LAN_PEER_PRIVATE_KEY_SECRET);
  if (stored !== null) return parsePrivateKey(stored);

  const { privateKey } = generateKeyPairSync('ed25519');
  const encoded = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url');
  await setSecret(LAN_PEER_PRIVATE_KEY_SECRET, encoded);
  return privateKey;
}

async function privateKey(): Promise<KeyObject> {
  if (identityLoadInFlight) return identityLoadInFlight;
  const load = loadOrCreatePrivateKey();
  identityLoadInFlight = load;
  try {
    return await load;
  } finally {
    if (identityLoadInFlight === load) identityLoadInFlight = null;
  }
}

/**
 * Return this installation's stable public LAN identity, creating it once when no identity exists.
 * Existing invalid material is an error: silently rotating it would let an installation take a new
 * fingerprint and break durable nickname ownership.
 */
export async function getOrCreateLanPeerIdentity(): Promise<LanPeerIdentity> {
  return identityFromPrivateKey(await privateKey());
}

/**
 * Verify that a public key owns peerId and signed the exact supplied bytes.
 * All wire encodings must already be canonical unpadded base64url.
 */
export function verifyLanPeerSignature(
  peerId: string,
  publicKey: string,
  bytes: Uint8Array,
  signature: string
): boolean {
  const id = decodeCanonicalBase64url(peerId);
  const parsedPublicKey = parsePublicKey(publicKey);
  const sig = decodeCanonicalBase64url(signature);
  if (!id || id.length !== PEER_ID_BYTES || !parsedPublicKey || !sig || sig.length !== ED25519_SIGNATURE_BYTES) return false;
  if (!createHash('sha256').update(parsedPublicKey.spki).digest().equals(id)) return false;
  try {
    return verifyBytes(null, Buffer.from(bytes), parsedPublicKey.key, sig);
  } catch {
    return false;
  }
}
