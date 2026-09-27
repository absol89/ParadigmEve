import path from 'node:path';
import { app } from 'electron';
import { rawPromises as fs } from './rawfs.js';

export const VAULT_MANUAL_ROOT = 'paradigmeve-manual';
export const VAULT_CONTEXT_MARKER = '[[PARADIGMEVE_PACKAGED_VAULT:v1]]';
const VAULT_MANUAL_VIRTUAL_ROOT = `/${VAULT_MANUAL_ROOT}`;

const normalManualPath = (requested: string): string => requested.replace(/\\/g, '/').replace(/\/+$/g, '');

export function isVaultManualReadPath(requested: string): boolean {
  const normal = normalManualPath(requested);
  return normal === VAULT_MANUAL_VIRTUAL_ROOT || normal.startsWith(`${VAULT_MANUAL_VIRTUAL_ROOT}/`);
}

/** The shipped/current engineering Vault, outside app.asar in packaged builds. */
export function vaultManualDirectory(): string {
  return app?.isPackaged
    ? path.join(process.resourcesPath, 'docs', 'vault')
    : path.join(app?.getAppPath?.() ?? process.cwd(), 'docs', 'vault');
}

/** Physical, app-managed mirror users can inspect under Roaming AppData. */
export function vaultManualMirrorDirectory(userDataDirectory: string): string {
  return path.join(userDataDirectory, 'docs', 'vault');
}

/**
 * Synchronize the immutable shipped manual into the installation's durable AppData.
 *
 * The packaged/dev Vault remains canonical and continues to back `/paradigmeve-manual` and
 * `%how`. This mirror exists so browser-backed Eve/Eva and the user can also inspect the current
 * manual physically under `%APPDATA%\\ParadigmEve\\docs\\vault`. Only top-level Markdown files
 * are app-managed here: current pages are replaced byte-for-byte, stale Markdown pages from an
 * older build are removed, and unrelated AppData files are left alone.
 */
export async function syncVaultManualMirror(userDataDirectory: string): Promise<string> {
  const destination = vaultManualMirrorDirectory(userDataDirectory);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    const held = await fs.lstat(destination);
    if (held.isSymbolicLink() || !held.isDirectory()) {
      throw new Error('ParadigmEve manual mirror path is not a real directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(destination, { recursive: true });
  }

  const pages = await listVaultManualPages();
  const currentNames = new Set(pages.map(page => page.name.toLocaleLowerCase()));
  for (const entry of await fs.readdir(destination, { withFileTypes: true })) {
    if (path.extname(entry.name).toLowerCase() !== '.md' || currentNames.has(entry.name.toLocaleLowerCase())) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(`Stale manual path ${entry.name} is not a file.`);
    }
    await fs.rm(path.join(destination, entry.name), { force: true });
  }

  for (const page of pages) {
    const target = path.join(destination, page.name);
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      await fs.copyFile(page.real, temporary);
      await fs.rename(temporary, target);
      const synchronizedAt = new Date();
      await fs.utimes(target, synchronizedAt, synchronizedAt);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  return destination;
}

/**
 * Resolve only the app-owned read-only manual namespace.
 *
 * The manual is intentionally flat Markdown. Refusing traversal, nested paths and non-Markdown
 * files keeps this helper a documentation reader rather than a second filesystem sandbox.
 */
export async function resolveVaultManualReadPath(
  requested: string
): Promise<{ real: string; virtual: string } | null> {
  const normal = normalManualPath(requested);
  if (!isVaultManualReadPath(normal)) return null;

  const directory = vaultManualDirectory();
  if (normal === VAULT_MANUAL_VIRTUAL_ROOT) {
    const real = await fs.realpath(directory);
    return { real, virtual: VAULT_MANUAL_VIRTUAL_ROOT };
  }

  const relative = normal.slice(VAULT_MANUAL_VIRTUAL_ROOT.length + 1);
  if (!relative || relative.includes('/') || relative === '.' || relative === '..' || path.extname(relative).toLowerCase() !== '.md') {
    throw new Error('The ParadigmEve manual namespace contains only top-level Markdown pages.');
  }
  const rootReal = await fs.realpath(directory);
  const real = await fs.realpath(path.join(directory, relative));
  if (path.dirname(real).toLowerCase() !== rootReal.toLowerCase()) {
    throw new Error('The requested manual page is outside the packaged Vault.');
  }
  return { real, virtual: `${VAULT_MANUAL_VIRTUAL_ROOT}/${relative}` };
}

export interface VaultManualPage {
  name: string;
  real: string;
  virtual: string;
}

/** Only current top-level Markdown pages are visible through the app-owned manual namespace. */
export async function listVaultManualPages(): Promise<VaultManualPage[]> {
  const directory = vaultManualDirectory();
  const rootReal = await fs.realpath(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const pages: VaultManualPage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const real = await fs.realpath(path.join(directory, entry.name));
    if (path.dirname(real).toLowerCase() !== rootReal.toLowerCase()) {
      throw new Error(`Vault page ${entry.name} resolves outside the packaged Vault.`);
    }
    pages.push({ name: entry.name, real, virtual: `${VAULT_MANUAL_VIRTUAL_ROOT}/${entry.name}` });
  }
  return pages.sort((left, right) => {
    if (left.name === 'README.md') return -1;
    if (right.name === 'README.md') return 1;
    return left.name.localeCompare(right.name, 'en');
  });
}

function flatGlob(pattern: string): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

/** Safe glob expansion for the flat read-only manual namespace; null means it is not our path. */
export async function expandVaultManualReadGlob(requested: string): Promise<string[] | null> {
  const normal = normalManualPath(requested);
  if (!isVaultManualReadPath(normal)) return null;
  const relative = normal.slice(VAULT_MANUAL_VIRTUAL_ROOT.length + 1);
  if (!relative || relative.includes('/')) {
    throw new Error('Manual globs may match only top-level Markdown page names.');
  }
  const matcher = flatGlob(relative);
  return (await listVaultManualPages()).filter((page) => matcher.test(page.name)).map((page) => page.virtual);
}

/** Current manual as one ordered block for `%how` opening context. */
export async function readVaultManualText(): Promise<string> {
  const pages = await Promise.all((await listVaultManualPages()).map(async (page) => {
    const text = await fs.readFile(page.real, 'utf8');
    if (text.includes('\0')) throw new Error(`Vault page ${page.name} is not UTF-8 text`);
    return `\n\n<!-- ${page.name} -->\n${text.trim()}`;
  }));
  return pages.join('').trim();
}
