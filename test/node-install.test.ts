import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NODE_LTS_VERSION,
  downloadNodeInstaller,
  nodeInstallDialogOptions,
  nodeInstallerFor,
  offerNodeLtsInstall
} from '../src/main/node-install.js';

it('pins Node.js 24 LTS exactly, since "LTS" alone now means Node 26', () => {
  expect(NODE_LTS_VERSION).toMatch(/^24\.\d+\.\d+$/);
  for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64']] as const) {
    const installer = nodeInstallerFor(platform, arch)!;
    expect(installer.url).toBe(`https://nodejs.org/dist/v${NODE_LTS_VERSION}/${installer.file}`);
    expect(installer.file).toContain(`v${NODE_LTS_VERSION}`);
    expect(installer.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(nodeInstallerFor('linux', 'x64')).toBeNull();
});

it('keeps an installer only when it matches the SHA-256 pinned for that release', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-node-install-'));
  const installer = nodeInstallerFor('win32', 'x64')!;
  const tampered = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  await expect(downloadNodeInstaller(dir, installer, tampered as typeof fetch)).rejects.toThrow(/SHA-256/);
  expect(await fs.readdir(dir)).toEqual([]);

  const bytes = Buffer.from('a real installer');
  const matching = { ...installer, sha256: createHash('sha256').update(bytes).digest('hex') };
  const file = await downloadNodeInstaller(dir, matching, (async () => new Response(bytes)) as typeof fetch);
  expect(path.basename(file)).toBe(installer.file);
  expect(await fs.readFile(file)).toEqual(bytes);
});

it('asks first, downloads only on yes, and opens the installer for the user to finish', async () => {
  const options = nodeInstallDialogOptions();
  expect(options.buttons[options.cancelId]).toBe('Not now');
  expect(options.defaultId).toBe(options.cancelId);
  expect(options.detail).toContain(NODE_LTS_VERSION);
  expect(options.detail).toMatch(/SHA-256/);

  const download = vi.fn(async () => 'C:/downloads/node.msi');
  const open = vi.fn(async () => undefined);
  expect(await offerNodeLtsInstall({ confirm: async () => false, download, open, platform: 'win32', arch: 'x64' })).toBe('declined');
  expect(download).not.toHaveBeenCalled();

  expect(await offerNodeLtsInstall({ confirm: async () => true, download, open, platform: 'win32', arch: 'x64' })).toBe('opened');
  expect(open).toHaveBeenCalledWith('C:/downloads/node.msi');

  expect(await offerNodeLtsInstall({ confirm: async () => true, download, open, platform: 'linux', arch: 'x64' })).toBe('unsupported');
});
