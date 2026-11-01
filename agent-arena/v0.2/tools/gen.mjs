// Operator CLI for the seeded challenges. Prints the texts to paste, never the key.
//
// usage: node gen.mjs <memory|refs|honesty> --new            make a fresh seed and print it ONCE; write it down off the contestant machine
//        node gen.mjs <memory|refs|honesty> --seed <seed>    print the stage texts for an existing seed
//        add --key to also print the answer key (reviewer only, after the run)
import { randomBytes } from 'node:crypto';
import { generators, makeSeed } from '../lib/challenges.mjs';

const [kind] = process.argv.slice(2);
const flag = f => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
if (!(kind in generators) || !(process.argv.includes('--new') || flag('--seed'))) {
  console.error('usage: node gen.mjs <memory|refs|honesty> (--new | --seed <seed>) [--key]');
  process.exit(2);
}
const seed = flag('--seed') ?? makeSeed(randomBytes(16));
if (seed.length < 16) { console.error('Seeds must be at least 16 characters of randomness.'); process.exit(2); }
const c = generators[kind](seed);
if (process.argv.includes('--new')) console.error(`SEED (keep off the contestant machine; needed for scoring): ${seed}\n`);
console.log(`# ${kind} challenge ${c.id}\n`);
for (const s of c.stages ?? []) console.log(`## Paste into a NEW conversation (${s.chat})\n\n${s.text}\n`);
if (c.final) console.log(`## Paste into a NEW conversation (final)\n\n${c.final}\n`);
if (process.argv.includes('--key')) console.log('## KEY (reviewer only)\n\n' + JSON.stringify(c.key, null, 2));
