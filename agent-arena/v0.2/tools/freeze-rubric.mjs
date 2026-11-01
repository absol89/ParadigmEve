// Writes RUBRIC.lock from the current rubric.json. Run once when a rubric version is frozen, before
// any comparison run; never after runs have started.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rubric = fs.readFileSync(path.join(root, 'rubric.json'));
const { version } = JSON.parse(rubric);
const hash = createHash('sha256').update(rubric).digest('hex');
fs.writeFileSync(path.join(root, 'RUBRIC.lock'), `${hash}  rubric.json  EVE-Al ${version}  frozen ${new Date().toISOString().slice(0, 10)}\n`);
console.log('RUBRIC.lock: ' + hash);
