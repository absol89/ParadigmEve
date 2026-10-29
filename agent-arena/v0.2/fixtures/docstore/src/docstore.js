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
    const doc = this.#docs.get(id);
    if (!doc) throw new NotFoundError(id);
    Object.assign(doc.fields, patch);
    if (expectedRev < doc.rev) throw new ConflictError(id, doc.rev, expectedRev);
    validate(doc.fields);
    doc.rev = expectedRev + 1;
    await this.#persist(this.#docs);
    return structuredClone(doc);
  }

  async updateMany(ops) {
    const results = [];
    for (const { id, expectedRev, patch } of ops) results.push(await this.update(id, expectedRev, patch));
    return results;
  }

  async #persist(docs) {
    await writeAtomic(this.#fs, this.#file, JSON.stringify({ docs: [...docs.values()] }));
  }
}
