import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox, Status } from '../src/outbox.js';
import { runOnce } from '../src/worker.js';

const transport = (...outcomes) => {
  const sent = [];
  return {
    sent,
    async send(payload) {
      sent.push(payload);
      return outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    }
  };
};

test('an acknowledged message is delivered once', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'hello', 0);
  const t = transport({ outcome: 'acked', providerId: 'p1' });
  assert.equal(await runOnce(outbox, t, 'w1', 0), Status.ACKED);
  assert.equal(await runOnce(outbox, t, 'w1', 1_000), null);
  assert.deepEqual(t.sent, ['hello']);
  assert.equal(outbox.stats.delivered, 1);
});

test('an explicit rejection is retried after the backoff delay', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'hello', 0);
  const t = transport({ outcome: 'rejected' }, { outcome: 'acked' });
  assert.equal(await runOnce(outbox, t, 'w1', 0), Status.PENDING);
  assert.equal(await runOnce(outbox, t, 'w1', 1_000), null);
  assert.equal(await runOnce(outbox, t, 'w1', 2_000), Status.ACKED);
  assert.equal(t.sent.length, 2);
});

test('an expired lease sends the row to review instead of resending it', async () => {
  const outbox = new Outbox({ leaseMs: 5_000 });
  await outbox.enqueue('m1', 'hello', 0);
  await outbox.claimNext('w1', 0);
  assert.equal(await outbox.expireLeases(6_000), 1);
  const t = transport({ outcome: 'acked' });
  assert.equal(await runOnce(outbox, t, 'w2', 7_000), null);
  assert.equal(t.sent.length, 0);
});

test('after a restart, a message that was mid-send is not sent again automatically', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'hello', 0);
  await outbox.claimNext('w1', 0); // the process dies before the provider answers
  const restarted = new Outbox({ store: outbox.store });
  await restarted.recover(10_000);
  const t = transport({ outcome: 'acked' });
  for (let now = 10_000; now <= 120_000; now += 10_000) await runOnce(restarted, t, 'w1', now);
  assert.equal(t.sent.length, 0);
});
