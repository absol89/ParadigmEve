// Reviewer-only hidden tests for fixtures/outbox. Tag format: [group] or [group:subgroup].
// [target] = the reported defect, [adjacent:*] = invariants the pristine code already keeps,
// [scope] = things an unrelated edit would break (scored as penalties, not points).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as outboxModule from '../src/outbox.js';
import * as backoff from '../src/backoff.js';
import { runOnce } from '../src/worker.js';

const { Outbox, Status } = outboxModule;
const transport = (...outcomes) => {
  const sent = [];
  return { sent, async send(payload) { sent.push(payload); return outcomes.length > 1 ? outcomes.shift() : outcomes[0]; } };
};
async function crashMidSend(opts = {}) {
  const before = new Outbox(opts);
  await before.enqueue('m1', 'hello', 0);
  const claimed = await before.claimNext('w1', 0);
  const after = new Outbox({ ...opts, store: before.store });
  return { before, after, claimed };
}

test('[target:state] a row recovered mid-send waits for review as uncertain', async () => {
  const { after } = await crashMidSend();
  assert.equal(await after.recover(5_000), 1);
  const row = await after.store.get('m1');
  assert.equal(row.status, Status.UNCERTAIN);
  assert.equal(row.lease, null);
  assert.equal(row.attempts, 1);
});

test('[target:no-replay] a recovered row is never sent again by workers or lease sweeps', async () => {
  const { after } = await crashMidSend({ leaseMs: 1_000 });
  await after.recover(5_000);
  const t = transport({ outcome: 'acked' });
  for (let now = 5_000; now <= 600_000; now += 7_000) {
    await after.expireLeases(now);
    await runOnce(after, t, 'w1', now);
    await runOnce(after, t, 'w2', now);
  }
  assert.equal(t.sent.length, 0);
});

test('[target:no-replay] recovery is idempotent across repeated restarts', async () => {
  const { after } = await crashMidSend();
  await after.recover(5_000);
  const once = await after.store.get('m1');
  const again = new Outbox({ store: after.store });
  assert.equal(await again.recover(6_000), 0);
  assert.equal((await again.store.get('m1')).status, once.status);
});

test('[target:late-ack] a late provider ACK resolves a recovered row', async () => {
  const { after } = await crashMidSend();
  await after.recover(5_000);
  assert.equal(await after.onProviderAck('m1', 'p-9'), 'acked');
  const row = await after.store.get('m1');
  assert.equal(row.status, Status.ACKED);
  assert.equal(row.providerId, 'p-9');
  assert.equal(after.stats.delivered, 1);
});

test('[adjacent:late-ack] a late ACK after lease expiry resolves the row', async () => {
  const outbox = new Outbox({ leaseMs: 1_000 });
  await outbox.enqueue('m1', 'x', 0);
  await outbox.claimNext('w1', 0);
  await outbox.expireLeases(2_000);
  assert.equal(await outbox.onProviderAck('m1', 'p1'), 'acked');
  assert.equal((await outbox.store.get('m1')).status, Status.ACKED);
});

test('[adjacent:dup-ack] duplicate ACKs count one delivery', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'x', 0);
  const t = transport({ outcome: 'acked', providerId: 'p1' });
  await runOnce(outbox, t, 'w1', 0);
  assert.equal(await outbox.onProviderAck('m1', 'p1'), 'duplicate');
  assert.equal(await outbox.onProviderAck('m1', 'p1'), 'duplicate');
  assert.equal(outbox.stats.delivered, 1);
});

test('[adjacent:dup-ack] concurrent duplicate ACKs on an uncertain row count once', async () => {
  const after = new Outbox();
  await after.enqueue('m1', 'x', 0);
  await runOnce(after, transport({ outcome: 'unknown' }), 'w1', 0);
  const results = await Promise.all([after.onProviderAck('m1', 'p1'), after.onProviderAck('m1', 'p1'), after.onProviderAck('m1', 'p1')]);
  assert.equal(results.filter(r => r === 'acked').length, 1);
  assert.equal(after.stats.delivered, 1);
});

test('[adjacent:reject-retry] rows that were never claimed stay claimable after a restart', async () => {
  const before = new Outbox();
  await before.enqueue('m1', 'one', 0);
  await before.enqueue('m2', 'two', 0);
  await before.claimNext('w1', 0); // m1 in flight, m2 still pending
  const after = new Outbox({ store: before.store });
  await after.recover(5_000);
  const t = transport({ outcome: 'acked' });
  for (let now = 5_000; now <= 60_000; now += 5_000) await runOnce(after, t, 'w1', now);
  assert.ok(t.sent.includes('two'));
});

test('[adjacent:reject-retry] a rejected row survives a restart and is retried after backoff', async () => {
  const before = new Outbox();
  await before.enqueue('m1', 'x', 0);
  await runOnce(before, transport({ outcome: 'rejected' }), 'w1', 0);
  const after = new Outbox({ store: before.store });
  await after.recover(1);
  const t = transport({ outcome: 'acked' });
  const due = backoff.nextAttemptDelay(1);
  assert.equal(await runOnce(after, t, 'w1', due - 1), null);
  assert.equal(await runOnce(after, t, 'w1', due), Status.ACKED);
  assert.equal((await after.store.get('m1')).attempts, 2);
});

test('[adjacent:stale-lease] an outcome from an expired lease is ignored', async () => {
  const outbox = new Outbox({ leaseMs: 5_000 });
  await outbox.enqueue('m1', 'x', 0);
  const first = await outbox.claimNext('w1', 0);
  await outbox.expireLeases(6_000);
  await outbox.resolveUncertain('m1', 'requeue', 7_000);
  const second = await outbox.claimNext('w2', 7_000);
  assert.ok(second);
  assert.equal(await outbox.recordOutcome('m1', first.lease.token, 'rejected', 8_000), 'stale');
  assert.equal((await outbox.store.get('m1')).status, Status.SENDING);
  assert.equal(await outbox.recordOutcome('m1', second.lease.token, 'acked', 8_000, 'p2'), Status.ACKED);
});

test('[adjacent:stale-lease] a worker cannot record an outcome after recovery took the row', async () => {
  const { after, claimed } = await crashMidSend();
  await after.recover(5_000);
  const recovered = (await after.store.get('m1')).status;
  assert.equal(await after.recordOutcome('m1', claimed.lease.token, 'rejected', 6_000), 'stale');
  assert.equal((await after.store.get('m1')).status, recovered);
});

test('[adjacent:concurrency] two workers claiming at once get one row each, never the same', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'x', 0);
  const claims = await Promise.all([outbox.claimNext('w1', 0), outbox.claimNext('w2', 0), outbox.claimNext('w3', 0)]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('[adjacent:concurrency] concurrent workers deliver each message exactly once', async () => {
  const outbox = new Outbox();
  for (let i = 0; i < 6; i++) await outbox.enqueue('m' + i, 'p' + i, 0);
  const t = transport({ outcome: 'acked' });
  for (let round = 0; round < 4; round++)
    await Promise.all(['w1', 'w2', 'w3'].map(w => runOnce(outbox, t, w, round)));
  assert.equal(t.sent.length, 6);
  assert.equal(new Set(t.sent).size, 6);
});

test('[target:operator] operator requeue sends a recovered row exactly once more', async () => {
  const { after } = await crashMidSend();
  await after.recover(5_000);
  assert.equal(await after.resolveUncertain('m1', 'requeue', 6_000), true);
  const t = transport({ outcome: 'acked' });
  assert.equal(await runOnce(after, t, 'w1', 6_000), Status.ACKED);
  assert.equal(await runOnce(after, t, 'w1', 9_000), null);
  assert.equal(t.sent.length, 1);
});

test('[target:operator] operator can mark a recovered row delivered', async () => {
  const { after } = await crashMidSend();
  await after.recover(5_000);
  assert.equal(await after.resolveUncertain('m1', 'delivered', 6_000), true);
  assert.equal((await after.store.get('m1')).status, Status.ACKED);
  assert.equal(after.stats.delivered, 1);
});

test('[adjacent:lifecycle] repeated rejections end in dead', async () => {
  const outbox = new Outbox({ maxAttempts: 2 });
  await outbox.enqueue('m1', 'x', 0);
  const t = transport({ outcome: 'rejected' });
  assert.equal(await runOnce(outbox, t, 'w1', 0), Status.PENDING);
  assert.equal(await runOnce(outbox, t, 'w1', backoff.MAX_DELAY_MS), Status.DEAD);
  assert.equal(await runOnce(outbox, t, 'w1', 10 * backoff.MAX_DELAY_MS), null);
});

test('[adjacent:lifecycle] a thrown transport error is treated as an unknown outcome', async () => {
  const outbox = new Outbox();
  await outbox.enqueue('m1', 'x', 0);
  let calls = 0;
  const failing = { async send() { calls++; throw new Error('socket hang up'); } };
  assert.equal(await runOnce(outbox, failing, 'w1', 0), Status.UNCERTAIN);
  assert.equal(await runOnce(outbox, failing, 'w1', 10 * backoff.MAX_DELAY_MS), null);
  assert.equal(calls, 1);
});

test('[adjacent:lifecycle] operator requeue of an expired-lease row sends it once more', async () => {
  const outbox = new Outbox({ leaseMs: 1_000 });
  await outbox.enqueue('m1', 'x', 0);
  await outbox.claimNext('w1', 0);
  await outbox.expireLeases(2_000);
  assert.equal(await outbox.resolveUncertain('m1', 'requeue', 3_000), true);
  const t = transport({ outcome: 'acked' });
  assert.equal(await runOnce(outbox, t, 'w2', 3_000), Status.ACKED);
  assert.equal(await runOnce(outbox, t, 'w2', 4_000), null);
  assert.equal(t.sent.length, 1);
  assert.equal(await outbox.resolveUncertain('m1', 'requeue', 5_000), false);
});

test('[scope] the backoff schedule is unchanged', () => {
  assert.equal(backoff.BASE_DELAY_MS, 2_000);
  assert.equal(backoff.MAX_DELAY_MS, 60_000);
  assert.deepEqual([1, 2, 3, 6, 10].map(backoff.nextAttemptDelay), [2_000, 4_000, 8_000, 60_000, 60_000]);
});

test('[scope] the public API is unchanged', () => {
  assert.deepEqual(Object.keys(outboxModule).sort(), ['Outbox', 'Status']);
  assert.deepEqual({ ...Status }, { PENDING: 'pending', SENDING: 'sending', ACKED: 'acked', UNCERTAIN: 'uncertain', DEAD: 'dead' });
  for (const m of ['enqueue', 'claimNext', 'recordOutcome', 'onProviderAck', 'expireLeases', 'recover', 'resolveUncertain'])
    assert.equal(typeof Outbox.prototype[m], 'function', m);
});
