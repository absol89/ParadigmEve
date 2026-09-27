/** Fail-closed filesystem fence for canonical archive paths. */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class ArchivePathSecurityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ArchivePathSecurityError';
  }
}

type ArchivePathState = 'present' | 'missing';

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function containedPath(parent: string, child: string): boolean {
  const relative = path.relative(normalized(parent), normalized(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertLexicallyContained(archiveRoot: string, target: string): void {
  if (!containedPath(archiveRoot, target)) throw new ArchivePathSecurityError('ARCHIVE_PATH_ESCAPE');
}

async function lstatOrMissing(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Establishes the canonical archive root without following a pre-existing link. The root's
 * parent must already be a real directory; archive storage is always created below app-owned
 * durable storage, so inventing missing ancestors here would broaden the trust boundary.
 */
export async function ensureArchiveRoot(archiveRoot: string, create: boolean): Promise<ArchivePathState> {
  const root = path.resolve(archiveRoot);
  let entry = await lstatOrMissing(root);
  if (!entry) {
    if (!create) return 'missing';
    const parent = path.dirname(root);
    const parentEntry = await lstatOrMissing(parent);
    if (!parentEntry || parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
      throw new ArchivePathSecurityError('ARCHIVE_ROOT_PARENT_UNSAFE');
    }
    const realParent = await fs.realpath(parent);
    if (!samePath(realParent, parent)) throw new ArchivePathSecurityError('ARCHIVE_ROOT_PARENT_UNSAFE');
    try {
      await fs.mkdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    entry = await fs.lstat(root);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ArchivePathSecurityError('ARCHIVE_ROOT_UNSAFE');
  const realRoot = await fs.realpath(root);
  if (!samePath(realRoot, root)) throw new ArchivePathSecurityError('ARCHIVE_ROOT_UNSAFE');
  return 'present';
}

/**
 * Checks each existing directory component below archiveRoot with lstat + realpath. Missing
 * components are created one at a time only after their parent passed the fence.
 */
export async function ensureArchiveDirectory(archiveRoot: string, directory: string, create: boolean): Promise<ArchivePathState> {
  const root = path.resolve(archiveRoot);
  const target = path.resolve(directory);
  assertLexicallyContained(root, target);
  if (await ensureArchiveRoot(root, create) === 'missing') return 'missing';
  const realRoot = await fs.realpath(root);
  if (samePath(root, target)) return 'present';

  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry = await lstatOrMissing(current);
    if (!entry) {
      if (!create) return 'missing';
      try {
        await fs.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      entry = await fs.lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ArchivePathSecurityError('ARCHIVE_DIRECTORY_UNSAFE');
    const realCurrent = await fs.realpath(current);
    if (!samePath(realCurrent, current) || !containedPath(realRoot, realCurrent)) {
      throw new ArchivePathSecurityError('ARCHIVE_DIRECTORY_UNSAFE');
    }
  }
  return 'present';
}

/** Validates a canonical archive file and all of its parents without following links. */
export async function ensureArchiveFile(
  archiveRoot: string,
  file: string,
  options: { createParents: boolean }
): Promise<ArchivePathState> {
  const root = path.resolve(archiveRoot);
  const target = path.resolve(file);
  assertLexicallyContained(root, target);
  const parentState = await ensureArchiveDirectory(root, path.dirname(target), options.createParents);
  if (parentState === 'missing') return 'missing';

  const entry = await lstatOrMissing(target);
  if (!entry) return 'missing';
  if (entry.isSymbolicLink() || !entry.isFile()) throw new ArchivePathSecurityError('ARCHIVE_FILE_UNSAFE');
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(target);
  if (!samePath(realFile, target) || !containedPath(realRoot, realFile)) {
    throw new ArchivePathSecurityError('ARCHIVE_FILE_UNSAFE');
  }
  return 'present';
}

export function isArchivePathSecurityError(error: unknown): error is ArchivePathSecurityError {
  return error instanceof ArchivePathSecurityError;
}
