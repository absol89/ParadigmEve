import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
const inventory = JSON.parse(await fs.readFile(path.join(noticeDirectory, 'sources.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const componentNotices = await fs.readFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'));
if (createHash('sha256').update(componentNotices).digest('hex') !== inventory.componentNoticesSha256) {
  throw new Error('Native component notice bytes differ from the reviewed inventory');
}
for (const [name, version] of Object.entries(inventory.packages)) {
  if (lock.packages[`node_modules/${name}`]?.version !== version) {
    throw new Error(`Native source review does not cover locked ${name}; expected ${version}`);
  }
}
const filenames = new Set();
for (const source of inventory.sources) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(source.file) || filenames.has(source.file)) {
    throw new Error(`Invalid or duplicate native source filename: ${source.file}`);
  }
  filenames.add(source.file);
  if (!source.url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 256 * 1024 * 1024) {
    throw new Error(`Incomplete native source identity: ${source.file}`);
  }
}
if (process.argv.includes('--check')) {
  console.log(`Validated ${inventory.sources.length} pinned native source archives and patches.`);
  process.exit(0);
}

const output = path.join(root, 'release', 'native-sources');
const archives = path.join(output, 'archives');
const vendored = path.join(noticeDirectory, 'vendored');

async function readIfPresent(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}

// Waits before each retry. A host's transient failure (GitHub's on-demand archive endpoint answered
// 504 three times inside six seconds during the 2.3.3 release) needs more than a few seconds to
// clear; a permanent refusal such as 404 or 406 fails at once instead of waiting this out.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];
const transientStatus = status => status === 408 || status === 429 || status >= 500;

async function download(source) {
  let failure;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        const error = new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
        if (!transientStatus(response.status)) error.permanent = true;
        throw error;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > source.bytes) throw new Error(`Native source exceeds reviewed size: ${source.file}`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      failure = error;
      if (error.permanent || /exceeds reviewed size/.test(error.message)) throw error;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) break;
      console.log(`Retrying ${source.file} in ${delay / 1000}s after: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw failure;
}
await fs.mkdir(archives, { recursive: true });
let index = 0;
let completed = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (index < inventory.sources.length) {
    const source = inventory.sources[index++];
    const destination = path.join(archives, source.file);
    // A previous run's copy, then a reviewed copy kept in the repository for hosts that refuse
    // CI runners (gitlab.gnome.org answers them 406), then the pinned URL. All pass the same
    // size and SHA-256 check below.
    const bytes = await readIfPresent(destination) ?? await readIfPresent(path.join(vendored, source.file)) ?? await download(source);
    if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      throw new Error(`Native source checksum mismatch: ${source.file}`);
    }
    await fs.writeFile(destination, bytes);
    if (++completed % 50 === 0) console.log(`Verified ${completed}/${inventory.sources.length} source files.`);
  }
}));
for (const name of ['sources.json', 'README.md', 'SOURCE-BUILD.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) {
  await fs.copyFile(path.join(noticeDirectory, name), path.join(output, name));
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), inventory.sources.map(source => `${source.sha256}  archives/${source.file}`).join('\n') + '\n');
const destination = path.join(root, 'release', 'ParadigmEve-Native-Sources.tar.gz');
// List the reviewed files explicitly: stale files from an older local build cannot enter the release.
const files = ['sources.json', 'README.md', 'SOURCE-BUILD.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt', 'SHA256SUMS.txt',
  ...inventory.sources.map(source => `archives/${source.file}`)];
const list = path.join(root, 'release', 'native-source-files.txt');
await fs.writeFile(list, files.join('\n') + '\n');
const result = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', destination, '-C', output, '-T', list], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Native source archive failed: ${result.status}`);
console.log(`Built ${path.basename(destination)} with ${inventory.sources.length} verified source files.`);
