import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptDelivery } from '../src/delivery.js';

test('ack is terminal and never resends', async () => {
  const row = { status: 'pending', payload: 'hello' };
  let sends = 0;
  assert.equal(await attemptDelivery(row, async () => { sends++; return 'acked'; }), 'complete');
  assert.equal(await attemptDelivery(row, async () => { sends++; return 'acked'; }), 'complete');
  assert.equal(row.status, 'acked');
  assert.equal(sends, 1);
});

test('explicit rejection permits a later retry', async () => {
  const row = { status: 'pending', payload: 'hello' };
  assert.equal(await attemptDelivery(row, async () => 'rejected'), 'retry');
  assert.equal(row.status, 'pending');
  assert.equal(await attemptDelivery(row, async () => 'acked'), 'complete');
});

test('ambiguous send stays uncertain and is never automatically replayed', async () => {
  const row = { status: 'pending', payload: 'hello' };
  let sends = 0;
  assert.equal(await attemptDelivery(row, async () => { sends++; return 'unknown'; }), 'needs-review');
  assert.equal(row.status, 'uncertain');
  assert.equal(await attemptDelivery(row, async () => { sends++; return 'acked'; }), 'needs-review');
  assert.equal(sends, 1);
});
