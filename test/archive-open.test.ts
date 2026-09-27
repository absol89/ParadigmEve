import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifiedArchiveStaticIndex } from '../src/main/archive/archive-open.js';
import { DIR_LINK } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-archive-open-'));
  roots.push(parent);
  const archiveRoot = path.join(parent, 'archive');
  const siteRoot = path.join(archiveRoot, 'site');
  const indexPath = path.join(siteRoot, 'index.html');
  await fs.mkdir(siteRoot, { recursive: true });
  await fs.writeFile(indexPath, '<!doctype html>');
  return { archiveRoot, siteRoot, indexPath };
}

describe('verifiedArchiveStaticIndex', () => {
  it('returns only the exact regular main-owned archive/site/index.html', async () => {
    const target = await fixture();
    await expect(verifiedArchiveStaticIndex(target)).resolves.toBe(await fs.realpath(target.indexPath));

    const sibling = path.join(target.siteRoot, 'other.html');
    await fs.writeFile(sibling, 'other');
    await expect(verifiedArchiveStaticIndex({ ...target, indexPath: sibling })).rejects.toThrow('invalid');
  });

  it('rejects symbolic-link entry points before following them', async () => {
    const target = await fixture();
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async value => {
      const stat = await original(value);
      if (path.resolve(String(value)) !== path.resolve(target.siteRoot)) return stat;
      return new Proxy(stat, {
        get(current, property, receiver) {
          if (property === 'isSymbolicLink') return () => true;
          return Reflect.get(current, property, receiver);
        }
      });
    });

    await expect(verifiedArchiveStaticIndex(target)).rejects.toThrow('symbolic links');
  });

  it('rejects a real site junction escape even when the lexical target looks correct', async () => {
    const target = await fixture();
    const outside = path.join(path.dirname(target.archiveRoot), 'outside');
    const outsideIndex = path.join(outside, 'index.html');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(outsideIndex, 'outside');
    await fs.rm(target.siteRoot, { recursive: true });
    await fs.symlink(outside, target.siteRoot, DIR_LINK);

    await expect(verifiedArchiveStaticIndex(target)).rejects.toThrow('symbolic links or reparse points');
  });
});
