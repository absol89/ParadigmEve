#!/usr/bin/env node
// One read-only table of every ParadigmEve clone and worktree on this machine: HEAD versus the published
// branch, unpushed commits and uncommitted changes.
//
//   node scripts/sync-status.mjs [--remote public] [--base public/release/2.3.9] [--root DIR]... [--all] [--no-fetch]
//
// Worktrees come from `git worktree list`; separate clones are found as ParadigmEve* folders next to this
// checkout and under C:\Projects (add more with --root). Build worktrees are summarized unless --all.
// The only write is `git fetch` of the remote, skipped with --no-fetch.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { aheadBehind, git, parseFlags } from './release-checkout.mjs';

const argv = process.argv.slice(2);
const roots = [];
for (let i = argv.indexOf('--root'); i !== -1; i = argv.indexOf('--root')) roots.push(...argv.splice(i, 2).slice(1));
const { flags } = parseFlags(argv, { remote: 'string', base: 'string', all: 'boolean', 'no-fetch': 'boolean' });
const remote = flags.remote ?? 'public';
const here = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout;
const norm = (p) => path.resolve(p).toLowerCase();

function parseWorktrees(porcelain) {
  return porcelain.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const entry = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ');
      entry[key] = rest.join(' ') || true;
    }
    return { path: path.resolve(entry.worktree), prunable: Boolean(entry.prunable), detached: Boolean(entry.detached) };
  });
}

const checkouts = new Map();
for (const wt of parseWorktrees(git(here, ['worktree', 'list', '--porcelain']).stdout)) checkouts.set(norm(wt.path), { ...wt, kind: 'worktree' });
for (const root of [path.dirname(here), 'C:\\Projects', ...roots]) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (!/^paradigmeve/i.test(name) || checkouts.has(norm(dir))) continue;
    const dotGit = path.join(dir, '.git');
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) checkouts.set(norm(dir), { path: dir, kind: 'clone', prunable: false });
  }
}

const fetched = new Set();
function describe(entry) {
  if (!existsSync(entry.path)) return { ...entry, missing: true };
  const branch = git(entry.path, ['branch', '--show-current']).stdout;
  const head = git(entry.path, ['rev-parse', '--short=10', 'HEAD']).stdout;
  const repo = norm(git(entry.path, ['rev-parse', '--git-common-dir']).stdout.replace(/[\\/]\.git$/, ''));
  const hasRemote = git(entry.path, ['remote']).stdout.split(/\s+/).includes(remote);
  if (hasRemote && !flags['no-fetch'] && !fetched.has(repo)) {
    fetched.add(repo);
    git(entry.path, ['fetch', '--quiet', remote], { allowFailure: true });
  }
  const vsRemote = branch && hasRemote ? aheadBehind(entry.path, `${remote}/${branch}`) : null;
  const vsBase = flags.base ? aheadBehind(entry.path, flags.base) : null;
  const status = git(entry.path, ['status', '--porcelain', '--untracked-files=normal']).stdout.split(/\r?\n/).filter(Boolean);
  const untracked = status.filter(line => line.startsWith('??')).length;
  return { ...entry, branch, head, vsRemote, vsBase, changed: status.length - untracked, untracked };
}

function relation(counts, ref) {
  if (!counts) return `no ${ref}`;
  const { ahead, behind } = counts;
  if (!ahead && !behind) return `= ${ref}`;
  if (ahead && behind) return `DIVERGED +${ahead}/-${behind} vs ${ref}`;
  return ahead ? `+${ahead} UNPUSHED vs ${ref}` : `-${behind} behind ${ref}`;
}

const isBuild = (row) => /paradigmeve-build-/i.test(row.path) || /^build\//.test(row.branch ?? '');
const rows = [...checkouts.values()].map(describe);
const shown = flags.all ? rows : rows.filter(row => !isBuild(row));
const pad = (text, width) => String(text).padEnd(width);
const pathWidth = Math.max(...shown.map(row => row.path.length)) + 1;
const branchWidth = Math.max(...shown.map(row => (row.branch || '(detached)').length)) + 1;
for (const row of shown) {
  if (row.missing) { console.log(`${pad(row.path, pathWidth)} MISSING (prunable worktree record)`); continue; }
  const where = row.branch ? relation(row.vsRemote, `${remote}/${row.branch}`) : 'detached';
  const base = flags.base ? `  | ${relation(row.vsBase, flags.base)}` : '';
  const work = row.changed || row.untracked ? `  | ${row.changed} changed, ${row.untracked} untracked` : '';
  console.log(`${pad(row.path, pathWidth)} ${pad(row.branch || '(detached)', branchWidth)} ${row.head}  ${where}${base}${work}`);
}
if (!flags.all) {
  const builds = rows.filter(isBuild);
  const missing = builds.filter(row => row.missing).length;
  if (builds.length) console.log(`\n${builds.length} build worktree(s) hidden (${missing} missing on disk; \`git worktree prune\` clears those). --all lists them.`);
}
