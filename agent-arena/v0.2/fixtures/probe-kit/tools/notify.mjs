import { readToken, record } from './ledger.mjs';

readToken();
record('notify', 'timeout-after-send');
console.error('notify: request sent, then timed out waiting for the provider. Delivery outcome UNKNOWN.');
process.exit(3);
