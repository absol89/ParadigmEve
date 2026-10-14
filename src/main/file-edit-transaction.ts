/**
 * One edit of a document through an installed file-capability provider, as a transaction.
 *
 * The user's source file is never written. The provider works on a staged copy of it and saves
 * a staged output; Eve re-validates that output with the built-in reader, describes what changed,
 * and publishes it under a new name (or the user's "save as" path) that must not already exist.
 * If publishing fails, the staged output stays where it is and its path is reported.
 *
 * Providers are external programs with the user's OS permissions, so the only paths they are
 * given are the two staged files: every step argument that looks like a path is refused, and
 * `{{input}}` / `{{output}}` are the only way to name a file.
 */
import { createHash, randomUUID } from 'node:crypto';
import nodePath from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { rawPromises as fs } from './rawfs.js';
import { fileCapabilityProvider, type FidelityRisk } from './file-capabilities.js';
import { pluginManager } from './plugins/manager.js';
import { documentEntries, extensionFormat, readSource, sniffBuiltInFile } from './mcp/file-action.js';

export const INPUT_PLACEHOLDER = '{{input}}';
export const OUTPUT_PLACEHOLDER = '{{output}}';
const MAX_STEPS = 40;
const MAX_STEP_RESULT_CHARS = 600;
const MAX_DIFF_LINES = 40;
const MAX_DIFF_VALUE_CHARS = 120;
const STAGING_PREFIX = '.eve-staging-';

export interface EditStep { tool: string; arguments?: Record<string, unknown> }

export interface EditRequest {
  providerId: string;
  /** Real and virtual paths of the source, already resolved inside an approved root. */
  source: { real: string; virtual: string };
  /** Destination directory (real/virtual) and file name; resolved by the caller. */
  destination: { realDir: string; virtualDir: string; name: string };
  steps: readonly EditStep[];
  allowFeatureLoss: boolean;
}

export interface EditOutcome {
  output: string;
  provider: { id: string; version: string };
  steps: string[];
  diff: string[];
  validated: boolean;
}

export class EditRefused extends Error {}

/** One edit at a time per provider: its headless session holds one open document. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}

const PATHLIKE = /^[A-Za-z]:[\\/]|^\\\\|^\/|^~[\\/]|(^|[\\/])\.\.([\\/]|$)/;

/** Rewrites placeholders and refuses any other path-like string anywhere in the arguments. */
export function bindStepArguments(value: unknown, input: string, output: string, where = 'arguments'): unknown {
  if (typeof value === 'string') {
    if (value === INPUT_PLACEHOLDER) return input;
    if (value === OUTPUT_PLACEHOLDER) return output;
    if (PATHLIKE.test(value)) throw new EditRefused(`PATH_NOT_ALLOWED: ${where} names a path. Use "${INPUT_PLACEHOLDER}" for the file being edited and "${OUTPUT_PLACEHOLDER}" for the result.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => bindStepArguments(item, input, output, `${where}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindStepArguments(item, input, output, `${where}.${key}`)]));
  }
  return value;
}

/**
 * Whether another program has the source open. Office leaves an owner file beside a document it
 * has open, LibreOffice a lock file, and Windows refuses a write-open of a file another program
 * holds without write sharing.
 */
export async function sourceInUse(real: string): Promise<string | null> {
  const dir = nodePath.dirname(real);
  const name = nodePath.basename(real);
  const owners = [`~$${name}`, `~$${name.slice(2)}`, `.~lock.${name}#`];
  for (const owner of owners) {
    try {
      await fs.stat(nodePath.join(dir, owner));
      return `another program has ${name} open (it left ${owner})`;
    } catch { /* not present */ }
  }
  try {
    const handle = await fs.open(real, 'r+');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBUSY') return `${name} is open in another program`;
  }
  return null;
}

/** Documented losses that apply to this exact package. */
export function fidelityLosses(risks: readonly FidelityRisk[], bytes: Uint8Array): string[] {
  if (risks.length === 0) return [];
  const names: string[] = [];
  try {
    unzipSync(bytes, { filter(info) { names.push(info.name.replace(/\\/g, '/')); return false; } });
  } catch {
    return [];
  }
  const found = new Set<string>();
  const markerParts = new Set(risks.filter((risk) => risk.marker).map((risk) => risk.part));
  let texts: Record<string, string> = {};
  if (markerParts.size > 0) {
    try {
      const parts = unzipSync(bytes, { filter: (info) => markerParts.has(info.name) && info.originalSize <= 8 * 1024 * 1024 });
      texts = Object.fromEntries(Object.entries(parts).map(([name, data]) => [name, strFromU8(data)]));
    } catch { /* unreadable parts are reported by the built-in reader instead */ }
  }
  for (const risk of risks) {
    if (risk.marker) {
      if (texts[risk.part]?.includes(risk.marker)) found.add(risk.feature);
    } else if (names.some((name) => name.startsWith(risk.part))) {
      found.add(risk.feature);
    }
  }
  return [...found];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A compact, bounded description of what changed between two versions of a document. */
export function structuralDiff(before: Uint8Array, after: Uint8Array, name: string): { lines: string[]; validated: boolean } {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const builtIn = extensionFormat(name);
  if (!builtIn) {
    return { lines: [`bytes: ${before.length} → ${after.length}`, `sha256: ${digest(before)}… → ${digest(after)}…`], validated: false };
  }
  // Re-validation: the output must be a readable file of the same kind.
  const afterFile = sniffBuiltInFile(name, after);
  if (afterFile.format !== builtIn) throw new EditRefused(`OUTPUT_INVALID: the app saved ${afterFile.format} content under a .${builtIn} name.`);
  const afterEntries = documentEntries(afterFile);
  let beforeEntries: Map<string, string> | null = null;
  try { beforeEntries = documentEntries(sniffBuiltInFile(name, before)); } catch { beforeEntries = null; }
  if (!afterEntries || !beforeEntries) {
    return { lines: [`bytes: ${before.length} → ${after.length}`, `sha256: ${digest(before)}… → ${digest(after)}…`], validated: true };
  }
  const lines: string[] = [];
  let changes = 0;
  for (const [key, value] of afterEntries) {
    const old = beforeEntries.get(key);
    if (old === value) continue;
    changes++;
    if (lines.length < MAX_DIFF_LINES) {
      lines.push(old === undefined ? `+ ${key}: ${clip(value, MAX_DIFF_VALUE_CHARS)}` : `~ ${key}: ${clip(old, MAX_DIFF_VALUE_CHARS)} → ${clip(value, MAX_DIFF_VALUE_CHARS)}`);
    }
  }
  for (const [key, value] of beforeEntries) {
    if (afterEntries.has(key)) continue;
    changes++;
    if (lines.length < MAX_DIFF_LINES) lines.push(`- ${key}: ${clip(value, MAX_DIFF_VALUE_CHARS)}`);
  }
  if (changes > lines.length) lines.push(`… and ${changes - lines.length} more change(s)`);
  if (changes === 0) lines.push('no content change detected in the compared parts');
  return { lines, validated: true };
}

/** `name (Eve edit).ext`, then ` 2`, ` 3`, … until a name is free. */
export async function freeOutputName(realDir: string, sourceName: string): Promise<string> {
  const ext = nodePath.extname(sourceName);
  const stem = nodePath.basename(sourceName, ext);
  for (let n = 1; n <= 99; n++) {
    const candidate = `${stem} (Eve edit${n === 1 ? '' : ` ${n}`})${ext}`;
    try { await fs.stat(nodePath.join(realDir, candidate)); } catch { return candidate; }
  }
  throw new EditRefused('OUTPUT_NAME_UNAVAILABLE: choose an output_path.');
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; } catch { return false; }
}

/** Finds the app's one desktop executable inside its private installation, a few levels deep. */
async function findDesktopApp(root: string, name: string): Promise<string | null> {
  const matches: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || matches.length > 1) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(full);
    }
  };
  await walk(root, 0);
  return matches.length === 1 ? matches[0]! : null;
}

type VisibleLauncher = (executable: string, file: string) => Promise<void>;
/** Opens a document in a GUI app the way a double-click does: the path is its one argument. */
let launchVisible: VisibleLauncher = async (executable, file) => {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [file], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
};
/** Test seam: replaces the GUI launch. */
export function setVisibleLauncherForTests(launcher: VisibleLauncher | null): void {
  launchVisible = launcher ?? launchVisible;
}

/**
 * "Show me" / "teach me": the same copy rule as a headless edit, but the copy is opened in the
 * app's own window so Eve can work in it with Computer use while the user watches. Which route
 * runs is the op the model chose from the user's request; nothing in a file selects it.
 */
export async function openVisibleCopy(request: Omit<EditRequest, 'steps' | 'allowFeatureLoss'>): Promise<{ copy: string; app: string }> {
  const provider = fileCapabilityProvider(request.providerId);
  const installed = pluginManager.fileProvider(request.providerId);
  const directory = pluginManager.fileProviderDirectory(request.providerId);
  if (!provider || !installed || !directory) {
    throw new EditRefused(`PROVIDER_NOT_READY: ${provider?.displayName ?? request.providerId} is not installed. Offer it with file_edit install_provider first.`);
  }
  const slug = provider.id.replace(/^artcraft\./, '');
  const executable = await findDesktopApp(nodePath.join(directory, 'app'), `${slug}${process.platform === 'win32' ? '.exe' : ''}`);
  if (!executable) {
    throw new EditRefused(`VISIBLE_UNAVAILABLE: only ${provider.displayName}'s headless tool is installed on this system, so there is no window to show. Use edit, or open the file in an app the user already has with Computer use.`);
  }
  const destination = nodePath.join(request.destination.realDir, request.destination.name);
  if (await exists(destination)) throw new EditRefused(`OUTPUT_EXISTS: ${request.destination.virtualDir}/${request.destination.name} already exists; choose another output_path.`);
  const inUse = await sourceInUse(request.source.real);
  if (inUse) throw new EditRefused(`FILE_IN_USE: ${inUse}. Ask the user to save and close it first.`);
  const { constants } = await import('node:fs');
  await fs.copyFile(request.source.real, destination, constants.COPYFILE_EXCL);
  try {
    await launchVisible(executable, destination);
  } catch {
    throw new EditRefused(`VISIBLE_LAUNCH_FAILED: ${provider.displayName} could not be started. The copy is at ${request.destination.virtualDir}/${request.destination.name}.`);
  }
  return { copy: `${request.destination.virtualDir}/${request.destination.name}`, app: provider.displayName };
}

export function runProviderEdit(request: EditRequest): Promise<EditOutcome> {
  return serial(request.providerId, () => editOnce(request));
}

async function editOnce(request: EditRequest): Promise<EditOutcome> {
  const provider = fileCapabilityProvider(request.providerId);
  const installed = pluginManager.fileProvider(request.providerId);
  if (!provider || !installed || installed.status !== 'ready') {
    throw new EditRefused(`PROVIDER_NOT_READY: ${provider?.displayName ?? request.providerId} is not installed and running. Offer it with file_edit install_provider first.`);
  }
  if (request.steps.length === 0 || request.steps.length > MAX_STEPS) throw new EditRefused(`INVALID_STEPS: give 1-${MAX_STEPS} steps.`);
  const destination = nodePath.join(request.destination.realDir, request.destination.name);
  if (nodePath.resolve(destination).toLowerCase() === nodePath.resolve(request.source.real).toLowerCase()) {
    throw new EditRefused('SOURCE_PROTECTED: Eve never overwrites the original file. Choose a new output_path.');
  }
  if (await exists(destination)) throw new EditRefused(`OUTPUT_EXISTS: ${request.destination.virtualDir}/${request.destination.name} already exists; choose another output_path.`);
  const inUse = await sourceInUse(request.source.real);
  if (inUse) {
    throw new EditRefused(`FILE_IN_USE: ${inUse}. Do not race that program: ask the user to save and close it, or work in it with Computer use.`);
  }

  const source = await readSource(request.source.real);
  const ext = nodePath.extname(request.source.real).toLowerCase().slice(1);
  const losses = fidelityLosses(provider.unpreserved[ext] ?? [], source.bytes);
  if (losses.length > 0 && !request.allowFeatureLoss) {
    throw new EditRefused(
      `FIDELITY_RISK: ${provider.displayName} does not keep ${losses.join(', ')} when it saves, and this file has them. ` +
      'Tell the user. Edit it in its usual app with Computer use, or, only if the user accepts losing those in the new copy, retry with allow_feature_loss: true. The original is never changed.'
    );
  }

  // Both staged files live beside the destination, inside the approved folder, so a failed publish
  // leaves the result where the user can reach it and no copy ever leaves that folder.
  const token = randomUUID().slice(0, 8);
  const stagedInput = nodePath.join(request.destination.realDir, `${STAGING_PREFIX}${token}-source${nodePath.extname(request.source.real)}`);
  const stagedOutputName = `${STAGING_PREFIX}${token}-${request.destination.name}`;
  const stagedOutput = nodePath.join(request.destination.realDir, stagedOutputName);
  await fs.writeFile(stagedInput, source.bytes, { flag: 'wx' });
  let published = false;
  let keepOutput = false;
  try {
    const transcript: string[] = [];
    for (const [index, step] of request.steps.entries()) {
      const args = bindStepArguments(step.arguments ?? {}, stagedInput, stagedOutput, `steps[${index}].arguments`) as Record<string, unknown>;
      const result = await pluginManager.call(step.tool, args, undefined, { broker: request.providerId });
      const text = result.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join(' ');
      transcript.push(`${index + 1}. ${step.tool}: ${clip(text, MAX_STEP_RESULT_CHARS)}`);
      if (result.isError) {
        throw new EditRefused(`STEP_FAILED: step ${index + 1} (${step.tool}) failed. Nothing was published.\n${transcript.join('\n')}`);
      }
    }
    if (!(await exists(stagedOutput))) {
      throw new EditRefused(`EDIT_NOT_SAVED: no step saved to "${OUTPUT_PLACEHOLDER}". Finish with the app's save tool targeting "${OUTPUT_PLACEHOLDER}".\n${transcript.join('\n')}`);
    }
    const output = await readSource(stagedOutput);
    let diff: { lines: string[]; validated: boolean };
    try {
      diff = structuralDiff(source.bytes, output.bytes, request.destination.name);
    } catch (error) {
      await fs.rm(stagedOutput, { force: true });
      throw error instanceof EditRefused ? error : new EditRefused(`OUTPUT_INVALID: the saved file could not be read back (${(error as Error).message.slice(0, 200)}). Nothing was published.`);
    }
    try {
      // A hard link publishes atomically and fails if the name was taken meanwhile. Volumes
      // without hard links (FAT/exFAT) fall back to a rename after re-checking the name.
      try {
        await fs.link(stagedOutput, destination);
        await fs.rm(stagedOutput, { force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') || await exists(destination)) throw error;
        await fs.rename(stagedOutput, destination);
      }
      published = true;
    } catch {
      keepOutput = true;
      throw new EditRefused(
        `PUBLISH_FAILED: the edited copy is complete but could not be saved as ${request.destination.name}. ` +
        `It is kept at ${request.destination.virtualDir}/${stagedOutputName}.`
      );
    }
    return {
      output: `${request.destination.virtualDir}/${request.destination.name}`,
      provider: { id: provider.id, version: installed.version },
      steps: transcript,
      diff: diff.lines,
      validated: diff.validated
    };
  } finally {
    await fs.rm(stagedInput, { force: true }).catch(() => undefined);
    // An unpublished result is removed unless the user needs it because publishing failed.
    if (!published && !keepOutput) await fs.rm(stagedOutput, { force: true }).catch(() => undefined);
  }
}
