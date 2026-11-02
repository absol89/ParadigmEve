import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ mkdtemp: vi.fn(), getconf: vi.fn(), log: vi.fn() }));
vi.mock('node:fs', () => ({ promises: { mkdtemp: fixture.mkdtemp } }));
vi.mock('node:child_process', () => ({ execFile: fixture.getconf }));
vi.mock('../src/main/logger.js', () => ({ logInfo: fixture.log }));
const { createTunnelWorkDir } = await import('../src/main/tunnel/workdir.js');
const originalPlatform = process.platform;
const missing = Object.assign(new Error('inherited temp removed'), { code: 'ENOENT' });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.spyOn(os, 'tmpdir').mockReturnValue('/missing-installer-temp');
  fixture.mkdtemp.mockResolvedValue('/canonical-temp/cglf-unique');
  fixture.getconf.mockImplementation((_file, _args, _opts, cb) => cb(null, '/canonical-temp/\n'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('macOS tunnel temporary directory', () => {
  it('uses the original directory without a subprocess when present', async () => {
    await expect(createTunnelWorkDir()).resolves.toBe('/canonical-temp/cglf-unique');
    expect(fixture.mkdtemp).toHaveBeenCalledWith(path.join('/missing-installer-temp', 'cglf-'));
    expect(fixture.getconf).not.toHaveBeenCalled();
  });
  it('recovers a deleted installer temp dir without mutating the parent environment', async () => {
    const original = process.env.TMPDIR;
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    await expect(createTunnelWorkDir()).resolves.toBe('/canonical-temp/cglf-unique');
    expect(fixture.getconf).toHaveBeenCalledWith('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'],
      { encoding: 'utf8', timeout: 3_000 }, expect.any(Function));
    expect(fixture.mkdtemp.mock.calls.map(c => c[0])).toEqual([
      path.join('/missing-installer-temp', 'cglf-'), path.join('/canonical-temp', 'cglf-')]);
    expect(process.env.TMPDIR).toBe(original);
    expect(fixture.log).toHaveBeenCalledOnce();
    expect(fixture.log.mock.calls[0]![0]).not.toContain('/canonical-temp');
  });
  it.each(['EACCES', 'ENOSPC', 'ENOTDIR'])('does not mask %s', async code => {
    const err = Object.assign(new Error(code), { code });
    fixture.mkdtemp.mockRejectedValueOnce(err);
    await expect(createTunnelWorkDir()).rejects.toBe(err);
    expect(fixture.getconf).not.toHaveBeenCalled();
  });
  it.each(['win32', 'linux'])('does not change %s behavior', async platform => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    await expect(createTunnelWorkDir()).rejects.toBe(missing);
  });
  it.each(['relative', '/bad\npath', '', '/bad\0path'])('rejects an untrusted canonical path', async output => {
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    fixture.getconf.mockImplementation((_file, _args, _opts, cb) => cb(null, output));
    await expect(createTunnelWorkDir()).rejects.toThrow('no usable user temporary directory');
  });
});
