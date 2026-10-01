import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

const electronState = vi.hoisted(() => ({ appPath: '' }));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => electronState.appPath
  }
}));

const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const {
  createQuilt,
  initializeDefaultThreads,
  pinsLibrary,
  resetPinsForTests
} = await import('../src/main/pins.js');
const { syncVaultManualMirror } = await import('../src/main/vault-path.js');

let base = '';
let userData = '';
let appPath = '';

beforeEach(async () => {
  base = await makeTempDir('eva-bootstrap-');
  userData = path.join(base, 'user-data');
  appPath = path.join(base, 'app');
  electronState.appPath = appPath;
  await fs.mkdir(userData, { recursive: true });
  await writeTree(path.join(appPath, 'docs', 'vault'), {
    'README.md': '# Eva bootstrap manual\n',
    '06-pins-quilts-and-plans.md': '# Pins and Threads\n'
  });
  resetPinsForTests();
  resetDurableForTests();
  initDurableStore(userData);
});

afterEach(async () => {
  resetPinsForTests();
  resetDurableForTests();
  await removeTempDir(base);
});

it('bootstraps starter Threads and a physical AppData Vault mirror on a fresh Eva state', async () => {
  await syncVaultManualMirror(userData);
  await initializeDefaultThreads();

  const snapshot = await pinsLibrary();
  expect(snapshot.quilts.map(thread => thread.title)).toEqual(['how', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
  expect(snapshot.quilts.find(thread => thread.title === 'claude')?.prompt).toContain('claude -p');
  expect(snapshot.quilts.find(thread => thread.title === 'how')?.prompt).toContain('current packaged ParadigmEve manual');
  expect(await fs.readFile(path.join(userData, 'docs', 'vault', 'README.md'), 'utf8')).toBe('# Eva bootstrap manual\n');
});

it('upgrades an older custom-only Pins library while refreshing the managed AppData manual', async () => {
  const custom = await createQuilt({ title: 'gen1', collectionIds: [] });
  await fs.mkdir(path.join(userData, 'docs', 'vault'), { recursive: true });
  await fs.writeFile(path.join(userData, 'docs', 'vault', 'README.md'), '# stale old manual\n');
  await fs.writeFile(path.join(userData, 'docs', 'vault', 'removed.md'), '# removed page\n');

  await syncVaultManualMirror(userData);
  await initializeDefaultThreads();

  const snapshot = await pinsLibrary();
  expect(snapshot.quilts[0]).toEqual(custom);
  expect(snapshot.quilts.map(thread => thread.title)).toEqual(['gen1', 'how', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
  expect(await fs.readFile(path.join(userData, 'docs', 'vault', 'README.md'), 'utf8')).toBe('# Eva bootstrap manual\n');
  await expect(fs.access(path.join(userData, 'docs', 'vault', 'removed.md'))).rejects.toBeDefined();
});
