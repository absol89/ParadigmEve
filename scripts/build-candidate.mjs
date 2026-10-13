#!/usr/bin/env node
// Builds a numbered Windows x64 debug candidate from the files in this checkout, as they are, on the
// current branch: no extra worktree, no build branch, no commit. Dogfood the candidate, then commit what
// passed or revert what broke, so nothing broken gets committed.
//
//   node scripts/build-candidate.mjs c11 [--skip-verify] [--remote public] [--dry-run]
//
// Output goes to <installers>/<version>/<label> (installers defaults to C:\Projects\ParadigmEve-installers,
// or set PARADIGMEVE_INSTALLERS): the installer, blockmap, .sha256, COMMIT.txt and, when files were
// uncommitted, uncommitted.patch (every change against HEAD, untracked files included; `git apply` it on
// the recorded commit to get exactly the built source). Uses the existing node_modules; run `npm ci`
// yourself after a lockfile change. Nothing is installed, committed or published.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aheadBehind, compareWithRemote, dirtyLines, fail, git, parseFlags } from './release-checkout.mjs';

const { flags, positional } = parseFlags(process.argv.slice(2), { remote: 'string', 'skip-verify': 'boolean', 'dry-run': 'boolean' });
const label = positional[0];
if (!/^c\d+(?:-r\d+)?$/.test(label ?? '')) fail('usage: node scripts/build-candidate.mjs c<N> [--skip-verify] [--remote public] [--dry-run]');
const remote = flags.remote ?? 'public';

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout;
const branch = git(root, ['branch', '--show-current']).stdout || '(detached)';
const base = git(root, ['rev-parse', 'HEAD']).stdout;
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const installers = process.env.PARADIGMEVE_INSTALLERS ?? 'C:\\Projects\\ParadigmEve-installers';
const dest = path.join(installers, version, label);
if (existsSync(dest) && readdirSync(dest).length) fail(`${dest} already has files; pick the next candidate number.`);
if (!existsSync(path.join(root, 'node_modules'))) fail('node_modules is missing; run `npm ci` first.');

const dirty = dirtyLines(root);
if (dirty.some(line => line.endsWith('package-lock.json'))) fail('package-lock.json has uncommitted changes; run `npm ci` and commit the lockfile before building.');
let published = `branch ${branch}`;
if (branch !== '(detached)' && git(root, ['remote']).stdout.split(/\s+/).includes(remote)) {
  const tip = compareWithRemote(root, { remote, branch });
  const counts = tip.remote ? aheadBehind(root, tip.ref) : null;
  published = !counts ? `not on ${tip.ref}` : !counts.ahead && !counts.behind ? `= ${tip.ref}`
    : `${counts.ahead} unpublished commit(s) ahead of ${tip.ref}${counts.behind ? `, ${counts.behind} behind` : ''}`;
}

// The exact built source as a patch on HEAD, made through a temporary index so the real one is untouched.
function uncommittedPatch() {
  const tmpIndex = path.join(os.tmpdir(), `paradigmeve-candidate-${process.pid}.index`);
  const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).stdout);
  if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(root, ['add', '-A'], { env });
    return { tree: git(root, ['write-tree'], { env }).stdout, patch: git(root, ['diff', '--cached', '--binary', 'HEAD'], { env }).stdout };
  } finally { rmSync(tmpIndex, { force: true }); }
}
const snapshot = dirty.length ? uncommittedPatch() : null;

console.log(`candidate ${version} ${label}: ${branch} @ ${base.slice(0, 12)} (${published})` +
  (dirty.length ? ` + ${dirty.length} uncommitted path(s):\n    ${dirty.join('\n    ')}` : ', clean'));
console.log(`  output to ${dest}`);
if (flags['dry-run']) process.exit(0);

// Windows tar.exe must win over Git Bash's GNU tar, which treats "C:" as a remote host.
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
if (process.platform === 'win32') env[pathKey] = `${path.join(env.SystemRoot ?? 'C:\\Windows', 'System32')};${env[pathKey]}`;

function step(name, command) {
  console.log(`\n== ${name}: ${command}`);
  const started = Date.now();
  const result = spawnSync(command, { cwd: root, env, shell: true, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) fail(`${name} exited ${result.status}; nothing was copied to ${dest}.`);
  return Math.round((Date.now() - started) / 1000);
}

if (!existsSync(path.join(root, 'node_modules', 'electron', 'dist', 'LICENSE'))) step('electron', 'node node_modules/electron/install.js');
const verifySeconds = flags['skip-verify'] ? null : step('verify', 'npm run verify:ci');
// Uncommitted files make this a development package by definition; packaging labels it as such.
const packageSeconds = step('package', `node scripts/package.mjs --platform win32 --arch x64${dirty.length ? ' --allow-uncheckpointed' : ''}`);

const exe = 'ParadigmEve-Windows-x64-debug.exe';
const built = path.join(root, 'release', exe);
if (!existsSync(built)) fail(`${built} was not produced.`);
mkdirSync(dest, { recursive: true });
for (const name of [exe, `${exe}.blockmap`]) copyFileSync(path.join(root, 'release', name), path.join(dest, name));
const sha256 = createHash('sha256').update(readFileSync(path.join(dest, exe))).digest('hex').toUpperCase();
writeFileSync(path.join(dest, `${exe}.sha256`), `${sha256}  ${exe}\n`);
if (snapshot) writeFileSync(path.join(dest, 'uncommitted.patch'), `${snapshot.patch}\n`);
const builtAt = new Date().toISOString();
const verifyNote = verifySeconds === null ? 'SKIPPED (--skip-verify)' : `npm run verify:ci passed (${verifySeconds}s)`;
writeFileSync(path.join(dest, 'COMMIT.txt'), [
  `ParadigmEve ${version} ${label} local Windows x64 debug candidate`,
  `Branch: ${branch}`,
  `Commit: ${base} (${published} when built)`,
  ...(snapshot ? [`Uncommitted work included (source tree ${snapshot.tree}, see uncommitted.patch):`, ...dirty.map(line => `  ${line}`)] : ['Working tree: clean']),
  `Built: ${builtAt} in ${root}`,
  `Verify: ${verifyNote}`,
  `Package: win32 x64 passed (${packageSeconds}s)`,
  `Installer SHA256: ${sha256}`,
  'Not a public release. Not installed.', ''
].join('\n'));

console.log(`\n${dest}\n  ${exe}\n  SHA256 ${sha256}\n\nchecklist row:`);
console.log(`| ${version} ${label} | ${base.slice(0, 12)}${dirty.length ? ` +${dirty.length} uncommitted` : ''} | ${branch} | ${builtAt.slice(0, 16).replace('T', ' ')} | ${verifySeconds === null ? 'verify skipped' : 'verify passed'} | ${sha256.slice(0, 16)}… | not installed |`);
if (dirty.length) console.log('\nAfter dogfooding: commit what passed, or revert what broke.');
