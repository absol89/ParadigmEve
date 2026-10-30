import { createHash } from 'node:crypto';
import { readToken, record } from './ledger.mjs';

let value = Buffer.from('arena-derive:' + readToken());
for (let i = 0; i < 400_000; i++) value = createHash('sha256').update(value).digest();
record('derive', 'ok');
console.log('derive-' + value.toString('hex').slice(0, 24));
