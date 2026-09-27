/** SHA-256 content-addressed retained bytes. Filenames and extensions are metadata, never identity. */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArchiveBlobInspection, ArchiveBlobRef } from '../../shared/archive.js';
import { ensureArchiveDirectory, ensureArchiveFile } from './archive-path-security.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const EXTENSION_RE = /^[a-z0-9]{1,16}$/;

export interface ArchiveBlobMetadata {
  mimeType: string;
  extension?: string;
  width?: number;
  height?: number;
}

export interface StoredArchiveBlob {
  path: string;
  sha256: string | null;
  byteLength: number;
}

export function validArchiveSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

function normalizeExtension(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/^\.+/, '');
  return EXTENSION_RE.test(normalized) ? normalized : undefined;
}

function dimensions(metadata: ArchiveBlobMetadata): Pick<ArchiveBlobRef, 'width' | 'height'> {
  const out: Pick<ArchiveBlobRef, 'width' | 'height'> = {};
  if (metadata.width !== undefined) {
    if (!Number.isInteger(metadata.width) || metadata.width <= 0 || metadata.width > 1_000_000) throw new Error('ARCHIVE_BLOB_INVALID_WIDTH');
    out.width = metadata.width;
  }
  if (metadata.height !== undefined) {
    if (!Number.isInteger(metadata.height) || metadata.height <= 0 || metadata.height > 1_000_000) throw new Error('ARCHIVE_BLOB_INVALID_HEIGHT');
    out.height = metadata.height;
  }
  return out;
}

function blobRef(bytes: Uint8Array, metadata: ArchiveBlobMetadata): ArchiveBlobRef {
  const mimeType = metadata.mimeType.trim();
  if (!mimeType || mimeType.length > 255 || /[\r\n\0]/u.test(mimeType)) throw new Error('ARCHIVE_BLOB_INVALID_MIME');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = normalizeExtension(metadata.extension);
  return {
    sha256,
    mimeType,
    byteLength: bytes.byteLength,
    ...(extension ? { extension } : {}),
    ...dimensions(metadata)
  };
}

async function hashFile(file: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk: string | Buffer) => {
      byteLength += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), byteLength };
}

/** Canonical path contains only the content hash, so MIME/extension disagreement cannot duplicate bytes. */
export function archiveBlobPath(archiveRoot: string, sha256: string): string {
  if (!validArchiveSha256(sha256)) throw new Error('ARCHIVE_BLOB_INVALID_HASH');
  return path.join(archiveRoot, 'blobs', 'sha256', sha256.slice(0, 2), sha256);
}

export class ArchiveBlobStore {
  constructor(readonly archiveRoot: string) {}

  async put(bytes: Uint8Array, metadata: ArchiveBlobMetadata): Promise<ArchiveBlobRef> {
    const ref = blobRef(bytes, metadata);
    const target = archiveBlobPath(this.archiveRoot, ref.sha256);
    await ensureArchiveFile(this.archiveRoot, target, { createParents: true });

    if (await ensureArchiveFile(this.archiveRoot, target, { createParents: false }) === 'present') {
      const inspection = await this.inspect(ref);
      if (inspection.state !== 'present') throw new Error(`ARCHIVE_BLOB_COLLISION_OR_CORRUPTION: ${ref.sha256}`);
      return ref;
    }

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await ensureArchiveFile(this.archiveRoot, temporary, { createParents: false });
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await ensureArchiveFile(this.archiveRoot, temporary, { createParents: false });
      const staged = await hashFile(temporary);
      if (staged.sha256 !== ref.sha256 || staged.byteLength !== ref.byteLength) throw new Error('ARCHIVE_BLOB_STAGING_HASH_MISMATCH');
      try {
        await ensureArchiveFile(this.archiveRoot, target, { createParents: false });
        await fs.rename(temporary, target);
      } catch (error) {
        // Concurrent publication of the same content is success only after the winner verifies.
        if (await ensureArchiveFile(this.archiveRoot, target, { createParents: false }) !== 'present') throw error;
      }
      const inspection = await this.inspect(ref);
      if (inspection.state !== 'present') throw new Error(`ARCHIVE_BLOB_PUBLICATION_FAILED: ${ref.sha256}`);
      return ref;
    } finally {
      try {
        if (await ensureArchiveFile(this.archiveRoot, temporary, { createParents: false }) === 'present') await fs.rm(temporary, { force: true });
      } catch {
        // Never follow an unsafe or moved parent during cleanup.
      }
    }
  }

  async inspect(ref: ArchiveBlobRef): Promise<ArchiveBlobInspection> {
    if (!validArchiveSha256(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
      throw new Error('ARCHIVE_BLOB_INVALID_REF');
    }
    const file = archiveBlobPath(this.archiveRoot, ref.sha256);
    if (await ensureArchiveFile(this.archiveRoot, file, { createParents: false }) === 'missing') return { state: 'missing', ref, path: file };
    const actual = await hashFile(file);
    if (actual.sha256 !== ref.sha256 || actual.byteLength !== ref.byteLength) {
      return { state: 'corrupt', ref, path: file, actualSha256: actual.sha256, actualByteLength: actual.byteLength };
    }
    return { state: 'present', ref, path: file };
  }

  async scanStored(): Promise<StoredArchiveBlob[]> {
    const root = path.join(this.archiveRoot, 'blobs', 'sha256');
    if (await ensureArchiveDirectory(this.archiveRoot, root, false) === 'missing') return [];
    let prefixes: Dirent[];
    try {
      prefixes = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: StoredArchiveBlob[] = [];
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      const directory = path.join(root, prefix.name);
      await ensureArchiveDirectory(this.archiveRoot, directory, false);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.endsWith('.tmp')) continue;
        const file = path.join(directory, entry.name);
        if (await ensureArchiveFile(this.archiveRoot, file, { createParents: false }) !== 'present') continue;
        const stat = await fs.lstat(file);
        const sha256 = validArchiveSha256(entry.name) && entry.name.startsWith(prefix.name) ? entry.name : null;
        out.push({ path: file, sha256, byteLength: stat.size });
      }
    }
    return out.sort((left, right) => left.path.localeCompare(right.path));
  }

  async hashStoredFile(file: string): Promise<{ sha256: string; byteLength: number }> {
    if (await ensureArchiveFile(this.archiveRoot, file, { createParents: false }) !== 'present') throw new Error('ARCHIVE_BLOB_MISSING');
    return hashFile(file);
  }
}
