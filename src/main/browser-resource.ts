import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_BROWSER_RESOURCE_CHUNK_BYTES = 512 * 1024;

export type BrowserResourceSource = string | { bytes: Uint8Array };

export interface BrowserResourceDescriptor {
  id: string;
  size: number;
}

export interface BrowserResourceStoreOptions {
  /** Stable app-owned purpose. Browser callers never choose this value. */
  purpose: string;
  /** App-owned directory for this purpose. Keep different purposes in different stores. */
  directory: () => string;
  maxBytes: number;
  chunkBytes?: number;
}

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Main-process storage for bytes that one browser feature may consume through its own route.
 *
 * This is intentionally not a bridge/filesystem API. A feature binds one store to one private
 * purpose + directory, keeps path authorization in Electron, and exposes only opaque ids plus
 * bounded bytes after that feature has proved its own operation/document ownership. Native paths
 * never cross this class's public descriptor boundary.
 */
export class BrowserResourceStore {
  private readonly purpose: string;
  private readonly directory: () => string;
  private readonly maxBytes: number;
  readonly chunkBytes: number;
  private readonly purposeMarker = '.browser-resource-purpose';

  constructor(options: BrowserResourceStoreOptions) {
    if (!options.purpose.trim()) throw new Error('Browser resource purpose is required');
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new Error('Browser resource byte limit is invalid');
    }
    const chunkBytes = options.chunkBytes ?? DEFAULT_BROWSER_RESOURCE_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
      throw new Error('Browser resource chunk size is invalid');
    }
    this.purpose = options.purpose;
    this.directory = options.directory;
    this.maxBytes = options.maxBytes;
    this.chunkBytes = chunkBytes;
  }

  private id(value: string): string {
    if (!RESOURCE_ID.test(value)) throw new Error(`Invalid ${this.purpose} resource id`);
    return value;
  }

  /** Main-process-only path for feature-owned metadata/preview work. Never serialize this value. */
  localPath(id: string): string {
    return path.join(this.directory(), this.id(id));
  }

  private async ensureDirectory(): Promise<string> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true });
    const held = await fs.lstat(directory);
    if (!held.isDirectory() || held.isSymbolicLink()) {
      throw new Error(`The ${this.purpose} resource directory is not a real directory`);
    }
    const marker = path.join(directory, this.purposeMarker);
    try {
      await fs.writeFile(marker, this.purpose, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const markerStat = await fs.lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error(`The ${this.purpose} resource directory has an invalid purpose marker`);
    }
    const recorded = (await fs.readFile(marker, 'utf8')).trim();
    if (recorded !== this.purpose) {
      throw new Error(`The browser resource directory belongs to purpose "${recorded || 'unknown'}"`);
    }
    return directory;
  }

  async snapshot(source: BrowserResourceSource): Promise<BrowserResourceDescriptor> {
    const directory = await this.ensureDirectory();

    const id = randomUUID();
    const destination = path.join(directory, id);
    const sourceStat = typeof source === 'string' ? await fs.stat(source) : null;
    const size = typeof source === 'string' ? sourceStat!.size : source.bytes.byteLength;
    if (sourceStat && !sourceStat.isFile()) throw new Error('Browser resources must be individual files');
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes) {
      throw new Error(`The ${this.purpose} resource is too large`);
    }

    try {
      if (typeof source === 'string') {
        const input = await fs.open(source, 'r');
        const output = await fs.open(destination, 'wx');
        try {
          const buffer = Buffer.alloc(Math.min(this.chunkBytes, Math.max(1, size)));
          let offset = 0;
          while (offset < size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
            if (!bytesRead) throw new Error('The browser resource changed while being read; prepare it again');
            let written = 0;
            while (written < bytesRead) {
              written += (await output.write(buffer, written, bytesRead - written, offset + written)).bytesWritten;
            }
            offset += bytesRead;
          }
          const after = await input.stat();
          if (after.size !== size || after.mtimeMs !== sourceStat!.mtimeMs) {
            throw new Error('The browser resource changed while being read; prepare it again');
          }
        } finally {
          await input.close();
          await output.close();
        }
      } else {
        await fs.writeFile(destination, source.bytes, { flag: 'wx' });
      }
      return { id, size };
    } catch (error) {
      await fs.unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  async stat(resource: BrowserResourceDescriptor): Promise<Awaited<ReturnType<typeof fs.stat>>> {
    this.assertDescriptor(resource);
    await this.ensureDirectory();
    const target = this.localPath(resource.id);
    const linked = await fs.lstat(target);
    if (!linked.isFile() || linked.isSymbolicLink()) throw new Error(`The ${this.purpose} resource is unavailable`);
    const stat = await fs.stat(target);
    if (stat.size !== resource.size) throw new Error(`The ${this.purpose} resource changed`);
    return stat;
  }

  async validate(resource: BrowserResourceDescriptor): Promise<void> {
    await this.stat(resource);
  }

  async touch(resource: BrowserResourceDescriptor): Promise<void> {
    await this.stat(resource);
    const now = new Date();
    await fs.utimes(this.localPath(resource.id), now, now);
  }

  async remove(id: string): Promise<void> {
    await this.ensureDirectory();
    await fs.unlink(this.localPath(id)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async readChunk(resource: BrowserResourceDescriptor, offset: number): Promise<string> {
    this.assertDescriptor(resource);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > resource.size || offset % this.chunkBytes !== 0) {
      throw new Error(`Invalid ${this.purpose} resource offset`);
    }
    await this.ensureDirectory();
    const target = this.localPath(resource.id);
    const linked = await fs.lstat(target);
    if (!linked.isFile() || linked.isSymbolicLink()) throw new Error(`The ${this.purpose} resource is unavailable`);
    const handle = await fs.open(target, 'r');
    try {
      if ((await handle.stat()).size !== resource.size) throw new Error(`The ${this.purpose} resource changed`);
      const buffer = Buffer.alloc(Math.min(this.chunkBytes, resource.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error(`The ${this.purpose} resource read was incomplete`);
      return buffer.toString('base64');
    } finally {
      await handle.close();
    }
  }

  private assertDescriptor(resource: BrowserResourceDescriptor): void {
    this.id(resource.id);
    if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > this.maxBytes) {
      throw new Error(`Invalid ${this.purpose} resource size`);
    }
  }
}
