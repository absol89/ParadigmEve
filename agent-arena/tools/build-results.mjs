import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun } from './score.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = path.join(base, 'runs');
const entries = fs.readdirSync(runDir).filter(f => f.endsWith('.json') && !f.includes('.template.')).sort();
const ids = new Set();
const verified = [];
let unverified = 0;
for (const entry of entries) {
  const data = JSON.parse(fs.readFileSync(path.join(runDir, entry), 'utf8'));
  const result = scoreRun(data);
  if (ids.has(result.run_id)) throw new Error('Duplicate run_id: ' + result.run_id);
  ids.add(result.run_id);
  if (result.review.status === 'verified') verified.push(result);
  else unverified++;
}
verified.sort((a, b) => b.total - a.total || a.run_id.localeCompare(b.run_id));
const resultJson = { schema_version: '0.1', benchmark_version: '0.1.0', verified_count: verified.length, excluded_self_reports: unverified, results: verified };
const sanitize = s => String(s ?? '').replace(/[\r\n|]/g, ' ').slice(0, 160);
const rows = verified.map(x => '| ' + [
  sanitize(x.run_id), sanitize(x.agent.name), sanitize(x.agent.model),
  sanitize(x.agent.harness), `${x.total}/${x.max}`,
  ...['code', 'memory', 'hotlink', 'research', 'capability'].map(t => `${x.tracks[t].score}/${x.tracks[t].max}`),
  x.observations?.elapsed_minutes == null ? '—' : x.observations.elapsed_minutes + ' min',
  x.observations?.tool_calls == null ? '—' : String(x.observations.tool_calls),
  sanitize(x.review.reference)
].join(' | ') + ' |');
const md = [
  '# Agent Arena — independently reviewed results', '',
  'Only externally reviewed run receipts are shown. A runner or model cannot earn public points by reporting them without evidence and a review reference.', '',
  '| Run ID | Agent | Model | Harness | Total | Code | Recall | Hotlink | Research | Capability | Elapsed | Tool calls | Review receipt |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ...rows,
  ...(rows.length ? [] : ['| *No verified runs yet* | — | — | — | — | — | — | — | — | — | — | — | — |']),
  '', `Verified runs: ${verified.length}. Self-reported files not ranked: ${unverified}.`, '',
  'Scoring is a deterministic calculation of independently accepted check receipts. It does not authenticate submissions. Reviews must inspect reproducible tests and session evidence; no arbitrary participant code runs on Pages.', ''
].join('\n');
fs.writeFileSync(path.join(base, 'results.json'), JSON.stringify(resultJson, null, 2) + '\n');
fs.writeFileSync(path.join(base, 'RESULTS.md'), md);
console.log(`Built results: ${verified.length} verified, ${unverified} excluded self-reports`);
