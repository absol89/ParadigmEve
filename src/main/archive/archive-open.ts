import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArchiveStaticSiteTarget } from './archive-runtime.js';
import { ensureArchiveDirectory, ensureArchiveFile, isArchivePathSecurityError } from './archive-path-security.js';

/**
 * Resolves the exact generated static archive entry point while refusing symlink/path escapes.
 * The renderer never supplies any part of this path; main owns the target end to end.
 */
export async function verifiedArchiveStaticIndex(target: ArchiveStaticSiteTarget): Promise<string> {
  const expectedSiteRoot = path.join(target.archiveRoot, 'site');
  const expectedIndex = path.join(expectedSiteRoot, 'index.html');
  if (path.relative(path.resolve(expectedSiteRoot), path.resolve(target.siteRoot)) !== '' ||
      path.relative(path.resolve(expectedIndex), path.resolve(target.indexPath)) !== '') {
    throw new Error('Archive static entry point is invalid.');
  }

  try {
    const siteState = await ensureArchiveDirectory(target.archiveRoot, target.siteRoot, false);
    const indexState = await ensureArchiveFile(target.archiveRoot, target.indexPath, { createParents: false });
    if (siteState === 'missing' || indexState === 'missing') {
      throw new Error('Archive static entry point is missing.');
    }
  } catch (error) {
    if (isArchivePathSecurityError(error)) {
      throw new Error('Archive static entry point may not use symbolic links or reparse points.');
    }
    throw error;
  }

  const indexPath = await fs.realpath(target.indexPath);
  const stat = await fs.stat(indexPath);
  if (!stat.isFile()) throw new Error('Archive static entry point is not a file.');
  return indexPath;
}
