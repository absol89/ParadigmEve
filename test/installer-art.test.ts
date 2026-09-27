import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';

const root = process.cwd();

function sha256(relativePath: string): string {
  return createHash('sha256').update(readFileSync(path.join(root, relativePath))).digest('hex');
}

function bmpInfo(relativePath: string): { width: number; height: number; bitsPerPixel: number; compression: number } {
  const bytes = readFileSync(path.join(root, relativePath));
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('BM');
  return {
    width: bytes.readInt32LE(18),
    height: Math.abs(bytes.readInt32LE(22)),
    bitsPerPixel: bytes.readUInt16LE(28),
    compression: bytes.readUInt32LE(30),
  };
}

describe('ParadigmEve installer artwork contract', () => {
  it('keeps the two approved goddess PNGs as the canonical locked artwork', () => {
    expect(sha256('artwork/installer/goddess-header-source.png')).toBe(
      'b205378dedd3933e6dbc0fec8053fe63fef74abc1a448611c20b431c414cd035'
    );
    expect(sha256('artwork/installer/goddess-sidebar-source.png')).toBe(
      '65bf6493cda42a9bb529712502567ec115f91a514098f894b4e8c2cff8652738'
    );
  });

  it('wires only generated goddess derivatives into every visible assisted-NSIS art slot', () => {
    const config = loadYaml(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as {
      nsis?: Record<string, unknown>;
    };
    expect(config.nsis).toMatchObject({
      oneClick: false,
      installerHeader: 'build/installer-art/goddess-header.bmp',
      installerSidebar: 'build/installer-art/goddess-sidebar.bmp',
      uninstallerSidebar: 'build/installer-art/goddess-uninstaller-sidebar.bmp',
    });
    expect(JSON.stringify(config.nsis)).not.toMatch(/artwork\/installer\/(?:header|sidebar|uninstaller-sidebar)\.bmp/);
  });

  it.each([
    ['build/installer-art/goddess-header.bmp', 150, 57],
    ['build/installer-art/goddess-sidebar.bmp', 164, 314],
    ['build/installer-art/goddess-uninstaller-sidebar.bmp', 164, 314],
  ] as const)('%s is a valid NSIS 24-bit uncompressed bitmap at the exact wizard size', (file, width, height) => {
    const generated = spawnSync(process.execPath, ['scripts/make-installer-art.mjs'], { cwd: root, encoding: 'utf8' });
    expect(generated.status, generated.stderr || generated.stdout).toBe(0);
    expect(bmpInfo(file)).toEqual({ width, height, bitsPerPixel: 24, compression: 0 });
  });

  it('rebuilds deterministically from the approved goddess sources', () => {
    const generated = spawnSync(process.execPath, ['scripts/make-installer-art.mjs'], { cwd: root, encoding: 'utf8' });
    expect(generated.status, generated.stderr || generated.stdout).toBe(0);
    const check = spawnSync(process.execPath, ['scripts/make-installer-art.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(check.status, check.stderr || check.stdout).toBe(0);
  });
});
