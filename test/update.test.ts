/**
 * Private updater contract.
 *
 * Executable update authority is local-only: a direct version directory under the private feed,
 * its SHA256SUMS.txt, and the fixed platform artifact named by this process. Nothing in this suite
 * supplies a working network fixture; `fetch` is a tripwire so a future public fallback fails the
 * tests immediately.
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
const WINDOWS_ASSET = `ParadigmEve-Setup-${process.arch}.exe`;
const APPIMAGE_ASSET = `ParadigmEve-Linux-${process.arch}.AppImage`;
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

let publicFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'cos-private-update-'));
  packaged = true;
  spawned.length = 0;
  relaunched.length = 0;
  delete process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR;
  resetUpdateForTests();
  publicFetch = vi.fn(async () => {
    throw new Error('the private updater must never use public/network fetch');
  });
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
  it('uses the user-data private feed by default, and no feed means idle with no network fallback', async () => {
    expect(privateUpdateRoot()).toBe(defaultFeedRoot());
    expect(updateStatus().checkedAt).toBeNull();

    await checkForUpdates();

    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle', error: null });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it('never calls a public fake fetch even while staging a valid newer private build', async () => {
    privateBuild();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(publicFetch).not.toHaveBeenCalled();
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
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('rejects a relative PARADIGMEVE_PRIVATE_UPDATE_DIR instead of resolving it against cwd', async () => {
    process.env.PARADIGMEVE_PRIVATE_UPDATE_DIR = 'relative/private-updates';
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/PARADIGMEVE_PRIVATE_UPDATE_DIR.*absolute local path/i);
    expect(markInstallOnQuit()).toBe(false);
    expect(publicFetch).not.toHaveBeenCalled();
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
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the checksum file tries to authorize a path outside its release directory', async () => {
    const body = 'private bytes';
    privateBuild({ body, sums: `${sha256(body)}  ../${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toMatch(/checksum file contains a path/i);
    expect(markInstallOnQuit()).toBe(false);
    expect(publicFetch).not.toHaveBeenCalled();
  });
});

describe('which installations can apply a private build', () => {
  it('takes the Windows installer and Linux AppImage, and nothing else', () => {
    expect(stagedArtifact('win32', 'x64')).toMatchObject({ name: 'ParadigmEve-Setup-x64.exe', kind: 'installer' });
    expect(stagedArtifact('linux', 'arm64', '/opt/cos.AppImage')).toMatchObject({
      name: 'ParadigmEve-Linux-arm64.AppImage',
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
    expect(updateStatus().error).toContain(`provides no digest for ${WINDOWS_ASSET}`);
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
        expect(publicFetch).not.toHaveBeenCalled();

        privateBuild();
        repeat!();
        await checkForUpdates();
        expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready' });
        expect(publicFetch).not.toHaveBeenCalled();
      });
    } finally {
      interval.mockRestore();
    }
  });
});
