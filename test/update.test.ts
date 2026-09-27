/**
 * Updater contract.
 *
 * Two sources may authorize an update: a direct version directory under the private local feed,
 * and the release marked Latest in absol89/ParadigmEve. `fetch` is a fake GitHub that answers
 * only that repository's URLs; by default it has no Latest release, and any other URL throws, so
 * a request anywhere else fails the tests immediately.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: Array<{ file: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    spawned.push({ file, args });
    return { on: () => undefined, unref: () => undefined };
  }
}));

let userData = '';
let packaged = true;
const relaunched: Array<{ execPath?: string }> = [];
vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    get isPackaged() {
      return packaged;
    },
    relaunch: (options: { execPath?: string }) => relaunched.push(options)
  }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: () => undefined }));

const { APP_VERSION } = await import('../src/main/version.js');
const { isNewer } = await import('../src/shared/types.js');
const {
  applyStagedUpdate,
  checkForUpdates,
  markInstallOnQuit,
  privateUpdateRoot,
  releaseVersion,
  resetUpdateForTests,
  stagedArtifact,
  startUpdateChecks,
  updateStatus
} = await import('../src/main/update.js');

const NEXT = '99.0.0';
const REPLACEMENT = '99.0.1';
// Tests run as the local default flavor, debug, so they take `-debug` artifacts.
const WINDOWS_ASSET = `ParadigmEve-Setup-${process.arch}-debug.exe`;
const FUTURE_WINDOWS_ASSET = `ParadigmEve-Windows-${process.arch}-debug.exe`;
const APPIMAGE_ASSET = `ParadigmEve-Linux-${process.arch}-debug.AppImage`;
const LATEST_API = 'https://api.github.com/repos/absol89/ParadigmEve/releases/latest';
const DOWNLOADS = 'https://github.com/absol89/ParadigmEve/releases/download/';
const originalPrivateUpdateDir = process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR;

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');
const defaultFeedRoot = (): string => path.join(userData, 'private-updates');
const stagedPath = (version = NEXT, name = WINDOWS_ASSET): string => path.join(userData, 'updates', version, name);

interface PrivateBuildOptions {
  version?: string;
  root?: string;
  body?: string;
  sums?: string | false;
  omit?: string[];
}

/** Writes the same fixed-name feed shape a local private packaging step can produce. */
function privateBuild(options: PrivateBuildOptions = {}) {
  const version = options.version ?? NEXT;
  const root = options.root ?? defaultFeedRoot();
  const body = options.body ?? `private build ${version}`;
  const dir = path.join(root, version);
  mkdirSync(dir, { recursive: true });

  const assets = [WINDOWS_ASSET, APPIMAGE_ASSET];
  for (const name of assets) {
    if (!options.omit?.includes(name)) writeFileSync(path.join(dir, name), body);
  }
  if (options.sums !== false) {
    const sums =
      options.sums ?? assets.map((name) => `${sha256(body)}  ${name}`).join('\n') + '\n';
    writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums);
  }
  return { root, dir, version, body };
}

/** Runs a pass as an installation of the given shape, then restores the host process facts. */
async function asPlatform(platform: string, appImage: string | undefined, run: () => Promise<void>): Promise<void> {
  const realPlatform = process.platform;
  const realAppImage = process.env.APPIMAGE;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  }
}

interface FakeRelease {
  tag: string;
  body?: string;
  sums?: string;
  omit?: string[];
  draft?: boolean;
  prerelease?: boolean;
  /** Where the asset redirect lands; GitHub's own content host unless a test says otherwise. */
  landsOn?: string;
}

/** What the fake GitHub has marked Latest; null means nothing has been promoted yet. */
let latest: FakeRelease | Error | null = null;
let publicFetch: ReturnType<typeof vi.fn>;

function answer(body: BodyInit | null, status: number, url: string): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

async function fakeGithub(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url === LATEST_API) {
    if (latest instanceof Error) throw latest;
    if (!latest) return answer(JSON.stringify({ message: 'Not Found' }), 404, url);
    return answer(JSON.stringify({ tag_name: latest.tag, draft: latest.draft ?? false, prerelease: latest.prerelease ?? false }), 200, url);
  }
  if (latest && !(latest instanceof Error) && url.startsWith(`${DOWNLOADS}${latest.tag}/`)) {
    const name = decodeURIComponent(url.slice(`${DOWNLOADS}${latest.tag}/`.length));
    const body = latest.body ?? `github build ${latest.tag}`;
    const landed = `${latest.landsOn ?? 'https://release-assets.githubusercontent.com/assets/'}${name}`;
    if (name === 'SHA256SUMS.txt') {
      const release = latest;
      const sums = release.sums ?? [WINDOWS_ASSET, APPIMAGE_ASSET].filter((asset) => !release.omit?.includes(asset))
        .map((asset) => `${sha256(body)}  ${asset}`).join('\n') + '\n';
      return answer(sums, 200, landed);
    }
    if (latest.omit?.includes(name)) return answer('Not Found', 404, landed);
    return answer(body, 200, landed);
  }
  throw new Error(`the updater fetched a URL outside absol89/ParadigmEve: ${url}`);
}

/** Every request other than the Latest-release question itself. */
const assetFetches = (): string[] => publicFetch.mock.calls.map(([url]) => String(url)).filter((url) => url !== LATEST_API);

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'cos-private-update-'));
  packaged = true;
  spawned.length = 0;
  relaunched.length = 0;
  delete process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR;
  resetUpdateForTests();
  latest = null;
  publicFetch = vi.fn(fakeGithub);
  vi.stubGlobal('fetch', publicFetch);
});

afterEach(() => {
  if (originalPrivateUpdateDir === undefined) delete process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR;
  else process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR = originalPrivateUpdateDir;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(userData, { recursive: true, force: true });
});

describe('private update authority', () => {
  it('uses the user-data private feed by default, and no feed and no GitHub Latest means idle', async () => {
    expect(privateUpdateRoot()).toBe(defaultFeedRoot());
    expect(updateStatus().checkedAt).toBeNull();

    await checkForUpdates();

    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle', error: null });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    expect(publicFetch.mock.calls.map(([url]) => String(url))).toEqual([LATEST_API]);
    expect(spawned).toEqual([]);
  });

  it('stages a valid newer private build without downloading anything', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(assetFetches()).toEqual([]);
  });

  it('honors one explicit absolute private feed and never falls back to the default feed', async () => {
    privateBuild({ version: REPLACEMENT });
    const selected = path.join(userData, 'selected-private-feed');
    privateBuild({ root: selected, version: NEXT });
    process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR = selected;

    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(privateUpdateRoot()).toBe(path.resolve(selected));
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready' });
    expect(existsSync(stagedPath(NEXT))).toBe(true);
    expect(existsSync(stagedPath(REPLACEMENT))).toBe(false);
    expect(assetFetches()).toEqual([]);
  });

  it('rejects a relative PARADIGMEVE_PRIVATE_UPDATE_DIR instead of resolving it against cwd', async () => {
    process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR = 'relative/private-updates';
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/PARADIGMEVE_PRIVATE_UPDATE_DIR.*absolute local path/i);
    expect(markInstallOnQuit()).toBe(false);
    expect(assetFetches()).toEqual([]);
  });

  it('ignores a symlinked/junction release directory so it cannot escape the selected root', async () => {
    const outside = path.join(userData, 'outside-release');
    privateBuild({ root: outside, version: NEXT });
    mkdirSync(defaultFeedRoot(), { recursive: true });
    const link = path.join(defaultFeedRoot(), NEXT);
    try {
      // Junctions do not require Windows Developer Mode and still exercise the symlink fence.
      symlinkSync(path.join(outside, NEXT), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return;
      throw error;
    }

    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'idle', error: null });
    expect(markInstallOnQuit()).toBe(false);
    expect(assetFetches()).toEqual([]);
  });

  it('fails closed when the checksum file tries to authorize a path outside its release directory', async () => {
    const body = 'private bytes';
    privateBuild({ body, sums: `${sha256(body)}  ../${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/checksum file contains a path/i);
    expect(markInstallOnQuit()).toBe(false);
    expect(assetFetches()).toEqual([]);
  });
});

describe('which installations can apply a private build', () => {
  it('takes the Windows installer and Linux AppImage of its own flavor, and nothing else', () => {
    expect(stagedArtifact('win32', 'x64')).toMatchObject({ name: 'ParadigmEve-Setup-x64-debug.exe', kind: 'installer' });
    expect(stagedArtifact('win32', 'x64', undefined, true, 'shipping')).toMatchObject({ name: 'ParadigmEve-Setup-x64.exe' });
    expect(stagedArtifact('win32', 'arm64', undefined, true, 'dev')).toMatchObject({ name: 'ParadigmEve-Setup-arm64-dev.exe' });
    expect(stagedArtifact('linux', 'arm64', '/opt/cos.AppImage')).toMatchObject({
      name: 'ParadigmEve-Linux-arm64-debug.AppImage',
      kind: 'appimage',
      target: '/opt/cos.AppImage'
    });
    expect(stagedArtifact('linux', 'x64', undefined)).toBeNull();
    expect(stagedArtifact('darwin', 'arm64')).toBeNull();
    expect(stagedArtifact('win32', 'ia32')).toBeNull();
  });

  it('reports a newer private build but never stages it for a Linux package install', async () => {
    privateBuild();
    await asPlatform('linux', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(markInstallOnQuit()).toBe(false);
    expect(existsSync(path.join(userData, 'updates'))).toBe(false);
  });

  it('never stages a packaged installer for an unpackaged development run', async () => {
    privateBuild();
    packaged = false;
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(markInstallOnQuit()).toBe(false);
    expect(existsSync(path.join(userData, 'updates'))).toBe(false);
  });
});

describe('finding a newer private build', () => {
  it('accepts stable release-version names and refuses prerelease/non-version names', () => {
    expect(releaseVersion('v2.1.0')).toBe('2.1.0');
    expect(releaseVersion('2.1.0')).toBe('2.1.0');
    expect(releaseVersion('v2.1.0-rc.1')).toBeNull();
    expect(releaseVersion(null)).toBeNull();
  });

  it('compares versions numerically and ignores a feed version that is not newer', async () => {
    expect(isNewer('2.0.10', '2.0.9')).toBe(true);
    expect(isNewer('2.0.9', '2.0.10')).toBe(false);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);

    privateBuild({ version: APP_VERSION });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'idle', error: null });
    expect(existsSync(path.join(userData, 'updates'))).toBe(false);
  });
});

describe('staging and applying verified local bytes', () => {
  it('stages a valid newer Windows build and installs exactly those local bytes on quit', async () => {
    const { body } = privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());

    const staged = stagedPath();
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(readFileSync(staged, 'utf8')).toBe(body);
    expect(existsSync(`${staged}.part`)).toBe(false);

    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: staged, args: ['/S', '--updated'] }]);
  });

  it('can take the future Windows filename when that is the authorized private artifact', async () => {
    const body = 'future private build';
    const { dir } = privateBuild({ body, sums: `${sha256(body)}  ${FUTURE_WINDOWS_ASSET}\n` });
    rmSync(path.join(dir, WINDOWS_ASSET), { force: true });
    writeFileSync(path.join(dir, FUTURE_WINDOWS_ASSET), body);
    await asPlatform('win32', undefined, () => checkForUpdates());

    const futureStaged = stagedPath(NEXT, FUTURE_WINDOWS_ASSET);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(readFileSync(futureStaged, 'utf8')).toBe(body);
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: futureStaged, args: ['/S', '--updated'] }]);
  });

  it('fails closed when artifact bytes do not match the local checksum authority', async () => {
    const body = 'same-size-private-build';
    privateBuild({ body, sums: `${sha256('different-private-build')}  ${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/not the private manifest file/i);
    expect(markInstallOnQuit()).toBe(false);
    expect(existsSync(`${stagedPath()}.part`)).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('fails closed when SHA256SUMS.txt is missing', async () => {
    privateBuild({ sums: false });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/SHA256SUMS\.txt.*missing/i);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('fails closed when the checksum authority names the artifact but the artifact is missing', async () => {
    privateBuild({ omit: [WINDOWS_ASSET] });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/private update artifact.*missing/i);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('fails closed when SHA256SUMS.txt omits the platform artifact digest', async () => {
    privateBuild({ sums: `${sha256('x')}  ParadigmEve-Extension.zip\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toContain(WINDOWS_ASSET);
    expect(updateStatus().error).toContain(FUTURE_WINDOWS_ASSET);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('rechecks staged bytes at installer handoff and refuses post-staging tampering', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    writeFileSync(stagedPath(), 'changed after staging');

    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('replaces a running AppImage with the verified private build without spawning an installer', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'old AppImage');
    const { body } = privateBuild();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(updateStatus().stage).toBe('ready');
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(existsSync(`${live}.new`)).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe('staged authority across checks and process-local resets', () => {
  it('joins concurrent checks instead of racing duplicate staging work', async () => {
    privateBuild();
    await asPlatform('win32', undefined, async () => {
      await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdates()]);
    });
    expect(updateStatus().stage).toBe('ready');
    expect(readFileSync(stagedPath(), 'utf8')).toBe(`private build ${NEXT}`);
  });

  it('reuses a previously staged file after a process-local reset when the manifest still authorizes it', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    const before = statSync(stagedPath()).mtimeMs;

    resetUpdateForTests();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(statSync(stagedPath()).mtimeMs).toBe(before);
  });

  it('restages a corrupted carried file from the still-authoritative local source', async () => {
    const { body } = privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    writeFileSync(stagedPath(), 'corrupted staged copy');

    resetUpdateForTests();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(readFileSync(stagedPath(), 'utf8')).toBe(body);
  });

  it('withdraws executable authority when the selected private release disappears', async () => {
    const release = privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(true);

    // A later authority pass wins. Removing the release revokes the in-memory staged authority.
    rmSync(release.dir, { recursive: true, force: true });
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'idle', error: null });
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('retires an older staged installer before a newer replacement with invalid bytes fails', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');

    const replacementBody = 'replacement bytes';
    privateBuild({
      version: REPLACEMENT,
      body: replacementBody,
      sums: `${sha256('not replacement bytes')}  ${WINDOWS_ASSET}\n`
    });
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('keeps only the newest successfully staged private version', async () => {
    privateBuild({ version: '98.0.0' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual(['98.0.0']);

    resetUpdateForTests();
    privateBuild({ version: NEXT });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual([NEXT]);
  });

  it('hands one staged update over exactly once', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    await applyStagedUpdate();
    expect(spawned).toHaveLength(1);
  });
});

describe('installing on explicit request', () => {
  it('asks the Windows installer to relaunch after an Install press', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: stagedPath(), args: ['/S', '--updated', '--force-run'] }]);
  });

  it('relaunches an AppImage itself after an Install press', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'old AppImage');
    const { body } = privateBuild();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(markInstallOnQuit()).toBe(true);
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(relaunched).toEqual([{ execPath: live }]);
  });

  it('refuses an Install press when no private build is staged', async () => {
    await checkForUpdates();
    expect(markInstallOnQuit()).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('does not carry the relaunch request into a later ordinary handoff', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();

    resetUpdateForTests();
    spawned.length = 0;
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: stagedPath(), args: ['/S', '--updated'] }]);
  });
});

describe('local polling', () => {
  it('starts immediately and repeats on an unreferenced 60-second timer', async () => {
    const unref = vi.fn();
    let repeat: (() => void) | undefined;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(60_000);
      repeat = callback;
      return { unref };
    }) as unknown as typeof setInterval);
    try {
      // This is about the timer, so pin a platform that stages installers. A Linux package install
      // deliberately never stages (see "never stages it for a Linux package install").
      await asPlatform('win32', undefined, async () => {
        startUpdateChecks();
        await checkForUpdates();
        expect(updateStatus().checkedAt).toBeGreaterThan(0);
        expect(unref).toHaveBeenCalledOnce();
        expect(assetFetches()).toEqual([]);

        privateBuild();
        repeat!();
        await checkForUpdates();
        expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready' });
        expect(assetFetches()).toEqual([]);
        // The minute timer is for the local feed; GitHub was asked once and is not asked again.
        expect(publicFetch.mock.calls.filter(([url]) => String(url) === LATEST_API)).toHaveLength(1);
      });
    } finally {
      interval.mockRestore();
    }
  });
});

describe('the GitHub Latest release of absol89/ParadigmEve', () => {
  it('stages this flavor of the Windows installer from the Latest release and installs exactly those bytes', async () => {
    latest = { tag: `v${NEXT}`, body: 'published installer' };
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({
      latest: NEXT,
      stage: 'ready',
      error: null,
      releaseUrl: `https://github.com/absol89/ParadigmEve/releases/tag/v${NEXT}`
    });
    expect(assetFetches()).toEqual([`${DOWNLOADS}v${NEXT}/SHA256SUMS.txt`, `${DOWNLOADS}v${NEXT}/${WINDOWS_ASSET}`]);
    expect(readFileSync(stagedPath(), 'utf8')).toBe('published installer');
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: stagedPath(), args: ['/S', '--updated', '--force-run'] }]);
  });

  it('uses the future Windows asset when a later release publishes only that authorized name', async () => {
    const body = 'future published installer';
    latest = { tag: `v${NEXT}`, body, sums: `${sha256(body)}  ${FUTURE_WINDOWS_ASSET}\n` };
    await asPlatform('win32', undefined, () => checkForUpdates());

    const futureStaged = stagedPath(NEXT, FUTURE_WINDOWS_ASSET);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(assetFetches()).toEqual([`${DOWNLOADS}v${NEXT}/SHA256SUMS.txt`, `${DOWNLOADS}v${NEXT}/${FUTURE_WINDOWS_ASSET}`]);
    expect(readFileSync(futureStaged, 'utf8')).toBe(body);
  });

  it('prefers the future Windows asset when both Windows names are checksum-authorized', async () => {
    const body = 'bridge release bytes';
    latest = {
      tag: `v${NEXT}`,
      body,
      sums: `${sha256(body)}  ${WINDOWS_ASSET}\n${sha256(body)}  ${FUTURE_WINDOWS_ASSET}\n`
    };
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(assetFetches()).toEqual([`${DOWNLOADS}v${NEXT}/SHA256SUMS.txt`, `${DOWNLOADS}v${NEXT}/${FUTURE_WINDOWS_ASSET}`]);
  });

  it('asks only the fixed repository, whatever the release says about itself', async () => {
    latest = { tag: `v${NEXT}` };
    await asPlatform('win32', undefined, () => checkForUpdates());
    for (const [url] of publicFetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/(api\.github\.com\/repos|github\.com)\/absol89\/ParadigmEve\/releases\//);
    }
  });

  it('never offers a draft or a pre-release, even if the Latest endpoint returned one', async () => {
    for (const flags of [{ prerelease: true }, { draft: true }]) {
      resetUpdateForTests();
      publicFetch.mockClear();
      latest = { tag: `v${NEXT}`, ...flags };
      await asPlatform('win32', undefined, () => checkForUpdates());
      expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
      expect(updateStatus().error).toMatch(/not a published full release/);
      expect(assetFetches()).toEqual([]);
      expect(markInstallOnQuit()).toBe(false);
    }
  });

  it('refuses a tag that is not a plain release version', async () => {
    latest = { tag: 'v99.0.0-rc.1' };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/no usable version tag/);
    expect(assetFetches()).toEqual([]);
  });

  it('fails closed and keeps nothing when the downloaded bytes are not the published digest', async () => {
    latest = { tag: `v${NEXT}`, sums: `${sha256('something else')}  ${WINDOWS_ASSET}\n` };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/is not the published file/);
    expect(existsSync(stagedPath())).toBe(false);
    expect(existsSync(`${stagedPath()}.part`)).toBe(false);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('refuses an asset redirect that lands off GitHub', async () => {
    latest = { tag: `v${NEXT}`, landsOn: 'https://mirror.example.com/' };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/redirected off GitHub/);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('offers the release page when the Latest release has no artifact of this build flavor', async () => {
    latest = { tag: `v${NEXT}`, omit: [WINDOWS_ASSET] };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({
      latest: NEXT,
      stage: 'idle',
      error: null,
      releaseUrl: `https://github.com/absol89/ParadigmEve/releases/tag/v${NEXT}`
    });
    expect(assetFetches()).toEqual([`${DOWNLOADS}v${NEXT}/SHA256SUMS.txt`]);
    expect(markInstallOnQuit()).toBe(false);
  });

  it('reports a newer release to macOS with its page and downloads nothing', async () => {
    latest = { tag: `v${NEXT}` };
    await asPlatform('darwin', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', releaseUrl: expect.stringContaining('/releases/tag/v') });
    expect(assetFetches()).toEqual([]);
  });

  it('ignores a Latest release that is not newer than this app', async () => {
    latest = { tag: `v${APP_VERSION}` };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'idle', error: null, releaseUrl: null });
    expect(assetFetches()).toEqual([]);
  });

  it('takes the higher of the local feed and GitHub, and keeps the local build on a tie', async () => {
    privateBuild({ version: NEXT, body: 'local bytes' });
    latest = { tag: `v${REPLACEMENT}`, body: 'github bytes' };
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: REPLACEMENT, stage: 'ready' });
    expect(readFileSync(stagedPath(REPLACEMENT), 'utf8')).toBe('github bytes');

    resetUpdateForTests();
    publicFetch.mockClear();
    rmSync(path.join(userData, 'updates'), { recursive: true, force: true });
    privateBuild({ version: REPLACEMENT, body: 'local bytes' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: REPLACEMENT, stage: 'ready', releaseUrl: null });
    expect(readFileSync(stagedPath(REPLACEMENT), 'utf8')).toBe('local bytes');
    expect(assetFetches()).toEqual([]);
  });

  it('never lets a GitHub failure hide a local build, and reports it when there is nothing else', async () => {
    latest = new Error('network unreachable');
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });

    resetUpdateForTests();
    rmSync(defaultFeedRoot(), { recursive: true, force: true });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/could not check GitHub releases: network unreachable/);
  });

  it('asks GitHub again only after six hours', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.UTC(2026, 8, 27);
    now.mockReturnValue(start);
    const asked = () => publicFetch.mock.calls.filter(([url]) => String(url) === LATEST_API).length;
    await asPlatform('win32', undefined, async () => {
      await checkForUpdates();
      now.mockReturnValue(start + 6 * 60 * 60_000 - 1);
      await checkForUpdates();
      expect(asked()).toBe(1);
      latest = { tag: `v${NEXT}` };
      now.mockReturnValue(start + 6 * 60 * 60_000);
      await checkForUpdates();
      expect(asked()).toBe(2);
      expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready' });
    });
  });
});
