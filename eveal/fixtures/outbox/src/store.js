// An in-memory stand-in for a database table. Every call yields to the event loop first,
// so two workers really can interleave between a read and a write.
const tick = () => new Promise(resolve => setImmediate(resolve));

export class RowStore {
  #rows = new Map();
  #seq = 0;

  async insert(row) {
    await tick();
    if (this.#rows.has(row.id)) throw new Error('duplicate id ' + row.id);
    const stored = { ...structuredClone(row), seq: ++this.#seq, version: 1 };
    this.#rows.set(row.id, stored);
    return structuredClone(stored);
  }

  async get(id) {
    await tick();
    const row = this.#rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async list() {
    await tick();
    return [...this.#rows.values()].map(row => structuredClone(row));
  }

  // Applies the patch only if the row is still at expectedVersion. Returns the new row, or null on a lost race.
  async compareAndSet(id, expectedVersion, patch) {
    await tick();
    const row = this.#rows.get(id);
    if (!row || row.version !== expectedVersion) return null;
    const next = { ...row, ...structuredClone(patch), version: row.version + 1 };
    this.#rows.set(id, next);
    return structuredClone(next);
  }
}
