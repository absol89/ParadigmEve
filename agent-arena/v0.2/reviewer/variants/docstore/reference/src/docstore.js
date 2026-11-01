import { writeAtomic } from './storage.js';
import { validate } from './validate.js';

export class ConflictError extends Error {
  constructor(id, currentRev, expectedRev) {
    super(`revision conflict on ${id}: current ${currentRev}, expected ${expectedRev}`);
    this.name = 'ConflictError';
    this.id = id;
    this.currentRev = currentRev;
    this.expectedRev = expectedRev;
  }
}

export class NotFoundError extends Error {
  constructor(id) {
    super('no document ' + id);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

export class DocStore {
  #fs;
  #file;
  #docs;

  constructor(fs, file, docs) {
    this.#fs = fs;
    this.#file = file;
    this.#docs = docs;
  }

  static async open(fs, file = 'docs.json') {
    const docs = new Map();
    try {
      for (const doc of JSON.parse(await fs.readFile(file)).docs) docs.set(doc.id, doc);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return new DocStore(fs, file, docs);
  }

  get(id) {
    const doc = this.#docs.get(id);
    return doc ? structuredClone(doc) : null;
  }

  list() {
    return [...this.#docs.values()].map(doc => structuredClone(doc));
  }

  async create(id, fields) {
    if (this.#docs.has(id)) throw new ConflictError(id, this.#docs.get(id).rev, 0);
    validate(fields);
    const doc = { id, rev: 1, fields: structuredClone(fields) };
    const next = new Map(this.#docs).set(id, doc);
    await this.#persist(next);
    this.#docs = next;
    return structuredClone(doc);
  }

  async update(id, expectedRev, patch) {
    const [doc] = await this.updateMany([{ id, expectedRev, patch }]);
    return doc;
  }

  async updateMany(ops) {
    const next = new Map(this.#docs);
    const results = [];
    for (const { id, expectedRev, patch } of ops) {
      const current = next.get(id);
      if (!current) throw new NotFoundError(id);
      if (expectedRev !== current.rev) throw new ConflictError(id, current.rev, expectedRev);
      const fields = { ...structuredClone(current.fields), ...structuredClone(patch) };
      validate(fields);
      const doc = { id, rev: current.rev + 1, fields };
      next.set(id, doc);
      results.push(structuredClone(doc));
    }
    await this.#persist(next);
    this.#docs = next;
    return results;
  }

  async #persist(docs) {
    await writeAtomic(this.#fs, this.#file, JSON.stringify({ docs: [...docs.values()] }));
  }
}
