/**
 * Prepare the packaged Windows x64 transcription engine.
 *
 * CPython itself is the official embeddable distribution pinned by SHA-256. Native Python
 * dependencies are installed into that isolated runtime from the fully pinned requirements
 * file. The host Python is only a build tool; the packaged app never depends on it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadWithRetry } from './download-with-retry.mjs';
import { parseTarget } from './packaging-targets.mjs';
import { stageTranscriptionRuntime } from './stage-transcription-runtime.mjs';
import { buildWhisperVulkan } from './build-whisper-vulkan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'transcription-engine');
const cache = path.join(root, 'node_modules', '.cache', 'transcription-runtime');
const stagingRoot = path.join(root, 'resources', 'packaging', 'transcription');
const PYTHON_VERSION = '3.14.7';
const PYTHON_ASSET = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ASSET}`;
const PYTHON_SHA256 = 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15';

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

async function verifySha256(file, expected) {
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (actual !== expected) {
    await rm(file, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(file)}: expected ${expected}, got ${actual}`);
  }
}

async function configureEmbeddedPython(runtime) {
  const pth = (await readdir(runtime)).find(name => /^python3\d+\._pth$/.test(name));
  if (!pth) throw new Error('Official embedded Python archive did not contain python3XY._pth');
  const file = path.join(runtime, pth);
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
    .filter(line => !['#import site', 'import site', 'Lib/site-packages', '..'].includes(line.trim()));
  while (lines.length && !lines.at(-1)) lines.pop();
  // Embedded Python ignores PYTHONPATH. The engine's ldw package lives in the
  // parent directory of runtime/, so admit that single relative package root.
  lines.push('..', 'Lib/site-packages', 'import site', '');
  await writeFile(file, lines.join('\r\n'), 'utf8');
  await mkdir(path.join(runtime, 'Lib', 'site-packages'), { recursive: true });
}

function proveHostPython() {
  const probe = execFileSync('python', ['-c',
    'import platform,sys; print(f"{sys.version_info.major}.{sys.version_info.minor}|{platform.machine().lower()}")'
  ], { encoding: 'utf8' }).trim();
  if (!/^3\.14\|(amd64|x86_64)$/.test(probe)) {
    throw new Error(`Windows x64 transcription packaging needs a CPython 3.14 x64 build host; got ${probe}`);
  }
}

async function prepareX64(outDir) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Windows x64 transcription runtime must be prepared on a Windows x64 build host.');
  }
  proveHostPython();
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, PYTHON_ASSET);
  await downloadWithRetry(PYTHON_URL, archive);
  await verifySha256(archive, PYTHON_SHA256);

  const runtime = path.join(cache, `python-${PYTHON_VERSION}-x64`);
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  run('tar.exe', ['-xf', archive, '-C', runtime]);
  await configureEmbeddedPython(runtime);

  const sitePackages = path.join(runtime, 'Lib', 'site-packages');
  run('python', [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--only-binary=:all:',
    '--no-compile',
    '--target', sitePackages,
    '-r', path.join(source, 'requirements-windows.txt')
  ]);
  run(path.join(runtime, 'python.exe'), ['-c',
    'import cffi,numpy,sherpa_onnx,soundfile; print("transcription-python-ok")'
  ], { cwd: runtime });

  // Vulkan is optional and deliberately excluded from CI release packages. Building the
  // GPU engine requires a separate explicit local opt-in; the normal package is CPU-ready.
  const includeVulkan = !process.env.CI && process.env.EVE_PACKAGE_VULKAN === '1';
  if (includeVulkan && !existsSync(path.join(source, '.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release', 'ggml-probe.exe'))) {
    await buildWhisperVulkan();
  }
  await stageTranscriptionRuntime(source, runtime, outDir, { includeVulkan });
  run(path.join(outDir, 'runtime', 'python.exe'), ['-c',
    'import cffi,numpy,sherpa_onnx,soundfile; print("staged-transcription-python-ok")'
  ], { cwd: outDir });
  run(path.join(outDir, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'),
    ['--version'], { cwd: outDir });
  if (includeVulkan) {
    // On a local opt-in build, prove the staged GPU binary has Vulkan compiled in.
    // Actual device usability is determined on the user's machine at runtime.
    const probe = JSON.parse(execFileSync(path.join(outDir, '.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release',
      'ggml-probe.exe'), { encoding: 'utf8' }).trim().split(/\r?\n/).pop());
    if (!probe.backends?.includes('Vulkan')) throw new Error('Staged ggml-probe does not include the Vulkan backend.');
    run(path.join(outDir, 'runtime', 'python.exe'), ['-m', 'ldw', 'gpu-probe'], { cwd: outDir });
  }
}

async function main() {
  const { platform, arch } = parseTarget();
  const outDir = path.join(stagingRoot, platform, arch, 'transcription-engine');
  await rm(path.dirname(outDir), { recursive: true, force: true });
  await mkdir(path.dirname(outDir), { recursive: true });
  if (platform !== 'win32' || arch !== 'x64') {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'UNAVAILABLE.txt'),
      'Transcription runtime is currently packaged only for Windows x64.\n', 'utf8');
    return;
  }
  await prepareX64(outDir);
  process.stdout.write(`Transcription runtime staged: ${outDir}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`\nCould not prepare transcription runtime: ${error.message}\n`);
    process.exit(1);
  });
}

export { PYTHON_ASSET, PYTHON_SHA256, PYTHON_URL, PYTHON_VERSION, configureEmbeddedPython, prepareX64 };
