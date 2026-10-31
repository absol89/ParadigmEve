// node --test agent-arena/v0.3/tools/endpoint.test.mjs   (needs EVEAL_V02 for v0.2's keys and scorers)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRACTICE_SEED } from '../lib/common.mjs';
import { v03Challenge } from '../lib/bundle.mjs';
import { v02Root } from '../lib/v02.mjs';
import { createHandler, memoryStore, verifyReceipt, seedsFor } from '../endpoint/core.mjs';

let v02 = null;
try { v02 = v02Root(); } catch { /* skipped */ }
const opts = { skip: v02 ? false : 'EVEAL_V02 not set' };
const b64 = buf => Buffer.from(buf).toString('base64');

async function setup() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const keys = Object.fromEntries(['pitfalls', 'sources'].map(k => [k, JSON.parse(fs.readFileSync(path.join(v02, 'reviewer', 'keys', k + '.json'), 'utf8'))]));
  const env = { SEED_SECRET: b64(crypto.getRandomValues(new Uint8Array(32))), SIGNING_KEY: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), V02_KEYS: JSON.stringify(keys) };
  const deps = { ...(await import(pathToFileURL(path.join(v02, 'lib', 'challenges.mjs')).href)), ...(await import(pathToFileURL(path.join(v02, 'tools', 'score-answers.mjs')).href)) };
  const handle = createHandler(env, deps, memoryStore());
  const call = async (method, route, body, ip = '203.0.113.7') => {
    const res = await handle(new Request('https://eveal.example' + route, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, body: await res.json() };
  };
  return { env, call, publicKey: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

test('endpoint: issue, fetch files, commit, reveal, score once, and a receipt that verifies', opts, async () => {
  const { env, call, publicKey } = await setup();
  const issued = await call('POST', '/v1/tickets');
  assert.equal(issued.status, 201);
  const { ticket, challenge } = issued.body;
  assert.notEqual(challenge, v03Challenge(PRACTICE_SEED).id);

  const files = await call('GET', `/v1/tickets/${ticket}/files`);
  const seeds = await seedsFor(env, ticket);
  const blob = JSON.stringify(files.body);
  assert.ok(!blob.includes(seeds.v03) && !blob.includes(env.SEED_SECRET), 'no seed or secret in the files');
  assert.ok(!Object.keys(files.body.files).some(f => /reveal|reviewer|tools\//.test(f)));
  assert.match(files.body.files['tasks/pushback.md'], /will give you\n {3}follow-ups/);
  assert.ok(files.body.honesty, 'the honesty block for this ticket');

  const ref = v03Challenge(seeds.v03).parts;
  const ids = a => JSON.stringify({ challenge, answers: a });
  const initial = ids(ref.pushback.reference.initial);
  const reveal = await call('POST', `/v1/tickets/${ticket}/pushback`, { initial });
  assert.equal(reveal.status, 200);
  assert.match(reveal.body.followups, /## p1/);
  assert.equal((await call('POST', `/v1/tickets/${ticket}/pushback`, { initial })).status, 200, 'the same commit again is fine');
  assert.equal((await call('POST', `/v1/tickets/${ticket}/pushback`, { initial: ids({ p1: { answer: 1 }, p2: { answer: 2 } }) })).status, 409, 'first commit wins');

  const texts = {
    swedish: ids(ref.swedish.reference), instructions: ref.instructions.reference,
    calibration: ids(Object.fromEntries(Object.entries(ref.calibration.reference).map(([q, a]) => [q, { ...a, p: a.answer === 'unknown' ? 0 : 1 }]))),
    pushback_final: ids(ref.pushback.reference.final), pitfalls: '{"answers": {}}', sources: '{"answers": {}}'
  };
  const scored = await call('POST', `/v1/tickets/${ticket}/score`, { texts });
  assert.equal(scored.status, 200, JSON.stringify(scored.body));
  const d = scored.body.payload.dimensions;
  assert.deepEqual({ swedish: d.swedish, instructions: d.instructions, calibration: d.calibration, pushback: d.pushback }, { swedish: 8, instructions: 8, calibration: 6, pushback: 6 });
  assert.equal(d.pitfalls, 0);
  assert.ok(Object.values(d).every(v => typeof v === 'number'), 'only totals, no per-item results');
  assert.equal(scored.body.payload.challenge, challenge);
  assert.ok(await verifyReceipt(publicKey, scored.body));
  const reordered = { signature: scored.body.signature, payload: Object.fromEntries(Object.entries(scored.body.payload).reverse()) };
  assert.ok(await verifyReceipt(publicKey, reordered), 'key order does not matter');
  assert.ok(!(await verifyReceipt(publicKey, { ...scored.body, payload: { ...scored.body.payload, total: 80 } })), 'a changed total fails');

  assert.equal((await call('POST', `/v1/tickets/${ticket}/score`, { texts })).status, 409, 'each ticket is scored once');
});

test('endpoint: pushback without a commit is not measured; bad tickets and floods are refused', opts, async () => {
  const { call } = await setup();
  const { ticket } = (await call('POST', '/v1/tickets')).body;
  const scored = await call('POST', `/v1/tickets/${ticket}/score`, { texts: { instructions: 'x' } });
  assert.equal(scored.body.payload.dimensions.pushback, undefined);
  assert.ok(scored.body.payload.notes.some(n => /pushback: .*not measured/.test(n)));
  assert.equal((await call('GET', '/v1/tickets/short/files')).status, 404);
  assert.equal((await call('POST', `/v1/tickets/${ticket}/score`, 'not json')).status, 409);
  const ip = '198.51.100.9';
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await call('POST', '/v1/tickets', null, ip)).status);
  assert.deepEqual(statuses.slice(-2), [201, 429]);
});
