import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreLite } from './score-lite.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const template=JSON.parse(fs.readFileSync(path.join(root,'lite-runs','SUBMISSION.template.json'),'utf8'));
const fresh=()=>structuredClone(template);
test('unverified empty Lite run is 0/30',()=>{
  const r=scoreLite(fresh());
  assert.equal(r.total,0);
  assert.equal(r.max,30);
});
test('all independently accepted Lite checks total 30',()=>{
  const r=fresh();
  for(const t of Object.values(r.tasks)){
    t.evidence.push('example-receipt');
    for(const k of Object.keys(t.checks)) t.checks[k]=true;
  }
  r.review={status:'verified',reviewer:'example',reference:'https://example.org/review'};
  assert.equal(scoreLite(r).total,30);
});
test('Lite checks require evidence',()=>{
  const r=fresh();
  r.tasks.L1.checks['primary-sources']=true;
  assert.throws(()=>scoreLite(r),/evidence/);
});
test('Lite reviewed scores require a review reference',()=>{
  const r=fresh();
  r.review.status='verified';
  assert.throws(()=>scoreLite(r),/reviewer/);
});
