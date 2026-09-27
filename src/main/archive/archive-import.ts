import {
  DEFAULT_EVECHAT_BUNDLE_LIMITS,
  EVECHAT_BUNDLE_FORMAT,
  EVECHAT_BUNDLE_VERSION,
  EVECHAT_CORE_PATHS,
  EVECHAT_MANIFEST_PATH,
  EveChatBundleValidationError,
  computeEveChatBundleId,
  eveChatPathCollisionKey,
  resolveEveChatBundleLimits,
  sha256Hex,
  validateEveChatEntryPath,
  validateEveChatManifest,
  validateEveChatSessionId,
  type EveChatBundleEntryRole,
  type EveChatBundleLimits,
  type EveChatBundleManifest,
  type EveChatBundleManifestEntry
} from './archive-export.js';

export type EveChatContainerEntry =
  | {
      kind: 'file';
      path: string;
      declaredSize: number;
      /** The container adapter must stop decoding before returning more than maxBytes. */
      readBytes: (maxBytes: number) => Uint8Array | Promise<Uint8Array>;
    }
  | {
      kind: 'directory';
      path: string;
      declaredSize?: number;
    }
  | {
      kind: 'symlink';
      path: string;
      declaredSize: number;
      linkTarget?: string;
      readBytes?: (maxBytes: number) => Uint8Array | Promise<Uint8Array>;
    };

export interface EveChatImportOptions {
  entries: EveChatContainerEntry[];
  supportedArchiveSchemaVersion: number;
  liveSessionExists: (sessionId: string) => boolean | Promise<boolean>;
  limits?: Partial<EveChatBundleLimits>;
}

export interface EveChatImportValidation {
  manifest: EveChatBundleManifest;
  verifiedPaths: string[];
  totalDecodedBytes: number;
  disposition: 'read-only-import';
}

function fail(code: string, message: string): never {
  throw new EveChatBundleValidationError(code, message);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('invalid-number', `${label} must be a non-negative safe integer`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('invalid-manifest', `${label} contains unsupported field ${key}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-manifest', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('invalid-manifest', `${label} must be a string`);
  return value;
}

function parseManifestEntry(value: unknown): EveChatBundleManifestEntry {
  const row = record(value, 'manifest entry');
  exactKeys(row, ['path', 'role', 'byteLength', 'sha256', 'mediaType'], 'manifest entry');
  const role = string(row.role, 'manifest entry role');
  if (!['events', 'html', 'css', 'js', 'asset'].includes(role)) fail('invalid-manifest', `Unsupported manifest entry role ${role}`);
  const entry: EveChatBundleManifestEntry = {
    path: string(row.path, 'manifest entry path'),
    role: role as EveChatBundleEntryRole,
    byteLength: integer(row.byteLength, 'manifest entry byteLength'),
    sha256: string(row.sha256, 'manifest entry sha256'),
    ...(row.mediaType === undefined ? {} : { mediaType: string(row.mediaType, 'manifest entry mediaType') })
  };
  return entry;
}

export function parseEveChatManifest(bytes: Uint8Array, limits: Partial<EveChatBundleLimits> = {}): EveChatBundleManifest {
  const resolved = resolveEveChatBundleLimits(limits);
  if (bytes.byteLength > resolved.maxManifestBytes) fail('manifest-too-large', 'Bundle manifest exceeds its byte limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-manifest-encoding', 'Bundle manifest is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-manifest-json', 'Bundle manifest is not valid JSON');
  }
  const row = record(parsed, 'manifest');
  exactKeys(row, [
    'format', 'bundleVersion', 'archiveSchemaVersion', 'minimumCompatibleArchiveSchemaVersion', 'bundleId', 'session', 'entries'
  ], 'manifest');
  if (row.format !== EVECHAT_BUNDLE_FORMAT || row.bundleVersion !== EVECHAT_BUNDLE_VERSION) {
    fail('unsupported-bundle-version', 'Unsupported .evechat bundle format/version');
  }
  const session = record(row.session, 'manifest session');
  exactKeys(session, ['id'], 'manifest session');
  const entries = row.entries;
  if (!Array.isArray(entries)) fail('invalid-manifest', 'manifest entries must be an array');
  const manifest: EveChatBundleManifest = {
    format: EVECHAT_BUNDLE_FORMAT,
    bundleVersion: EVECHAT_BUNDLE_VERSION,
    archiveSchemaVersion: integer(row.archiveSchemaVersion, 'archiveSchemaVersion'),
    minimumCompatibleArchiveSchemaVersion: integer(row.minimumCompatibleArchiveSchemaVersion, 'minimumCompatibleArchiveSchemaVersion'),
    bundleId: string(row.bundleId, 'bundleId'),
    session: { id: string(session.id, 'session id') },
    entries: entries.map(parseManifestEntry)
  };
  validateEveChatManifest(manifest, resolved);
  return manifest;
}

function normalizedDirectoryPath(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function validateContainerPath(path: string, kind: EveChatContainerEntry['kind']): void {
  if (kind === 'directory') {
    const normalized = normalizedDirectoryPath(path);
    if (normalized !== 'assets') fail('unexpected-directory', `Bundle contains unexpected directory ${path}`);
    return;
  }
  if (path === EVECHAT_MANIFEST_PATH) return;
  const coreRole = (Object.entries(EVECHAT_CORE_PATHS) as Array<[Exclude<EveChatBundleEntryRole, 'asset'>, string]>)
    .find(([, expected]) => expected === path)?.[0];
  validateEveChatEntryPath(path, coreRole ?? 'asset');
}

function preflightContainer(entries: EveChatContainerEntry[], limits: EveChatBundleLimits): Map<string, EveChatContainerEntry> {
  if (!Array.isArray(entries) || entries.length > limits.maxEntries + 2) fail('too-many-entries', 'Bundle container has too many entries');
  const byPath = new Map<string, EveChatContainerEntry>();
  const collisionKeys = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !['file', 'directory', 'symlink'].includes(entry.kind)) {
      fail('unsupported-entry-type', 'Bundle contains an unsupported container entry type');
    }
    validateContainerPath(entry.path, entry.kind);
    const collisionPath = entry.kind === 'directory' ? normalizedDirectoryPath(entry.path) : entry.path;
    const key = eveChatPathCollisionKey(collisionPath);
    if (collisionKeys.has(key)) fail('duplicate-entry', `Bundle contains a colliding container path: ${entry.path}`);
    collisionKeys.add(key);
    if (entry.kind === 'symlink') fail('symlink-entry', `Bundle symlinks are not importable: ${entry.path}`);
    const declaredSize = integer(entry.declaredSize ?? 0, `declared size for ${entry.path}`);
    if (entry.kind === 'directory' && declaredSize !== 0) fail('invalid-directory', `Bundle directory ${entry.path} must have zero decoded bytes`);
    if (entry.kind === 'file') {
      if (declaredSize > limits.maxEntryBytes) fail('entry-too-large', `${entry.path} exceeds the per-entry bundle limit`);
      total += declaredSize;
      if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes + limits.maxManifestBytes) {
        fail('bundle-too-large', 'Bundle container exceeds the total decoded byte limit');
      }
    }
    byPath.set(entry.path, entry);
  }
  return byPath;
}

async function readExactFile(entry: EveChatContainerEntry | undefined, expectedBytes: number, path: string): Promise<Uint8Array> {
  if (!entry || entry.kind !== 'file') fail('missing-entry', `Bundle is missing ${path}`);
  if (entry.declaredSize !== expectedBytes) fail('entry-size-mismatch', `${path} declared size does not match the manifest`);
  const bytes = await entry.readBytes(expectedBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedBytes) fail('entry-size-mismatch', `${path} decoded size does not match the manifest`);
  return bytes;
}

export async function validateEveChatImport(options: EveChatImportOptions): Promise<EveChatImportValidation> {
  const limits = resolveEveChatBundleLimits(options.limits);
  const supportedArchiveSchemaVersion = integer(options.supportedArchiveSchemaVersion, 'supportedArchiveSchemaVersion');
  if (supportedArchiveSchemaVersion === 0) fail('unsupported-archive-schema', 'Supported archive schema version must be greater than zero');
  if (typeof options.liveSessionExists !== 'function') fail('live-session-check-required', 'Import requires an authoritative live-session collision check');
  const byPath = preflightContainer(options.entries, limits);
  const manifestEntry = byPath.get(EVECHAT_MANIFEST_PATH);
  if (!manifestEntry || manifestEntry.kind !== 'file') fail('missing-manifest', 'Bundle is missing manifest.json');
  if (manifestEntry.declaredSize > limits.maxManifestBytes) fail('manifest-too-large', 'Bundle manifest exceeds its byte limit');
  const manifestBytes = await readExactFile(manifestEntry, manifestEntry.declaredSize, EVECHAT_MANIFEST_PATH);
  const manifest = parseEveChatManifest(manifestBytes, limits);
  validateEveChatSessionId(manifest.session.id);
  if (manifest.minimumCompatibleArchiveSchemaVersion > supportedArchiveSchemaVersion) {
    fail('unsupported-archive-schema', `Bundle requires archive schema ${manifest.minimumCompatibleArchiveSchemaVersion} or newer`);
  }

  if (await options.liveSessionExists(manifest.session.id)) {
    fail('live-session-collision', `Import refuses to overwrite authoritative live session ${manifest.session.id}`);
  }

  const expectedFiles = new Set([EVECHAT_MANIFEST_PATH, ...manifest.entries.map(entry => entry.path)]);
  for (const entry of options.entries) {
    if (entry.kind === 'file' && !expectedFiles.has(entry.path)) fail('unexpected-entry', `Bundle contains unlisted file ${entry.path}`);
  }

  const manifestId = computeEveChatBundleId({
    archiveSchemaVersion: manifest.archiveSchemaVersion,
    minimumCompatibleArchiveSchemaVersion: manifest.minimumCompatibleArchiveSchemaVersion,
    sessionId: manifest.session.id,
    entries: manifest.entries
  });
  if (manifestId !== manifest.bundleId) fail('bundle-id-mismatch', 'Bundle manifest identity is inconsistent');

  let totalDecodedBytes = 0;
  const verifiedPaths: string[] = [];
  for (const expected of manifest.entries) {
    const bytes = await readExactFile(byPath.get(expected.path), expected.byteLength, expected.path);
    totalDecodedBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalDecodedBytes) || totalDecodedBytes > limits.maxTotalBytes) fail('bundle-too-large', 'Bundle exceeds the total decoded byte limit');
    if (sha256Hex(bytes) !== expected.sha256) fail('hash-mismatch', `${expected.path} does not match its manifest SHA-256`);
    verifiedPaths.push(expected.path);
  }

  return {
    manifest,
    verifiedPaths,
    totalDecodedBytes,
    disposition: 'read-only-import'
  };
}

export { DEFAULT_EVECHAT_BUNDLE_LIMITS };
