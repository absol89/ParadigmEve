/**
 * Local private-build updater.
 *
 * The public upstream repository is deliberately not an update authority. At runtime this module
 * makes no HTTP requests. A build is eligible only when it exists in the private local update
 * root as:
 *
 *   <root>/<version>/SHA256SUMS.txt
 *   <root>/<version>/<platform artifact>
 *
 * The exact artifact name comes from this process, never from a manifest or the renderer. The
 * checksum file authorizes the bytes, staging rehashes them, and installer handoff rehashes them
 * once more. Missing private update state simply means there is no update.
 *
 * `PARADIGMEVE_PRIVATE_UPDATE_DIR` may point at an explicit absolute local feed. Without it, the feed is
 * `<userData>/private-updates`. Neither path has any network fallback.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION } from './version.js';
import { isNewer, type UpdateStatus } from '../shared/types.js';

const PRIVATE_UPDATE_ENV = 'PARADIGMEVE_PRIVATE_UPDATE_DIR';
const CHECKSUMS_FILE = 'SHA256SUMS.txt';
const MAX_CHECKSUMS_BYTES = 64 * 1024;
/** Local file reads are cheap, so newly staged private builds become visible quickly. */
const RECHECK_MS = 60_000;

/**
 * The artifact this exact installation can apply to itself, or null for one that cannot.
 *
 * An unpackaged run must never hand a packaged installer to the developer's real installation.
 * Linux package-manager installs need root and macOS artifacts are intentionally unsigned, so
 * those installations only report that a private build exists; they do not apply it themselves.
 */
export function stagedArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appImage: string | undefined = process.env.APPIMAGE,
  packaged: boolean = app.isPackaged
): { name: string; kind: 'installer' | 'appimage'; target: string } | null {
  if (!packaged) return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'win32') return { name: `ParadigmEve-Setup-${arch}.exe`, kind: 'installer', target: '' };
  if (platform === 'linux' && appImage) {
    return { name: `ParadigmEve-Linux-${arch}.AppImage`, kind: 'appimage', target: appImage };
  }
  return null;
}

/** `v2.0.3` -> `2.0.3`, and anything that is not a stable release version -> null. */
export function releaseVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const version = tag.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/**
 * Local private update authority. An explicit override must be absolute so service/shortcut cwd
 * changes cannot silently retarget executable authority.
 */
export function privateUpdateRoot(): string {
  const configured = process.env[PRIVATE_UPDATE_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`${PRIVATE_UPDATE_ENV} must be an absolute local path`);
    return path.resolve(configured);
  }
  return path.join(app.getPath('userData'), 'private-updates');
}

const CLEAR: UpdateStatus = { current: APP_VERSION, latest: null, stage: 'idle', error: null, checkedAt: null };

let status: UpdateStatus = CLEAR;
let staged: { version: string; file: string; kind: 'installer' | 'appimage'; target: string; digest: string } | null = null;
let pass: Promise<void> | null = null;
/** Set by `markInstallOnQuit`: the user pressed Install, so bring the app back afterwards. */
let runAfterInstall = false;
const listeners = new Set<() => void>();

export function onUpdateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateStatus(): UpdateStatus {
  return { ...status };
}

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener();
}

/** Runs one local check now and repeats it while the tray app remains open. */
export function startUpdateChecks(): void {
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), RECHECK_MS).unref();
}

/** Concurrent checks join one pass; no second staging copy can race the first. */
export function checkForUpdates(): Promise<void> {
  if (pass) return pass;
  const run = runPass()
    .catch((err: Error) => {
      staged = null;
      set({ latest: null, stage: 'failed', error: err.message });
      logWarn(`private update check failed: ${err.message}`);
    })
    .finally(() => {
      if (pass === run) pass = null;
    });
  pass = run;
  return run;
}

interface PrivateRelease {
  version: string;
  dir: string;
}

function compareVersions(a: string, b: string): number {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = aa[i]! - bb[i]!;
    if (delta) return delta;
  }
  return 0;
}

/** Direct child directories only. Symlinks/junctions never become executable authority. */
async function latestPrivateRelease(): Promise<PrivateRelease | null> {
  const root = privateUpdateRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const versions: string[] = [];
  for (const entry of entries) {
    const version = releaseVersion(entry.name);
    if (!version || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    versions.push(version);
  }
  versions.sort(compareVersions);
  const version = versions.at(-1);
  return version ? { version, dir: path.join(root, version) } : null;
}

async function regularPrivateFile(file: string, label: string): Promise<void> {
  const stat = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw err;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular local file`);
}

async function releaseDigests(release: PrivateRelease): Promise<Map<string, string>> {
  const sums = path.join(release.dir, CHECKSUMS_FILE);
  await regularPrivateFile(sums, `private build ${release.version} ${CHECKSUMS_FILE}`);
  const body = await readFile(sums, 'utf8');
  if (Buffer.byteLength(body, 'utf8') > MAX_CHECKSUMS_BYTES) throw new Error('private update checksum file is too large');
  const digests = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^([0-9a-f]{64})\s+[*\s]?(\S+)\s*$/i.exec(line.trim());
    if (!match) continue;
    const name = match[2]!;
    if (name !== path.basename(name)) throw new Error('private update checksum file contains a path');
    digests.set(name, match[1]!.toLowerCase());
  }
  return digests;
}

async function runPass(): Promise<void> {
  set({ stage: 'checking', error: null });
  const release = await latestPrivateRelease();
  set({ checkedAt: Date.now() });
  if (!release) {
    staged = null;
    set({ latest: null, stage: 'idle', error: null });
    return;
  }

  if (!isNewer(release.version, APP_VERSION)) {
    staged = null;
    set({ latest: null, stage: 'idle', error: null });
    return;
  }

  logInfo(`private update: ${release.version} is available; this app is ${APP_VERSION}`);
  const artifact = stagedArtifact();
  if (!artifact) {
    staged = null;
    set({ latest: release.version, stage: 'idle', error: null });
    return;
  }

  const digests = await releaseDigests(release);
  const expected = digests.get(artifact.name);
  if (!expected) throw new Error(`private build ${release.version} provides no digest for ${artifact.name}`);
  const source = path.join(release.dir, artifact.name);
  await regularPrivateFile(source, `private update artifact ${artifact.name}`);

  if (staged?.version === release.version && staged.digest === expected) {
    if ((await fileDigest(staged.file)) === expected) {
      set({ latest: release.version, stage: 'ready', error: null });
      return;
    }
    staged = null;
  } else {
    staged = null;
  }

  const carried = await adopt(release.version, artifact.name, expected);
  if (carried) {
    staged = { version: release.version, file: carried, kind: artifact.kind, target: artifact.target, digest: expected };
    set({ latest: release.version, stage: 'ready', error: null });
    logInfo(`private update: ${release.version} was already staged and is ready to install`);
    return;
  }

  set({ latest: release.version, stage: 'downloading', error: null });
  const file = await stagePrivateArtifact(release, artifact.name, expected);
  staged = { version: release.version, file, kind: artifact.kind, target: artifact.target, digest: expected };
  set({ latest: release.version, stage: 'ready', error: null });
  logInfo(`private update: ${release.version} is staged and ready to install`);
}

/** Where one verified private artifact is kept after being copied out of the feed. */
function stagingDir(version: string): string {
  return path.join(app.getPath('userData'), 'updates', version);
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Reuse is allowed only after rehashing against the current private feed authority. */
async function adopt(version: string, name: string, expected: string): Promise<string | null> {
  const file = path.join(stagingDir(version), name);
  if (!existsSync(file)) return null;
  try {
    await regularPrivateFile(file, 'staged private update');
    if ((await fileDigest(file)) !== expected) throw new Error('it does not match the private build digest');
    return file;
  } catch (err) {
    logWarn(`private update: staged ${version} cannot be reused (${(err as Error).message}); staging it again`);
    return null;
  }
}

/**
 * Copies the fixed-name local artifact into the private staging area. The copied bytes, not merely
 * the source, are hashed before `.part` is promoted, so a source changed mid-copy fails closed.
 */
async function stagePrivateArtifact(release: PrivateRelease, name: string, expected: string): Promise<string> {
  const source = path.join(release.dir, name);
  const dir = stagingDir(release.version);
  await rm(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const partial = `${file}.part`;
  await copyFile(source, partial);
  const digest = await fileDigest(partial);
  if (digest !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${name} is not the private manifest file: sha256 ${digest} instead of ${expected}`);
  }
  await rename(partial, file);
  return file;
}

/** Records that the user pressed Install. The caller owns the orderly quit. */
export function markInstallOnQuit(): boolean {
  if (!staged) return false;
  runAfterInstall = true;
  return true;
}

/**
 * Hands a previously staged and reverified private build to the platform only at the end of the
 * ordinary shutdown sequence, after bridge drain and durable flushes.
 */
export async function applyStagedUpdate(): Promise<void> {
  const ready = staged;
  const relaunch = runAfterInstall;
  staged = null;
  runAfterInstall = false;
  if (!ready) return;
  try {
    await regularPrivateFile(ready.file, 'staged private update');
    if ((await fileDigest(ready.file)) !== ready.digest) throw new Error('the staged artifact changed after verification');
    if (ready.kind === 'installer') {
      const args = relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'];
      const installer = spawn(ready.file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      installer.on('error', (err: Error) => logWarn(`the private ${ready.version} installer did not start: ${err.message}`));
      installer.unref();
    } else {
      const next = `${ready.target}.new`;
      await copyFile(ready.file, next);
      await chmod(next, 0o755);
      await rename(next, ready.target);
      if (relaunch) app.relaunch({ execPath: ready.target });
    }
    logInfo(
      relaunch
        ? `private update: installing ${ready.version} now; the app starts itself again as the new version`
        : `private update: ${ready.version} handed over; the next start of this app is the new version`
    );
  } catch (err) {
    logWarn(`could not apply the staged private ${ready.version} update: ${(err as Error).message}`);
  }
}

/** Test seam: forgets process-local updater state. */
export function resetUpdateForTests(): void {
  status = CLEAR;
  staged = null;
  pass = null;
  runAfterInstall = false;
  listeners.clear();
}
