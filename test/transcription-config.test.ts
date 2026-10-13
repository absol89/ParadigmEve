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
const { DEFAULT_TRANSCRIPTION_SETTINGS } = await import('../src/shared/transcription.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('eve-transcription-config-');
  initConfigPath(dir);
});

afterEach(async () => {
  await removeTempDir(dir);
});

async function loadWith(transcription: unknown) {
  const config = defaultConfig() as unknown as Record<string, unknown>;
  if (transcription === undefined) delete config.transcription;
  else config.transcription = transcription;
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  return (await loadConfig()).transcription;
}

describe('transcription settings in config', () => {
  it('fresh and pre-2.4.0 configs get GPU 1, Local 2, Cloud 3 with Cloud off', async () => {
    expect(defaultConfig().transcription).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
    expect(await loadWith(undefined)).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
  });

  it('repairs a damaged avenue to its own default without touching the others', async () => {
    const loaded = await loadWith({
      gpu: { enabled: false, priority: 4 },
      local: { enabled: true, priority: 2.5 },
      cloud: { enabled: true, priority: 'first', provider: 'groq' }
    });
    expect(loaded?.gpu).toEqual({ enabled: false, priority: 4 });
    expect(loaded?.local).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS.local);
    // A damaged Cloud entry must never come back enabled: that would start uploading audio.
    expect(loaded?.cloud.enabled).toBe(false);
  });

  it('round-trips a valid custom order', async () => {
    const transcription = {
      gpu: { enabled: true, priority: 3 },
      local: { enabled: true, priority: 7 },
      cloud: { enabled: true, priority: 1, provider: 'groq' as const }
    };
    const saved = await saveConfig({ ...defaultConfig(), transcription });
    expect(saved.transcription).toEqual(transcription);
    expect((await loadConfig()).transcription).toEqual(transcription);
  });
});
