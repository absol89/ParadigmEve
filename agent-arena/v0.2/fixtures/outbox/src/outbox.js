import { randomUUID } from 'node:crypto';
import { RowStore } from './store.js';
import { nextAttemptDelay } from './backoff.js';

// Row status values. See README.md for the lifecycle.
export const Status = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  ACKED: 'acked',
  UNCERTAIN: 'uncertain',
  DEAD: 'dead'
});

export class Outbox {
  constructor({ store = new RowStore(), leaseMs = 30_000, maxAttempts = 5, log = () => {} } = {}) {
    this.store = store;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.log = log;
    this.stats = { delivered: 0, rejected: 0, uncertain: 0, dead: 0, staleOutcomes: 0 };
  }

  async enqueue(id, payload, now) {
    return this.store.insert({
      id, payload, status: Status.PENDING, attempts: 0, nextAttemptAt: now, lease: null, providerId: null
    });
  }

  async claimNext(workerId, now) {
    for (let race = 0; race < 8; race++) {
      const rows = await this.store.list();
      const candidate = rows
        .filter(row => row.status === Status.PENDING && row.nextAttemptAt <= now)
        .sort((a, b) => a.seq - b.seq)[0];
      if (!candidate) return null;
      const lease = { owner: workerId, token: randomUUID(), expiresAt: now + this.leaseMs };
      const claimed = await this.store.compareAndSet(candidate.id, candidate.version, {
        status: Status.SENDING, lease, attempts: candidate.attempts + 1
      });
      if (claimed) {
        this.log(`claim ${claimed.id} attempt=${claimed.attempts} worker=${workerId}`);
        return claimed;
      }
    }
    return null;
  }

  // Called by the worker that holds the lease once the provider call returns.
  async recordOutcome(id, leaseToken, outcome, now, providerId = null) {
    const row = await this.store.get(id);
    if (!row || row.status !== Status.SENDING || row.lease?.token !== leaseToken) {
      this.stats.staleOutcomes++;
      this.log(`outcome ${outcome} for ${id} ignored: lease no longer held`);
      return 'stale';
    }
    let patch;
    if (outcome === 'acked') {
      patch = { status: Status.ACKED, lease: null, providerId };
    } else if (outcome === 'rejected') {
      patch = row.attempts >= this.maxAttempts
        ? { status: Status.DEAD, lease: null }
        : { status: Status.PENDING, lease: null, nextAttemptAt: now + nextAttemptDelay(row.attempts) };
    } else if (outcome === 'unknown') {
      patch = { status: Status.UNCERTAIN, lease: null };
    } else {
      throw new Error('unexpected outcome ' + outcome);
    }
    const next = await this.store.compareAndSet(id, row.version, patch);
    if (!next) {
      this.stats.staleOutcomes++;
      return 'stale';
    }
    this.#count(next.status);
    this.log(`outcome ${outcome} for ${id} -> ${next.status}`);
    return next.status;
  }

  // Provider webhook. ACKs can arrive late (after a timeout or restart) and more than once.
  async onProviderAck(id, providerId) {
    for (let race = 0; race < 8; race++) {
      const row = await this.store.get(id);
      if (!row) return 'unknown-row';
      if (row.status === Status.ACKED) {
        this.log(`late ack for ${id} ignored: duplicate`);
        return 'duplicate';
      }
      if (row.status !== Status.SENDING && row.status !== Status.UNCERTAIN) {
        this.log(`late ack for ${id} in state ${row.status} ignored`);
        return 'ignored';
      }
      const next = await this.store.compareAndSet(id, row.version, { status: Status.ACKED, lease: null, providerId });
      if (next) {
        this.#count(Status.ACKED);
        this.log(`late ack for ${id} -> acked`);
        return 'acked';
      }
    }
    return 'busy';
  }

  // Periodic sweep: a lease that ran out means the worker stalled or died mid-call.
  async expireLeases(now) {
    let expired = 0;
    for (const row of await this.store.list()) {
      if (row.status !== Status.SENDING || row.lease.expiresAt > now) continue;
      const next = await this.store.compareAndSet(row.id, row.version, { status: Status.UNCERTAIN, lease: null });
      if (next) {
        expired++;
        this.#count(Status.UNCERTAIN);
        this.log(`lease for ${row.id} expired -> uncertain`);
      }
    }
    return expired;
  }

  // Runs once at process start, before any worker claims.
  async recover(now) {
    let inFlight = 0;
    for (const row of await this.store.list()) {
      if (row.status !== Status.SENDING) continue;
      const next = await this.store.compareAndSet(row.id, row.version, {
        status: Status.PENDING, lease: null, nextAttemptAt: now
      });
      if (next) inFlight++;
    }
    this.log(`startup: recovery complete (${inFlight} in-flight row(s))`);
    return inFlight;
  }

  // Operator decision for a row in review: 'delivered' when the provider confirms it, 'requeue' to send again.
  async resolveUncertain(id, decision, now) {
    const row = await this.store.get(id);
    if (!row || row.status !== Status.UNCERTAIN) return false;
    const patch = decision === 'delivered'
      ? { status: Status.ACKED }
      : decision === 'requeue'
        ? { status: Status.PENDING, nextAttemptAt: now }
        : null;
    if (!patch) throw new Error('unexpected decision ' + decision);
    const next = await this.store.compareAndSet(id, row.version, patch);
    if (next?.status === Status.ACKED) this.#count(Status.ACKED);
    return Boolean(next);
  }

  #count(status) {
    if (status === Status.ACKED) this.stats.delivered++;
    else if (status === Status.PENDING) this.stats.rejected++;
    else if (status === Status.UNCERTAIN) this.stats.uncertain++;
    else if (status === Status.DEAD) this.stats.dead++;
  }
}
