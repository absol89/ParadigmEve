import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error JavaScript staging CLI intentionally has no generated declaration file.
import { validatePortablePython } from '../scripts/stage-transcription-runtime.mjs';
// @ts-expect-error Build scripts are intentionally plain ESM JavaScript.
import { PYTHON_ASSET, PYTHON_SHA256, PYTHON_URL, PYTHON_VERSION, configureEmbeddedPython } from '../scripts/prepare-transcription-runtime.mjs';

describe('portable transcription runtime staging', () => {
  it('pins an official CPython embeddable runtime rather than the host installation', () => {
    expect(PYTHON_VERSION).toBe('3.14.7');
    expect(PYTHON_ASSET).toBe('python-3.14.7-embed-amd64.zip');
    expect(PYTHON_URL).toBe('https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip');
    expect(PYTHON_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects machine-bound venvs and incomplete portable runtimes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-python-stage-'));
    try {
      await writeFile(path.join(root, 'python.exe'), 'stub');
      await writeFile(path.join(root, 'pyvenv.cfg'), 'home=C:\\Python314');
      await expect(validatePortablePython(root)).rejects.toThrow();
      await rm(path.join(root, 'pyvenv.cfg'));
      await writeFile(path.join(root, 'python314._pth'), 'python314.zip\n.\nimport site\n');
      await mkdir(path.join(root, 'Lib', 'site-packages', 'sherpa_onnx'), { recursive: true });
      await expect(validatePortablePython(root)).rejects.toThrow('parent engine');
      await configureEmbeddedPython(root);
      await expect(validatePortablePython(root)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Vulkan GPU validation is manual/local only. CI must not execute Vulkan tests.
// Opt in locally with EVE_TEST_VULKAN=1; CI still skips even if that is set.
describe.runIf(!process.env.CI && process.env.EVE_TEST_VULKAN === '1')('GPU (Vulkan) transcription build inputs', () => {
  it('ships the vendored Vulkan build tools unmodified and hash-verified', async () => {
    // @ts-expect-error Build scripts are intentionally plain ESM JavaScript.
    const { verifyVendoredTools } = await import('../scripts/build-whisper-vulkan.mjs');
    await expect(verifyVendoredTools()).resolves.toBeUndefined();
  });

  it('pins the GPU recipe: Vulkan on, CUDA off, static, with the compute probe', async () => {
    const { readFile } = await import('node:fs/promises');
    const recipe = await readFile('transcription-engine/native/CMakeLists.txt', 'utf8');
    expect(recipe).toContain('set(GGML_VULKAN ON');
    expect(recipe).toContain('set(GGML_CUDA OFF');
    expect(recipe).toContain('set(BUILD_SHARED_LIBS OFF');
    expect(recipe).toContain('add_executable(ggml-probe');
    const stage = await readFile('scripts/stage-transcription-runtime.mjs', 'utf8');
    for (const name of ['whisper-cli.exe', 'ggml-probe.exe', 'build-info.json']) expect(stage).toContain(name);
    const lock = JSON.parse(await readFile('transcription-engine/lock/components.json', 'utf8'));
    expect(lock.whisper_cpp.build_gpu).toContain('GGML_VULKAN=ON');
  });
});
