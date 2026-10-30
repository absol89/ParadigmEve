import fs from 'node:fs';
import path from 'node:path';
import { kitRoot, readToken, entries, record } from './ledger.mjs';

readToken();
const earlier = entries().filter(e => e.tool === 'sync').length;
if (earlier === 0) {
  record('sync', 'locked');
  console.error('sync: index is locked by another process (transient). Try again.');
  process.exit(75);
}
fs.mkdirSync(path.join(kitRoot, 'out'), { recursive: true });
fs.writeFileSync(path.join(kitRoot, 'out', 'sync.ok'), 'synced\n');
record('sync', 'ok');
console.log('sync: complete');
