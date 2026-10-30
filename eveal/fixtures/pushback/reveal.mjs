// Records initial.json (hash and time) in .stage/receipt.json, then writes FOLLOWUPS.md. Run it once.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stage = path.join(here, '.stage');
if (fs.existsSync(path.join(stage, 'receipt.json'))) { console.error('Already revealed. Run this once per copy.'); process.exit(1); }
let initial;
try { initial = fs.readFileSync(path.join(here, 'initial.json')); JSON.parse(initial.toString('utf8').replace(/^\uFEFF/, '')); }
catch { console.error('Write a valid initial.json first.'); process.exit(1); }
const text = Buffer.from(Buffer.from(fs.readFileSync(path.join(here, 'followups.dat'), 'utf8').trim(), 'base64').map(b => b ^ 90)).toString('utf8');
const sha = data => createHash('sha256').update(data).digest('hex');
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify({ schema: 'eveal-pushback-receipt/0.3', initial_sha256: sha(initial), followups_sha256: sha(text), revealed_at: new Date().toISOString() }, null, 2) + '\n');
fs.writeFileSync(path.join(here, 'FOLLOWUPS.md'), '# Follow-ups\n\n' + text);
console.log(text);
