import { createHash } from 'node:crypto';

export const EVECHAT_BUNDLE_FORMAT = 'paradigmeve.evechat' as const;
export const EVECHAT_BUNDLE_VERSION = 1 as const;
export const EVECHAT_MANIFEST_PATH = 'manifest.json' as const;

export const EVECHAT_CORE_PATHS = {
  events: 'events.jsonl',
  html: 'index.html',
  css: 'archive.css',
  js: 'archive.js'
} as const;

export type EveChatBundleEntryRole = keyof typeof EVECHAT_CORE_PATHS | 'asset';

export interface EveChatBundleLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
}

export const DEFAULT_EVECHAT_BUNDLE_LIMITS: Readonly<EveChatBundleLimits> = Object.freeze({
  maxEntries: 10_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024
});

export interface EveChatBundleManifestEntry {
  path: string;
  role: EveChatBundleEntryRole;
  byteLength: number;
  sha256: string;
  mediaType?: string;
}

export interface EveChatBundleManifest {
  format: typeof EVECHAT_BUNDLE_FORMAT;
  bundleVersion: typeof EVECHAT_BUNDLE_VERSION;
  archiveSchemaVersion: number;
  minimumCompatibleArchiveSchemaVersion: number;
  bundleId: string;
  session: { id: string };
  entries: EveChatBundleManifestEntry[];
}

export interface EveChatExportSource {
  path: string;
  role: EveChatBundleEntryRole;
  byteLength: number;
  mediaType?: string;
  readBytes: () => Uint8Array | Promise<Uint8Array>;
}

export interface EveChatPlannedEntry extends EveChatBundleManifestEntry {
  readBytes: () => Uint8Array | Promise<Uint8Array>;
}

export interface EveChatExportPlan {
  manifest: EveChatBundleManifest;
  manifestBytes: Uint8Array;
  entries: EveChatPlannedEntry[];
}

export interface EveChatExportInput {
  sessionId: string;
  archiveSchemaVersion: number;
  minimumCompatibleArchiveSchemaVersion: number;
  entries: EveChatExportSource[];
  limits?: Partial<EveChatBundleLimits>;
}

export class EveChatBundleValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EveChatBundleValidationError';
    this.code = code;
  }
}

const HASH = /^[a-f0-9]{64}$/;
const ASSET_PATH = /^assets\/([a-f0-9]{64})(?:\.([a-z0-9]{1,16}))?$/;

function fail(code: string, message: string): never {
  throw new EveChatBundleValidationError(code, message);
}

function finiteNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-number', `${label} must be a non-negative safe integer`);
}

export function resolveEveChatBundleLimits(overrides: Partial<EveChatBundleLimits> = {}): EveChatBundleLimits {
  const limits = { ...DEFAULT_EVECHAT_BUNDLE_LIMITS, ...overrides };
  finiteNonnegativeInteger(limits.maxEntries, 'maxEntries');
  finiteNonnegativeInteger(limits.maxEntryBytes, 'maxEntryBytes');
  finiteNonnegativeInteger(limits.maxTotalBytes, 'maxTotalBytes');
  finiteNonnegativeInteger(limits.maxManifestBytes, 'maxManifestBytes');
  if (limits.maxEntries < 4) fail('invalid-limits', 'maxEntries must leave room for the four required bundle files');
  if (limits.maxEntryBytes === 0 || limits.maxTotalBytes === 0 || limits.maxManifestBytes === 0) {
    fail('invalid-limits', 'Bundle byte limits must be greater than zero');
  }
  return limits;
}

export function validateEveChatSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(sessionId) || sessionId.includes('/') || sessionId.includes('\\')) {
    fail('invalid-session-id', 'Bundle session id is invalid');
  }
}

export function validateEveChatEntryPath(path: string, role: EveChatBundleEntryRole): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512 || /[\u0000-\u001f\u007f]/.test(path)) {
    fail('invalid-path', 'Bundle entry path is invalid');
  }
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('//')) {
    fail('unsafe-path', `Bundle entry path is not relative and canonical: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail('unsafe-path', `Bundle entry path contains traversal: ${path}`);
  }
  if (role === 'asset') {
    if (!ASSET_PATH.test(path)) fail('invalid-asset-path', `Asset path must use its SHA-256 name: ${path}`);
    return;
  }
  if (path !== EVECHAT_CORE_PATHS[role]) {
    fail('invalid-core-path', `${role} entry must use ${EVECHAT_CORE_PATHS[role]}`);
  }
}

export function eveChatPathCollisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareEntries(left: Pick<EveChatBundleManifestEntry, 'path' | 'role'>, right: Pick<EveChatBundleManifestEntry, 'path' | 'role'>): number {
  const rank = (role: EveChatBundleEntryRole): number => role === 'events' ? 0 : role === 'html' ? 1 : role === 'css' ? 2 : role === 'js' ? 3 : 4;
  const roleOrder = rank(left.role) - rank(right.role);
  if (roleOrder !== 0) return roleOrder;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function manifestIdentity(input: {
  archiveSchemaVersion: number;
  minimumCompatibleArchiveSchemaVersion: number;
  sessionId: string;
  entries: EveChatBundleManifestEntry[];
}): Omit<EveChatBundleManifest, 'bundleId'> {
  return {
    format: EVECHAT_BUNDLE_FORMAT,
    bundleVersion: EVECHAT_BUNDLE_VERSION,
    archiveSchemaVersion: input.archiveSchemaVersion,
    minimumCompatibleArchiveSchemaVersion: input.minimumCompatibleArchiveSchemaVersion,
    session: { id: input.sessionId },
    entries: input.entries.map(entry => ({ ...entry }))
  };
}

export function computeEveChatBundleId(input: {
  archiveSchemaVersion: number;
  minimumCompatibleArchiveSchemaVersion: number;
  sessionId: string;
  entries: EveChatBundleManifestEntry[];
}): string {
  return sha256Hex(Buffer.from(JSON.stringify(manifestIdentity(input)), 'utf8'));
}

export function serializeEveChatManifest(manifest: EveChatBundleManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function validateManifestEntry(entry: EveChatBundleManifestEntry, limits: EveChatBundleLimits): void {
  validateEveChatEntryPath(entry.path, entry.role);
  finiteNonnegativeInteger(entry.byteLength, `byteLength for ${entry.path}`);
  if (entry.byteLength > limits.maxEntryBytes) fail('entry-too-large', `${entry.path} exceeds the per-entry bundle limit`);
  if (!HASH.test(entry.sha256)) fail('invalid-hash', `${entry.path} has an invalid SHA-256`);
  if (entry.role === 'asset') {
    const pathHash = ASSET_PATH.exec(entry.path)?.[1];
    if (pathHash !== entry.sha256) fail('asset-hash-path-mismatch', `${entry.path} does not match its content hash`);
  }
  if (entry.mediaType !== undefined && (entry.mediaType.length === 0 || entry.mediaType.length > 160 || /[\u0000-\u001f\u007f]/.test(entry.mediaType))) {
    fail('invalid-media-type', `${entry.path} has an invalid media type`);
  }
}

function validateRequiredCoreEntries(entries: readonly EveChatBundleManifestEntry[]): void {
  for (const role of ['events', 'html', 'css', 'js'] as const) {
    if (entries.filter(entry => entry.role === role).length !== 1) fail('missing-core-entry', `Bundle requires exactly one ${role} entry`);
  }
}

export function validateEveChatManifest(manifest: EveChatBundleManifest, overrides: Partial<EveChatBundleLimits> = {}): void {
  const limits = resolveEveChatBundleLimits(overrides);
  if (manifest.format !== EVECHAT_BUNDLE_FORMAT || manifest.bundleVersion !== EVECHAT_BUNDLE_VERSION) {
    fail('unsupported-bundle-version', 'Unsupported .evechat bundle format/version');
  }
  validateEveChatSessionId(manifest.session.id);
  finiteNonnegativeInteger(manifest.archiveSchemaVersion, 'archiveSchemaVersion');
  finiteNonnegativeInteger(manifest.minimumCompatibleArchiveSchemaVersion, 'minimumCompatibleArchiveSchemaVersion');
  if (manifest.archiveSchemaVersion === 0 || manifest.minimumCompatibleArchiveSchemaVersion === 0 ||
      manifest.minimumCompatibleArchiveSchemaVersion > manifest.archiveSchemaVersion) {
    fail('invalid-archive-schema', 'Bundle archive schema compatibility range is invalid');
  }
  if (!HASH.test(manifest.bundleId)) fail('invalid-bundle-id', 'Bundle id must be a SHA-256 hex digest');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > limits.maxEntries) fail('too-many-entries', 'Bundle has too many entries');
  const seen = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    validateManifestEntry(entry, limits);
    const key = eveChatPathCollisionKey(entry.path);
    if (seen.has(key)) fail('duplicate-entry', `Bundle contains a colliding entry path: ${entry.path}`);
    seen.add(key);
    total += entry.byteLength;
    if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) fail('bundle-too-large', 'Bundle exceeds the total decoded byte limit');
  }
  validateRequiredCoreEntries(manifest.entries);
  const expectedId = computeEveChatBundleId({
    archiveSchemaVersion: manifest.archiveSchemaVersion,
    minimumCompatibleArchiveSchemaVersion: manifest.minimumCompatibleArchiveSchemaVersion,
    sessionId: manifest.session.id,
    entries: manifest.entries
  });
  if (manifest.bundleId !== expectedId) fail('bundle-id-mismatch', 'Bundle id does not match the deterministic manifest contents');
}

async function readAndValidateSource(source: EveChatExportSource, limits: EveChatBundleLimits): Promise<EveChatPlannedEntry> {
  validateEveChatEntryPath(source.path, source.role);
  finiteNonnegativeInteger(source.byteLength, `byteLength for ${source.path}`);
  if (source.byteLength > limits.maxEntryBytes) fail('entry-too-large', `${source.path} exceeds the per-entry bundle limit`);
  const bytes = await source.readBytes();
  if (!(bytes instanceof Uint8Array)) fail('invalid-entry-bytes', `${source.path} did not return bytes`);
  if (bytes.byteLength !== source.byteLength) fail('entry-size-mismatch', `${source.path} byte length changed while planning export`);
  const sha256 = sha256Hex(bytes);
  const entry: EveChatPlannedEntry = {
    path: source.path,
    role: source.role,
    byteLength: source.byteLength,
    sha256,
    ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
    readBytes: source.readBytes
  };
  validateManifestEntry(entry, limits);
  return entry;
}

export async function planEveChatExport(input: EveChatExportInput): Promise<EveChatExportPlan> {
  validateEveChatSessionId(input.sessionId);
  const limits = resolveEveChatBundleLimits(input.limits);
  finiteNonnegativeInteger(input.archiveSchemaVersion, 'archiveSchemaVersion');
  finiteNonnegativeInteger(input.minimumCompatibleArchiveSchemaVersion, 'minimumCompatibleArchiveSchemaVersion');
  if (input.archiveSchemaVersion === 0 || input.minimumCompatibleArchiveSchemaVersion === 0 ||
      input.minimumCompatibleArchiveSchemaVersion > input.archiveSchemaVersion) {
    fail('invalid-archive-schema', 'Bundle archive schema compatibility range is invalid');
  }
  if (!Array.isArray(input.entries) || input.entries.length > limits.maxEntries) fail('too-many-entries', 'Bundle has too many entries');

  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const source of input.entries) {
    validateEveChatEntryPath(source.path, source.role);
    finiteNonnegativeInteger(source.byteLength, `byteLength for ${source.path}`);
    if (source.byteLength > limits.maxEntryBytes) fail('entry-too-large', `${source.path} exceeds the per-entry bundle limit`);
    declaredTotal += source.byteLength;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes) fail('bundle-too-large', 'Bundle exceeds the total decoded byte limit');
    const key = eveChatPathCollisionKey(source.path);
    if (seen.has(key)) fail('duplicate-entry', `Bundle contains a colliding entry path: ${source.path}`);
    seen.add(key);
  }

  const entries = (await Promise.all(input.entries.map(source => readAndValidateSource(source, limits)))).sort(compareEntries);
  validateRequiredCoreEntries(entries);
  const manifestEntries = entries.map(({ readBytes: _readBytes, ...entry }) => entry);
  const bundleId = computeEveChatBundleId({
    archiveSchemaVersion: input.archiveSchemaVersion,
    minimumCompatibleArchiveSchemaVersion: input.minimumCompatibleArchiveSchemaVersion,
    sessionId: input.sessionId,
    entries: manifestEntries
  });
  const manifest: EveChatBundleManifest = {
    ...manifestIdentity({
      archiveSchemaVersion: input.archiveSchemaVersion,
      minimumCompatibleArchiveSchemaVersion: input.minimumCompatibleArchiveSchemaVersion,
      sessionId: input.sessionId,
      entries: manifestEntries
    }),
    bundleId
  };
  const manifestBytes = serializeEveChatManifest(manifest);
  if (manifestBytes.byteLength > limits.maxManifestBytes) fail('manifest-too-large', 'Bundle manifest exceeds its byte limit');
  validateEveChatManifest(manifest, limits);
  return { manifest, manifestBytes, entries };
}

export async function readPlannedEveChatEntry(entry: EveChatPlannedEntry): Promise<Uint8Array> {
  const bytes = await entry.readBytes();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
    fail('export-source-changed', `${entry.path} changed after the export plan was created`);
  }
  return bytes;
}
