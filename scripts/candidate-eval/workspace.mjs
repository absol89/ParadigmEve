/**
 * Candidate workspaces, contamination fingerprints, the scope guard and freezing.
 *
 * What this module ENFORCES:
 * - a workspace is a standalone repository whose only commit is the frozen fixture tree, so the
 *   product history (which contains the real fix) is not reachable through the candidate's git;
 * - evaluation never trusts the candidate's directory: it reads a commit the harness made from
 *   explicitly named, in-scope paths, after hooks/config tampering checks;
 * - an out-of-scope or protected change is never committed; the attempt is disqualified and its
 *   working-tree diff is kept as evidence.
 *
 * What it only DETECTS (fail closed, never prevents): writes by a candidate outside its own
 * workspace. A candidate agent runs with the operator's OS authority; the before/after
 * fingerprints below find damage to watched repositories and sibling workspaces and halt the run,
 * but cannot stop it happening. Ignored files outside workspaces are not fingerprinted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HarnessError, canonicalJson, git, matchesAny, sha256, sha256File, toPosix } from './core.mjs';

export const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'candidate-eval',
  GIT_AUTHOR_EMAIL: 'candidate-eval@invalid',
  GIT_COMMITTER_NAME: 'candidate-eval',
  GIT_COMMITTER_EMAIL: 'candidate-eval@invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
};

const noHooks = contract => path.join(contract.machine.runDir, 'no-hooks');

/** Links node_modules without copying it. A junction needs no elevation on Windows. */
export function linkNodeModules(contract, dir) {
  if (!contract.machine.nodeModules) return;
  fs.symlinkSync(contract.machine.nodeModules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Removes only the node_modules link, never its target, and proves it is gone. Must run before any
 * recursive removal of a workspace, so no delete can follow the link into the shared dependencies.
 */
export function unlinkNodeModules(dir) {
  const link = path.join(dir, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) throw new HarnessError('NODE_MODULES_NOT_LINK', `${link} is a real directory; refusing to touch it`);
  if (process.platform === 'win32') fs.rmdirSync(link);
  else fs.unlinkSync(link);
  let still = true;
  try { fs.lstatSync(link); } catch { still = false; }
  if (still) throw new HarnessError('NODE_MODULES_LINK_STUCK', `${link} could not be removed`);
}

/** Writes `tree` from the product repo into a new directory and commits it as a fresh repo. */
export function materializeFixture(contract, taskId, dir) {
  const task = contract.tasks[taskId];
  if (fs.existsSync(dir)) throw new HarnessError('WORKSPACE_EXISTS', `${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(contract.machine.runDir, 'tmp', `materialize-${process.pid}-${Date.now()}.index`);
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const repo = contract.machine.productRepo;
  try {
    // Private index + explicit work tree: the product checkout and its index are never written.
    git(repo, ['--work-tree', dir, 'read-tree', task.fixture.tree], { env: { GIT_INDEX_FILE: index } });
    git(repo, ['--work-tree', dir, 'checkout-index', '--all', '--force'], { env: { GIT_INDEX_FILE: index } });
  } finally {
    fs.rmSync(index, { force: true });
  }
  const hooks = noHooks(contract);
  git(dir, ['init', '--quiet', '--initial-branch=fixture'], { noHooksDir: hooks });
  git(dir, ['config', 'core.autocrlf', 'false'], { noHooksDir: hooks });
  git(dir, ['add', '--all'], { noHooksDir: hooks });
  git(dir, ['commit', '--quiet', '--no-gpg-sign', '-m', `fixture ${taskId}`], { env: FIXTURE_IDENTITY, noHooksDir: hooks });
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}'], { noHooksDir: hooks }).trim();
  if (tree !== task.fixture.tree) throw new HarnessError('WORKSPACE_MISMATCH', `materialized tree ${tree} differs from fixture ${task.fixture.tree}`);
  const commit = git(dir, ['rev-parse', 'HEAD'], { noHooksDir: hooks }).trim();
  linkNodeModules(contract, dir);
  return { commit, tree, gitConfigSha: gitControlSha(dir) };
}

/** Hash of the repository-local files that can make git execute code or rewrite content. */
export function gitControlSha(dir) {
  const gitDir = path.join(dir, '.git');
  const parts = [];
  for (const relative of ['config', 'info/attributes']) {
    const file = path.join(gitDir, relative);
    parts.push(`${relative}:${fs.existsSync(file) ? sha256File(file) : '-'}`);
  }
  const hooksDir = path.join(gitDir, 'hooks');
  const hooks = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).filter(name => !name.endsWith('.sample')).sort() : [];
  parts.push(`hooks:${hooks.join(',')}`);
  return sha256(parts.join('\n'));
}

function repoFingerprint(dir, hooks) {
  if (!fs.existsSync(dir)) return { missing: true };
  const head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true, noHooksDir: hooks });
  const status = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { noHooksDir: hooks });
  const files = {};
  for (const entry of status.split('\0').filter(Boolean)) {
    const relative = entry.slice(3);
    const file = path.join(dir, relative);
    try {
      const stat = fs.lstatSync(file);
      files[relative] = stat.isFile() ? sha256File(file) : stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : 'dir';
    } catch {
      files[relative] = 'absent';
    }
  }
  return { head: head.status === 0 ? head.stdout.trim() : null, status: sha256(status), files };
}

/**
 * Fingerprint of everything a candidate must not touch: watched repositories (the shared
 * checkout, the release worktree), every other attempt's workspace, and the node_modules lockfile.
 */
export function fingerprint(contract, state, exceptAttemptId) {
  const hooks = noHooks(contract);
  const entries = {};
  for (const dir of contract.machine.watch) entries[`watch:${dir}`] = repoFingerprint(dir, hooks);
  for (const attempt of state.attempts.values()) {
    if (attempt.id === exceptAttemptId || !fs.existsSync(attempt.workspace)) continue;
    entries[`attempt:${attempt.id}`] = repoFingerprint(attempt.workspace, hooks);
  }
  if (contract.machine.nodeModules) {
    const lock = path.join(contract.machine.nodeModules, '.package-lock.json');
    entries['node_modules'] = { lock: fs.existsSync(lock) ? sha256File(lock) : 'absent' };
  }
  return { entries, sha256: sha256(canonicalJson(entries)) };
}

/** Human-readable differences between two fingerprints. Empty means no contamination seen. */
export function fingerprintDrift(before, after) {
  const drift = [];
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const key of [...keys].sort()) {
    const a = before.entries[key];
    const b = after.entries[key];
    if (!a || !b) { drift.push(`${key}: ${a ? 'disappeared' : 'appeared'}`); continue; }
    if (a.missing !== b.missing) { drift.push(`${key}: existence changed`); continue; }
    if (a.lock !== b.lock) drift.push(`${key}: lockfile changed`);
    if (a.head !== b.head) drift.push(`${key}: HEAD ${a.head} -> ${b.head}`);
    const files = new Set([...Object.keys(a.files ?? {}), ...Object.keys(b.files ?? {})]);
    for (const file of [...files].sort()) if ((a.files ?? {})[file] !== (b.files ?? {})[file]) drift.push(`${key}: ${file}`);
    if (a.status !== b.status && !drift.some(line => line.startsWith(`${key}:`))) drift.push(`${key}: status changed`);
  }
  return drift;
}

const FOCUS_OR_SKIP = /\b(?:it|test|describe|suite)\s*\.\s*(?:only|skip|todo|skipIf|runIf)\b|\b(?:xit|xdescribe|fit|fdescribe)\s*\(/;

/** The changes in a workspace relative to its fixture commit, and whether they are in scope. */
export function guardWorkspace(contract, attempt) {
  const dir = attempt.workspace;
  const hooks = noHooks(contract);
  const reasons = [];
  if (gitControlSha(dir) !== attempt.gitConfigSha) {
    // Do not run git here at all: config/hooks may now execute candidate code.
    return { ok: false, reasons: ['git-control-tampered'], changed: [], safeToInspect: false };
  }
  const fixtureTree = git(dir, ['rev-parse', `${attempt.fixtureCommit}^{tree}`], { noHooksDir: hooks }).trim();
  if (fixtureTree !== contract.tasks[attempt.taskId].fixture.tree) reasons.push('fixture-commit-rewritten');
  const head = git(dir, ['rev-parse', 'HEAD'], { noHooksDir: hooks }).trim();
  if (head !== attempt.fixtureCommit) reasons.push('candidate-made-commits');
  const changed = [];
  const tracked = git(dir, ['diff', '--name-status', '-z', '--no-renames', attempt.fixtureCommit], { noHooksDir: hooks }).split('\0').filter(Boolean);
  for (let i = 0; i < tracked.length; i += 2) changed.push({ status: tracked[i], path: tracked[i + 1] });
  for (const file of git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { noHooksDir: hooks }).split('\0').filter(Boolean)) {
    changed.push({ status: '?', path: file });
  }
  if (!changed.length) reasons.push('empty-diff');
  for (const change of changed) {
    const file = toPosix(change.path);
    if (matchesAny(file, contract.scope.protectedPaths)) reasons.push(`protected-path:${file}`);
    else if (!matchesAny(file, contract.scope.allowedPaths)) reasons.push(`out-of-scope:${file}`);
    const absolute = path.join(dir, change.path);
    if (change.status !== 'D' && fs.existsSync(absolute)) {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) reasons.push(`link:${file}`);
      if (/\.test\.[cm]?[jt]sx?$/.test(file)) {
        const added = change.status === '?'
          ? fs.readFileSync(absolute, 'utf8').split('\n')
          : git(dir, ['diff', attempt.fixtureCommit, '--', change.path], { noHooksDir: hooks }).split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
        if (added.some(line => FOCUS_OR_SKIP.test(line))) reasons.push(`focus-or-skip-marker:${file}`);
      }
    }
  }
  // A candidate commit is noted, not disqualifying: the working tree is compared with the fixture.
  const blocking = reasons.filter(reason => reason !== 'candidate-made-commits');
  return { ok: blocking.length === 0, reasons, changed, safeToInspect: true };
}

/** Lines added/removed under src/, the patch-size measure used for ranking. */
export function diffStats(dir, fromCommit, toCommit, hooks) {
  const numstat = git(dir, ['diff', '--numstat', fromCommit, toCommit], { noHooksDir: hooks }).trim();
  let srcLines = 0;
  let totalLines = 0;
  let files = 0;
  for (const line of numstat ? numstat.split('\n') : []) {
    const [added, removed, file] = line.split('\t');
    const lines = (Number(added) || 0) + (Number(removed) || 0);
    totalLines += lines;
    files += 1;
    if (file.startsWith('src/')) srcLines += lines;
  }
  return { files, totalLines, srcLines };
}

/**
 * Commits exactly the in-scope changed paths on `candidate/<attemptId>`. Nothing is staged with
 * `add --all`; staging is checked to equal the guarded set before the commit is made.
 */
export function freezeWorkspace(contract, attempt) {
  const dir = attempt.workspace;
  const hooks = noHooks(contract);
  const guard = guardWorkspace(contract, attempt);
  const evidenceDir = path.join(contract.machine.runDir, 'attempts', attempt.id);
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (!guard.ok) {
    let evidence = null;
    if (guard.safeToInspect) {
      const untracked = guard.changed.filter(change => change.status === '?').map(change => change.path);
      const patch = git(dir, ['diff', '--binary', attempt.fixtureCommit], { noHooksDir: hooks }) +
        (untracked.length ? `\n# untracked (not committed):\n${untracked.map(file => `#   ${file}`).join('\n')}\n` : '');
      const file = path.join(evidenceDir, 'rejected-worktree.patch');
      fs.writeFileSync(file, patch);
      evidence = { file: toPosix(path.relative(contract.machine.runDir, file)), sha256: sha256File(file) };
    }
    return { ok: false, guard, evidence };
  }
  if (guard.reasons.includes('candidate-made-commits')) git(dir, ['reset', '--quiet', '--mixed', attempt.fixtureCommit], { noHooksDir: hooks });
  git(dir, ['checkout', '--quiet', '-b', `candidate/${attempt.id}`, attempt.fixtureCommit], { noHooksDir: hooks, allowFail: false });
  const paths = guard.changed.map(change => change.path);
  git(dir, ['add', '--', ...paths], { noHooksDir: hooks });
  const staged = git(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames'], { noHooksDir: hooks }).split('\0').filter(Boolean).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...paths].sort())) {
    throw new HarnessError('FREEZE_MISMATCH', `staged ${staged.join(',')} differs from guarded ${paths.join(',')}`);
  }
  const leftover = (git(dir, ['diff', '--name-only'], { noHooksDir: hooks }) +
    git(dir, ['ls-files', '--others', '--exclude-standard'], { noHooksDir: hooks })).trim();
  if (leftover) throw new HarnessError('FREEZE_MISMATCH', `unstaged changes remain after staging: ${leftover.slice(0, 500)}`);
  git(dir, ['commit', '--quiet', '--no-gpg-sign', '-m', `candidate ${attempt.id}`], {
    env: { ...FIXTURE_IDENTITY, GIT_AUTHOR_DATE: new Date().toISOString(), GIT_COMMITTER_DATE: new Date().toISOString() },
    noHooksDir: hooks
  });
  const commit = git(dir, ['rev-parse', 'HEAD'], { noHooksDir: hooks }).trim();
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}'], { noHooksDir: hooks }).trim();
  const patchText = git(dir, ['diff', '--binary', attempt.fixtureCommit, commit], { noHooksDir: hooks });
  const patchFile = path.join(evidenceDir, 'candidate.patch');
  fs.writeFileSync(patchFile, patchText);
  return {
    ok: true,
    guard,
    frozen: {
      branch: `candidate/${attempt.id}`,
      commit,
      tree,
      changedPaths: paths.sort(),
      stats: diffStats(dir, attempt.fixtureCommit, commit, hooks),
      patch: { file: toPosix(path.relative(contract.machine.runDir, patchFile)), sha256: sha256File(patchFile) },
      notes: guard.reasons
    }
  };
}

/** Added-line overlap with the reference fix. A leak signal only; a small correct fix may match. */
export function referenceSimilarity(candidatePatch, referencePatch) {
  const added = text => new Set(text.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1).trim()).filter(line => line.length > 3));
  const a = added(candidatePatch);
  const b = added(referencePatch);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const line of a) if (b.has(line)) shared += 1;
  return Number((shared / new Set([...a, ...b]).size).toFixed(3));
}
