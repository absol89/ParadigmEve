// Freezes the v0.3 rubric and scoring code: writes their combined hash to RUBRIC.lock. Rerun after any
// intended change to rubric.json, lib/ or tools/score.mjs; scores made before the change stay comparable
// only among themselves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockHash } from './score.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = lockHash();
fs.writeFileSync(path.join(root, 'RUBRIC.lock'), `${hash}  rubric.json + lib/*.mjs + tools/score.mjs (EVE-Al v0.3)\n`);
console.log('RUBRIC.lock ' + hash);
