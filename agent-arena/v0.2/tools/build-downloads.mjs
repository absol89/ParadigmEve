// Builds byte-for-byte reproducible ZIPs (stored, fixed timestamps, sorted entries) of everything a
// contestant may receive. Nothing under reviewer/ or tools/ is ever packed.
//   downloads/<fixture>.zip      one fixture each
//   downloads/eveal-suite.zip    the offline Quick reveal + full-suite contestant material
// usage: node build-downloads.mjs [--check]   (--check fails if a committed ZIP is stale)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function collect(rel, prefix) {
  const out = [];
  const walk = r => {
    for (const e of fs.readdirSync(path.join(root, r), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.posix.join(r, e.name);
      if (e.name === 'node_modules' || e.name === '.stage' || p.startsWith('reviewer') || p.startsWith('tools')) continue;
      if (e.isDirectory()) walk(p); else out.push([path.posix.join(prefix, path.posix.relative(rel, p)), fs.readFileSync(path.join(root, p))]);
    }
  };
  walk(rel);
  return out;
}

export function buildAll() {
  const outputs = {};
  for (const f of ['outbox', 'docstore', 'control-port', 'probe-kit']) outputs[f + '.zip'] = zip(collect('fixtures/' + f, f));
  const suite = [['eveal-suite/EVEAL.md', fs.readFileSync(path.join(root, 'EVEAL.md'))],
    ...['tasks', 'corpus', 'fixtures'].flatMap(d => collect(d, 'eveal-suite/' + d)),
    ...['QUICK-RUN.template.json', 'FULL-RUN.template.json'].map(f => ['eveal-suite/runs/' + f, fs.readFileSync(path.join(root, 'runs', f))])];
  outputs['eveal-suite.zip'] = zip(suite);
  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(root, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  let stale = 0;
  for (const [name, data] of Object.entries(buildAll())) {
    const file = path.join(dir, name);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(data)) { console.error('stale: downloads/' + name); stale++; }
    } else fs.writeFileSync(file, data);
  }
  if (stale) process.exit(1);
  console.log(process.argv.includes('--check') ? 'downloads up to date' : 'downloads built');
}
