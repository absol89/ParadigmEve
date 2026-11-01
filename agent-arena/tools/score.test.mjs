import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun } from './score.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'SUBMISSION.template.json'), 'utf8'));
const fresh = () => structuredClone(base);
test('empty scored submission produces zero and cannot enter ranked results', () => {
  const score = scoreRun(fresh());
  assert.equal(score.total, 0);
  assert.equal(score.review.status, 'self-reported');
});
test('all passed checks exactly total 100', () => {
  const v = fresh();
  for (const item of Object.values(v.tasks)) {
    item.evidence.push('public-reviewed-receipt-example');
    for (const key of Object.keys(item.checks)) item.checks[key] = true;
  }
  v.review = { status: 'verified', reviewer: 'test-reviewer', reference: 'https://example.org/test' };
  const scored = scoreRun(v);
  assert.equal(scored.total, 100);
  assert.deepEqual(Object.fromEntries(Object.entries(scored.tracks).map(([k, x]) => [k, x.score])),
    { code: 30, memory: 25, hotlink: 20, research: 15, capability: 10 });
});
test('verified claim without reviewer is rejected', () => {
  const v = fresh();
  v.review.status = 'verified';
  assert.throws(() => scoreRun(v), /reviewer/);
});
test('unsubstantiated passed check is rejected', () => {
  const v = fresh();
  v.tasks['code-uncertain-send'].checks['test-suite-green'] = true;
  assert.throws(() => scoreRun(v), /evidence/);
});
test('invalid task/check is rejected', () => {
  const v = fresh();
  v.tasks['code-uncertain-send'].checks['magic'] = true;
  assert.throws(() => scoreRun(v), /Unknown check/);
});
