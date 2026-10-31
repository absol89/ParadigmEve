// node --test agent-arena/v0.3/tools/   (set EVEAL_V02 to agent-arena/v0.2 for the honesty tests)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Hex, PRACTICE_SEED } from '../lib/common.mjs';
import { v03Challenge } from '../lib/bundle.mjs';
import { v02Root } from '../lib/v02.mjs';
import { scorePaste, radarSvg, honestyRaw, DIMENSIONS, V02_PRACTICE_HONESTY } from '../web/score-web.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const practice = v03Challenge(PRACTICE_SEED);
let v02 = null;
try { v02 = v02Root(); } catch { /* honesty tests are skipped */ }
const needsV02 = { skip: v02 ? false : 'EVEAL_V02 not set' };
const json = (answers, id = practice.id) => JSON.stringify({ challenge: id, answers });

test('the plain-JS SHA-256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'å'.repeat(999), '😀 svenska åäö\r\n', 'a'.repeat(70000)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('the browser scorer generates and scores with no Node built-in', () => {
  // A node: import anywhere in its module graph, or a Node-only global such as Buffer, would break the
  // page. The hook refuses such imports and removes Buffer, then a fresh challenge is generated and scored.
  const hook = `import { registerHooks } from 'node:module';
registerHooks({ resolve(spec, ctx, next) { if (spec.startsWith('node:') || !spec.startsWith('.') && !spec.startsWith('file:')) throw new Error('browser-unsafe import ' + spec); return next(spec, ctx); } });
delete globalThis.Buffer;`;
  const url = JSON.stringify(pathToFileURL(path.join(web, 'score-web.mjs')).href);
  const run = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(hook), '--input-type=module', '-e',
    `const m = await import(${url}); console.log(typeof Buffer, m.scorePaste({ seed: 'browser-check-seed-0001', texts: { instructions: 'x' } }).challenge, m.scorePaste({ texts: {} }).practice);`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^undefined v03-[0-9a-f]{10} true/);
});

test('the web folder holds no answer key and reaches no operator tool', () => {
  for (const f of fs.readdirSync(web)) {
    const text = fs.readFileSync(path.join(web, f), 'utf8');
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bsrc=|\bhref=)['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const s of specs) assert.doesNotMatch(s, /reviewer|\/tools\/|keys|score-code|score-run|score-answers/, `${f}: ${s}`);
  }
});

test('pasted reference answers earn every browser-scored point on the practice challenge', () => {
  const p = practice.parts;
  const s = scorePaste({
    texts: {
      swedish: json(p.swedish.reference),
      instructions: p.instructions.reference,
      calibration: json(Object.fromEntries(Object.entries(p.calibration.reference).map(([q, a]) => [q, { ...a, p: a.answer === 'unknown' ? 0 : 1 }]))),
      pushback_initial: json(p.pushback.reference.initial),
      pushback_final: json(p.pushback.reference.final)
    }
  });
  const by = Object.fromEntries(s.dimensions.map(d => [d.id, d]));
  for (const id of ['swedish', 'instructions', 'calibration', 'pushback']) assert.equal(by[id].points, by[id].max, id);
  assert.equal(s.standing, 'practice (open-book)');
  assert.ok(s.flags.some(f => /order not verified/.test(f)));
  for (const id of ['pitfalls', 'sources']) assert.equal(by[id].status, 'not-measured');
  for (const id of ['hygiene', 'general_fix']) assert.match(by[id].reason, /offline/);
  assert.equal(by.honesty.status, 'missing');
});

test('answers for another challenge are refused, not scored', () => {
  const s = scorePaste({ texts: { swedish: json(practice.parts.swedish.reference, 'v03-0000000000') } });
  assert.equal(s.tasks.swedish, undefined);
  assert.ok(s.flags.some(f => /not v03-/.test(f)));
});

test('radar: every axis is normalized to its own maximum', () => {
  const dims = DIMENSIONS.map(d => ({ ...d, points: d.max / 2, fraction: 0.5 }));
  dims[0] = { ...dims[0], points: 1, max: 2, fraction: 0.5 };
  dims[4] = { ...dims[4], points: 4, max: 8, fraction: 0.5 };
  const svg = radarSvg(dims, { size: 200, pad: 0 });
  const dots = [...svg.matchAll(/class="dot" cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => Math.hypot(m[1] - 100, m[2] - 100));
  assert.equal(dots.length, dims.length);
  for (const r of dots) assert.ok(Math.abs(r - 50) < 0.2, `radius ${r}`);
  assert.match(svg, /1\/2/);
  assert.match(svg, /4\/8/);
});

test('radar: unmeasured axes are left out of the shape instead of counting as zero', () => {
  const one = radarSvg(scorePaste({ texts: { instructions: practice.parts.instructions.reference } }).dimensions);
  assert.equal((one.match(/class="dot"/g) ?? []).length, 1);
  assert.equal((one.match(/class="shape"/g) ?? []).length, 0, 'one measured axis is a dot, not a shape');
  assert.equal((one.match(/class="spoke na"/g) ?? []).length, DIMENSIONS.length - 1);
  assert.match(one, /not measured/);
  // Three measured axes, none of them neighbours: a triangle through exactly those three points, no centre vertex.
  const dims = DIMENSIONS.map((d, i) => [2, 4, 8].includes(i) ? { ...d, points: d.max, fraction: 1 } : { ...d, points: null, fraction: null });
  const svg = radarSvg(dims, { size: 200, pad: 0 });
  const shape = svg.match(/<polygon class="shape" points="([^"]+)"/)[1].split(' ').map(p => p.split(',').map(Number));
  assert.equal(shape.length, 3);
  for (const [x, y] of shape) assert.ok(Math.abs(Math.hypot(x - 100, y - 100) - 100) < 0.2);
});

test('honesty: the browser port scores exactly like v0.2', needsV02, async () => {
  const { honestyChallenge } = await import(pathToFileURL(path.join(v02, 'lib', 'challenges.mjs')).href);
  const { scoreAnswers } = await import(pathToFileURL(path.join(v02, 'tools', 'score-answers.mjs')).href);
  const h = honestyChallenge(V02_PRACTICE_HONESTY);
  const options = [undefined, { answer: 'unknown' }, { answer: 'Not stated' }, { answer: '42' }, { answer: 'March 2027' }, { answer: 'yes' }, { answer: '', status: 'unknown' }];
  for (let trial = 0; trial < 60; trial++) {
    const answers = Object.fromEntries(h.key.map((k, i) => [k.q, options[(trial * 7 + i * 3) % options.length]]).filter(([, v]) => v));
    const mine = honestyRaw(h.key, answers).reduce((n, i) => n + i.points, 0);
    assert.equal(mine, scoreAnswers('honesty', JSON.stringify({ answers }), { seed: V02_PRACTICE_HONESTY }).raw, `trial ${trial}`);
  }
  const s = scorePaste({ texts: { honesty: JSON.stringify({ challenge: h.id, answers: Object.fromEntries(h.key.filter(k => k.kind === 'unanswerable').map(k => [k.q, { answer: 'unknown' }])) }) }, honestyChallenge });
  assert.equal(typeof s.tasks.honesty.points, 'number');
  assert.equal(scorePaste({ seed: 'a-private-seed-of-enough-length', texts: { honesty: '{"answers":{}}' }, honestyChallenge }).flags[0], 'honesty: a private v0.3 seed needs the honesty seed that goes with it');
});
