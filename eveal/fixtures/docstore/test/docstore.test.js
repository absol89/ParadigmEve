import test from 'node:test';
import assert from 'node:assert/strict';
import { DocStore, ConflictError } from '../src/docstore.js';
import { MemoryFs } from '../src/storage.js';

async function seeded() {
  const fs = new MemoryFs();
  const store = await DocStore.open(fs);
  await store.create('a', { title: 'Alpha' });
  await store.create('b', { title: 'Beta' });
  return { fs, store };
}

test('an update with the current revision applies once', async () => {
  const { store } = await seeded();
  const doc = await store.update('a', 1, { title: 'Alpha 2' });
  assert.equal(doc.rev, 2);
  assert.equal(store.get('a').fields.title, 'Alpha 2');
});

test('a stale revision is rejected and changes nothing', async () => {
  const { store } = await seeded();
  await store.update('a', 1, { title: 'Alpha 2' });
  await assert.rejects(store.update('a', 1, { title: 'Overwritten' }), ConflictError);
  assert.equal(store.get('a').fields.title, 'Alpha 2');
});

test('a batch with one conflicting op applies nothing', async () => {
  const { store } = await seeded();
  await store.update('b', 1, { title: 'Beta 2' });
  await assert.rejects(store.updateMany([
    { id: 'a', expectedRev: 1, patch: { title: 'Alpha 2' } },
    { id: 'b', expectedRev: 1, patch: { title: 'Beta 3' } }
  ]), ConflictError);
  assert.equal(store.get('a').fields.title, 'Alpha');
  assert.equal(store.get('a').rev, 1);
});

test('reopening the store sees persisted documents', async () => {
  const { fs, store } = await seeded();
  await store.update('b', 1, { tags: ['x'] });
  const reopened = await DocStore.open(fs);
  assert.deepEqual(reopened.get('b'), { id: 'b', rev: 2, fields: { title: 'Beta', tags: ['x'] } });
});
