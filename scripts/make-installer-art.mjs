/**
 * Build the exact NSIS bitmap derivatives from ParadigmEve's two approved goddess portraits.
 *
 * The PNGs under artwork/installer are the canonical tracked artwork. NSIS still requires
 * 24-bit BI_RGB bitmaps, so packaging derives those into ignored build/installer-art output.
 * Nothing procedural or placeholder-like is drawn here.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'artwork', 'installer');
const outDir = path.join(root, 'build', 'installer-art');

const sources = {
  header: {
    file: path.join(sourceDir, 'goddess-header-source.png'),
    sha256: 'b205378dedd3933e6dbc0fec8053fe63fef74abc1a448611c20b431c414cd035',
  },
  sidebar: {
    file: path.join(sourceDir, 'goddess-sidebar-source.png'),
    sha256: '65bf6493cda42a9bb529712502567ec115f91a514098f894b4e8c2cff8652738',
  },
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertLockedSource(source) {
  if (!existsSync(source.file)) throw new Error(`missing approved installer artwork: ${path.relative(root, source.file)}`);
  const actual = sha256(readFileSync(source.file));
  if (actual !== source.sha256) {
    throw new Error(
      `approved installer artwork changed: ${path.relative(root, source.file)}\n` +
      `expected ${source.sha256}\nactual   ${actual}`
    );
  }
}

function rgbToBmp(rgb, width, height, channels) {
  if (channels !== 3) throw new Error(`expected three-channel RGB pixels, got ${channels}`);
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const out = Buffer.alloc(54 + pixelBytes);

  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30); // BI_RGB / uncompressed
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(3780, 38); // 96 DPI
  out.writeInt32LE(3780, 42);

  // Sharp returns top-down RGB; Windows BMP stores bottom-up BGR rows.
  for (let y = 0; y < height; y++) {
    const sourceRow = y * width * 3;
    const targetRow = 54 + (height - 1 - y) * rowStride;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 3;
      const target = targetRow + x * 3;
      out[target] = rgb[source + 2];
      out[target + 1] = rgb[source + 1];
      out[target + 2] = rgb[source];
    }
  }
  return out;
}

async function render(source, width, height, extract = null) {
  assertLockedSource(source);
  let image = sharp(source.file);
  if (extract) image = image.extract(extract);
  const { data, info } = await image
    .resize({ width, height, fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return rgbToBmp(data, width, height, info.channels);
}

// The approved wide portrait intentionally contains generous navy negative space. The NSIS
// header is tiny, so crop into the right-hand face/halo before downsampling; otherwise the
// identity reads as a distant thumbnail instead of the user's requested face crop.
const header = await render(sources.header, 150, 57, { left: 715, top: 80, width: 1320, height: 502 });
const sidebar = await render(sources.sidebar, 164, 314);
const outputs = [
  ['goddess-header.bmp', header],
  ['goddess-sidebar.bmp', sidebar],
  ['goddess-uninstaller-sidebar.bmp', sidebar],
];

const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  let mismatches = 0;
  for (const [name, data] of outputs) {
    const file = path.join(outDir, name);
    if (!existsSync(file) || !readFileSync(file).equals(data)) {
      console.error(`installer artwork is stale or missing: build/installer-art/${name}`);
      mismatches++;
    }
  }
  if (mismatches > 0) process.exit(1);
  console.log('ParadigmEve NSIS artwork matches the locked approved goddess portraits.');
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [name, data] of outputs) writeFileSync(path.join(outDir, name), data);
  console.log('Derived ParadigmEve NSIS artwork from the locked approved goddess portraits.');
}
