import { randomBytes } from 'node:crypto';
import { clearSecret, getSecret, setSecret } from './secrets.js';

export const LAN_GROUP_KEY_BYTES = 32;
export const LAN_GROUP_SECRET_KEY = 'lanGroupKey' as const;

/** Generate one fresh group key in the exact canonical form accepted by parseLanGroupKey(). */
export function generateLanGroupKey(): string {
  return randomBytes(LAN_GROUP_KEY_BYTES).toString('base64url');
}

/**
 * Parse the only accepted persisted/wire-entry form for a LAN group key.
 *
 * Canonical unpadded base64url is compact, copyable and has exactly one spelling for 32 bytes.
 * Reject whitespace, padding, hex, short keys and permissive decoder aliases rather than silently
 * normalizing user input at a trust boundary.
 */
export function parseLanGroupKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === LAN_GROUP_KEY_BYTES && decoded.toString('base64url') === value ? decoded : null;
}

/** Store one explicitly supplied, already-generated group key in the OS-backed secret store. */
export async function setLanGroupKey(value: string): Promise<void> {
  if (!parseLanGroupKey(value)) throw new Error('LAN group key must be exactly 32 bytes encoded as canonical base64url');
  await setSecret(LAN_GROUP_SECRET_KEY, value);
}

/** Read a usable key. Malformed historical/hand-edited secret material fails closed. */
export async function getLanGroupKey(): Promise<Buffer | null> {
  const stored = await getSecret(LAN_GROUP_SECRET_KEY);
  return stored === null ? null : parseLanGroupKey(stored);
}

export function clearLanGroupKey(): Promise<void> {
  return clearSecret(LAN_GROUP_SECRET_KEY);
}
