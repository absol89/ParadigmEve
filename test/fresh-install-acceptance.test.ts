import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({
      result: buffer.toString('utf8'),
      shouldReEncrypt: false
    }))
  }
}));

const {
  initConfigPath,
  loadConfig,
  saveConfig,
  updateConfig
} = await import('../src/main/config.js');
const {
  getSecret,
  initSecretsPath,
  resetSecretsCacheForTests,
  setSecret
} = await import('../src/main/secrets.js');
const { requiresApprovedFilesystemRoot } = await import('../src/shared/capabilities.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let userData: string;
let installDir: string;

beforeEach(async () => {
  userData = await makeTempDir('paradigmeve-fresh-install-');
  installDir = path.join(userData, 'custom-install');
  await fs.mkdir(installDir);
  initConfigPath(userData);
  initSecretsPath(userData);
  resetSecretsCacheForTests();
});

afterEach(async () => {
  resetSecretsCacheForTests();
  await removeTempDir(userData);
});

describe('fresh-install acceptance state', () => {
  it('survives the pristine AppData -> folder -> guided credentials -> relaunch boundary', async () => {
    expect(await fs.readdir(userData)).toEqual(['custom-install']);

    const fresh = await loadConfig();
    expect(fresh.roots).toEqual([]);
    expect(requiresApprovedFilesystemRoot(fresh)).toBe(true);
    expect(fresh.tunnel).toMatchObject({ kind: 'openai', tunnelId: '' });
    expect(fresh.ui).toMatchObject({
      autoConnect: false,
      startAtLogin: false,
      autoRefreshPlugins: true,
      minimizeToTray: false,
      privacyScreenshots: true
    });
    expect(fresh.capabilities).toMatchObject({
      browse: true,
      search: true,
      read: true,
      metadata: true,
      create: true,
      edit: true,
      move: true,
      deleteFile: true,
      command: true,
      saveArtifact: true,
      screen: false,
      control: false,
      clipboardRead: false,
      clipboardWrite: false
    });
    expect(fresh.multiAgent).toMatchObject({ enabled: true, allowUnattributedCalls: false });
    expect(fresh.eveAuthority).toEqual({ allowOtherChats: true, changeSettings: false, archiveCompletedWork: false, controlParadigmEve: false });
    expect(await getSecret('openaiApiKey')).toBeNull();
    await expect(fs.access(path.join(userData, 'config.json'))).rejects.toBeDefined();
    await expect(fs.access(path.join(userData, 'secrets.bin'))).rejects.toBeDefined();

    const approvedFolder = path.join(userData, 'focus-workspace');
    await fs.mkdir(approvedFolder);
    await saveConfig({
      ...fresh,
      roots: [...fresh.roots, { name: 'focus-workspace', path: approvedFolder }]
    });

    // This is the durable side of setup-assistant's onCredentials handoff. The browser guide's
    // ordering and provider-page boundary are exercised in setup-assistant.test.ts; here we prove
    // those captured values land in the same pristine userData state the next process will read.
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const apiKey = 'sk-focus-test-placeholder';
    await setSecret('openaiApiKey', apiKey);
    await updateConfig((config) => ({
      ...config,
      tunnel: { ...config.tunnel, kind: 'openai', tunnelId }
    }));

    const configText = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
    expect(configText).toContain(tunnelId);
    expect(configText).not.toContain(apiKey);
    expect(await fs.stat(path.join(userData, 'secrets.bin'))).toBeTruthy();

    // Model a process relaunch by discarding the secret cache and re-reading the durable files.
    resetSecretsCacheForTests();
    const relaunched = await loadConfig();
    expect(relaunched.roots).toEqual([{ name: 'focus-workspace', path: approvedFolder }]);
    expect(relaunched.tunnel).toMatchObject({ kind: 'openai', tunnelId });
    expect(relaunched.ui).toMatchObject({ autoConnect: false, startAtLogin: false, autoRefreshPlugins: true, minimizeToTray: false, privacyScreenshots: true });
    expect(await getSecret('openaiApiKey')).toBe(apiKey);
  });
});
