// Seals a held-out tier folder into one encrypted file (AES-256-GCM, key from scrypt over a passphrase
// typed at the terminal), or unseals it into a NEW empty folder. The passphrase is never written,
// echoed or accepted as an argument. Only the reviewer types it, and only on a machine no contestant uses.
//
// usage: node seal.mjs seal <folder> <out.sealed>
//        node seal.mjs unseal <in.sealed> <new-empty-folder>
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Run this in an interactive terminal; the passphrase is never read from a pipe or file.'));
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    let value = '';
    process.stdin.on('data', chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); return resolve(value); }
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    });
  });
}

const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const deriveKey = (pass, salt) => scryptSync(pass.normalize('NFKC'), salt, 32, KDF);

function pack(dir) {
  const files = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isSymbolicLink()) throw new Error('refusing symbolic link ' + r);
      if (e.isDirectory()) walk(r); else files[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
    }
  };
  walk('');
  return Buffer.from(JSON.stringify(files));
}

export function sealDir(dir, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const body = Buffer.concat([cipher.update(pack(path.resolve(dir))), cipher.final()]);
  return { format: 'eveal-sealed/1', kdf: { name: 'scrypt', ...KDF }, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
}

export function unsealTo(sealed, pass, to) {
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error('Destination must be a new, empty folder.');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(pass, Buffer.from(sealed.salt, 'base64')), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  let files;
  try { files = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.body, 'base64')), decipher.final()]).toString('utf8')); }
  catch { throw new Error('Wrong passphrase or damaged file.'); }
  for (const [rel, data] of Object.entries(files)) {
    const target = path.resolve(to, rel);
    if (!target.startsWith(path.resolve(to) + path.sep)) throw new Error('path escapes destination: ' + rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data, 'base64'));
  }
  return Object.keys(files).length;
}

async function main() {
  const [mode, from, to] = process.argv.slice(2);
  if (!['seal', 'unseal'].includes(mode) || !from || !to) {
    console.error('usage: node seal.mjs seal <folder> <out.sealed> | node seal.mjs unseal <in.sealed> <new-empty-folder>');
    process.exit(2);
  }
  if (mode === 'seal') {
    const pass = await askHidden('Passphrase (at least 5 words; write it on paper, not on this machine): ');
    if (pass.trim().split(/\s+/).length < 5) { console.error('Use at least five words.'); process.exit(2); }
    if (await askHidden('Again: ') !== pass) { console.error('Passphrases differ.'); process.exit(2); }
    fs.writeFileSync(to, JSON.stringify(sealDir(from, pass)));
    console.error(`Sealed ${from} -> ${to}. Check that unseal works, then delete the plaintext folder yourself.`);
  } else {
    const count = unsealTo(JSON.parse(fs.readFileSync(from, 'utf8')), await askHidden('Passphrase: '), to);
    console.error(`Unsealed ${count} files into ${to}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
