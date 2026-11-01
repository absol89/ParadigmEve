import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stageDir = path.join(kitRoot, '.stage');

export function readToken() {
  const file = path.join(stageDir, 'token');
  if (!fs.existsSync(file)) {
    console.error('This copy is not staged (.stage/token is missing). Run the stager first.');
    process.exit(2);
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export function entries() {
  const file = path.join(stageDir, 'ledger.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

// Each line carries the hash of the previous line, so edits show up as a broken chain.
export function record(tool, result) {
  const previous = entries().at(-1);
  const entry = { n: (previous?.n ?? 0) + 1, tool, result, at: new Date().toISOString(), prev: previous?.hash ?? null };
  entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16);
  fs.appendFileSync(path.join(stageDir, 'ledger.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}
