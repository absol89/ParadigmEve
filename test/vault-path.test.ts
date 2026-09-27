import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

const electronState = vi.hoisted(() => ({ isPackaged: false, appPath: '' }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronState.isPackaged; },
    getAppPath: () => electronState.appPath
  }
}));

let base: string;
let appPath: string;
let vault: string;
let outside: string;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

beforeEach(async () => {
  vi.resetModules();
  base = await makeTempDir('eve-vault-path-');
  appPath = path.join(base, 'app');
  vault = path.join(appPath, 'docs', 'vault');
  outside = path.join(base, 'outside');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await fs.mkdir(path.join(vault, 'nested'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(vault, 'README.md'), '# Current manual\n');
  await fs.writeFile(path.join(vault, '02-runtime.md'), '# Runtime\n');
  await fs.writeFile(path.join(vault, 'notes.txt'), 'not part of the manual\n');
  await fs.writeFile(path.join(vault, '.obsidian', 'workspace.json'), '{}');
  await fs.writeFile(path.join(vault, 'nested', 'hidden.md'), '# hidden\n');
  await fs.writeFile(path.join(outside, 'secret.md'), '# outside\n');
  electronState.isPackaged = false;
  electronState.appPath = appPath;
});

afterEach(async () => {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
  await removeTempDir(base);
});

it('lists and reads only current top-level Markdown pages', async () => {
  const { listVaultManualPages, readVaultManualText, resolveVaultManualReadPath } = await import('../src/main/vault-path.js');
  const pages = await listVaultManualPages();
  const rootReal = await awaitReal(vault);
  expect(pages.map((page) => page.name)).toEqual(['README.md', '02-runtime.md']);
  expect(pages.every((page) => path.dirname(page.real) === rootReal)).toBe(true);

  const root = await resolveVaultManualReadPath('/paradigmeve-manual');
  expect(root?.real).toBe(rootReal);
  const readme = await resolveVaultManualReadPath('/paradigmeve-manual/README.md');
  expect(readme?.virtual).toBe('/paradigmeve-manual/README.md');

  const manual = await readVaultManualText();
  expect(manual).toContain('# Current manual');
  expect(manual).toContain('# Runtime');
  expect(manual).not.toMatch(/notes\.txt|workspace\.json|# hidden/);
});

it('fails closed on traversal, nested paths, non-Markdown files, and symlink escapes', async () => {
  const { resolveVaultManualReadPath } = await import('../src/main/vault-path.js');
  for (const requested of [
    '/paradigmeve-manual/../secret.md',
    '/paradigmeve-manual/nested/hidden.md',
    '/paradigmeve-manual/notes.txt'
  ]) {
    await expect(resolveVaultManualReadPath(requested)).rejects.toThrow();
  }

  const escape = path.join(vault, 'escape.md');
  await fs.symlink(outside, escape, DIR_LINK);
  await expect(resolveVaultManualReadPath('/paradigmeve-manual/escape.md')).rejects.toThrow(/outside/i);
});

it('expands only flat manual globs and never delegates nested manual patterns', async () => {
  const { expandVaultManualReadGlob } = await import('../src/main/vault-path.js');
  expect(await expandVaultManualReadGlob('/paradigmeve-manual/*.md')).toEqual([
    '/paradigmeve-manual/README.md',
    '/paradigmeve-manual/02-runtime.md'
  ]);
  expect(await expandVaultManualReadGlob('/paradigmeve-manual/0?-runtime.md')).toEqual([
    '/paradigmeve-manual/02-runtime.md'
  ]);
  await expect(expandVaultManualReadGlob('/paradigmeve-manual/**/*.md')).rejects.toThrow(/top-level/i);
  expect(await expandVaultManualReadGlob('/workspace/*.md')).toBeNull();
});

it('uses the packaged resources Vault when Electron is packaged', async () => {
  const resources = path.join(base, 'resources');
  const packagedVault = path.join(resources, 'docs', 'vault');
  await fs.mkdir(packagedVault, { recursive: true });
  await fs.writeFile(path.join(packagedVault, 'README.md'), '# Packaged manual\n');
  electronState.isPackaged = true;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  const { readVaultManualText, vaultManualDirectory } = await import('../src/main/vault-path.js');
  expect(vaultManualDirectory()).toBe(packagedVault);
  expect(await readVaultManualText()).toContain('# Packaged manual');
});

it('synchronizes a current managed manual mirror under AppData without touching unrelated files', async () => {
  const userData = path.join(base, 'user-data');
  const destination = path.join(userData, 'docs', 'vault');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'OLD.md'), '# stale\n');
  await fs.writeFile(path.join(destination, 'keep.txt'), 'user-owned neighbor\n');

  const { syncVaultManualMirror, vaultManualMirrorDirectory } = await import('../src/main/vault-path.js');
  expect(await syncVaultManualMirror(userData)).toBe(destination);
  expect(vaultManualMirrorDirectory(userData)).toBe(destination);
  expect((await fs.readdir(destination)).sort()).toEqual(['02-runtime.md', 'README.md', 'keep.txt']);
  expect(await fs.readFile(path.join(destination, 'README.md'), 'utf8')).toBe('# Current manual\n');
  expect(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('user-owned neighbor\n');

  await fs.writeFile(path.join(vault, 'README.md'), '# Updated manual\n');
  const oldSourceTime = new Date('2001-01-01T00:00:00.000Z');
  await fs.utimes(path.join(vault, 'README.md'), oldSourceTime, oldSourceTime);
  const refreshStartedAt = Date.now();
  await syncVaultManualMirror(userData);
  expect(await fs.readFile(path.join(destination, 'README.md'), 'utf8')).toBe('# Updated manual\n');
  expect((await fs.stat(path.join(destination, 'README.md'))).mtimeMs).toBeGreaterThanOrEqual(refreshStartedAt - 1_000);
});

it('fails closed instead of following an AppData manual-directory symlink', async () => {
  const userData = path.join(base, 'user-data-link');
  const docs = path.join(userData, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.symlink(outside, path.join(docs, 'vault'), DIR_LINK);

  const { syncVaultManualMirror } = await import('../src/main/vault-path.js');
  await expect(syncVaultManualMirror(userData)).rejects.toThrow(/not a real directory/i);
  expect(await fs.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('# outside\n');
});

async function awaitReal(target: string): Promise<string> {
  return fs.realpath(target);
}
