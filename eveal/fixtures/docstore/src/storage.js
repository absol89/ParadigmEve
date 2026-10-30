// A tiny in-memory file system with fault injection, plus the atomic write the store relies on.
const tick = () => new Promise(resolve => setImmediate(resolve));
const notFound = path => Object.assign(new Error('ENOENT: no such file ' + path), { code: 'ENOENT' });

export class MemoryFs {
  files = new Map();
  writes = 0;
  renames = 0;
  #faults = [];

  // mode 'throw' fails before writing; 'torn' leaves half the bytes behind, like a crash mid-write.
  failNext(op, mode = 'throw') {
    this.#faults.push({ op, mode });
  }

  #takeFault(op) {
    const i = this.#faults.findIndex(f => f.op === op);
    return i < 0 ? null : this.#faults.splice(i, 1)[0];
  }

  async readFile(path) {
    await tick();
    if (!this.files.has(path)) throw notFound(path);
    return this.files.get(path);
  }

  async writeFile(path, data) {
    await tick();
    this.writes++;
    const fault = this.#takeFault('writeFile');
    if (fault) {
      if (fault.mode === 'torn') this.files.set(path, data.slice(0, Math.floor(data.length / 2)));
      throw Object.assign(new Error('EIO: write failed'), { code: 'EIO' });
    }
    this.files.set(path, data);
  }

  async rename(from, to) {
    await tick();
    if (this.#takeFault('rename')) throw Object.assign(new Error('EPERM: rename failed'), { code: 'EPERM' });
    if (!this.files.has(from)) throw notFound(from);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.renames++;
  }
}

export async function writeAtomic(fs, path, data) {
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path);
}
