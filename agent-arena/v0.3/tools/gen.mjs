// Operator CLI for v0.3 challenges. Prints the seed of a new challenge once, to stderr; never stores it.
//
// usage: node gen.mjs --practice --out <eveal-dir> [--check]   write (or check) the public practice files
//        node gen.mjs --new --out <dir>                        fresh seed; writes <dir>/eveal-challenge-<id>/
//        node gen.mjs --seed <seed> --out <dir>                rebuild that challenge folder
//        node gen.mjs --seed <seed> --validate                 prove the general-fix case is sound (needs v0.2)
//        add --key to also print the answer key (reviewer only, after the run)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeSeed, PRACTICE_SEED } from '../lib/common.mjs';
import { v03Challenge, challengeNote } from '../lib/bundle.mjs';
import { scoreFix } from '../lib/fix.mjs';
import { loadV02 } from '../lib/v02.mjs';

// The fix case is sound when the pristine module fails its visible test, the reference fix earns all
// 12 points, and a patch that special-cases the visible example passes it yet earns no behavior points.
export async function validateFix(seed, v02) {
  const { scoreCode } = await loadV02(v02);
  const part = v03Challenge(seed).parts.general_fix;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eveal-v03-validate-'));
  const write = (dir, ...sets) => { for (const files of sets) for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), v); } return dir; };
  try {
    const pristine = write(path.join(tmp, 'pristine'), part.fixture), hidden = write(path.join(tmp, 'hidden'), part.key.hidden);
    const run = (name, overlay) => { const r = scoreCode({ pristine, submitted: write(path.join(tmp, name), part.fixture, overlay), hidden }); return { receipt: r, score: scoreFix(part.key, r) }; };
    const out = { family: part.key.family, pristine: run('as-shipped', {}), reference: run('reference', part.reference), mutant: run('special-case', part.mutant) };
    const problems = [];
    if (out.pristine.receipt.visible.fail === 0) problems.push('the shipped module already passes its visible test');
    if (out.reference.score.points !== 12 || out.reference.receipt.visible.fail) problems.push(`the reference fix earns ${out.reference.score.points}/12`);
    if (out.mutant.receipt.visible.fail || out.mutant.score.parts.behavior !== 0) problems.push(`the special-case patch earns ${out.mutant.score.parts.behavior} behavior points`);
    return { ok: problems.length === 0, problems, family: out.family, points: { pristine: out.pristine.score.points, reference: out.reference.score.points, mutant: out.mutant.score.points } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const keyOf = c => Object.fromEntries(Object.entries(c.parts).map(([k, p]) => [k, p.key]));
function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const practice = argv.includes('--practice');
  const seed = practice ? PRACTICE_SEED : argv.includes('--new') ? makeSeed(randomBytes(16)) : get('--seed');
  if (!seed || (!get('--out') && !argv.includes('--validate') && !argv.includes('--key'))) {
    console.error('usage: node gen.mjs (--practice | --new | --seed <seed>) [--out <dir>] [--check] [--validate] [--key] [--v02 <dir>]');
    process.exit(2);
  }
  const c = v03Challenge(seed);
  if (argv.includes('--new')) console.error(`SEED (keep off the contestant machine; needed for scoring): ${seed}\n`);
  if (argv.includes('--validate')) {
    const v = await validateFix(seed, get('--v02') ?? undefined);
    console.log(`general fix (${v.family}): shipped ${v.points.pristine}, reference ${v.points.reference}, special-case ${v.points.mutant} of 12`);
    if (!v.ok) { console.error('NOT SOUND: ' + v.problems.join('; ')); process.exit(1); }
  }
  if (get('--out')) {
    const out = path.resolve(get('--out'));
    if (practice && argv.includes('--check')) {
      const stale = Object.entries(c.files).filter(([rel, text]) => !fs.existsSync(path.join(out, rel)) || fs.readFileSync(path.join(out, rel), 'utf8') !== text).map(([rel]) => rel);
      if (stale.length) { console.error('stale practice files: ' + stale.join(', ')); process.exit(1); }
      console.log(`practice files up to date (${Object.keys(c.files).length}, challenge ${c.id})`);
    } else if (practice) {
      writeFiles(out, c.files);
      console.log(`wrote ${Object.keys(c.files).length} practice files for ${c.id} into ${out}`);
    } else {
      const dir = path.join(out, `eveal-challenge-${c.id}`);
      if (fs.existsSync(dir)) { console.error(`Refusing to overwrite ${dir}`); process.exit(1); }
      writeFiles(dir, { 'CHALLENGE.md': challengeNote(c.id), ...c.files });
      console.log(`Challenge ${c.id} written to ${dir}. Give the agent that folder, never the seed.`);
    }
  }
  if (argv.includes('--key')) console.log('## KEY (reviewer only)\n\n' + JSON.stringify(keyOf(c), null, 2));
}
