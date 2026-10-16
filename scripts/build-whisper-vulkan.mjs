/**
 * Build the Vulkan (GPU) whisper-cli and ggml-probe for Windows x64 from pinned sources.
 *
 * Inputs, all pinned and verified:
 *  - whisper.cpp tag + commit from transcription-engine/lock/components.json (cloned into the cache);
 *  - the vendored Vulkan build tools in transcription-engine/third_party/vulkan-build (glslc, headers,
 *    vulkan-1.lib, SPIRV-Headers), checked against their SHA256SUMS.txt;
 *  - MSVC + CMake from Visual Studio Build Tools 2022 (or CMAKE on PATH).
 * Output: transcription-engine/.vendor/whisper.cpp/build-vulkan/bin/Release/{whisper-cli.exe, ggml-probe.exe,
 * build-info.json}. No Vulkan SDK and no admin rights are needed. Users need only a GPU driver.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'transcription-engine');
const tools = path.join(engine, 'third_party', 'vulkan-build');
const output = path.join(engine, '.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release');

function cmakePath() {
  if (process.env.CMAKE) return process.env.CMAKE;
  const bundled = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe';
  return existsSync(bundled) ? bundled : 'cmake';
}

export async function verifyVendoredTools() {
  const sums = (await readFile(path.join(tools, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
  if (sums.length < 3) throw new Error('vulkan-build/SHA256SUMS.txt is empty');
  for (const line of sums) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    const relative = rest.join(' ').replace(/^\*/, '');
    const actual = createHash('sha256').update(await readFile(path.join(tools, relative))).digest('hex');
    if (actual !== hash) throw new Error(`Vendored Vulkan tool changed: ${relative}`);
  }
}

async function pinnedWhisperSource() {
  const lock = JSON.parse(await readFile(path.join(engine, 'lock', 'components.json'), 'utf8')).whisper_cpp;
  const dir = path.join(root, 'node_modules', '.cache', 'transcription-runtime', `whisper.cpp-${lock.tag}`);
  if (!existsSync(path.join(dir, '.git'))) {
    await mkdir(path.dirname(dir), { recursive: true });
    execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', lock.tag,
      lock.repository, dir], { stdio: 'inherit' });
  }
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== lock.commit) throw new Error(`whisper.cpp ${lock.tag} resolved to ${head}, expected ${lock.commit}`);
  return { dir, lock };
}

export async function buildWhisperVulkan() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The Vulkan whisper.cpp build is currently produced on a Windows x64 build host.');
  }
  await verifyVendoredTools();
  const { dir: source, lock } = await pinnedWhisperSource();
  // Short build path: MSBuild tlogs of ggml's vulkan-shaders-gen ExternalProject exceed MAX_PATH otherwise.
  // One per checkout: CMake refuses a cache generated from another checkout's source folder.
  const checkout = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8);
  const build = path.join(os.homedir(), `.eve-wvk-${checkout}`);
  const win = path.join(tools, 'win32-x64');
  const cmake = cmakePath();
  execFileSync(cmake, ['-S', path.join(engine, 'native'), '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64',
    `-DWHISPER_CPP_DIR=${source}`,
    `-DVulkan_INCLUDE_DIR=${path.join(tools, 'include')}`,
    `-DVulkan_LIBRARY=${path.join(win, 'lib', 'vulkan-1.lib')}`,
    `-DVulkan_GLSLC_EXECUTABLE=${path.join(win, 'bin', 'glslc.exe')}`,
    `-DSPIRV-Headers_DIR=${path.join(tools, 'spirv-headers', 'share', 'cmake', 'SPIRV-Headers')}`
  ], { stdio: 'inherit' });
  execFileSync(cmake, ['--build', build, '--config', 'Release', '--target', 'whisper-cli', 'ggml-probe', '--parallel'],
    { stdio: 'inherit' });
  await mkdir(output, { recursive: true });
  const built = {
    'whisper-cli.exe': path.join(build, 'bin', 'Release', 'whisper-cli.exe'),
    'ggml-probe.exe': path.join(build, 'Release', 'ggml-probe.exe')
  };
  const hashes = {};
  for (const [name, file] of Object.entries(built)) {
    await copyFile(file, path.join(output, name));
    hashes[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  await writeFile(path.join(output, 'build-info.json'), JSON.stringify({
    backend: 'vulkan',
    whisper_cpp: { tag: lock.tag, commit: lock.commit },
    vulkan_build_tools: 'transcription-engine/third_party/vulkan-build (SHA256SUMS.txt verified)',
    sha256: hashes
  }, null, 2) + '\n', 'utf8');
  // The probe must start and report the Vulkan backend as compiled in, even on a build host without a GPU.
  const probe = JSON.parse(execFileSync(path.join(output, 'ggml-probe.exe'), { encoding: 'utf8' }).trim().split(/\r?\n/).pop());
  if (!probe.backends?.includes('Vulkan')) throw new Error('Built ggml-probe does not include the Vulkan backend.');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWhisperVulkan().then(dir => process.stdout.write(`Vulkan whisper.cpp built: ${dir}\n`)).catch(error => {
    process.stderr.write(`\nCould not build the Vulkan whisper.cpp runtime: ${error.message}\n`);
    process.exit(1);
  });
}
