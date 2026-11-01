// Consistency and privacy checks for the v0.2 package. Runs only repository code; executes no
// contestant code. Exit code 1 on any problem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRubric } from './score-run.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const need = (ok, msg) => { if (!ok) problems.push(msg); };

const { rubric } = loadRubric();
const tierTotals = { quick: 40, full: 100 };
for (const [id, tier] of Object.entries(rubric.tiers)) {
  need(tier.tasks.reduce((n, t) => n + t.points, 0) === tierTotals[id], `${id}: task points must total ${tierTotals[id]}`);
  for (const t of tier.tasks) {
    let sum = 0;
    if (t.code) {
      const c = t.code;
      sum += Object.values(c.groups).reduce((a, b) => a + b, 0) + (c.visible ?? 0) + (c.claims_match ?? 0) + (c.scope_clean ?? 0) + (c.efficiency?.points ?? 0);
      for (const p of [`fixtures/${c.fixture}/package.json`, `reviewer/hidden/${c.fixture}`, `reviewer/variants/${c.fixture}.json`])
        need(fs.existsSync(path.join(root, p)), `${t.id}: missing ${p}`);
    }
    if (t.auto_raw) sum += t.auto_raw.points ?? t.points;
    if (t.probe) sum += Object.values(t.probe.checks).reduce((a, b) => a + b, 0);
    sum += Object.values(t.reviewer ?? {}).reduce((a, r) => a + r.points, 0);
    need(Math.abs(sum - t.points) < 1e-9, `${id}/${t.id}: parts sum to ${sum}, not ${t.points}`);
  }
}

// Contestant-facing files must not point into reviewer material.
for (const rel of ['EVEAL.md', ...fs.readdirSync(path.join(root, 'tasks')).map(f => 'tasks/' + f)]) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  need(!/\]\((\.\.\/)?reviewer\//.test(text), `${rel} links into reviewer/`);
}

// Privacy: no machine paths, mailboxes or held-out locations anywhere in the arena folder.
const arena = path.join(root, '..');
const PRIVATE = [/[A-Za-z]:[\\/]+Users[\\/]/, /\/c\/Users\//i, /eval-hold/i, /@gmail\.com/i, /side-session-notes/i];
const scan = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p === fileURLToPath(import.meta.url)) continue; // this file holds the patterns
    if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
    const text = fs.readFileSync(p).toString('latin1');
    for (const re of PRIVATE) need(!re.test(text), `private-looking text ${re} in ${path.relative(arena, p)}`);
  }
};
scan(arena);

if (problems.length) { for (const p of problems) console.error('x ' + p); process.exit(1); }
console.log('EVE-Al v0.2 package checks passed');
