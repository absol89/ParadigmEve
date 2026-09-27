/**
 * Generates ParadigmEve application and extension icons.
 *
 * Windows and the Chrome Companion use the user's approved icon artwork so the installer,
 * installed executable, taskbar/window icon, tray, and browser-extension identity all agree.
 * macOS/Linux retain the compact symbolic mark, which was designed specifically for those
 * platform icon treatments.
 *
 *   build/icon.ico            Windows app/installer icon (7 sizes)
 *   build/icon.png            1024 px macOS/Linux packaging source
 *   build/icon-preview.png    256 px preview
 *   build/runtime-icon.png    Linux BrowserWindow icon
 *   extension/icons/*.png     Chrome Companion icons
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const EXTENSION_SIZES = [128, 48, 32, 16];
const WINDOWS_ICON_SOURCE = path.join(root, 'artwork', 'icon.png');

const GOLD = [248, 190, 86];
const IVORY = [255, 236, 194];
const BLUE = [77, 182, 255];
const DEEP = [3, 10, 24];
const NAVY = [8, 24, 48];

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return a.map((value, index) => value + (b[index] - value) * t);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const length2 = vx * vx + vy * vy;
  const t = length2 > 0 ? clamp(((px - ax) * vx + (py - ay) * vy) / length2) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

function ellipseDistance(x, y, cx, cy, rx, ry, rotation = 0) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = x - cx;
  const dy = y - cy;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return Math.hypot(u / rx, v / ry);
}

function roundedSquareMask(x, y) {
  const radius = 0.19;
  const qx = Math.abs(x - 0.5) - (0.5 - radius);
  const qy = Math.abs(y - 0.5) - (0.5 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return clamp(0.006 - outside, 0, 0.006) / 0.006;
}

function addGlow(rgb, colour, strength) {
  for (let i = 0; i < 3; i++) rgb[i] += colour[i] * strength;
}

function sample(x, y) {
  const mask = roundedSquareMask(x, y);
  if (mask <= 0) return [0, 0, 0, 0];

  const radial = clamp(1 - Math.hypot(x - 0.5, y - 0.38) / 0.75);
  const vertical = clamp(y);
  const base = mix(NAVY, DEEP, vertical * 0.9);
  const rgb = base.map((value) => value * (0.82 + radial * 0.18));

  // Deterministic sparse star field, subtle enough not to turn into noise at small sizes.
  const star = Math.sin((x * 157.3 + y * 271.9) * 12.9898) * 43758.5453;
  const starFrac = star - Math.floor(star);
  if (starFrac > 0.996 && y < 0.72) addGlow(rgb, IVORY, (starFrac - 0.996) * 18);

  // Workshop halo: warm knowledge on the left, cool possibility on the right.
  const haloCx = 0.5;
  const haloCy = 0.38;
  const haloRadius = 0.285;
  const haloDistance = Math.abs(Math.hypot(x - haloCx, y - haloCy) - haloRadius);
  const haloColour = mix(GOLD, BLUE, clamp((x - 0.22) / 0.56));
  if (haloDistance < 0.06) addGlow(rgb, haloColour, clamp((0.06 - haloDistance) / 0.06) * 0.20);
  if (haloDistance < 0.0105) addGlow(rgb, haloColour, 0.82);

  // The apple/seed of knowledge, simple enough to survive the 16 px extension icon.
  const leftApple = ellipseDistance(x, y, 0.475, 0.405, 0.073, 0.078);
  const rightApple = ellipseDistance(x, y, 0.525, 0.405, 0.073, 0.078);
  const apple = Math.min(leftApple, rightApple);
  if (apple < 1.25) addGlow(rgb, GOLD, clamp((1.25 - apple) / 0.25) * 0.20);
  if (apple <= 1) {
    const edge = clamp((1 - apple) / 0.10);
    const appleColour = mix(GOLD, IVORY, clamp(0.30 + edge * 0.45));
    for (let i = 0; i < 3; i++) rgb[i] = rgb[i] * (1 - 0.88) + appleColour[i] * 0.88;
  }

  // Stem and leaf make the central symbol read as an apple rather than a generic orb.
  const stem = distanceToSegment(x, y, 0.502, 0.335, 0.515, 0.292);
  if (stem < 0.008) addGlow(rgb, IVORY, 0.95);
  const leaf = ellipseDistance(x, y, 0.555, 0.307, 0.050, 0.020, -0.55);
  if (leaf < 1) addGlow(rgb, mix(GOLD, BLUE, 0.35), 0.80);

  // One trunk becomes a tree of knowledge, then resolves into circuit-like roots.
  const branches = [
    [0.5, 0.48, 0.5, 0.72],
    [0.5, 0.54, 0.39, 0.48],
    [0.39, 0.48, 0.30, 0.41],
    [0.39, 0.48, 0.31, 0.56],
    [0.5, 0.54, 0.61, 0.48],
    [0.61, 0.48, 0.70, 0.41],
    [0.61, 0.48, 0.69, 0.56],
    [0.5, 0.66, 0.38, 0.76],
    [0.5, 0.66, 0.62, 0.76],
    [0.38, 0.76, 0.31, 0.86],
    [0.38, 0.76, 0.40, 0.91],
    [0.62, 0.76, 0.69, 0.86],
    [0.62, 0.76, 0.60, 0.91],
    [0.5, 0.72, 0.5, 0.93]
  ];
  for (const [ax, ay, bx, by] of branches) {
    const d = distanceToSegment(x, y, ax, ay, bx, by);
    if (d < 0.025) addGlow(rgb, mix(GOLD, BLUE, clamp((x - 0.32) / 0.36)), clamp((0.025 - d) / 0.025) * 0.15);
    if (d < 0.0065) addGlow(rgb, mix(IVORY, BLUE, clamp((x - 0.40) / 0.20)), 0.82);
  }

  for (const [cx, cy, colour] of [
    [0.31, 0.86, GOLD], [0.40, 0.91, BLUE], [0.5, 0.93, IVORY], [0.60, 0.91, BLUE], [0.69, 0.86, GOLD]
  ]) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < 0.018) addGlow(rgb, colour, clamp((0.018 - d) / 0.018));
  }

  for (const [cx, cy, rotation, colour] of [
    [0.287, 0.395, -0.72, GOLD], [0.30, 0.565, 0.72, BLUE],
    [0.713, 0.395, 0.72, BLUE], [0.70, 0.565, -0.72, GOLD]
  ]) {
    const leafDistance = ellipseDistance(x, y, cx, cy, 0.047, 0.018, rotation);
    if (leafDistance < 1.25) addGlow(rgb, colour, clamp((1.25 - leafDistance) / 0.25) * 0.20);
    if (leafDistance < 1) addGlow(rgb, colour, 0.72);
  }

  return [
    Math.round(clamp(rgb[0], 0, 255)),
    Math.round(clamp(rgb[1], 0, 255)),
    Math.round(clamp(rgb[2], 0, 255)),
    Math.round(mask * 255)
  ];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 4 : 2;
  const count = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const rgba = sample((px + (sx + 0.5) / samples) / size, (py + (sy + 0.5) / samples) / size);
          for (let channel = 0; channel < 4; channel++) sum[channel] += rgba[channel];
        }
      }
      const at = (py * size + px) * 4;
      for (let channel = 0; channel < 4; channel++) pixels[at + channel] = Math.round(sum[channel] / count);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const cache = new Map();
const pngFor = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(size, render(size)));
  return cache.get(size);
};

mkdirSync(path.join(root, 'build'), { recursive: true });
const windowsSource = readFileSync(WINDOWS_ICON_SOURCE);
const windowsMetadata = await sharp(windowsSource).metadata();
if (windowsMetadata.format !== 'png' || !windowsMetadata.width || !windowsMetadata.height) {
  throw new Error('artwork/icon.png must be a readable PNG image');
}
const windowsPngFor = async (size) => {
  // Preserve the user's exact bytes at the native source size when possible. Other ICO frames are
  // faithful Lanczos resamples of the same image; no procedural drawing or alternate face is used.
  if (windowsMetadata.width === size && windowsMetadata.height === size) return windowsSource;
  return sharp(windowsSource)
    .resize({ width: size, height: size, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
};

const icoImages = await Promise.all(ICO_SIZES.map(async (size) => ({ size, png: await windowsPngFor(size) })));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages));
writeFileSync(path.join(root, 'build', 'icon.png'), pngFor(1024));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), pngFor(256));
writeFileSync(path.join(root, 'build', 'runtime-icon.png'), pngFor(256));
console.log(`Wrote ParadigmEve app icons (${ICO_SIZES.join(', ')} px Windows set)`);

const iconsDir = path.join(root, 'extension', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of EXTENSION_SIZES) writeFileSync(path.join(iconsDir, `icon${size}.png`), await windowsPngFor(size));
console.log(`Wrote ParadigmEve extension icons (${EXTENSION_SIZES.join(', ')} px)`);
