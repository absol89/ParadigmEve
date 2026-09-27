/**
 * Updater: two sources, one staged artifact, and the user's own quit.
 *
 * **Sources.** A pass asks two places for a newer build and takes the higher version; the local
 * feed wins a tie, since it needs no download.
 *
 * - The private local feed, `<root>/<version>/SHA256SUMS.txt` plus `<root>/<version>/<artifact>`.
 *   `PARADIGMEVE_PRIVATE_UPDATE_DIR` may point at an explicit absolute feed; without it the feed
 *   is `<userData>/private-updates`. It is read every minute.
 * - The release marked **Latest** in the maintainer's repository, `absol89/ParadigmEve`, and no
 *   other. The repository is a constant in this file, never configuration, a response field or a
 *   renderer argument. GitHub's `releases/latest` never returns a draft or a pre-release, and the
 *   answer is checked for both again. `publish.yml` creates every release as a pre-release, so
 *   nothing reaches an installation until the maintainer promotes it to Latest on GitHub. GitHub
 *   is asked at most every six hours.
 *
 * **Authority.** The artifact name comes from this process: platform, arch and the compiled build
 * flavor (a debug build takes `-debug` artifacts and nothing else). Every URL is built from the
 * fixed repository, a validated version tag and that name, and a redirect may only land on
 * GitHub's own hosts. The release's `SHA256SUMS.txt` authorizes the bytes: staging hashes them
 * before `.part` is promoted, adoption rehashes a carried file, and the installer handoff rehashes
 * once more.
 *
 * **Nothing may wedge startup.** Every failure ends as `stage: 'failed'` plus a log line, and no
 * caller awaits this. A GitHub failure never hides a usable local build.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION } from './version.js';
import { BUILD_FLAVOR, type BuildFlavor } from '../shared/build-flavor.js';
import { isNewer, type UpdateStatus } from '../shared/types.js';

const PRIVATE_UPDATE_ENV = 'PARADIGMEVE_PRIVATE_UPDATE_DIR';
const CHECKSUMS_FILE = 'SHA256SUMS.txt';
const MAX_CHECKSUMS_BYTES = 64 * 1024;
/** Local file reads are cheap, so newly staged private builds become visible quickly. */
const RECHECK_MS = 60_000;

/** The only repository whose releases this app will ever offer or install. */
export const UPDATE_REPOSITORY = 'absol89/ParadigmEve';
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
/** One request per six hours is invisible, and far inside the anonymous API rate limit. */
const GITHUB_RECHECK_MS = 6 * 60 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/**
 * The artifact this exact installation can apply to itself, or null for one that cannot.
 *
 * An unpackaged run must never hand a packaged installer to the developer's real installation.
 * Linux package-manager installs need root and macOS artifacts are intentionally unsigned, so
 * those installations only report that a newer build exists; they do not apply it themselves.
 */
export function stagedArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appImage: string | undefined = process.env.APPIMAGE,
  packaged: boolean = app.isPackaged,
  flavor: BuildFlavor = BUILD_FLAVOR
): { name: string; kind: 'installer' | 'appimage'; target: string } | null {
  if (!packaged) return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  // The suffix scripts/build-flavor.mjs gives the packages, so a build only ever takes an
  // artifact of its own flavor.
  const suffix = flavor === 'shipping' ? '' : `-${flavor}`;
  if (platform === 'win32') return { name: `ParadigmEve-Setup-${arch}${suffix}.exe`, kind: 'installer', target: '' };
  if (platform === 'linux' && appImage) {
    return { name: `ParadigmEve-Linux-${arch}${suffix}.AppImage`, kind: 'appimage', target: appImage };
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

const CLEAR: UpdateStatus = { current: APP_VERSION, latest: null, stage: 'idle', error: null, checkedAt: null, releaseUrl: null };

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

/** Runs one check now and repeats it while the tray app remains open; GitHub is asked far less often. */
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
      set({ latest: null, stage: 'failed', error: err.message, releaseUrl: null });
      logWarn(`update check failed: ${err.message}`);
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
  return parseDigests(body, 'private update checksum file');
}

/** `sha256sum` output: "<64 hex>  <name>", with a binary/text marker on the second space. */
function parseDigests(body: string, label: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of body.split('\n')) {
    const match = /^([0-9a-f]{64})\s+[*\s]?(\S+)\s*$/i.exec(line.trim());
    if (!match) continue;
    const name = match[2]!;
    if (name !== path.basename(name)) throw new Error(`${label} contains a path`);
    digests.set(name, match[1]!.toLowerCase());
  }
  return digests;
}

/** One newer build, wherever it came from, and how to get its bytes. */
interface Candidate {
  version: string;
  source: 'private' | 'github';
  releaseUrl: string | null;
  digests(): Promise<Map<string, string>>;
  /** Fails when the source no longer holds the artifact it authorizes. */
  present(name: string): Promise<void>;
  /** Copies or downloads `name` into staging and proves it is `expected`. */
  stage(name: string, expected: string): Promise<string>;
}

function privateCandidate(release: PrivateRelease): Candidate {
  return {
    version: release.version,
    source: 'private',
    releaseUrl: null,
    digests: () => releaseDigests(release),
    present: (name) => regularPrivateFile(path.join(release.dir, name), `private update artifact ${name}`),
    stage: (name, expected) => stagePrivateArtifact(release, name, expected)
  };
}

async function runPass(): Promise<void> {
  set({ stage: 'checking', error: null });
  const local = await latestPrivateRelease();
  const remote = await githubRelease();
  set({ checkedAt: Date.now() });

  const candidates: Candidate[] = [];
  if (local && isNewer(local.version, APP_VERSION)) candidates.push(privateCandidate(local));
  if (remote.release && isNewer(remote.release.version, APP_VERSION)) candidates.push(githubCandidate(remote.release));
  // Highest version wins; the local feed is first, so it keeps a tie.
  const chosen = candidates.reduce<Candidate | null>(
    (best, next) => (!best || isNewer(next.version, best.version) ? next : best),
    null
  );
  if (!chosen) {
    staged = null;
    // A GitHub failure is reported only when nothing newer was found anywhere else.
    if (remote.error) throw new Error(`could not check GitHub releases: ${remote.error}`);
    set({ latest: null, stage: 'idle', error: null, releaseUrl: null });
    return;
  }
  if (remote.error) logWarn(`update: the GitHub check failed (${remote.error}); using the local private feed`);

  const label = chosen.source === 'github' ? `release ${chosen.version} (GitHub Latest)` : `private build ${chosen.version}`;
  logInfo(`update: ${label} is available; this app is ${APP_VERSION}`);
  const artifact = stagedArtifact();
  if (!artifact) {
    staged = null;
    set({ latest: chosen.version, stage: 'idle', error: null, releaseUrl: chosen.releaseUrl });
    return;
  }

  const expected = (await chosen.digests()).get(artifact.name);
  if (!expected) {
    if (chosen.source === 'private') throw new Error(`private build ${chosen.version} provides no digest for ${artifact.name}`);
    // A release without this build's flavor is news, not a failure: this installation is shown
    // the release page and updates by hand.
    staged = null;
    logWarn(`update: ${label} publishes no ${artifact.name}; offering the release page instead`);
    set({ latest: chosen.version, stage: 'idle', error: null, releaseUrl: chosen.releaseUrl });
    return;
  }
  await chosen.present(artifact.name);

  if (staged?.version === chosen.version && staged.digest === expected && (await fileDigest(staged.file)) === expected) {
    set({ latest: chosen.version, stage: 'ready', error: null, releaseUrl: chosen.releaseUrl });
    return;
  }
  staged = null;

  const carried = await adopt(chosen.version, artifact.name, expected);
  if (carried) {
    staged = { version: chosen.version, file: carried, kind: artifact.kind, target: artifact.target, digest: expected };
    set({ latest: chosen.version, stage: 'ready', error: null, releaseUrl: chosen.releaseUrl });
    logInfo(`update: ${label} was already staged and is ready to install`);
    return;
  }

  set({ latest: chosen.version, stage: 'downloading', error: null, releaseUrl: chosen.releaseUrl });
  const file = await chosen.stage(artifact.name, expected);
  staged = { version: chosen.version, file, kind: artifact.kind, target: artifact.target, digest: expected };
  set({ latest: chosen.version, stage: 'ready', error: null, releaseUrl: chosen.releaseUrl });
  logInfo(`update: ${label} is staged and ready to install`);
}

// ------------------------------------------------------------------ GitHub Latest

interface GithubRelease {
  version: string;
  /** The exact tag, `v2.2.7` or `2.2.7`, validated before it is ever put in a URL. */
  tag: string;
}

/** The last GitHub answer, reused until it is six hours old. */
let github: { at: number; release: GithubRelease | null; error: string | null; digests: Map<string, string> | null } | null = null;

async function githubRelease(): Promise<{ release: GithubRelease | null; error: string | null }> {
  if (github && Date.now() - github.at < GITHUB_RECHECK_MS) return github;
  try {
    github = { at: Date.now(), release: await latestGithubRelease(), error: null, digests: null };
  } catch (err) {
    github = { at: Date.now(), release: null, error: (err as Error).message, digests: null };
  }
  return github;
}

/**
 * The release GitHub marks Latest. `releases/latest` already excludes drafts and pre-releases;
 * the flags are checked again so a changed API cannot turn a pre-release into an update.
 */
async function latestGithubRelease(): Promise<GithubRelease | null> {
  const response = await get(LATEST_RELEASE_API, CHECK_TIMEOUT_MS, { accept: 'application/vnd.github+json' }, true);
  // Nothing has been promoted to Latest yet: nothing to offer, and nothing wrong.
  if (!response) return null;
  const body = (await response.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (body.draft !== false || body.prerelease !== false) throw new Error('the Latest release is not a published full release');
  const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
  const version = releaseVersion(tag);
  if (!version || !/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error('the Latest release has no usable version tag');
  return { version, tag };
}

function githubCandidate(release: GithubRelease): Candidate {
  return {
    version: release.version,
    source: 'github',
    releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${release.tag}`,
    digests: async () => {
      if (github?.release?.tag === release.tag && github.digests) return github.digests;
      const response = (await get(assetUrl(release.tag, CHECKSUMS_FILE), CHECK_TIMEOUT_MS))!;
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_CHECKSUMS_BYTES) throw new Error('the release checksum file is too large');
      const digests = parseDigests(body, 'the release checksum file');
      if (github?.release?.tag === release.tag) github.digests = digests;
      return digests;
    },
    present: async () => undefined,
    stage: (name, expected) => download(release, name, expected)
  };
}

/** One release asset of the fixed repository. Built here, never taken from a response body. */
function assetUrl(tag: string, name: string): string {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** GitHub serves release assets through redirects to its own content hosts, and only there. */
function githubHost(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' && (hostname === 'github.com' || hostname === 'api.github.com' || hostname.endsWith('.githubusercontent.com'));
}

async function get(url: string, timeout: number, headers: Record<string, string> = {}, missingIsNull = false): Promise<Response | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    headers: { 'user-agent': `paradigmeve/${APP_VERSION}`, ...headers }
  });
  if (response.url && !githubHost(response.url)) throw new Error('the update request was redirected off GitHub');
  if (missingIsNull && response.status === 404) return null;
  if (!response.ok) throw new Error(`${new URL(url).pathname.split('/').pop()} answered ${response.status}`);
  return response;
}

/**
 * Downloads one release artifact into staging, hashing it as it arrives. It stays `.part` until
 * it matches the release's published digest; anything else is deleted and staged as nothing.
 */
async function download(release: GithubRelease, name: string, expected: string): Promise<string> {
  const dir = stagingDir(release.version);
  await rm(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const partial = `${file}.part`;
  const response = (await get(assetUrl(release.tag, name), DOWNLOAD_TIMEOUT_MS))!;
  if (!response.body) throw new Error(`downloading ${name} returned no content`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_ARTIFACT_BYTES) return done(new Error(`${name} is larger than any release artifact`));
      hash.update(chunk);
      done(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(partial));
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  const digest = hash.digest('hex');
  if (digest !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${name} is not the published file: sha256 ${digest} instead of ${expected}`);
  }
  await rename(partial, file);
  return file;
}

/** Where one verified artifact is kept after being copied out of the feed or downloaded. */
function stagingDir(version: string): string {
  return path.join(app.getPath('userData'), 'updates', version);
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Reuse is allowed only after rehashing against the chosen release's current checksums. */
async function adopt(version: string, name: string, expected: string): Promise<string | null> {
  const file = path.join(stagingDir(version), name);
  if (!existsSync(file)) return null;
  try {
    await regularPrivateFile(file, 'staged update');
    if ((await fileDigest(file)) !== expected) throw new Error('it does not match the private build digest');
    return file;
  } catch (err) {
    logWarn(`update: staged ${version} cannot be reused (${(err as Error).message}); staging it again`);
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
    await regularPrivateFile(ready.file, 'staged update');
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
        ? `update: installing ${ready.version} now; the app starts itself again as the new version`
        : `update: ${ready.version} handed over; the next start of this app is the new version`
    );
  } catch (err) {
    logWarn(`could not apply the staged ${ready.version} update: ${(err as Error).message}`);
  }
}

/** Test seam: forgets process-local updater state. */
export function resetUpdateForTests(): void {
  status = CLEAR;
  staged = null;
  pass = null;
  runAfterInstall = false;
  github = null;
  listeners.clear();
}
