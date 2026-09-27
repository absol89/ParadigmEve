import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BrowserResourceStore } from '../src/main/browser-resource.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let base: string;
let uploadDirectory: string;

beforeEach(async () => {
  base = await makeTempDir('eve-browser-resource-');
  uploadDirectory = path.join(base, 'uploads');
});

afterEach(async () => {
  await removeTempDir(base);
});

it('snapshots bytes behind opaque ids without exposing the source path', async () => {
  const store = new BrowserResourceStore({ purpose: 'test upload', directory: () => uploadDirectory, maxBytes: 1024, chunkBytes: 4 });
  const source = path.join(base, 'secret-name.txt');
  await fs.writeFile(source, 'abcdefghij');

  const resource = await store.snapshot(source);
  await fs.writeFile(source, 'later edit');

  expect(resource).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/i), size: 10 });
  expect(JSON.stringify(resource)).not.toContain(base);
  expect(Buffer.from(await store.readChunk(resource, 0), 'base64').toString()).toBe('abcd');
  expect(Buffer.from(await store.readChunk(resource, 8), 'base64').toString()).toBe('ij');
  await expect(store.readChunk(resource, 1)).rejects.toThrow(/offset/i);
});

it('binds a storage directory to one purpose even when another feature knows an opaque id', async () => {
  const uploads = new BrowserResourceStore({ purpose: 'upload', directory: () => uploadDirectory, maxBytes: 1024 });
  const previews = new BrowserResourceStore({ purpose: 'preview', directory: () => uploadDirectory, maxBytes: 1024 });
  const resource = await uploads.snapshot({ bytes: Buffer.from('owned') });

  await expect(previews.readChunk(resource, 0)).rejects.toThrow(/belongs to purpose/i);
  expect(Buffer.from(await uploads.readChunk(resource, 0), 'base64').toString()).toBe('owned');
});

it('rejects symlink-backed resources and size spoofing', async () => {
  const store = new BrowserResourceStore({ purpose: 'upload', directory: () => uploadDirectory, maxBytes: 1024 });
  const resource = await store.snapshot({ bytes: Buffer.from('safe') });
  await expect(store.validate({ ...resource, size: resource.size + 1 })).rejects.toThrow(/changed/i);

  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await store.remove(resource.id);
  await fs.symlink(outside, store.localPath(resource.id), DIR_LINK);
  await expect(store.readChunk(resource, 0)).rejects.toThrow(/unavailable/i);
});
