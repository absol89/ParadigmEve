import { promises as fs } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { craftZip, mockReleaseServer, type MockRelease } from './helpers-release.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireFileProvider, chooseProviderRelease, ProviderUnavailableError, setProviderAcquireOptionsForTests } from '../src/main/file-provider-install.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const mock = mockReleaseServer();
let endpoints: { apiBase: string; downloadBase: string };
let dir = '';

beforeAll(async () => { endpoints = await mock.start(); });
afterAll(async () => { setProviderAcquireOptionsForTests({}); await mock.stop(); });
beforeEach(async () => {
  dir = await makeTempDir('eve-provider-install-');
  mock.releases.clear();
  mock.requests.length = 0;
  setProviderAcquireOptionsForTests({ ...endpoints, platform: 'win32-x64' });
});
afterEach(async () => { await removeTempDir(dir); });

function publish(slug: string, version: string, overrides: Partial<MockRelease['assets'][number]> = {}, bytes = craftZip(slug)) {
  mock.releases.set(`storytold/${slug}`, {
    tag: `v${version}`,
    assets: [
      { name: `${slug}-${version}-windows-x64-portable.zip`, bytes, ...overrides },
      { name: `${slug}-${version}-windows-arm64-portable.zip`, bytes: craftZip(slug) },
      { name: `${slug}-cli-${version}-macos-universal.zip`, bytes: craftZip(slug) },
      { name: `${slug}-${version}-linux-x86_64.tar.gz`, bytes: new Uint8Array([1, 2, 3]) }
    ]
  });
}

describe('file provider acquisition', () => {
  it.each([['gridcraft', '0.6.1'], ['wordcraft', '0.7.0']])('installs only this machine\'s verified %s build through the same data-driven flow', async (slug, version) => {
    publish(slug, version);
    const launch = await acquireFileProvider(`artcraft.${slug}`, dir, { expectVersion: version });
    expect(launch).toMatchObject({ args: ['mcp'], version, license: 'Apache-2.0' });
    expect(path.basename(launch.command)).toBe(`${slug}-cli.exe`);
    expect(launch.command.startsWith(path.join(dir, 'app') + path.sep)).toBe(true);
    expect(await fs.readFile(launch.command, 'utf8')).toBe(`fake ${slug} cli`);
    // Metadata, then exactly one download: the Windows x64 zip. No other platform's build.
    expect(mock.requests).toEqual([
      `/api/repos/storytold/${slug}/releases/latest`,
      `/dl/storytold/${slug}/releases/download/v${version}/${slug}-${version}-windows-x64-portable.zip`
    ]);
  });

  it('picks the macOS CLI build on a Mac and refuses Linux without any request', async () => {
    publish('deckcraft', '0.6.1');
    const mac = await chooseProviderRelease('artcraft.deckcraft', { platform: 'darwin-arm64' });
    expect(mac.asset.name).toBe('deckcraft-cli-0.6.1-macos-universal.zip');
    mock.requests.length = 0;
    await expect(chooseProviderRelease('artcraft.deckcraft', { platform: 'linux-x64' })).rejects.toThrow(ProviderUnavailableError);
    await expect(chooseProviderRelease('artcraft.deckcraft', { platform: null })).rejects.toThrow(/no build|does not publish/i);
    expect(mock.requests).toEqual([]);
  });

  it('refuses a release that publishes no checksum, before downloading anything', async () => {
    publish('gridcraft', '0.6.1', { digest: null });
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/publishes no SHA-256 checksum/);
    expect(mock.requests.some((url) => url.startsWith('/dl/'))).toBe(false);
  });

  it('refuses bytes that do not match the published digest and leaves nothing installed', async () => {
    publish('gridcraft', '0.6.1', { digest: `sha256:${'0'.repeat(64)}` });
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/does not match the SHA-256/);
    await expect(fs.readdir(path.join(dir, 'app'))).rejects.toThrow();
  });

  it('refuses a newer release than the one the user approved', async () => {
    publish('gridcraft', '0.7.0');
    await expect(acquireFileProvider('artcraft.gridcraft', dir, { expectVersion: '0.6.1' })).rejects.toThrow(/newer release \(0\.7\.0\) after you approved 0\.6\.1/);
    expect(mock.requests.some((url) => url.startsWith('/dl/'))).toBe(false);
  });

  it('refuses pre-releases, oversized downloads, traversal archives and archives without the CLI', async () => {
    mock.releases.set('storytold/gridcraft', { tag: 'v0.6.1', prerelease: true, assets: [{ name: 'gridcraft-0.6.1-windows-x64-portable.zip', bytes: craftZip('gridcraft') }] });
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/no stable release/);

    const real = craftZip('gridcraft');
    publish('gridcraft', '0.6.1', { size: real.length - 10 });
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/larger than expected|does not match/);

    publish('gridcraft', '0.6.1', {}, zipSync({ '../evil.exe': strToU8('x'), 'gridcraft-cli.exe': strToU8('x') }));
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/unsafe archive path/);

    publish('gridcraft', '0.6.1', {}, zipSync({ 'gridcraft/gridcraft.exe': strToU8('only the desktop app') }));
    await expect(acquireFileProvider('artcraft.gridcraft', dir)).rejects.toThrow(/exactly one gridcraft-cli\.exe/);
  });
});
