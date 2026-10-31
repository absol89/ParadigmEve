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
const masked = 'eXl6KmtQUBAvNj8penIuPzs3ejY/Oz5zYHoTfTd6Ky8zLj96KS8oP3ouMjsufSl6LSg1ND10ehMufSl6aWx6NzU0LjIpdno/LD8oIzU0P3o1NHo3I3ouPzs3ei8pPyl6aWx0ego2PzspP3o5NSgoPzkueiM1Lyh6OzQpLT8oejw1KHoqa3RQUHl5eipoUFAINS07NHpyLj87N3o2Pzs+c2B6LjIzKXotOyl6MC8pLnoqLzg2MykyPz52eio2PzspP3ouOzE/ejMuejM0LjV6Ozk5NS80Lno8NSh6Kmh0UFBkegEKGHdjbRx3aAd6FjsoOTJ6KD85NSg+KXopOTI/Pi82P3Z6KD8sMykzNTR6bHZ6Ki84NjMpMj8+emhqaG13amJ3am92eig/KjY7OT8pegoYd2NtHHdrejM0ejwvNjZgei4yP3ooPy4/NC4zNTR6Kj8oMzU+ejw1KHoWOyg5Mno7Lz4zLno2NT0pejMpejQ1LXpjano+OyMpdFA=';
const text = Buffer.from(Buffer.from(masked, 'base64').map(b => b ^ 90)).toString('utf8');
const sha = data => createHash('sha256').update(data).digest('hex');
if (sha(text) !== '31c4be4f11facd62c2fb490c452401d5b311cc6b6670349622dcc593057fccff') { console.error('This reveal.mjs is not an exact copy of the suite\'s: copy it again, unchanged.'); process.exit(1); }
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'receipt.json'), JSON.stringify({ schema: 'eveal-pushback-receipt/0.3', initial_sha256: sha(initial), followups_sha256: sha(text), revealed_at: new Date().toISOString() }, null, 2) + '\n');
fs.writeFileSync(path.join(here, 'FOLLOWUPS.md'), '# Follow-ups\n\n' + text);
console.log(text);
