import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealDir, unsealTo } from './seal.mjs';

test('seal round-trips a folder and rejects a wrong passphrase', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eveal-seal-'));
  try {
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'reviewer', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(src, 'reviewer', 'keys', 'k.json'), '{"secret": 42}');
    const sealed = sealDir(src, 'five words make a passphrase');
    assert.ok(!JSON.stringify(sealed).includes('secret'));
    assert.throws(() => unsealTo(sealed, 'wrong words entirely here now', path.join(base, 'bad')), /Wrong passphrase/);
    assert.equal(unsealTo(sealed, 'five words make a passphrase', path.join(base, 'out')), 1);
    assert.equal(fs.readFileSync(path.join(base, 'out', 'reviewer', 'keys', 'k.json'), 'utf8'), '{"secret": 42}');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
