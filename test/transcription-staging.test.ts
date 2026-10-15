import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error JavaScript staging CLI intentionally has no generated declaration file.
import { stageTranscriptionRuntime, validatePortablePython } from '../scripts/stage-transcription-runtime.mjs';
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

  it('ships the CPU transcription runtime without optional Vulkan binaries by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-cpu-stage-'));
    try {
      const { source, portable, target } = await stagingFixture(root);
      await stageTranscriptionRuntime(source, portable, target);
      expect(await readFile(path.join(target, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'), 'utf8'))
        .toBe('cpu-whisper');
      await expect(stat(path.join(target, '.vendor', 'whisper.cpp', 'build-vulkan')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.join(target, 'licenses', 'vulkan-build')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(target, 'runtime', 'python314._pth'), 'utf8')).toContain('import site');
      expect(await readFile(path.join(target, 'LICENSE.sherpa-onnx-core.txt'), 'utf8')).toBe('core-license');
      expect(await readFile(path.join(target, 'LICENSE.onnxruntime.txt'), 'utf8')).toBe('onnx-license');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a modified or unpinned CPU binary before creating a package', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-cpu-hash-'));
    try {
      const { source, portable, target } = await stagingFixture(root);
      await writeFile(path.join(source, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'), 'changed-cpu');
      await expect(stageTranscriptionRuntime(source, portable, target)).rejects.toThrow('checksum mismatch');
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(!process.env.CI)('only stages a complete optional GPU payload when explicitly requested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-gpu-stage-'));
    try {
      const { source, portable, target } = await stagingFixture(root);
      await stageTranscriptionRuntime(source, portable, target, { includeVulkan: true });
      for (const file of ['whisper-cli.exe', 'ggml-probe.exe', 'build-info.json']) {
        expect(await readFile(path.join(target, '.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release', file), 'utf8'))
          .toBe(`gpu-${file}`);
      }
      expect(await readFile(path.join(target, 'licenses', 'vulkan-build', 'LICENSE.txt'), 'utf8'))
        .toBe('vulkan-license');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(!process.env.CI)('rejects an incomplete optional GPU payload before publishing any output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-gpu-incomplete-'));
    try {
      const { source, portable, target } = await stagingFixture(root);
      await rm(path.join(source, '.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release', 'ggml-probe.exe'));
      await expect(stageTranscriptionRuntime(source, portable, target, { includeVulkan: true }))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function stagingFixture(root: string) {
  const source = path.join(root, 'source');
  const portable = path.join(root, 'python');
  const target = path.join(root, 'output');
  const write = async (base: string, relative: string, value: string) => {
    const file = path.join(base, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  };
  const cpuCli = '.vendor/whisper.cpp/build/bin/Release/whisper-cli.exe';
  const cpuContent = 'cpu-whisper';
  const lock = JSON.stringify({ whisper_cpp: { windows_cpu_binary: {
    path: cpuCli,
    sha256: createHash('sha256').update(cpuContent).digest('hex')
  } } });
  for (const [file, value] of Object.entries({
    'ldw/__main__.py': 'pass',
    'upstream/src/local_diarization/__init__.py': 'pass',
    'lock/components.json': lock,
    [cpuCli]: cpuContent,
    'requirements-windows.txt': 'pinned',
    'LICENSE.local-diarization.txt': 'local-license',
    'LICENSE.whisper-cpp.txt': 'whisper-license',
    'LICENSE.sherpa-onnx-core.txt': 'core-license',
    'LICENSE.onnxruntime.txt': 'onnx-license',
    '.vendor/whisper.cpp/build-vulkan/bin/Release/whisper-cli.exe': 'gpu-whisper-cli.exe',
    '.vendor/whisper.cpp/build-vulkan/bin/Release/ggml-probe.exe': 'gpu-ggml-probe.exe',
    '.vendor/whisper.cpp/build-vulkan/bin/Release/build-info.json': 'gpu-build-info.json',
    'third_party/vulkan-build/licenses/LICENSE.txt': 'vulkan-license'
  })) await write(source, file, value);
  await write(portable, 'python.exe', 'python-stub');
  await write(portable, 'python314._pth', 'python314.zip\n.\n..\nLib/site-packages\nimport site\n');
  await write(portable, 'Lib/site-packages/sherpa_onnx/__init__.py', 'pass');
  return { source, portable, target };
}

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
