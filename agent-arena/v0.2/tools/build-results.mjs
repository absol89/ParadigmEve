// Builds results.json and RESULTS.md from scored runs in runs/scored/*.json (outputs of score-run.mjs).
// Only verified runs are listed; self-reports are counted and excluded. No row is ever invented.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRubric } from './score-run.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'runs', 'scored');
const { hash } = loadRubric();
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const verified = [];
let excluded = 0;
const ids = new Set();
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (ids.has(r.run_id)) throw new Error('duplicate run_id ' + r.run_id);
  ids.add(r.run_id);
  if (r.rubric_sha256 !== hash) throw new Error(`${f} was scored against a different rubric`);
  if (r.review?.status === 'verified' && r.review.reviewer && r.review.reference) verified.push(r); else excluded++;
}
verified.sort((a, b) => a.tier.localeCompare(b.tier) || b.percent - a.percent || a.run_id.localeCompare(b.run_id));
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ schema: 'eveal-results/0.2', rubric_sha256: hash, verified_count: verified.length, excluded_self_reports: excluded, results: verified }, null, 2) + '\n');
const safe = s => String(s ?? '').replace(/[\r\n|]/g, ' ').slice(0, 120);
const rows = verified.map(r => `| ${[r.run_id, r.agent.name, r.agent.persona, r.agent.model, r.agent.harness, r.tier, `${r.total}/${r.applicable_max}`, r.tasks?.honesty?.receipt?.stats?.fabricated ?? '—', r.review.reference].map(safe).join(' | ')} |`);
fs.writeFileSync(path.join(root, 'RESULTS.md'), [
  '# EVE-Al suite v0.2: verified results', '',
  `Rubric SHA-256: \`${hash}\``, '',
  '| Run | Agent | Persona | Model | Harness | Tier | Score | Fabricated | Review |',
  '| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |',
  ...(rows.length ? rows : ['| *No verified runs yet* | | | | | | | | |']), '',
  `Verified: ${verified.length}. Self-reports excluded: ${excluded}. Quick (out of 40) and full (out of 100, or 95 offline) scores are different scales; don't compare them.`, ''
].join('\n'));
console.log(`results: ${verified.length} verified, ${excluded} excluded`);
