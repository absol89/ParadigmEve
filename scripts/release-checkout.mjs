// Shared Git helpers for the maintainer scripts (build-candidate, publish-commit, sync-status).
import { spawnSync } from 'node:child_process';

export function git(cwd, args, { allowFailure = false, env } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (result.error) throw result.error;
  const out = { ok: result.status === 0, stdout: String(result.stdout ?? '').trimEnd(), stderr: String(result.stderr ?? '').trim() };
  if (!out.ok && !allowFailure) throw new Error(`git ${args.join(' ')} failed${out.stderr ? `: ${out.stderr}` : ''}`);
  return out;
}

export function fail(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

export function parseFlags(argv, spec) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!(name in spec)) fail(`unknown option --${name}`);
    if (spec[name] === 'boolean') flags[name] = true;
    else flags[name] = inline ?? argv[++i];
  }
  return { flags, positional };
}

// Uncommitted work, untracked files included, as porcelain lines.
export function dirtyLines(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all']).stdout.split(/\r?\n/).filter(Boolean);
}

// Fetches `remote` and returns { local, remote, ref } for the checkout's branch.
export function compareWithRemote(cwd, { remote, branch, fetch = true }) {
  if (fetch) git(cwd, ['fetch', '--quiet', remote, branch], { allowFailure: true }); // a never-pushed branch has no remote ref
  const ref = `${remote}/${branch}`;
  const remoteSha = git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], { allowFailure: true }).stdout;
  return { local: git(cwd, ['rev-parse', 'HEAD']).stdout, remote: remoteSha || null, ref };
}

// "ahead behind" of HEAD against ref, or null when ref does not exist.
export function aheadBehind(cwd, ref) {
  const result = git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], { allowFailure: true });
  if (!result.ok) return null;
  const [ahead, behind] = result.stdout.split(/\s+/).map(Number);
  return { ahead, behind };
}

export function currentBranch(cwd) {
  return git(cwd, ['branch', '--show-current']).stdout;
}

// Per-machine settings never live in the repository. They come from an environment variable, then from the
// clone's own Git config (shared by its worktrees, never committed), e.g.
//   git config paradigmeve.remote public
//   git config paradigmeve.installers "D:\Builds\ParadigmEve-installers"
//   git config paradigmeve.checkoutRoots "D:\Builds;E:\Other"
export function localSetting(cwd, key, envName, fallback = null) {
  if (process.env[envName]) return process.env[envName];
  const configured = git(cwd, ['config', '--get', `paradigmeve.${key}`], { allowFailure: true }).stdout;
  return configured || fallback;
}
