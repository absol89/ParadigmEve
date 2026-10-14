/** Main-process custody for a proven external diarization runtime. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { getSecret } from './secrets.js';
import { terminateProcessTree } from './exec.js';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  UNKNOWN_GPU_CAPABILITY,
  parseGpuProbe,
  transcriptionOrder,
  type TranscriptionAsrBackend,
  type TranscriptionGpuCapability,
  type TranscriptionAvenue,
  type TranscriptionJob,
  type TranscriptionRuntimeProvider,
  type TranscriptionSettings
} from '../shared/transcription.js';

/**
 * The cloud avenue is usable only with the key for the exact selected recipient; the GPU avenue
 * only when the engine's compute probe proved a usable Vulkan device on this computer.
 */
export function availableTranscriptionAvenues(settings: TranscriptionSettings, keys: {
  groq: string | null; openai: string | null
}, gpu: TranscriptionGpuCapability = UNKNOWN_GPU_CAPABILITY): TranscriptionAvenue[] {
  return transcriptionOrder(settings, {
    gpu: gpu.status === 'usable', local: true,
    cloud: Boolean(settings.cloud.provider === 'openai' ? keys.openai : keys.groq)
  });
}

/** Engine arguments that select where local ASR runs. GPU never silently falls back inside the
 * engine: a GPU failure fails this avenue, and the next avenue (normally Local) runs explicitly. */
export function asrDeviceArgs(avenue: TranscriptionAvenue): string[] {
  if (avenue === 'gpu') return ['--asr-device', 'gpu', '--no-gpu-fallback'];
  if (avenue === 'local') return ['--asr-device', 'cpu'];
  return [];
}

/**
 * What really transcribed the words, from the engine's provenance. Returns null when the transcript
 * does not prove the avenue that was requested (for example a GPU avenue whose run was not Vulkan),
 * so the caller can refuse the result instead of mislabelling it.
 */
export function executedAsrBackend(transcript: unknown, avenue: TranscriptionAvenue):
  { backend: TranscriptionAsrBackend; device?: string } | null {
  const provenance = (transcript as { provenance?: { asr_execution?: Record<string, unknown> } } | null)?.provenance;
  const execution = provenance?.asr_execution;
  const backend = execution?.backend;
  const device = typeof execution?.device === 'string' ? execution.device.slice(0, 120) : undefined;
  if (avenue === 'gpu') return (backend === 'vulkan' || backend === 'metal') && device ? { backend, device } : null;
  if (avenue === 'local') return backend === 'cpu' ? { backend } : null;
  return backend === 'groq' || backend === 'openai' ? { backend } : null;
}

let gpuCapability: TranscriptionGpuCapability = { ...UNKNOWN_GPU_CAPABILITY };
let gpuProbe: Promise<TranscriptionGpuCapability> | null = null;

export function transcriptionGpuCapability(): TranscriptionGpuCapability {
  return { ...gpuCapability };
}

/** Run the engine's GPU compute probe once per app run (or again when asked). Never throws. */
export function probeTranscriptionGpu(engineRoot: string, force = false): Promise<TranscriptionGpuCapability> {
  if (gpuProbe && !force) return gpuProbe;
  const root = path.resolve(engineRoot);
  const python = path.join(root, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  gpuProbe = new Promise<TranscriptionGpuCapability>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: TranscriptionGpuCapability) => {
      if (settled) return;
      settled = true;
      gpuCapability = value;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(python, ['-m', 'ldw', 'gpu-probe'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LDW_ROOT: root }
      });
    } catch {
      finish({ status: 'unknown', device: null, reason: 'The transcription engine could not start.' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 'unknown', device: null, reason: 'The GPU probe timed out.' });
    }, 90_000);
    child.stdout?.on('data', (chunk: Buffer) => { if (output.length < 65_536) output += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); finish({ status: 'unknown', device: null, reason: 'The transcription engine is not installed.' }); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const line = output.trim().split(/\r?\n/).pop() ?? '';
      finish(code === 0 ? parseGpuProbe(line)
        : { status: 'unknown', device: null, reason: 'The GPU probe exited unsuccessfully.' });
    });
  });
  return gpuProbe;
}

/** Native input filenames are kept inside the engine's on-disk evidence, not the UI result. */
export function publicTranscriptionDocument(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed transcript.');
  const document = value as Record<string, unknown>;
  if (document.schema !== 'eve.local-transcript' || !Array.isArray(document.segments)) {
    throw new Error('Unexpected transcript schema.');
  }
  const source = document.source;
  return {
    ...document,
    ...(source && typeof source === 'object' && !Array.isArray(source)
      ? { source: { ...source as Record<string, unknown>, path: undefined } } : {})
  };
}
type InternalJob = TranscriptionJob & { cancelled?: boolean; child?: ChildProcess };
const jobs = new Map<string, InternalJob>();
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

export function getTranscriptionJob(id: string): TranscriptionJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id,
    state: job.state,
    avenue: job.avenue,
    provider: job.provider,
    backend: job.backend,
    device: job.device,
    fallbacks: job.fallbacks ? [...job.fallbacks] : undefined,
    stage: job.stage,
    transcript: job.transcript,
    error: job.error
  };
}

export function cancelTranscriptionJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.state !== 'running') return false;
  job.cancelled = true;
  job.state = 'cancelled';
  if (job.child?.pid) void terminateProcessTree(job.child.pid);
  else job.child?.kill();
  return true;
}

/** audioPath must be authorized by the main-process file picker or broker. */
export async function startTranscriptionJob(input: {
  audioPath: string;
  engineRoot: string;
  outputRoot: string;
  pythonPath?: string;
}): Promise<{ id: string }> {
  const audio = path.resolve(input.audioPath);
  if (!(await stat(audio)).isFile()) throw new Error('Selected audio is not a file.');
  const root = path.resolve(input.engineRoot);
  const python = input.pythonPath ?? path.join(root, 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  if (!(await stat(python)).isFile() || !(await stat(path.join(root, 'ldw', '__main__.py'))).isFile())
    throw new Error('Transcription runtime is unavailable.');
  const id = randomUUID();
  if (jobs.size >= 64) {
    const old = [...jobs].find(([, job]) => job.state !== 'running');
    if (!old) throw new Error('Too many active transcription jobs.');
    jobs.delete(old[0]);
  }
  const output = path.join(path.resolve(input.outputRoot), id);
  await mkdir(output, { recursive: true });
  // The engine's downloader checks disk space at this root before creating model folders.
  // It must exist on the very first run, while packaged engine resources remain immutable.
  await mkdir(path.join(path.resolve(input.outputRoot), 'runtime'), { recursive: true });
  const job: InternalJob = { id, state: 'running' };
  jobs.set(id, job);
  void execute(job, { audio, root, python, output });
  return { id };
}

async function execute(job: InternalJob, runtime: { audio: string; root: string; python: string; output: string }): Promise<void> {
  try {
    const settings = getConfig().transcription ?? DEFAULT_TRANSCRIPTION_SETTINGS;
    const groq = await getSecret('transcriptionGroqApiKey');
    const openai = await getSecret('openaiApiKey');
    const cloudKey = settings.cloud.provider === 'openai' ? openai : groq;
    const gpu = settings.gpu.enabled ? await probeTranscriptionGpu(runtime.root) : transcriptionGpuCapability();
    const avenues = availableTranscriptionAvenues(settings, { groq, openai }, gpu);
    if (!avenues.length) throw new Error('No enabled transcription avenue is currently available.');
    const failures: string[] = [];
    for (const avenue of avenues) {
      if (job.cancelled) return;
      job.avenue = avenue;
      const provider = avenue === 'cloud' ? settings.cloud.provider : 'local';
      job.provider = provider as TranscriptionRuntimeProvider;
      const env: NodeJS.ProcessEnv = { ...process.env, LDW_ROOT: runtime.root,
        LDW_DATA_ROOT: path.join(path.dirname(runtime.output), 'runtime') };
      delete env.GROQ_API_KEY;
      delete env.OPENAI_API_KEY;
      if (provider === 'groq') env.GROQ_API_KEY = cloudKey!;
      if (provider === 'openai') env.OPENAI_API_KEY = cloudKey!;
      try {
        // Both local and cloud ASR need the local speaker models, tools and diarization dependencies.
        job.stage = 'Preparing verified local models (first use can download about 700 MB)…';
        await runChild(job, runtime.python, ['-m', 'ldw', 'models', 'fetch', '--yes'], runtime.root, env);
        if (job.cancelled) return;
        job.stage = avenue === 'gpu'
          ? `Transcribing on the GPU (${gpu.device ?? 'Vulkan'}) and separating speakers locally…`
          : provider === 'local'
          ? 'Transcribing and separating speakers locally…'
          : `Transcribing with ${provider === 'openai' ? 'OpenAI' : 'Groq'}; separating speakers locally…`;
        await runChild(job, runtime.python, ['-m', 'ldw', 'run', runtime.audio, '--asr', provider,
          ...asrDeviceArgs(avenue), '--output', runtime.output], runtime.root, env);
        if (job.cancelled) return;
        const file = path.join(runtime.output, 'eve-transcript.json');
        if ((await stat(file)).size > MAX_RESULT_BYTES) throw new Error('Transcript exceeds size limit.');
        const transcript = publicTranscriptionDocument(JSON.parse(await readFile(file, 'utf8')));
        const executed = executedAsrBackend(transcript, avenue);
        if (!executed) throw new Error(`The ${avenue} run did not prove it used the ${avenue} backend.`);
        job.backend = executed.backend;
        job.device = executed.device;
        job.transcript = transcript;
        job.state = 'completed';
        job.stage = 'Completed';
        return;
      } catch (error) {
        if (job.cancelled) return;
        failures.push(avenue);
        // An explicit, visible fallback: the next avenue runs and the job lists why this one failed.
        (job.fallbacks ??= []).push({ avenue, reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      }
    }
    throw new Error('All available transcription avenues failed: ' + failures.join(', '));
  } catch (error) {
    if (!job.cancelled) {
      job.state = 'failed';
      job.stage = 'Failed';
      job.error = error instanceof Error ? error.message : 'Transcription failed.';
    }
  } finally {
    job.child = undefined;
  }
}

function runChild(job: InternalJob, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Cancelled.'));
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore'] });
    job.child = child;
    child.once('error', () => reject(new Error('Transcription subprocess failed to start.')));
    child.once('close', (code) => {
      if (job.child === child) job.child = undefined;
      if (code === 0) resolve();
      else reject(new Error('Transcription subprocess exited unsuccessfully.'));
    });
  });
}
