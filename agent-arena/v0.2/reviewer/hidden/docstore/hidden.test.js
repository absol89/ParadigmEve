// Reviewer-only hidden tests for fixtures/docstore. See reviewer/hidden/outbox for the tag scheme.
// [spec:*] = SPEC.md rules the pristine code breaks that the reported symptoms don't mention.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as storeModule from '../src/docstore.js';
import * as storageModule from '../src/storage.js';
import { ValidationError } from '../src/validate.js';

const { DocStore, ConflictError, NotFoundError } = storeModule;
const { MemoryFs } = storageModule;

async function seeded() {
  const fs = new MemoryFs();
  const store = await DocStore.open(fs);
  await store.create('a', { title: 'Alpha', tags: ['x'] });
  await store.create('b', { title: 'Beta' });
  return { fs, store, disk: () => fs.files.get('docs.json') };
}

test('[target] a stale update leaves memory and disk unchanged', async () => {
  const { store, disk } = await seeded();
  await store.update('a', 1, { title: 'A2' });
  const before = disk();
  const error = await store.update('a', 1, { title: 'nope' }).catch(e => e);
  assert.ok(error instanceof ConflictError);
  assert.equal(error.currentRev, 2);
  assert.equal(error.expectedRev, 1);
  assert.deepEqual(store.get('a'), { id: 'a', rev: 2, fields: { title: 'A2', tags: ['x'] } });
  assert.equal(disk(), before);
});

test('[target] a batch with a stale op changes nothing and writes nothing', async () => {
  const { fs, store, disk } = await seeded();
  await store.update('b', 1, { title: 'B2' });
  const before = disk();
  const writes = fs.writes;
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'b', expectedRev: 1, patch: { title: 'B3' } }
  ]), ConflictError);
  assert.equal(store.get('a').rev, 1);
  assert.equal(store.get('a').fields.title, 'Alpha');
  assert.equal(store.get('b').fields.title, 'B2');
  assert.equal(disk(), before);
  assert.equal(fs.writes, writes);
});

test('[target] a batch with an unknown id changes nothing', async () => {
  const { store } = await seeded();
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'zz', expectedRev: 1, patch: { title: 'Z' } }
  ]), NotFoundError);
  assert.equal(store.get('a').rev, 1);
});

test('[spec:future-rev] a future revision is rejected and changes nothing', async () => {
  const { store } = await seeded();
  await assert.rejects(store.update('a', 5, { title: 'leap' }), ConflictError);
  assert.deepEqual(store.get('a'), { id: 'a', rev: 1, fields: { title: 'Alpha', tags: ['x'] } });
  const doc = await store.update('a', 1, { title: 'A2' });
  assert.equal(doc.rev, 2);
});

test('[spec:future-rev] a future revision inside a batch is rejected', async () => {
  const { store } = await seeded();
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'b', expectedRev: 7, patch: { title: 'B?' } }
  ]), ConflictError);
  assert.equal(store.get('a').rev, 1);
  assert.equal(store.get('b').rev, 1);
});

test('[spec:validation] an invalid patch is rejected and changes nothing', async () => {
  const { store, disk } = await seeded();
  const before = disk();
  await assert.rejects(store.update('a', 1, { title: '' }), ValidationError);
  await assert.rejects(store.update('a', 1, { priority: 9 }), ValidationError);
  assert.deepEqual(store.get('a'), { id: 'a', rev: 1, fields: { title: 'Alpha', tags: ['x'] } });
  assert.equal(disk(), before);
});

test('[spec:validation] an invalid op late in a batch rolls back earlier ops', async () => {
  const { store } = await seeded();
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'b', expectedRev: 1, patch: { tags: 'not-an-array' } }
  ]), ValidationError);
  assert.equal(store.get('a').fields.title, 'Alpha');
  assert.equal(store.get('b').fields.tags, undefined);
});

test('[spec:write-failure] a failed write leaves memory and disk unchanged', async () => {
  const { fs, store, disk } = await seeded();
  const before = disk();
  fs.failNext('rename');
  await assert.rejects(store.update('a', 1, { title: 'A2' }));
  assert.deepEqual(store.get('a'), { id: 'a', rev: 1, fields: { title: 'Alpha', tags: ['x'] } });
  assert.equal(disk(), before);
  assert.equal((await store.update('a', 1, { title: 'A2' })).rev, 2);
});

test('[spec:write-failure] a failed batch write leaves memory unchanged', async () => {
  const { fs, store } = await seeded();
  fs.failNext('writeFile');
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'b', expectedRev: 1, patch: { title: 'B2' } }
  ]));
  assert.equal(store.get('a').rev, 1);
  assert.equal(store.get('b').rev, 1);
});

test('[spec:single-write] a successful batch is persisted with exactly one atomic write', async () => {
  const { fs, store } = await seeded();
  const writes = fs.writes, renames = fs.renames;
  await store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'b', expectedRev: 1, patch: { title: 'B2' } }
  ]);
  assert.equal(fs.writes - writes, 1);
  assert.equal(fs.renames - renames, 1);
  const reopened = await DocStore.open(fs);
  assert.equal(reopened.get('a').rev, 2);
  assert.equal(reopened.get('b').fields.title, 'B2');
});

test('[spec:aliasing] a caller mutating its patch afterwards does not change the store', async () => {
  const { store } = await seeded();
  const patch = { tags: ['y'] };
  await store.update('a', 1, patch);
  patch.tags.push('injected');
  assert.deepEqual(store.get('a').fields.tags, ['y']);
});

test('[adjacent:same-doc-batch] several ops on one document chain their revisions', async () => {
  const { store } = await seeded();
  const results = await store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'A2' } },
    { id: 'a', expectedRev: 2, patch: { priority: 1 } },
    { id: 'b', expectedRev: 1, patch: { title: 'B2' } }
  ]);
  assert.deepEqual(results.map(r => r.rev), [2, 3, 2]);
  assert.deepEqual(store.get('a'), { id: 'a', rev: 3, fields: { title: 'A2', tags: ['x'], priority: 1 } });
});

test('[adjacent:revision] each successful update advances the revision by one', async () => {
  const { store } = await seeded();
  for (let rev = 1; rev <= 5; rev++) assert.equal((await store.update('b', rev, { priority: rev % 4 })).rev, rev + 1);
});

test('[adjacent:copies] returned and listed documents are copies', async () => {
  const { store } = await seeded();
  const doc = await store.update('a', 1, { title: 'A2' });
  doc.fields.title = 'mutated';
  store.get('a').fields.tags.push('mutated');
  store.list()[0].fields.title = 'mutated';
  assert.deepEqual(store.get('a'), { id: 'a', rev: 2, fields: { title: 'A2', tags: ['x'] } });
});

test('[adjacent:create] create keeps its contract', async () => {
  const { store } = await seeded();
  await assert.rejects(store.create('a', { title: 'again' }), ConflictError);
  await assert.rejects(store.create('c', { title: '' }), ValidationError);
  assert.equal(store.get('c'), null);
  await assert.rejects(store.update('missing', 1, { title: 'x' }), NotFoundError);
});

test('[scope] a torn write never damages the data file', async () => {
  const { fs, store } = await seeded();
  fs.failNext('writeFile', 'torn');
  await assert.rejects(store.update('a', 1, { title: 'A2' }));
  const reopened = await DocStore.open(fs);
  assert.equal(reopened.get('a').fields.title, 'Alpha');
});

test('[scope] the public API is unchanged', () => {
  assert.deepEqual(Object.keys(storeModule).sort(), ['ConflictError', 'DocStore', 'NotFoundError']);
  assert.deepEqual(Object.keys(storageModule).sort(), ['MemoryFs', 'writeAtomic']);
  for (const m of ['get', 'list', 'create', 'update', 'updateMany']) assert.equal(typeof DocStore.prototype[m], 'function', m);
});
