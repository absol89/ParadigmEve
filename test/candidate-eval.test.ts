import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-ignore The Phase-0 candidate-eval harness is intentionally plain ESM JavaScript.
import { freezeContract, harnessSha256, loadContract } from '../scripts/candidate-eval/contract.mjs';
// @ts-ignore The Phase-0 candidate-eval harness is intentionally plain ESM JavaScript.
import * as harness from '../scripts/candidate-eval/harness.mjs';
// @ts-ignore The Phase-0 candidate-eval harness is intentionally plain ESM JavaScript.
import { Journal } from '../scripts/candidate-eval/journal.mjs';
// @ts-ignore The Phase-0 candidate-eval harness is intentionally plain ESM JavaScript.
import { sha256 } from '../scripts/candidate-eval/core.mjs';

/**
 * Phase-0 candidate-eval harness. Each run uses a tiny synthetic product repository with one bug
 * (`add` subtracts), a separate "shared checkout" holding unrelated uncommitted work, and node-only
 * ladder commands, so the safety properties are exercised without the real ParadigmEve toolchain.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-eval-'));
const IDENTITY = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@invalid' };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const gitOk = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd }).status === 0;
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const ORACLE = "import { add } from '../src/calc.mjs';\nif (add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\n";

const product = path.join(root, 'product');
write(path.join(product, '.gitattributes'), '* text=auto eol=lf\n');
write(path.join(product, 'src', 'calc.mjs'), BUGGY);
write(path.join(product, 'test', 'calc.test.mjs'), "import { add } from '../src/calc.mjs';\nif (typeof add !== 'function') process.exit(1);\n");
write(path.join(product, 'test', 'helpers.mjs'), 'export const helper = 1;\n');
write(path.join(product, 'package.json'), '{ "name": "fixture" }\n');
write(path.join(product, 'docs', 'readme.md'), '# fixture\n');
write(path.join(product, 'docs', 'skills.md'), '# Skills\n\n## Test-first\n\nWrite the failing test first.\n\n## Other\n\nUnrelated.\n');
write(path.join(product, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
git(product, 'init', '-q', '-b', 'main');
git(product, 'add', '-A');
// An executable file: workspaces must reproduce its mode even where the filesystem cannot.
git(product, 'update-index', '--chmod=+x', 'scripts/run.sh');
git(product, 'commit', '-q', '-m', 'base');
const baseCommit = git(product, 'rev-parse', 'HEAD');
write(path.join(product, 'src', 'calc.mjs'), FIXED);
write(path.join(product, 'test', 'calc.test.mjs'), ORACLE);
git(product, 'add', '-A');
git(product, 'commit', '-q', '-m', 'fix add');
const fixCommit = git(product, 'rev-parse', 'HEAD');

/** The "shared checkout": at the bug's base, with someone else's uncommitted work in it. */
const shared = path.join(root, 'shared');
git(root, 'clone', '-q', product, shared);
git(shared, 'reset', '-q', '--hard', baseCommit);
write(path.join(shared, 'docs', 'readme.md'), '# fixture\n\nsomeone else is editing this\n');
write(path.join(shared, 'notes.txt'), 'untracked notes that belong to someone else\n');

const specDir = path.join(root, 'spec');
write(path.join(specDir, 'bug.md'), 'add subtracts instead of adding: add(2, 3) returns -1.\n');
for (const id of ['baseline', 'b2', 'b3']) write(path.join(specDir, 'strategies', `${id}.md`), `Strategy ${id}.\n`);

function spec(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    experimentId: 'unit',
    ownerNote: 'unit test fixture without a Plan',
    worker: { backend: 'test-backend', model: 'model-1' },
    scope: { allowedPaths: ['src/**', 'test/**/*.test.mjs'], protectedPaths: ['package.json', 'test/helpers.mjs', '.gitattributes'] },
    strategies: [
      { id: 'baseline', kind: 'file', path: 'strategies/baseline.md' },
      { id: 'test-first', kind: 'vault-section', path: 'docs/skills.md', heading: 'Test-first', commit: fixCommit },
      { id: 'b2', kind: 'file', path: 'strategies/b2.md' },
      { id: 'b3', kind: 'file', path: 'strategies/b3.md' }
    ],
    arms: { A: ['baseline'], B: ['test-first', 'b2', 'b3'] },
    tasks: [{
      id: 'calc',
      title: 'add subtracts',
      bugReport: 'bug.md',
      fixture: { baseCommit, patches: [] },
      reference: { commit: fixCommit, paths: ['src'] },
      oracle: [{ path: 'test/calc.test.mjs', fromCommit: fixCommit }],
      subsystemTests: ['test/calc.test.mjs']
    }],
    ladder: {
      T1: { cmd: ['node', '{oracle}'], timeoutMs: 30_000 },
      T2: { cmd: ['node', '-e', "import('./src/calc.mjs').then(() => {}, () => process.exit(1))"], timeoutMs: 30_000 },
      T3: { cmd: ['node', '{subsystemTests}'], timeoutMs: 30_000 }
    },
    budget: { metric: 'totalTokens', armBMultiplier: 3.5, perAttemptWallMs: 3_600_000 },
    selection: { order: ['srcLines', 'files', 'cost', 'ordinal'], topForT3: 2 },
    successCriteria: { smallerPatchTasks: 2 },
    ...overrides
  };
}

const candidatesRoot = path.join(root, 'candidates');
const machine = (extra: Record<string, unknown> = {}) => ({ productRepo: product, candidatesRoot, watch: [shared], nodeModules: null, ...extra });

function newRun(name: string, overrides: Record<string, unknown> = {}, extraMachine: Record<string, unknown> = {}): string {
  const specFile = path.join(specDir, `${name}.json`);
  write(specFile, JSON.stringify(spec(overrides)));
  const runDir = path.join(candidatesRoot, 'runs', name);
  freezeContract({ specFile, machine: machine(extraMachine), runDir });
  return runDir;
}
async function calibratedRun(name: string): Promise<string> {
  const run = newRun(name);
  expect((await harness.calibrateTask(run, 'calc')).ok).toBe(true);
  return run;
}
function fix(workspace: string): void {
  write(path.join(workspace, 'src', 'calc.mjs'), FIXED);
  write(path.join(workspace, 'test', 'calc-regression.test.mjs'), "import { add } from '../src/calc.mjs';\nif (add(1, 1) !== 2) process.exit(1);\n");
}
function attempt(run: string, arm: string, strategyId: string, mutate: (workspace: string) => void, usage: Record<string, number> = { totalTokens: 100 }) {
  const reserved = harness.reserveAttempt(run, { taskId: 'calc', arm, strategyId });
  harness.startAttempt(run, reserved.attemptId, { model: 'model-1' });
  mutate(reserved.workspace);
  return { ...reserved, finish: harness.finishAttempt(run, reserved.attemptId, { usage }) };
}
const state = (run: string) => new Journal(run).state();

afterAll(() => {
  for (const file of fs.readdirSync(path.join(candidatesRoot, 'runs'))) {
    const contract = path.join(candidatesRoot, 'runs', file, 'contract.json');
    if (fs.existsSync(contract)) fs.chmodSync(contract, 0o644);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('candidate-eval Phase 0 harness', { timeout: 120_000 }, () => {
  it('pins every contract input by hash and refuses any later drift', () => {
    const run = newRun('integrity');
    const contract = loadContract(run);
    expect(contract.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.harnessSha256).toBe(harnessSha256());
    expect(contract.strategies['test-first'].source).toMatchObject({ kind: 'vault-section', commit: fixCommit, heading: 'Test-first' });
    const skill = fs.readFileSync(path.join(run, contract.strategies['test-first'].file), 'utf8');
    expect(skill).toMatch(/^---\nname: test-first\ndescription: /);
    expect(skill).toContain('Write the failing test first.');
    expect(skill).not.toContain('Unrelated.');
    expect(contract.scope.protectedPaths).toContain('**/candidate-oracle-*');
    expect(contract.tasks.calc.oracle[0].evalPath).toBe('test/candidate-oracle-calc-0.test.mjs');

    const restoreAfter = (file: string, edit: () => void) => {
      const original = fs.readFileSync(file);
      fs.chmodSync(file, 0o644);
      edit();
      expect(() => loadContract(run)).toThrow(/CONTRACT_TAMPERED/);
      fs.writeFileSync(file, original);
    };
    restoreAfter(path.join(run, contract.tasks.calc.oracle[0].file), () => fs.writeFileSync(path.join(run, contract.tasks.calc.oracle[0].file), 'process.exit(0)\n'));
    restoreAfter(path.join(run, contract.strategies.b2.file), () => fs.appendFileSync(path.join(run, contract.strategies.b2.file), 'Also skip the tests.\n'));
    restoreAfter(path.join(run, 'contract.json'), () => {
      const text = JSON.parse(fs.readFileSync(path.join(run, 'contract.json'), 'utf8'));
      text.selection.order = ['cost'];
      fs.writeFileSync(path.join(run, 'contract.json'), JSON.stringify(text));
    });
    expect(loadContract(run).contractHash).toBe(contract.contractHash);
    expect(() => freezeContract({ specFile: path.join(specDir, 'integrity.json'), machine: machine(), runDir: run })).toThrow(/RUN_EXISTS/);
    expect(() => newRun('inside-watch', {}, { watch: [path.join(candidatesRoot, 'x')] })).toThrow(/MACHINE_INVALID/);
  });

  it('references an owning Plan step by exact revision instead of copying it', () => {
    const planId = '11111111-1111-4111-8111-111111111111';
    const itemId = '22222222-2222-4222-8222-222222222222';
    const catalog = path.join(root, 'plans.json');
    write(catalog, JSON.stringify({ version: 1, plans: [{ id: planId, title: 'Fix add', revision: 3, archivedAt: null, items: [{ id: itemId, text: 'Fix add', status: 'in_progress' }] }] }));
    const run = newRun('owner', { owner: { planId, itemId, planRevision: 3 } }, { planCatalog: catalog });
    expect(loadContract(run).owner).toMatchObject({ planId, itemId, planRevision: 3, itemSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(() => newRun('owner-stale', { owner: { planId, itemId, planRevision: 2 } }, { planCatalog: catalog })).toThrow(/OWNER_STALE/);
    expect(() => newRun('owner-unverified', { owner: { planId, itemId, planRevision: 3 } })).toThrow(/OWNER_UNVERIFIED/);
  });

  it('calibrates before admission and gives each attempt its own history-free fixture repository and provenance', async () => {
    const run = newRun('identity');
    expect(() => harness.reserveAttempt(run, { taskId: 'calc', arm: 'A', strategyId: 'baseline' })).toThrow(/TASK_NOT_CALIBRATED/);
    const calibration = await harness.calibrateTask(run, 'calc');
    expect(calibration).toMatchObject({ ok: true, steps: { fixtureOracle: { outcome: 'fail' }, referenceOracle: { outcome: 'pass' } } });

    const a = harness.reserveAttempt(run, { taskId: 'calc', arm: 'A', strategyId: 'baseline' });
    const b = harness.reserveAttempt(run, { taskId: 'calc', arm: 'B', strategyId: 'b2' });
    expect(a.attemptId).not.toBe(b.attemptId);
    expect([state(run).attempts.get(a.attemptId).ordinal, state(run).attempts.get(b.attemptId).ordinal]).toEqual([1, 2]);
    expect(git(a.workspace, 'rev-parse', 'HEAD^{tree}')).toBe(loadContract(run).tasks.calc.fixture.tree);
    expect(git(a.workspace, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(gitOk(a.workspace, 'cat-file', '-e', fixCommit)).toBe(false); // the real fix is not reachable
    expect(fs.existsSync(path.join(a.workspace, 'test', 'candidate-oracle-calc-0.test.mjs'))).toBe(false);
    expect(fs.readFileSync(path.join(a.workspace, 'test', 'calc.test.mjs'), 'utf8')).not.toContain('add(2, 3)');
    expect(() => harness.reserveAttempt(run, { taskId: 'calc', arm: 'A', strategyId: 'baseline' })).toThrow(/STRATEGY_ALREADY_TRIED/);

    expect(() => harness.startAttempt(run, a.attemptId, { model: 'model-2' })).toThrow(/MODEL_MISMATCH/);
    expect(() => harness.startAttempt(run, b.attemptId, { model: 'model-1' })).toThrow(/BASELINE_REQUIRED/);
    const { briefFile, brief } = harness.startAttempt(run, a.attemptId, { model: 'model-1', agentType: 'general-purpose' });
    expect(brief).toContain(a.workspace);
    expect(brief).toContain('add subtracts instead of adding');
    expect(() => harness.startAttempt(run, b.attemptId, { model: 'model-1' })).toThrow(/ATTEMPT_RUNNING/);
    const started = state(run).attempts.get(a.attemptId);
    expect(started.brief.sha256).toBe(sha256(fs.readFileSync(briefFile)));
    expect(started.worker).toMatchObject({ backend: 'test-backend', model: 'model-1', agentType: 'general-purpose', strategyPackageSha256: loadContract(run).strategies.baseline.packageSha256 });
  });

  it('halts the run when a candidate writes into the shared checkout, and keeps that a detection', async () => {
    const run = await calibratedRun('contaminate-shared');
    const victim = path.join(shared, 'docs', 'readme.md');
    const before = fs.readFileSync(victim, 'utf8');
    const { attemptId, finish } = attempt(run, 'A', 'baseline', workspace => {
      fix(workspace);
      fs.appendFileSync(victim, 'candidate was here\n');
    });
    expect(finish).toMatchObject({ ok: false, reason: 'contamination' });
    expect(finish.drift.join('\n')).toContain('docs/readme.md');
    expect(state(run).halted?.reason).toContain(attemptId);
    expect(state(run).attempts.get(attemptId).state).toBe('disqualified');
    expect(() => harness.reserveAttempt(run, { taskId: 'calc', arm: 'B', strategyId: 'b2' })).toThrow(/RUN_HALTED/);
    // Detection only: the write happened and stays until a person repairs it.
    expect(fs.readFileSync(victim, 'utf8')).toContain('candidate was here');
    fs.writeFileSync(victim, before);
  });

  it('halts the run when a candidate writes into a sibling candidate workspace', async () => {
    const run = await calibratedRun('contaminate-sibling');
    const first = attempt(run, 'A', 'baseline', fix);
    expect(first.finish.ok).toBe(true);
    const second = attempt(run, 'B', 'b2', workspace => {
      fix(workspace);
      fs.writeFileSync(path.join(first.workspace, 'src', 'calc.mjs'), 'export const add = () => 5;\n');
    });
    expect(second.finish).toMatchObject({ ok: false, reason: 'contamination' });
    expect(second.finish.drift.join('\n')).toContain(`attempt:${first.attemptId}`);
  });

  it.each([
    ['an out-of-scope file', (w: string) => write(path.join(w, 'docs', 'new.md'), 'x\n'), 'out-of-scope:docs/new.md'],
    ['package.json', (w: string) => write(path.join(w, 'package.json'), '{ "name": "fixture", "scripts": {} }\n'), 'protected-path:package.json'],
    ['a file shaped like the oracle', (w: string) => write(path.join(w, 'test', 'candidate-oracle-calc-0.test.mjs'), 'process.exit(0)\n'), 'protected-path:test/candidate-oracle-calc-0.test.mjs'],
    ['a test helper the oracle may import', (w: string) => write(path.join(w, 'test', 'helpers.mjs'), 'export const helper = 2;\n'), 'protected-path:test/helpers.mjs'],
    ['a focused test', (w: string) => write(path.join(w, 'test', 'focus.test.mjs'), "it.only('x', () => {});\n"), 'focus-or-skip-marker:test/focus.test.mjs'],
    ['a git hook', (w: string) => write(path.join(w, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n'), 'git-control-tampered']
  ])('disqualifies %s without committing anything', async (label, tamper, reason) => {
    const run = await calibratedRun(`scope-${label.replace(/[^a-z]+/g, '-')}`);
    const { attemptId, workspace, finish } = attempt(run, 'A', 'baseline', w => { fix(w); tamper(w); });
    expect(finish).toMatchObject({ ok: false, reason: 'scope' });
    expect(finish.details).toContain(reason);
    expect(state(run).attempts.get(attemptId).state).toBe('disqualified');
    if (reason !== 'git-control-tampered') {
      expect(gitOk(workspace, 'rev-parse', '--verify', `candidate/${attemptId}`)).toBe(false);
      expect(fs.existsSync(path.join(run, 'attempts', attemptId, 'rejected-worktree.patch'))).toBe(true);
    }
  });

  it('disqualifies an attempt that changed nothing', async () => {
    const run = await calibratedRun('empty');
    expect(attempt(run, 'A', 'baseline', () => undefined).finish.details).toContain('empty-diff');
  });

  it('evaluates the frozen commit in a fresh checkout and refuses missing or altered evidence', async () => {
    const run = await calibratedRun('evidence');
    const { attemptId, workspace, finish } = attempt(run, 'A', 'baseline', fix);
    expect(finish.ok).toBe(true);
    expect(finish.frozen.changedPaths).toEqual(['src/calc.mjs', 'test/calc-regression.test.mjs']);
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`candidate/${attemptId}`);

    let selection = await harness.selectArm(run, 'calc', 'A');
    expect(selection.winner).toBeNull();
    expect(selection.table[0].reasons).toEqual(['missing-evidence:T1']);

    // Something the candidate leaves behind after its freeze cannot reach the evaluated tree.
    write(path.join(workspace, 'src', 'calc.mjs'), BUGGY);
    const results = await harness.evaluateAttempt(run, attemptId);
    expect(results.map((r: { tier: string; outcome: string }) => `${r.tier}:${r.outcome}`)).toEqual(['T1:pass', 'T2:pass']);
    expect(fs.existsSync(path.join(workspace, 'test', 'candidate-oracle-calc-0.test.mjs'))).toBe(false);

    selection = await harness.selectArm(run, 'calc', 'A');
    expect(selection.winner).toBe(attemptId);
    expect(selection.table[0]).toMatchObject({ eligible: true, rank: 1, t3: 'pass' });

    const t1 = state(run).evals.find((r: { tier: string }) => r.tier === 'T1');
    fs.appendFileSync(path.join(run, t1.log.file), 'edited\n');
    selection = await harness.selectArm(run, 'calc', 'A');
    expect(selection.winner).toBeNull();
    expect(selection.table[0].reasons).toEqual(['invalid-evidence:T1']);
  });

  it('records a no-winner result, prunes after the first failing tier and refuses to propose it', async () => {
    const run = await calibratedRun('no-winner');
    const { attemptId } = attempt(run, 'A', 'baseline', w => write(path.join(w, 'src', 'calc.mjs'), `// looked at it\n${BUGGY}`));
    const results = await harness.evaluateAttempt(run, attemptId);
    expect(results.map((r: { tier: string; outcome: string }) => `${r.tier}:${r.outcome}`)).toEqual(['T1:fail']);
    const selection = await harness.selectArm(run, 'calc', 'A');
    expect(selection.winner).toBeNull();
    expect(selection.table[0].reasons).toEqual(['fail:T1']);
    expect(() => harness.proposePromotion(run, attemptId, shared)).toThrow(/NOT_SELECTED/);
  });

  it('enforces the arm-B compute budget at admission and marks an overrun ineligible', async () => {
    const run = await calibratedRun('budget');
    attempt(run, 'A', 'baseline', fix, { totalTokens: 100 });
    const b1 = attempt(run, 'B', 'test-first', fix, { totalTokens: 300 });
    expect(state(run).attempts.get(b1.attemptId).flags).toEqual([]);
    const b2 = attempt(run, 'B', 'b2', fix, { totalTokens: 100 });
    expect(state(run).attempts.get(b2.attemptId).flags).toContain('over-budget');
    const b3 = harness.reserveAttempt(run, { taskId: 'calc', arm: 'B', strategyId: 'b3' });
    expect(() => harness.startAttempt(run, b3.attemptId, { model: 'model-1' })).toThrow(/BUDGET_EXHAUSTED/);
    await harness.evaluateAttempt(run, b2.attemptId);
    const selection = await harness.selectArm(run, 'calc', 'B');
    expect(selection.table.find((row: { attemptId: string }) => row.attemptId === b2.attemptId).reasons).toContain('flag:over-budget');

    const unknown = await calibratedRun('budget-unknown');
    const a = attempt(unknown, 'A', 'baseline', fix, {});
    expect(state(unknown).attempts.get(a.attemptId).flags).toContain('cost-unknown');
    const b = harness.reserveAttempt(unknown, { taskId: 'calc', arm: 'B', strategyId: 'b2' });
    expect(() => harness.startAttempt(unknown, b.attemptId, { model: 'model-1' })).toThrow(/BASELINE_REQUIRED/);
  });

  it('applies the frozen success criteria to recorded selections', async () => {
    const run = await calibratedRun('verdict');
    const a = attempt(run, 'A', 'baseline', w => write(path.join(w, 'src', 'calc.mjs'), `// no fix\n${BUGGY}`));
    await harness.evaluateAttempt(run, a.attemptId);
    expect(harness.verdict(run).outcome).toBe('INCONCLUSIVE');
    for (const strategy of ['test-first', 'b2']) {
      const b = attempt(run, 'B', strategy, fix, { totalTokens: 100 });
      await harness.evaluateAttempt(run, b.attemptId);
    }
    await harness.selectArm(run, 'calc', 'A');
    const selection = await harness.selectArm(run, 'calc', 'B');
    expect(selection.table.map((row: { rank: number | null }) => row.rank)).toEqual([1, 2]);
    const result = harness.verdict(run);
    expect(result.criteria).toMatchObject({ aVerified: 0, bVerified: 1, criterionA: true, budgetOk: true });
    expect(result.outcome).toBe('B_BETTER');
    expect(result.tasks[0].arms.B.timeToVerifiedMs).toBeGreaterThan(0);
  });

  it('recovers from a torn journal tail and interrupted steps without reusing identities', async () => {
    const run = await calibratedRun('recover');
    const journalFile = path.join(run, 'journal.jsonl');
    fs.appendFileSync(journalFile, '{"seq":99,"type":"attempt.res');
    expect(() => state(run)).not.toThrow();

    // Interrupted while running: failed after a contamination check, never restarted.
    const running = harness.reserveAttempt(run, { taskId: 'calc', arm: 'A', strategyId: 'baseline' });
    harness.startAttempt(run, running.attemptId, { model: 'model-1' });
    expect(harness.recover(run).join('\n')).toContain(`${running.attemptId}: was running -> failed`);
    expect(state(run).attempts.get(running.attemptId).state).toBe('failed');
    expect(() => harness.reserveAttempt(run, { taskId: 'calc', arm: 'A', strategyId: 'baseline' })).toThrow(/STRATEGY_ALREADY_TRIED/);

    // Interrupted between finish and freeze, then mid-evaluation.
    const second = await calibratedRun('recover-freeze');
    const reserved = harness.reserveAttempt(second, { taskId: 'calc', arm: 'A', strategyId: 'baseline' });
    harness.startAttempt(second, reserved.attemptId, { model: 'model-1' });
    fix(reserved.workspace);
    const journal = new Journal(second);
    const pre = state(second).attempts.get(reserved.attemptId).preFingerprint;
    journal.append('attempt.finished', { attemptId: reserved.attemptId, usage: { totalTokens: 5 }, postFingerprint: pre, flags: [], drift: [] });
    journal.append('attempt.freeze.intent', { attemptId: reserved.attemptId });
    harness.recover(second);
    expect(state(second).attempts.get(reserved.attemptId).state).toBe('frozen');
    journal.append('eval.intent', { attemptId: reserved.attemptId, tier: 'T1' });
    expect(harness.recover(second).join('\n')).toContain('T1 interrupted -> will be re-run');
    expect(state(second).pendingEvals).toEqual([]);
    expect((await harness.evaluateAttempt(second, reserved.attemptId)).map((r: { outcome: string }) => r.outcome)).toEqual(['pass', 'pass']);

    // A corrupt line that is not the tail fails closed.
    const lines = fs.readFileSync(journalFile, 'utf8').split('\n');
    lines[1] = '{broken';
    fs.writeFileSync(journalFile, lines.join('\n'));
    expect(() => state(run)).toThrow(/JOURNAL_CORRUPT/);
  });

  it('serializes promotion proposals per target and never touches the shared checkout', async () => {
    const run = await calibratedRun('promote');
    const { attemptId } = attempt(run, 'A', 'baseline', fix);
    await harness.evaluateAttempt(run, attemptId);
    expect((await harness.selectArm(run, 'calc', 'A')).winner).toBe(attemptId);

    const snapshot = () => ({
      status: git(shared, 'status', '--porcelain=v1', '--untracked-files=all'),
      head: git(shared, 'rev-parse', 'HEAD'),
      files: ['docs/readme.md', 'notes.txt', 'src/calc.mjs'].map(file => fs.readFileSync(path.join(shared, file), 'utf8'))
    });
    const before = snapshot();
    const proposal = harness.proposePromotion(run, attemptId, shared);
    expect(proposal).toMatchObject({ attemptId, targetHead: before.head, changedPaths: ['src/calc.mjs', 'test/calc-regression.test.mjs'] });
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(run, 'proposals', proposal.proposalId, 'proposal.md'))).toBe(true);

    expect(() => harness.proposePromotion(run, attemptId, shared)).toThrow(/PROMOTION_BUSY/);
    expect(harness.checkProposal(run, proposal.proposalId)).toMatchObject({ ok: true });
    git(shared, 'commit', '-q', '--allow-empty', '-m', 'someone else moved the branch');
    expect(() => harness.checkProposal(run, proposal.proposalId)).toThrow(/STALE_TARGET/);
    harness.releaseProposal(run, proposal.proposalId);

    write(path.join(shared, 'src', 'calc.mjs'), `${BUGGY}// local edit\n`);
    expect(() => harness.proposePromotion(run, attemptId, shared)).toThrow(/TARGET_PATHS_DIRTY/);
    expect(fs.readFileSync(path.join(shared, 'src', 'calc.mjs'), 'utf8')).toBe(`${BUGGY}// local edit\n`);
    write(path.join(shared, 'src', 'calc.mjs'), BUGGY);
    const again = harness.proposePromotion(run, attemptId, shared); // the refused proposal released its lock
    harness.releaseProposal(run, again.proposalId);
    expect(fs.readFileSync(path.join(shared, 'notes.txt'), 'utf8')).toBe(before.files[1]);
  });
});
