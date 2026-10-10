/**
 * Candidate-eval Phase 0 orchestration: admission, execution bookkeeping, evaluation ladder,
 * deterministic selection, verdict and promotion proposals.
 *
 * Candidates themselves are run by an operator (a person, Eve or another agent) with the brief
 * this module writes. The harness never trusts a candidate's own report: it freezes the candidate's
 * changes itself and runs the contract's evaluation commands in a fresh checkout of that freeze.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, git, runCommand, sha256, sha256File, toPosix, writeExclusive } from './core.mjs';
import { loadContract } from './contract.mjs';
import { Journal } from './journal.mjs';
import {
  diffStats,
  fingerprint,
  fingerprintDrift,
  freezeWorkspace,
  linkNodeModules,
  materializeFixture,
  referenceSimilarity,
  unlinkNodeModules
} from './workspace.mjs';

const TIERS = ['T1', 'T2', 'T3'];
const ELIGIBILITY_FLAGS = ['contamination', 'over-budget', 'over-time', 'cost-unknown', 'oracle-modified-during-eval'];

export function openRun(runDir) {
  const contract = loadContract(runDir);
  const journal = new Journal(contract.machine.runDir);
  return { contract, journal, state: journal.state() };
}

const noHooks = contract => path.join(contract.machine.runDir, 'no-hooks');
const attemptsFor = (state, taskId, arm) => [...state.attempts.values()].filter(a => a.taskId === taskId && (!arm || a.arm === arm));
const costOf = (contract, attempt) => attempt.usage?.[contract.budget.metric];

function requireLive(state) {
  if (state.halted) throw new HarnessError('RUN_HALTED', `run halted: ${state.halted.reason}`);
}

function requireAttempt(state, attemptId) {
  const attempt = state.attempts.get(attemptId);
  if (!attempt) throw new HarnessError('UNKNOWN_ATTEMPT', attemptId);
  return attempt;
}

// ------------------------------------------------------------------------------------------ admission

/** Reserves a new attempt and materializes its isolated workspace. Ids are never reused. */
export function reserveAttempt(runDir, { taskId, arm, strategyId }) {
  const { contract, journal, state } = openRun(runDir);
  requireLive(state);
  const calibration = state.calibration[taskId];
  if (!contract.tasks[taskId]) throw new HarnessError('UNKNOWN_TASK', taskId);
  if (!calibration?.ok) throw new HarnessError('TASK_NOT_CALIBRATED', `${taskId} has no passing calibration`);
  if (!contract.arms[arm]?.includes(strategyId)) throw new HarnessError('STRATEGY_NOT_IN_ARM', `${strategyId} is not in arm ${arm}`);
  if (attemptsFor(state, taskId, arm).some(a => a.strategyId === strategyId)) {
    throw new HarnessError('STRATEGY_ALREADY_TRIED', `${taskId}/${arm}/${strategyId} already has an attempt; failed attempts stay recorded`);
  }
  const attemptId = `${taskId}-${arm}-${strategyId}-${randomUUID().slice(0, 8)}`;
  const workspace = path.join(contract.machine.candidatesRoot, 'workspaces', path.basename(contract.machine.runDir), attemptId);
  journal.append('attempt.reserve.intent', { attemptId, ordinal: state.nextOrdinal, taskId, arm, strategyId, workspace });
  const fixture = materializeFixture(contract, taskId, workspace);
  journal.append('attempt.reserved', { attemptId, fixtureCommit: fixture.commit, gitConfigSha: fixture.gitConfigSha });
  return { attemptId, workspace };
}

export function renderBrief(contract, attempt) {
  const task = contract.tasks[attempt.taskId];
  const bugReport = fs.readFileSync(path.join(contract.machine.runDir, task.bugReport.file), 'utf8').trim();
  const strategy = fs.readFileSync(path.join(contract.machine.runDir, contract.strategies[attempt.strategyId].file), 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '').trim();
  return [
    `You are fixing one bug in a copy of the ParadigmEve TypeScript repository.`,
    ``,
    `Your workspace is exactly this folder: ${attempt.workspace}`,
    `Use absolute paths inside it. Run commands with that folder as the working directory.`,
    ``,
    `Rules (checked by the harness after you finish; a breach disqualifies the attempt):`,
    `- Change files only inside your workspace, and inside it only paths matching: ${contract.scope.allowedPaths.join(', ')}.`,
    `- Never change: ${contract.scope.protectedPaths.join(', ')}.`,
    `- Do not read, search or change anything outside your workspace: no other checkouts, worktrees or candidate folders.`,
    `- Do not run git commands that create commits, branches or tags, and do not change git configuration or hooks.`,
    `- Do not install packages or use the network. Dependencies are already present in node_modules.`,
    `- Do not add .only, .skip or .todo to tests.`,
    `- You may run tests and the type checker, for example:`,
    `  node node_modules/vitest/vitest.mjs run test/<file>.test.ts`,
    `  node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`,
    `- Hidden acceptance tests will be run against your changes. Fix the bug itself; do not special-case tests.`,
    ``,
    `Bug report:`,
    ``,
    bugReport,
    ``,
    `Procedure to follow:`,
    ``,
    strategy,
    ``,
    `When you are done, reply with a short report: root cause, files changed, tests you added or ran and their results.`
  ].join('\n');
}

/**
 * Starts one attempt: single-flight, calibration, baseline-first and budget admission, a
 * pre-execution contamination fingerprint, and the exact brief the worker must receive.
 */
export function startAttempt(runDir, attemptId, { model, agentType = null }) {
  const { contract, journal, state } = openRun(runDir);
  requireLive(state);
  const attempt = requireAttempt(state, attemptId);
  if (attempt.state !== 'reserved') throw new HarnessError('ATTEMPT_NOT_RESERVED', `${attemptId} is ${attempt.state}`);
  const running = [...state.attempts.values()].find(a => a.state === 'running');
  if (running) throw new HarnessError('ATTEMPT_RUNNING', `${running.id} is still running; Phase 0 runs one candidate at a time`);
  if (model !== contract.worker.model) throw new HarnessError('MODEL_MISMATCH', `contract fixes model ${contract.worker.model}, got ${model}`);
  if (attempt.arm !== 'A') {
    const baseline = attemptsFor(state, attempt.taskId, 'A').find(a => typeof costOf(contract, a) === 'number');
    if (!baseline) throw new HarnessError('BASELINE_REQUIRED', `arm A of ${attempt.taskId} must finish with a measured cost first`);
    const budget = contract.budget.armBMultiplier * costOf(contract, baseline);
    const spent = attemptsFor(state, attempt.taskId, attempt.arm).reduce((sum, a) => sum + (costOf(contract, a) ?? 0), 0);
    if (spent >= budget) throw new HarnessError('BUDGET_EXHAUSTED', `${attempt.arm} spent ${spent} of ${budget} ${contract.budget.metric} on ${attempt.taskId}`);
  }
  const brief = renderBrief(contract, attempt);
  const briefFile = path.join(contract.machine.runDir, 'attempts', attemptId, 'brief.md');
  fs.mkdirSync(path.dirname(briefFile), { recursive: true });
  fs.writeFileSync(briefFile, brief);
  const preFingerprint = fingerprint(contract, state, attemptId);
  journal.append('attempt.started', {
    attemptId,
    brief: { file: toPosix(path.relative(contract.machine.runDir, briefFile)), sha256: sha256(brief) },
    worker: { ...contract.worker, model, agentType, strategyPackageSha256: contract.strategies[attempt.strategyId].packageSha256 },
    preFingerprint
  });
  return { briefFile, brief };
}

// ------------------------------------------------------------------------------------------ finish + freeze

/**
 * Records the end of one attempt. Contamination halts the whole run (fail closed). Budget and
 * time overruns make the attempt ineligible. Otherwise the harness freezes the in-scope changes.
 */
export function finishAttempt(runDir, attemptId, { usage = {}, reportFile = null }) {
  const { contract, journal, state } = openRun(runDir);
  const attempt = requireAttempt(state, attemptId);
  if (attempt.state !== 'running') throw new HarnessError('ATTEMPT_NOT_RUNNING', `${attemptId} is ${attempt.state}`);
  const postFingerprint = fingerprint(contract, state, attemptId);
  const drift = fingerprintDrift(attempt.preFingerprint, postFingerprint);
  const flags = [];
  if (drift.length) flags.push('contamination');
  const metric = contract.budget.metric;
  if (!Number.isFinite(usage[metric]) || usage[metric] < 0) flags.push('cost-unknown');
  const wallMs = Date.now() - attempt.startedAt;
  if (contract.budget.perAttemptWallMs && wallMs > contract.budget.perAttemptWallMs) flags.push('over-time');
  if (attempt.arm !== 'A' && Number.isFinite(usage[metric])) {
    const baseline = attemptsFor(state, attempt.taskId, 'A').find(a => typeof costOf(contract, a) === 'number');
    const spent = attemptsFor(state, attempt.taskId, attempt.arm).reduce((sum, a) => sum + (costOf(contract, a) ?? 0), 0) + usage[metric];
    if (!baseline || spent > contract.budget.armBMultiplier * costOf(contract, baseline)) flags.push('over-budget');
  }
  let report = null;
  if (reportFile) {
    const target = path.join(contract.machine.runDir, 'attempts', attemptId, 'worker-report.md');
    fs.copyFileSync(reportFile, target);
    report = { file: toPosix(path.relative(contract.machine.runDir, target)), sha256: sha256File(target), evidence: false };
  }
  journal.append('attempt.finished', { attemptId, usage, report, postFingerprint, flags, drift });
  if (drift.length) {
    journal.append('attempt.disqualified', { attemptId, reason: 'contamination', details: drift });
    journal.append('run.halted', { reason: `contamination during ${attemptId}`, details: drift });
    return { ok: false, reason: 'contamination', drift };
  }
  return freezeAttempt(runDir, attemptId);
}

export function freezeAttempt(runDir, attemptId) {
  const { contract, journal, state } = openRun(runDir);
  const attempt = requireAttempt(state, attemptId);
  if (attempt.state === 'finished') journal.append('attempt.freeze.intent', { attemptId });
  else if (attempt.state !== 'freezing') throw new HarnessError('ATTEMPT_NOT_FINISHED', `${attemptId} is ${attempt.state}`);
  const result = freezeWorkspace(contract, attempt);
  if (!result.ok) {
    journal.append('attempt.disqualified', { attemptId, reason: 'scope', details: result.guard.reasons, evidence: result.evidence });
    return { ok: false, reason: 'scope', details: result.guard.reasons };
  }
  const reference = fs.readFileSync(path.join(contract.machine.runDir, contract.tasks[attempt.taskId].reference.file), 'utf8');
  const candidate = fs.readFileSync(path.join(contract.machine.runDir, result.frozen.patch.file), 'utf8');
  journal.append('attempt.frozen', { attemptId, frozen: { ...result.frozen, referenceSimilarity: referenceSimilarity(candidate, reference) } });
  return { ok: true, frozen: result.frozen };
}

// ------------------------------------------------------------------------------------------ evaluation

function commandFor(contract, tier, { oracle, subsystemTests }) {
  const spec = contract.ladder[tier];
  if (!spec?.cmd?.length) throw new HarnessError('LADDER_INVALID', `no command for ${tier}`);
  const args = spec.cmd.flatMap(part => part === '{oracle}' ? oracle : part === '{subsystemTests}' ? subsystemTests : [part]);
  return { cmd: args[0] === 'node' ? process.execPath : args[0], args: args.slice(1), display: args, timeoutMs: spec.timeoutMs };
}

/** A checkout of exactly `commit`, made by the harness, outside the candidate workspace. */
function prepareEvalTree(contract, sourceRepo, commit, expectedTree, label) {
  const dir = path.join(contract.machine.runDir, 'eval', `${label}-${Date.now()}`);
  git(sourceRepo, ['worktree', 'add', '--quiet', '--detach', dir, commit], { noHooksDir: noHooks(contract) });
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}'], { noHooksDir: noHooks(contract) }).trim();
  const dirty = git(dir, ['status', '--porcelain=v1', '--untracked-files=all'], { noHooksDir: noHooks(contract) }).trim();
  if (tree !== expectedTree || dirty) throw new HarnessError('EVAL_TREE_MISMATCH', `${label}: tree ${tree} dirty=${Boolean(dirty)}`);
  linkNodeModules(contract, dir);
  return dir;
}

function removeEvalTree(contract, sourceRepo, dir) {
  unlinkNodeModules(dir);
  git(sourceRepo, ['worktree', 'remove', '--force', dir], { noHooksDir: noHooks(contract), allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeOracle(contract, task, dir) {
  for (const oracle of task.oracle) {
    const bytes = fs.readFileSync(path.join(contract.machine.runDir, oracle.file));
    if (sha256(bytes) !== oracle.sha256) throw new HarnessError('CONTRACT_TAMPERED', `oracle ${oracle.file}`);
    fs.writeFileSync(path.join(dir, oracle.evalPath), bytes);
  }
}

function oracleIntact(task, dir) {
  return task.oracle.every(oracle => {
    const file = path.join(dir, oracle.evalPath);
    return fs.existsSync(file) && sha256File(file) === oracle.sha256;
  });
}

function removeOracle(task, dir) {
  for (const oracle of task.oracle) fs.rmSync(path.join(dir, oracle.evalPath), { force: true });
}

async function runTier(contract, task, dir, tier, extraTests, logFile) {
  const { cmd, args, display, timeoutMs } = commandFor(contract, tier, {
    oracle: task.oracle.map(o => o.evalPath),
    subsystemTests: [...new Set([...task.subsystemTests, ...extraTests])]
  });
  if (tier === 'T1') writeOracle(contract, task, dir);
  const result = await runCommand(cmd, args, { cwd: dir, timeoutMs });
  let tampered = false;
  if (tier === 'T1') {
    tampered = !oracleIntact(task, dir);
    removeOracle(task, dir);
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, result.output);
  const outcome = tampered ? 'error' : result.timedOut ? 'timeout' : result.code === 0 ? 'pass' : 'fail';
  return { cmd: display, exitCode: result.code, timedOut: result.timedOut, durationMs: result.durationMs, outcome, tampered };
}

/** Runs the requested tiers in order on a fresh checkout of the frozen commit, pruning on failure. */
export async function evaluateAttempt(runDir, attemptId, tiers = ['T1', 'T2']) {
  const { contract, journal, state } = openRun(runDir);
  requireLive(state);
  const attempt = requireAttempt(state, attemptId);
  if (!['frozen', 'evaluated'].includes(attempt.state)) throw new HarnessError('ATTEMPT_NOT_FROZEN', `${attemptId} is ${attempt.state}`);
  const task = contract.tasks[attempt.taskId];
  const candidateTests = attempt.frozen.changedPaths.filter(file => /\.test\.[cm]?[jt]sx?$/.test(file));
  const dir = prepareEvalTree(contract, attempt.workspace, attempt.frozen.commit, attempt.frozen.tree, attemptId);
  const results = [];
  try {
    for (const tier of tiers) {
      if (!TIERS.includes(tier)) throw new HarnessError('LADDER_INVALID', tier);
      journal.append('eval.intent', { attemptId, tier });
      const logFile = path.join(contract.machine.runDir, 'evals', attemptId, `${tier}-${Date.now()}.log`);
      const startedAt = Date.now();
      const run = await runTier(contract, task, dir, tier, tier === 'T3' ? candidateTests : [], logFile);
      const result = {
        attemptId,
        tier,
        contractHash: contract.contractHash,
        frozenCommit: attempt.frozen.commit,
        frozenTree: attempt.frozen.tree,
        ...run,
        startedAt,
        log: { file: toPosix(path.relative(contract.machine.runDir, logFile)), sha256: sha256File(logFile) },
        env: { node: process.version, platform: `${process.platform}-${process.arch}` }
      };
      journal.append('eval.result', { attemptId, result });
      results.push(result);
      if (run.tampered) journal.append('attempt.disqualified', { attemptId, reason: 'oracle-modified-during-eval', details: [tier] });
      if (result.outcome !== 'pass') break;
    }
  } finally {
    removeEvalTree(contract, attempt.workspace, dir);
  }
  return results;
}

/**
 * Proves the task is a fair fixture before any candidate runs: the oracle fails on the fixture
 * and passes once the reference fix is applied, and both states typecheck.
 */
export async function calibrateTask(runDir, taskId) {
  const { contract, journal, state } = openRun(runDir);
  requireLive(state);
  const task = contract.tasks[taskId];
  if (!task) throw new HarnessError('UNKNOWN_TASK', taskId);
  const workspace = path.join(contract.machine.runDir, 'calibration', `${taskId}-${Date.now()}`);
  const fixture = materializeFixture(contract, taskId, workspace);
  const log = name => path.join(contract.machine.runDir, 'calibration-logs', taskId, `${name}.log`);
  const steps = {};
  try {
    steps.fixtureOracle = await runTier(contract, task, workspace, 'T1', [], log('fixture-T1'));
    steps.fixtureTypecheck = await runTier(contract, task, workspace, 'T2', [], log('fixture-T2'));
    git(workspace, ['apply', '--whitespace=nowarn', path.join(contract.machine.runDir, task.reference.file)], { noHooksDir: noHooks(contract) });
    steps.referenceOracle = await runTier(contract, task, workspace, 'T1', [], log('reference-T1'));
    steps.referenceTypecheck = await runTier(contract, task, workspace, 'T2', [], log('reference-T2'));
    steps.referenceSubsystem = await runTier(contract, task, workspace, 'T3', [], log('reference-T3'));
  } finally {
    unlinkNodeModules(workspace);
  }
  const ok = steps.fixtureOracle.outcome === 'fail' && steps.fixtureTypecheck.outcome === 'pass' &&
    steps.referenceOracle.outcome === 'pass' && steps.referenceTypecheck.outcome === 'pass' && steps.referenceSubsystem.outcome === 'pass';
  const result = { ok, fixtureCommit: fixture.commit, steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { outcome: v.outcome, exitCode: v.exitCode, durationMs: v.durationMs }])) };
  journal.append('calibration.recorded', { taskId, result });
  return result;
}

// ------------------------------------------------------------------------------------------ selection

/** The latest valid evidence for one tier, or why there is none. */
export function evidenceFor(contract, state, attempt, tier) {
  const results = state.evals.filter(r => r.attemptId === attempt.id && r.tier === tier);
  const latest = results.at(-1);
  if (!latest) return { ok: false, reason: `missing-evidence:${tier}` };
  if (latest.contractHash !== contract.contractHash || latest.frozenCommit !== attempt.frozen?.commit) return { ok: false, reason: `foreign-evidence:${tier}` };
  const logFile = path.join(contract.machine.runDir, latest.log.file);
  if (!fs.existsSync(logFile) || sha256File(logFile) !== latest.log.sha256) return { ok: false, reason: `invalid-evidence:${tier}` };
  if (latest.outcome !== 'pass') return { ok: false, reason: `${latest.outcome}:${tier}`, result: latest };
  return { ok: true, result: latest };
}

function eligibility(contract, state, attempt) {
  const reasons = [];
  if (attempt.state === 'disqualified') reasons.push(`disqualified:${attempt.disqualification.reason}`);
  if (attempt.state === 'failed') reasons.push(`failed:${attempt.failure.reason}`);
  if (['reserving', 'reserved', 'running', 'finished', 'freezing'].includes(attempt.state)) reasons.push(`incomplete:${attempt.state}`);
  for (const flag of attempt.flags) if (ELIGIBILITY_FLAGS.includes(flag)) reasons.push(`flag:${flag}`);
  if (!reasons.length) for (const tier of ['T1', 'T2']) {
    const evidence = evidenceFor(contract, state, attempt, tier);
    if (!evidence.ok) { reasons.push(evidence.reason); break; }
  }
  return reasons;
}

function compareBy(contract, a, b) {
  for (const key of contract.selection.order) {
    const value = attempt => key === 'srcLines' ? attempt.frozen.stats.srcLines
      : key === 'srcChars' ? attempt.frozen.stats.srcChars
      : key === 'files' ? attempt.frozen.stats.files
      : key === 'cost' ? costOf(contract, attempt)
      : key === 'ordinal' ? attempt.ordinal
      : (() => { throw new HarnessError('SELECTION_INVALID', `unknown order key ${key}`); })();
    const difference = value(a) - value(b);
    if (difference) return difference;
  }
  return a.ordinal - b.ordinal;
}

/**
 * Deterministic selection for one task arm. Eligible attempts are ordered by the frozen policy;
 * the subsystem tier (T3) runs on the first `topForT3` of them; the winner is the first in order
 * whose T3 passed. Every attempt, including failed and disqualified ones, is listed.
 */
export async function selectArm(runDir, taskId, arm) {
  let { contract, state } = openRun(runDir);
  requireLive(state);
  const all = attemptsFor(state, taskId, arm).sort((a, b) => a.ordinal - b.ordinal);
  const ordered = all.filter(a => !eligibility(contract, state, a).length).sort((a, b) => compareBy(contract, a, b));
  for (const attempt of ordered.slice(0, contract.selection.topForT3)) {
    if (!state.evals.some(r => r.attemptId === attempt.id && r.tier === 'T3')) await evaluateAttempt(runDir, attempt.id, ['T3']);
  }
  ({ contract, state } = openRun(runDir));
  const table = all.map(stale => {
    const attempt = state.attempts.get(stale.id);
    const reasons = eligibility(contract, state, attempt);
    const rank = reasons.length ? null : ordered.findIndex(a => a.id === attempt.id) + 1;
    const t3 = rank && rank <= contract.selection.topForT3 ? evidenceFor(contract, state, attempt, 'T3') : null;
    return {
      attemptId: attempt.id,
      strategyId: attempt.strategyId,
      ordinal: attempt.ordinal,
      state: attempt.state,
      eligible: !reasons.length,
      reasons,
      rank,
      t3: t3 ? (t3.ok ? 'pass' : t3.reason) : 'not-reached',
      srcLines: attempt.frozen?.stats.srcLines ?? null,
      cost: costOf(contract, attempt) ?? null
    };
  });
  const winnerRow = table.filter(row => row.eligible && row.t3 === 'pass').sort((a, b) => a.rank - b.rank)[0] ?? null;
  const selection = { taskId, arm, policy: contract.selection, contractHash: contract.contractHash, table, winner: winnerRow?.attemptId ?? null };
  new Journal(contract.machine.runDir).append('selection.recorded', { selection });
  return selection;
}

const latestSelection = (state, taskId, arm) => state.selections.filter(s => s.taskId === taskId && s.arm === arm).at(-1) ?? null;

// ------------------------------------------------------------------------------------------ verdict

function evalMs(state, attemptId) {
  return state.evals.filter(r => r.attemptId === attemptId).reduce((sum, r) => sum + r.durationMs, 0);
}

/** Applies the frozen success criteria to the recorded selections. Never re-runs anything. */
export function verdict(runDir) {
  const { contract, state } = openRun(runDir);
  const metric = contract.budget.metric;
  const tasks = Object.keys(contract.tasks).map(taskId => {
    const arms = {};
    for (const arm of Object.keys(contract.arms)) {
      const attempts = attemptsFor(state, taskId, arm);
      const selection = latestSelection(state, taskId, arm);
      const winner = selection?.winner ? state.attempts.get(selection.winner) : null;
      // Active time only: an attempt's own agent wall time plus its own T1/T2 evaluation. Idle gaps
      // between commands and the T3 run made at selection time are excluded (run 2 counted them).
      const activeMs = a => (a.wallMs ?? 0) + state.evals.filter(r => r.attemptId === a.id && r.tier !== 'T3').reduce((sum, r) => sum + r.durationMs, 0);
      const eligible = new Set((selection?.table ?? []).filter(row => row.eligible).map(row => row.attemptId));
      let elapsed = 0;
      let timeToVerifiedMs = null;
      for (const a of [...attempts].sort((x, y) => x.ordinal - y.ordinal)) {
        elapsed += activeMs(a);
        if (timeToVerifiedMs === null && eligible.has(a.id)) timeToVerifiedMs = elapsed;
      }
      const verified = attempts.filter(a => eligible.has(a.id));
      arms[arm] = {
        attempts: attempts.map(a => ({ id: a.id, strategyId: a.strategyId, state: a.state, flags: a.flags, cost: costOf(contract, a) ?? null, wallMs: a.wallMs ?? null, evalMs: evalMs(state, a.id), toolUses: a.usage?.toolUses ?? null, testFiles: a.frozen?.stats.testFiles ?? null, similarity: a.frozen?.referenceSimilarity ?? null })),
        selected: Boolean(selection),
        winner: winner?.id ?? null,
        winnerSize: winner ? winner.frozen.stats[contract.successCriteria.patchSizeMeasure ?? 'srcLines'] : null,
        cost: attempts.reduce((sum, a) => sum + (costOf(contract, a) ?? 0), 0),
        agentWallMs: attempts.reduce((sum, a) => sum + (a.wallMs ?? 0), 0),
        evalMs: attempts.reduce((sum, a) => sum + evalMs(state, a.id), 0),
        // Measured, sequential: active time from the arm's first attempt to its first T1/T2-verified one.
        timeToVerifiedMs,
        // Projection only: the fastest verified attempt's own active time, as if all ran in parallel.
        projectedParallelMs: verified.length ? Math.min(...verified.map(activeMs)) : null
      };
    }
    const A = arms.A;
    const B = arms.B;
    return { taskId, arms, budgetOk: !B || !A || B.cost <= contract.budget.armBMultiplier * A.cost, complete: Object.values(arms).every(arm => arm.selected) };
  });
  const complete = tasks.every(task => task.complete) && !state.halted;
  const aVerified = tasks.filter(task => task.arms.A?.winner).length;
  const bVerified = tasks.filter(task => task.arms.B?.winner).length;
  const both = tasks.filter(task => task.arms.A?.winner && task.arms.B?.winner);
  const bSmaller = both.filter(task => task.arms.B.winnerSize < task.arms.A.winnerSize).length;
  const criterionA = bVerified >= aVerified + 1;
  const criterionB = bVerified === aVerified && bSmaller >= contract.successCriteria.smallerPatchTasks;
  const budgetOk = tasks.every(task => task.budgetOk);
  const outcome = !complete ? 'INCONCLUSIVE' : (criterionA || criterionB) && budgetOk ? 'B_BETTER' : 'NOT_BETTER';
  return { experimentId: contract.experimentId, contractHash: contract.contractHash, metric, outcome, halted: state.halted, criteria: { aVerified, bVerified, criterionA, bSmaller, criterionB, budgetOk }, tasks };
}

// ------------------------------------------------------------------------------------------ promotion proposals

function lockFileFor(contract, target) {
  return path.join(contract.machine.candidatesRoot, 'locks', `promotion-${sha256(fs.realpathSync.native(target).toLowerCase())}.lock`);
}

/**
 * Writes a reviewable promotion proposal for a selected winner. Never changes the target: the
 * patch is only checked (`git apply --check` is read-only) against the target's current HEAD and
 * working tree, and refused when any path it touches is dirty there. One proposal per target is
 * open at a time; the lock is held until a human releases it.
 */
export function proposePromotion(runDir, attemptId, target) {
  const { contract, journal, state } = openRun(runDir);
  requireLive(state);
  const attempt = requireAttempt(state, attemptId);
  const selection = latestSelection(state, attempt.taskId, attempt.arm);
  if (selection?.winner !== attemptId) throw new HarnessError('NOT_SELECTED', `${attemptId} is not the recorded winner of ${attempt.taskId}/${attempt.arm}`);
  const proposalId = randomUUID();
  const lockFile = lockFileFor(contract, target);
  const targetHead = git(target, ['rev-parse', 'HEAD'], { noHooksDir: noHooks(contract) }).trim();
  try {
    writeExclusive(lockFile, JSON.stringify({ proposalId, runDir: contract.machine.runDir, attemptId, targetHead, at: Date.now() }));
  } catch (error) {
    if (error.code === 'EEXIST') throw new HarnessError('PROMOTION_BUSY', `another proposal holds ${lockFile}`);
    throw error;
  }
  journal.append('proposal.intent', { proposalId, attemptId, target, lockFile });
  const refuse = (code, details) => {
    fs.rmSync(lockFile, { force: true });
    journal.append('proposal.refused', { proposalId, code, details });
    throw new HarnessError(code, details);
  };
  const patchFile = path.join(contract.machine.runDir, attempt.frozen.patch.file);
  if (sha256File(patchFile) !== attempt.frozen.patch.sha256) refuse('EVIDENCE_TAMPERED', 'candidate patch changed after freeze');
  const dirty = git(target, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...attempt.frozen.changedPaths], { noHooksDir: noHooks(contract) }).trim();
  if (dirty) refuse('TARGET_PATHS_DIRTY', `target has uncommitted changes on touched paths:\n${dirty}`);
  const check = git(target, ['apply', '--check', '--whitespace=nowarn', patchFile], { allowFail: true, noHooksDir: noHooks(contract) });
  if (check.status !== 0) refuse('PATCH_DOES_NOT_APPLY', check.stderr.trim());
  const dir = path.join(contract.machine.runDir, 'proposals', proposalId);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(patchFile, path.join(dir, 'candidate.patch'));
  const proposal = {
    proposalId,
    attemptId,
    taskId: attempt.taskId,
    arm: attempt.arm,
    strategyId: attempt.strategyId,
    contractHash: contract.contractHash,
    target,
    targetHead,
    patchSha256: attempt.frozen.patch.sha256,
    changedPaths: attempt.frozen.changedPaths,
    evidence: state.evals.filter(r => r.attemptId === attemptId).map(r => ({ tier: r.tier, outcome: r.outcome, log: r.log })),
    requiredAfterApply: ['T1', 'T2', 'T3'],
    decidedBy: null
  };
  fs.writeFileSync(path.join(dir, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'proposal.md'), [
    `# Promotion proposal ${proposalId}`,
    ``,
    `Winner \`${attemptId}\` (${attempt.strategyId}) for task \`${attempt.taskId}\`, arm ${attempt.arm}.`,
    `Contract \`${contract.contractHash}\`. Target \`${target}\` at \`${targetHead}\`.`,
    ``,
    `Nothing has been applied. To promote, a person must:`,
    `1. confirm the target is still at \`${targetHead}\` and the touched paths are still clean;`,
    `2. apply \`candidate.patch\` with \`git apply --3way\`;`,
    `3. re-run the task's T1-T3 commands in that final state before committing;`,
    `4. release this proposal's lock (\`release-proposal\`).`,
    ``,
    `Touched paths: ${attempt.frozen.changedPaths.join(', ')}`
  ].join('\n'));
  journal.append('proposal.written', { proposalId, proposal: { dir: toPosix(path.relative(contract.machine.runDir, dir)), targetHead, patchSha256: proposal.patchSha256 } });
  return proposal;
}

/** Re-checks a written proposal against the target as it is now (compare-and-swap on HEAD). */
export function checkProposal(runDir, proposalId) {
  const { contract, state } = openRun(runDir);
  const proposal = state.proposals.get(proposalId);
  if (proposal?.state !== 'written') throw new HarnessError('UNKNOWN_PROPOSAL', proposalId);
  const head = git(proposal.target, ['rev-parse', 'HEAD'], { noHooksDir: noHooks(contract) }).trim();
  if (head !== proposal.written.targetHead) throw new HarnessError('STALE_TARGET', `target moved from ${proposal.written.targetHead} to ${head}; re-propose and re-verify`);
  const attempt = state.attempts.get(proposal.attemptId);
  const dirty = git(proposal.target, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...attempt.frozen.changedPaths], { noHooksDir: noHooks(contract) }).trim();
  if (dirty) throw new HarnessError('TARGET_PATHS_DIRTY', dirty);
  return { ok: true, targetHead: head };
}

export function releaseProposal(runDir, proposalId) {
  const { journal, state } = openRun(runDir);
  const proposal = state.proposals.get(proposalId);
  if (!proposal || proposal.state !== 'written') throw new HarnessError('UNKNOWN_PROPOSAL', proposalId);
  const holder = fs.existsSync(proposal.lockFile) ? JSON.parse(fs.readFileSync(proposal.lockFile, 'utf8')) : null;
  if (holder?.proposalId === proposalId) fs.rmSync(proposal.lockFile);
  journal.append('proposal.released', { proposalId });
}

// ------------------------------------------------------------------------------------------ recovery

/**
 * Reconciles every interrupted step after a crash. Nothing is resumed silently: an attempt that
 * was running is failed (after a contamination check), never restarted under the same id.
 */
export function recover(runDir) {
  const { contract, journal, state } = openRun(runDir);
  const actions = [];
  for (const attempt of state.attempts.values()) {
    if (attempt.state === 'reserving') {
      journal.append('attempt.failed', { attemptId: attempt.id, reason: 'crash-during-reserve', details: fs.existsSync(attempt.workspace) ? 'partial workspace kept as evidence' : null });
      actions.push(`${attempt.id}: reserve interrupted -> failed`);
    } else if (attempt.state === 'running') {
      const drift = fingerprintDrift(attempt.preFingerprint, fingerprint(contract, state, attempt.id));
      journal.append('attempt.failed', { attemptId: attempt.id, reason: 'interrupted', details: drift.length ? drift : null });
      if (drift.length && !state.halted) journal.append('run.halted', { reason: `contamination seen while recovering ${attempt.id}`, details: drift });
      actions.push(`${attempt.id}: was running -> failed (confirm its worker has stopped)`);
    } else if (attempt.state === 'finished' || attempt.state === 'freezing') {
      if (attempt.state === 'freezing') {
        const hooks = noHooks(contract);
        const branch = `candidate/${attempt.id}`;
        const existing = git(attempt.workspace, ['rev-parse', '--verify', '--quiet', branch], { allowFail: true, noHooksDir: hooks });
        if (existing.status === 0 && existing.stdout.trim() !== attempt.fixtureCommit) {
          const commit = existing.stdout.trim();
          const patchText = git(attempt.workspace, ['diff', '--binary', attempt.fixtureCommit, commit], { noHooksDir: hooks });
          const patchFile = path.join(contract.machine.runDir, 'attempts', attempt.id, 'candidate.patch');
          fs.writeFileSync(patchFile, patchText);
          const changedPaths = git(attempt.workspace, ['diff', '--name-only', '-z', attempt.fixtureCommit, commit], { noHooksDir: hooks }).split('\0').filter(Boolean).sort();
          journal.append('attempt.frozen', { attemptId: attempt.id, frozen: {
            branch, commit, tree: git(attempt.workspace, ['rev-parse', `${commit}^{tree}`], { noHooksDir: hooks }).trim(), changedPaths,
            stats: diffStats(attempt.workspace, attempt.fixtureCommit, commit, hooks),
            patch: { file: toPosix(path.relative(contract.machine.runDir, patchFile)), sha256: sha256File(patchFile) }, notes: ['recovered']
          } });
          actions.push(`${attempt.id}: freeze had committed -> adopted ${commit}`);
          continue;
        }
        if (existing.status === 0) {
          git(attempt.workspace, ['checkout', '--quiet', 'fixture'], { noHooksDir: hooks });
          git(attempt.workspace, ['branch', '-D', branch], { noHooksDir: hooks });
          git(attempt.workspace, ['reset', '--quiet'], { noHooksDir: hooks });
        }
      }
      const result = freezeAttempt(runDir, attempt.id);
      actions.push(`${attempt.id}: freeze ${result.ok ? 'completed' : `refused (${result.details?.join(', ') ?? result.reason})`}`);
    }
  }
  for (const pending of journal.state().pendingEvals) {
    journal.append('eval.abandoned', { attemptId: pending.attemptId, tier: pending.tier });
    actions.push(`${pending.attemptId}: ${pending.tier} interrupted -> will be re-run`);
  }
  for (const proposal of journal.state().proposals.values()) {
    if (proposal.state !== 'intent') continue;
    const holder = fs.existsSync(proposal.lockFile) ? JSON.parse(fs.readFileSync(proposal.lockFile, 'utf8')) : null;
    if (holder?.proposalId === proposal.id) fs.rmSync(proposal.lockFile);
    journal.append('proposal.refused', { proposalId: proposal.id, code: 'INTERRUPTED', details: 'proposal interrupted before it was written' });
    actions.push(`proposal ${proposal.id}: interrupted -> refused, lock released`);
  }
  return actions;
}
