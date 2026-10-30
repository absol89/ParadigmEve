import path from 'node:path';
import { app } from 'electron';
import { rawPromises as fs } from './rawfs.js';
import type { Root } from '../shared/types.js';
import { selfMaintenanceRoots } from './self-maintenance.js';

/**
 * The EVE-Al Quick reveal that `%eveal` runs. Only the contestant material ships (EVEAL.md,
 * tasks, corpus, fixtures, run templates); answer keys, hidden tests and scoring tools never do,
 * because anything installed is readable by Eve and a key she can read makes every run worthless.
 */
export const EVEAL_SUITE_ROOT = 'paradigmeve-eveal';
export const EVEAL_RUNS_ROOT = 'eveal-runs';
export const EVEAL_RUN_ROOT = 'eveal-run';

/** The shipped suite, outside app.asar in packaged builds. */
export function evealSuiteDirectory(): string {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'eveal')
    : path.join(app?.getAppPath?.() ?? process.cwd(), 'eveal');
}

function namesEvealSuite(requested: string): boolean {
  const normal = requested.replace(/\\/g, '/').toLowerCase();
  if (normal === `/${EVEAL_SUITE_ROOT}` || normal.startsWith(`/${EVEAL_SUITE_ROOT}/`)) return true;
  // Native spelling, as copied from command output. Only absolute paths can name the suite, so
  // ordinary virtual paths never touch Electron's app state.
  if (!path.isAbsolute(requested) || normal.startsWith('/') && process.platform === 'win32') return false;
  const base = evealSuiteDirectory().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  return normal === base || normal.startsWith(`${base}/`);
}

/**
 * The suite as a read-only root, offered to the inspection tools only when a call names it.
 *
 * Handing it to `read`/`find`/`view_image` alone, rather than listing it among the approved
 * roots, keeps every write and command tool from ever seeing it, and the ordinary root
 * resolver then supplies traversal and link confinement unchanged.
 */
export function evealSuiteRoots(requestedPaths: readonly string[]): Root[] {
  return requestedPaths.some(namesEvealSuite) ? [{ name: EVEAL_SUITE_ROOT, path: evealSuiteDirectory() }] : [];
}

/**
 * Durable app-owned EVE-Al output root. Unlike `/appdata`, this narrow subtree is safe to expose
 * as an ordinary writable sandbox root to the one local chat that activated `%eveal`.
 */
export function evealRunsDirectory(): string | null {
  const appData = selfMaintenanceRoots().find((root) => root.name === 'appdata');
  return appData ? path.join(appData.path, EVEAL_RUNS_ROOT) : null;
}

function runTimestamp(startedAt: number): string {
  const iso = new Date(startedAt).toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
}

/**
 * One immutable-by-name output location per durable session. Milliseconds plus the session suffix
 * make accidental reuse impossible even if two sessions begin in the same clock tick.
 */
export async function ensureEvealRunDirectory(sessionId: string, startedAt: number): Promise<{
  root: Root;
  virtual: string;
  native: string;
} | null> {
  const runsDirectory = evealRunsDirectory();
  if (!runsDirectory) return null;
  const suffix = sessionId.split('-').at(-1)?.replace(/[^a-zA-Z0-9_]+/g, '').slice(-12) || 'session';
  const name = `eveal-run-${runTimestamp(startedAt)}-${suffix}`;
  const native = path.join(runsDirectory, name);
  await fs.mkdir(native, { recursive: true });
  return { root: { name: EVEAL_RUN_ROOT, path: native }, virtual: `/${EVEAL_RUN_ROOT}`, native };
}

/** Where an activated `%eveal` gets its opening context, the way `%how` gets the Vault's. */
export const EVEAL_CONTEXT_MARKER = '[[PARADIGMEVE_EVEAL_SUITE:v1]]';

export interface EvealOpeningOptions {
  /** Paste EVEAL.md itself, for a model that may not be able to read it. */
  inline: boolean;
  /** Whether this chat has a tool that reads files. */
  fileTools: boolean;
  /** Name the folder on disk. Only for a model running on this computer: the path names the user's account. */
  nativePath: boolean;
}

/** Where the suite is and, when asked, its steps. Never more than the contestant material ships. */
export async function evealOpeningContext(options: EvealOpeningOptions): Promise<string> {
  const lines = [
    '# EVE-Al suite',
    `The suite is read-only at /${EVEAL_SUITE_ROOT}; read its files there with the read tool, starting with /${EVEAL_SUITE_ROOT}/EVEAL.md. It holds the same files as the offline eveal-suite.zip download.`
  ];
  if (options.nativePath) {
    lines.push(`On this computer the same folder is ${evealSuiteDirectory()}. Use it as the source when a command copies suite files, such as the probe kit, into your output folder.`);
  }
  if (!options.fileTools) {
    lines.push('This chat has no tool that reads files, so it cannot read the task files or write the output folder. Tell the user that, show them the steps below and where the suite is, and stop. Never answer a task you have not read.');
  }
  if (options.inline) {
    const quick = await fs.readFile(path.join(evealSuiteDirectory(), 'EVEAL.md'), 'utf8').catch(() => null);
    if (quick && !quick.includes('\0')) lines.push(`## /${EVEAL_SUITE_ROOT}/EVEAL.md\n\n${quick.trim()}`);
  }
  return lines.join('\n\n');
}
