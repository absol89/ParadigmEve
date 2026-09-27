import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'dpapi'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const { defaultConfig, initConfigPath, loadConfig, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests, setSecret } = await import('../src/main/secrets.js');
const { generateLanGroupKey, getLanGroupKey, parseLanGroupKey, setLanGroupKey } = await import('../src/main/lan-peer-key.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('eve-lan-config-');
  initConfigPath(dir);
  initSecretsPath(dir);
  resetSecretsCacheForTests();
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('LAN opt-in and secret boundary', () => {
  it('defaults fresh, legacy and malformed LAN config to disabled', async () => {
    expect(defaultConfig().lan).toEqual({ enabled: false });

    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy.lan;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).lan).toEqual({ enabled: false });

    const malformed = defaultConfig() as unknown as Record<string, unknown>;
    malformed.lan = { enabled: true, groupKey: 'must-never-live-in-config' };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(malformed), 'utf8');
    expect((await loadConfig()).lan).toEqual({ enabled: false });
  });

  it('round-trips explicit opt-in without adding any key material to config', async () => {
    const saved = await saveConfig({ ...defaultConfig(), lan: { enabled: true } });
    expect(saved.lan).toEqual({ enabled: true });
    const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    expect(raw).toContain('"lan"');
    expect(raw).not.toContain('lanGroupKey');
    expect(raw).not.toContain('groupKey');
  });

  it('accepts only canonical unpadded base64url encoding of exactly 32 key bytes', async () => {
    const generated = generateLanGroupKey();
    expect(generated).toHaveLength(43);
    expect(parseLanGroupKey(generated)).not.toBeNull();
    const canonical = Buffer.alloc(32, 0x5a).toString('base64url');
    expect(canonical).toHaveLength(43);
    expect(parseLanGroupKey(canonical)).toEqual(Buffer.alloc(32, 0x5a));
    for (const invalid of ['', canonical.slice(1), `${canonical}=`, ` ${canonical}`, 'a'.repeat(64)]) {
      expect(parseLanGroupKey(invalid)).toBeNull();
      await expect(setLanGroupKey(invalid)).rejects.toThrow(/32 bytes.*base64url/i);
    }
  });

  it('stores the LAN key only through the encrypted secret abstraction and fails closed on malformed stored material', async () => {
    const canonical = Buffer.alloc(32, 0xa5).toString('base64url');
    await setLanGroupKey(canonical);
    expect(await getLanGroupKey()).toEqual(Buffer.alloc(32, 0xa5));

    await setSecret('lanGroupKey', 'malformed-hand-edited-value');
    expect(await getLanGroupKey()).toBeNull();
  });
});
