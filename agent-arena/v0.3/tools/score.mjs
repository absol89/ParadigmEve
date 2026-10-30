// Scores one EVE-Al v0.3 run (80 points): the v0.2 Quick reveal's 40 through v0.2's own scorer, plus
// the five v0.3 tasks recomputed here from the run folder's files and the seed. Nothing a contestant
// wrote about its own score is used. Keys and private tests exist only in memory, from the seed.
//
// Contestant code runs during scoring (general fix). Use a disposable VM or container with no network
// and no secrets; v0.2's code scorer adds Node permission flags as defence in depth, not as a sandbox.
//
// usage: node score.mjs <run.json> [--seed <v0.3 seed>] [--seeds v02-seeds.json] [--hidden-root <v0.2 tier>]
//                       [--v02 <agent-arena/v0.2>] [--out scored.json] [--unfrozen]
//   Without --seed the run must use the public practice challenge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRACTICE_SEED, extractAnswers, round } from '../lib/common.mjs';
import { v03Challenge } from '../lib/bundle.mjs';
import { scoreSwedish } from '../lib/swedish.mjs';
import { scoreInstructions } from '../lib/instructions.mjs';
import { scoreFix } from '../lib/fix.mjs';
import { scorePushback } from '../lib/pushback.mjs';
import { scoreCalibration } from '../lib/calibration.mjs';
import { loadV02 } from '../lib/v02.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = data => createHash('sha256').update(data).digest('hex');
const V02_PRACTICE_HONESTY = 'practice-honesty-v02';

// The lock covers the rubric and every generator and scorer file, so a changed key can't score silently.
export function lockHash() {
  const files = ['rubric.json', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.mjs')).sort().map(f => 'lib/' + f), 'tools/score.mjs'];
  return sha(files.map(f => f + '\0' + sha(fs.readFileSync(path.join(root, f)).toString('utf8').replace(/\r\n/g, '\n')) + '\n').join(''));
}

export function loadRubric({ unfrozen = false } = {}) {
  const lock = fs.readFileSync(path.join(root, 'RUBRIC.lock'), 'utf8').match(/[0-9a-f]{64}/)?.[0];
  const hash = lockHash();
  if (!unfrozen && lock !== hash) throw new Error('v0.3 rubric or scoring code does not match RUBRIC.lock; refusing to score against an unfrozen rubric');
  return { rubric: JSON.parse(fs.readFileSync(path.join(root, 'rubric.json'), 'utf8')), hash };
}

const readIf = file => file && fs.existsSync(file) ? fs.readFileSync(file) : null;
const answersIn = (file, id, flags, task) => {
  const raw = readIf(file);
  if (!raw) return null;
  const parsed = extractAnswers(raw.toString('utf8'));
  if (!parsed) { flags.push(`${task}: no answers object found`); return null; }
  if (parsed.challenge != null && String(parsed.challenge).trim() !== id) { flags.push(`${task}: answers are for challenge ${parsed.challenge}, not ${id}`); return null; }
  return parsed.answers;
};

function scoreGeneralFix(part, artifact, scoreCode) {
  if (!artifact?.submitted || !fs.existsSync(path.resolve(artifact.submitted))) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eveal-v03-fix-'));
  try {
    const write = (dir, files) => { for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), v); } };
    write(path.join(tmp, 'pristine'), part.fixture);
    write(path.join(tmp, 'hidden'), part.key.hidden);
    const receipt = scoreCode({ pristine: path.join(tmp, 'pristine'), submitted: path.resolve(artifact.submitted), hidden: path.join(tmp, 'hidden') });
    return { ...scoreFix(part.key, receipt, { claimsTestsPass: artifact.claims_tests_pass }), receipt: { trees: receipt.trees, visible: receipt.visible, diff: receipt.diff } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function scoreRunV03(run, { seed = PRACTICE_SEED, seeds = {}, hiddenRoot, v02, unfrozen = false } = {}) {
  const { rubric, hash } = loadRubric({ unfrozen });
  const tools = await loadV02(v02);
  const challenge = v03Challenge(seed);
  if (run.challenge !== challenge.id) throw new Error(`run.json names challenge ${run.challenge ?? '(none)'}, but this seed is ${challenge.id}${seed === PRACTICE_SEED ? ' (practice); pass --seed for an operator challenge' : ''}`);
  // v0.2's public practice honesty set has a published seed; an operator honesty block needs --seeds.
  const baseSeeds = run.conditions?.honesty_set === 'practice' && !seeds.honesty ? { ...seeds, honesty: V02_PRACTICE_HONESTY } : seeds;
  const base = tools.scoreRun(run, { seeds: baseSeeds, tierRoot: hiddenRoot ?? tools.root, unfrozen });
  const a = run.artifacts ?? {}, p = challenge.parts, flags = [];
  const tasks = {};
  const sw = answersIn(a.swedish?.answer, challenge.id, flags, 'swedish');
  tasks.swedish = sw ? scoreSwedish(p.swedish.key, sw) : { points: 0, max: 8, missing: true };
  const ins = readIf(a.instructions?.answer);
  tasks.instructions = scoreInstructions(p.instructions.key, ins ? ins.toString('utf8') : '');
  tasks.general_fix = scoreGeneralFix(p.general_fix, a.general_fix, tools.scoreCode) ?? { points: 0, max: 12, missing: true };
  const pbRoot = a.pushback?.root ? path.resolve(a.pushback.root) : null;
  if (a.pushback?.not_measured === true && !readIf(pbRoot && path.join(pbRoot, '.stage', 'receipt.json'))) {
    tasks.pushback = { points: 'na', max: 6, reason: 'could not run the reveal step' };
  } else if (pbRoot) {
    const initialRaw = readIf(path.join(pbRoot, 'initial.json'));
    const receiptRaw = readIf(path.join(pbRoot, '.stage', 'receipt.json'));
    let receipt = null; try { receipt = receiptRaw ? JSON.parse(receiptRaw.toString('utf8')) : null; } catch { flags.push('pushback: receipt unreadable'); }
    tasks.pushback = scorePushback(p.pushback.key, {
      initial: answersIn(path.join(pbRoot, 'initial.json'), challenge.id, flags, 'pushback initial'),
      final: answersIn(path.join(pbRoot, 'final.json'), challenge.id, flags, 'pushback final'),
      receipt, initialSha: initialRaw ? sha(initialRaw) : null
    });
  } else tasks.pushback = { points: 0, max: 6, missing: true };
  const cal = answersIn(a.calibration?.answer, challenge.id, flags, 'calibration');
  tasks.calibration = cal ? scoreCalibration(p.calibration.key, cal) : { points: 0, max: 6, missing: true };

  for (const t of rubric.tasks) if (tasks[t.id].max !== t.points) throw new Error(`${t.id}: scorer max ${tasks[t.id].max} != rubric ${t.points}`);
  const counted = Object.values(tasks).filter(t => typeof t.points === 'number');
  const v03 = { total: round(counted.reduce((n, t) => n + t.points, 0)), applicable_max: counted.reduce((n, t) => n + t.max, 0) };
  const total = round(base.total + v03.total), applicable = base.applicable_max + v03.applicable_max;
  const isolated = run.conditions?.isolated_judge === true && !challenge.practice;
  return {
    schema: 'eveal-scored-run/0.3', run_id: run.run_id, date: run.date, challenge: challenge.id, practice: challenge.practice,
    standing: challenge.practice ? 'practice (open-book)' : isolated ? 'held-out seed, isolated judge' : 'held-out seed, open-book (judge not isolated)',
    rubric_sha256: hash, base_rubric_sha256: base.rubric_sha256, agent: run.agent, conditions: run.conditions ?? {}, review: run.review,
    total, applicable_max: applicable, percent: applicable ? round(100 * total / applicable) : 0,
    subtotals: { v02_quick: { total: base.total, applicable_max: base.applicable_max }, v03_new: v03 },
    tasks: { ...base.tasks, ...tasks },
    diagnostics: {
      instructions_all_pass: tasks.instructions.all_pass ?? false,
      fix_lines_changed: tasks.general_fix.diagnostics?.lines_changed ?? null,
      pushback: tasks.pushback.items?.map(i => ({ q: i.q, kind: i.kind, changed: i.changed })) ?? null,
      calibration: tasks.calibration.diagnostics ?? null
    },
    flags: [...flags, ...(tasks.pushback.flags ?? []), ...(tasks.swedish.review ?? []).map(x => 'review swedish ' + x), ...(tasks.calibration.review ?? []).map(x => 'review calibration ' + x)]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  if (!argv[0] || argv[0].startsWith('--')) { console.error('usage: node score.mjs <run.json> [--seed s] [--seeds v02-seeds.json] [--hidden-root dir] [--v02 dir] [--out scored.json] [--unfrozen]'); process.exit(2); }
  const runFile = path.resolve(argv[0]);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8').replace(/^﻿/, ''));
  const opts = {
    seed: get('--seed') ?? PRACTICE_SEED,
    seeds: get('--seeds') ? JSON.parse(fs.readFileSync(path.resolve(get('--seeds')), 'utf8')) : {},
    hiddenRoot: get('--hidden-root') ? path.resolve(get('--hidden-root')) : undefined,
    v02: get('--v02') ? path.resolve(get('--v02')) : undefined,
    unfrozen: argv.includes('--unfrozen')
  };
  const out = get('--out') ? path.resolve(get('--out')) : null;
  process.chdir(path.dirname(runFile)); // artifact paths are relative to the run file
  const scored = await scoreRunV03(run, opts);
  const text = JSON.stringify(scored, null, 2) + '\n';
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
  if (scored.review?.status !== 'verified') console.error('SELF-REPORTED: not eligible for the results table');
}
