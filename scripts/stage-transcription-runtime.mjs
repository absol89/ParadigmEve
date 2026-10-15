/**
 * Stage the proven engine beside an independently prepared Windows embedded Python runtime.
 * Usage: node scripts/stage-transcription-runtime.mjs <prototype-source> <portable-python-dir> <destination>
 * The portable runtime must already include site-packages installed from locked wheels.
 * This script rejects venvs rather than copying local absolute-path launchers.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function validatePortablePython(root) {
  const names = await readdir(root);
  if (!names.includes('python.exe') || !names.some(name => /^python3\d+\._pth$/.test(name)))
    throw new Error('Expected an official portable Windows Python distribution with python.exe and python3XY._pth.');
  if (names.includes('pyvenv.cfg') || names.includes('Scripts'))
    throw new Error('Virtual environments cannot be staged as a portable runtime.');
  const pth = names.find(name => /^python3\d+\._pth$/.test(name));
  const contents = await readFile(path.join(root, pth), 'utf8');
  if (!contents.split(/\r?\n/).some(line => line.trim() === '..'))
    throw new Error('Portable Python must include its parent engine package root in python._pth.');
  if (!contents.split(/\r?\n/).some(line => /^import site\s*$/.test(line)))
    throw new Error('Portable Python must enable import site for bundled dependencies.');
  if (!(await stat(path.join(root, 'Lib', 'site-packages', 'sherpa_onnx'))).isDirectory())
    throw new Error('Portable Python is missing bundled diarization dependencies.');
}

export async function stageTranscriptionRuntime(source, portablePython, destination, { includeVulkan = false } = {}) {
  const target = path.resolve(destination);
  if ((await readdir(path.dirname(target))).includes(path.basename(target)))
    throw new Error('Destination already exists; staging must not overwrite prior output.');
  await validatePortablePython(portablePython);
  const cpuCli = '.vendor/whisper.cpp/build/bin/Release/whisper-cli.exe';
  const lock = JSON.parse(await readFile(path.join(source, 'lock', 'components.json'), 'utf8'));
  const pinnedCpu = lock.whisper_cpp?.windows_cpu_binary;
  if (pinnedCpu?.path !== cpuCli || !/^[0-9a-f]{64}$/.test(pinnedCpu.sha256 ?? '')) {
    throw new Error('Pinned Windows x64 CPU Whisper executable is not declared in the component lock.');
  }
  const vulkan = path.join('.vendor', 'whisper.cpp', 'build-vulkan', 'bin', 'Release');
  const gpuFiles = ['whisper-cli.exe', 'ggml-probe.exe', 'build-info.json'];
  for (const relative of ['ldw', 'upstream/src/local_diarization', 'lock/components.json',
    cpuCli, 'requirements-windows.txt', 'LICENSE.local-diarization.txt', 'LICENSE.whisper-cpp.txt',
    'LICENSE.sherpa-onnx-core.txt', 'LICENSE.onnxruntime.txt',
    ...(includeVulkan ? [...gpuFiles.map(name => path.join(vulkan, name)), 'third_party/vulkan-build/licenses'] : [])]) {
    await stat(path.join(source, relative));
  }
  const actualCpuHash = createHash('sha256').update(await readFile(path.join(source, cpuCli))).digest('hex');
  if (actualCpuHash !== pinnedCpu.sha256) {
    throw new Error(`CPU whisper-cli checksum mismatch: expected ${pinnedCpu.sha256}, got ${actualCpuHash}`);
  }
  await mkdir(target, { recursive: false });
  await mkdir(path.join(target, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release'), { recursive: true });
  await Promise.all([
    cp(path.join(source, 'ldw'), path.join(target, 'ldw'), { recursive: true,
      filter: entry => !entry.includes('__pycache__') }),
    cp(path.join(source, 'upstream', 'src', 'local_diarization'),
      path.join(target, 'upstream', 'src', 'local_diarization'), { recursive: true }),
    cp(path.join(source, 'lock'), path.join(target, 'lock'), { recursive: true }),
    cp(path.join(source, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'),
      path.join(target, '.vendor', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe')),
    cp(path.join(source, 'requirements-windows.txt'), path.join(target, 'requirements-windows.txt')),
    cp(path.join(source, 'LICENSE.local-diarization.txt'), path.join(target, 'LICENSE.local-diarization.txt')),
    cp(path.join(source, 'LICENSE.whisper-cpp.txt'), path.join(target, 'LICENSE.whisper-cpp.txt')),
    cp(path.join(source, 'LICENSE.sherpa-onnx-core.txt'), path.join(target, 'LICENSE.sherpa-onnx-core.txt')),
    cp(path.join(source, 'LICENSE.onnxruntime.txt'), path.join(target, 'LICENSE.onnxruntime.txt')),
    cp(portablePython, path.join(target, 'runtime'), { recursive: true })
  ]);
  // Optional manually built GPU payload. Default/CI packages contain no Vulkan executable,
  // so ldw's probe truthfully reports cpu-only-build instead of advertising unavailable hardware.
  if (includeVulkan) {
    await mkdir(path.join(target, vulkan), { recursive: true });
    for (const name of gpuFiles) await cp(path.join(source, vulkan, name), path.join(target, vulkan, name));
    await cp(path.join(source, 'third_party', 'vulkan-build', 'licenses'), path.join(target, 'licenses', 'vulkan-build'),
      { recursive: true });
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(here, 'stage-transcription-runtime.mjs')) {
  if (process.argv.length !== 5) throw new Error('Usage: stage-transcription-runtime.mjs <engine> <portable-python> <destination>');
  console.log(await stageTranscriptionRuntime(...process.argv.slice(2)));
}
