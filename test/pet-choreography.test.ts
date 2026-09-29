import fs from 'node:fs';
import { expect, it } from 'vitest';
import type { PetAnimationManifest } from '../src/shared/pets.js';
import { carriedText, thrownText, throwRelease } from '../src/renderer/pet-choreography.js';

const manifest = JSON.parse(fs.readFileSync('pets/hammy/animations.json', 'utf8')) as PetAnimationManifest;
const release = throwRelease(manifest);

it('releases at the attached position in both directions without a discontinuity', () => {
  const hand = carriedText('throw', release - .001, 70, manifest);
  for (const facing of [1, -1] as const) {
    const start = thrownText({ x: 100, y: 100 }, facing, release, 70, { x: 400, y: 237 }, manifest);
    expect(start.x).toBeCloseTo(180 + facing * (hand.x - 80));
    expect(start.y).toBeCloseTo(100 + hand.y);
    expect(start.progress).toBe(0);
    const contact = thrownText({ x: 100, y: 100 }, facing, release + 600, 70, { x: 400, y: 237 }, manifest);
    expect(contact).toEqual({ x: 400, y: 219, progress: 1 });
  }
});

it('keeps carried text on the authored hand anchors through the whole carry loop', () => {
  for (let time = 0; time < 880; time += 10) {
    const point = carriedText('carry', time, 70, manifest);
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(160);
  }
});
