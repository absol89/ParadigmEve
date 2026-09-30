import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import sharp from 'sharp';

// Every bundled pet, including ones Eve makes later, must meet the same visual contract the
// Vault page 15-desktop-pets-and-avatars.md describes (ported from Chat On Steroids 2.1.20).
const bundled = fs.readdirSync('pets', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

it('bundles at least one pet', () => { expect(bundled.length).toBeGreaterThan(0); });

it.each(bundled)('%s has 96 non-empty, transparent cells that stay inside their cell edges', async id => {
  const atlas = path.join('pets', id, 'atlas.png');
  const { data, info } = await sharp(atlas).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([1280, 1920]);
  const hashes = new Set<string>();
  const idleBounds: number[][] = [];
  for (let frame = 0; frame < 96; frame++) {
    const cell = Buffer.alloc(160 * 160 * 4);
    let pixels = 0, minX = 160, maxX = 0, minY = 160, maxY = 0;
    for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
      const from = ((Math.floor(frame / 8) * 160 + y) * info.width + frame % 8 * 160 + x) * 4;
      data.copy(cell, (y * 160 + x) * 4, from, from + 4);
      if (data[from + 3]! > 1) { pixels++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    expect(pixels, `${id} frame ${frame} is nearly empty`).toBeGreaterThan(400);
    expect(minX, `${id} frame ${frame} touches the left edge`).toBeGreaterThan(0);
    expect(maxX, `${id} frame ${frame} touches the right edge`).toBeLessThan(159);
    expect(minY, `${id} frame ${frame} touches the top edge`).toBeGreaterThan(0);
    expect(maxY, `${id} frame ${frame} touches the bottom edge`).toBeLessThan(159);
    hashes.add(createHash('sha256').update(cell).digest('hex'));
    if (frame >= 4 && frame <= 7) idleBounds.push([minX, maxX, minY, maxY]);
  }
  // A few authored animation holds may intentionally repeat a pose, but a mostly-static atlas
  // (for example a blink-only placeholder) is not an acceptable bundled desktop pet.
  expect(hashes.size, `${id} has too many repeated frames`).toBeGreaterThanOrEqual(90);
  // Idle is calm breathing: the silhouette may not jump around between its four frames.
  for (let axis = 0; axis < 4; axis++) {
    const spread = Math.max(...idleBounds.map(bounds => bounds[axis]!)) - Math.min(...idleBounds.map(bounds => bounds[axis]!));
    expect(spread, `${id} idle geometry axis ${axis}`).toBeLessThanOrEqual(8);
  }
});

it('ships the transparent bin variants used by the desktop overlay', async () => {
  for (const name of ['bin', 'bin-open', 'bin-hit']) {
    const meta = await sharp(`src/renderer/pet-assets/${name}.png`).metadata();
    expect(meta.hasAlpha, name).toBe(true);
    expect(meta.width).toBeLessThanOrEqual(32);
    expect(meta.height).toBeLessThanOrEqual(49);
  }
});
