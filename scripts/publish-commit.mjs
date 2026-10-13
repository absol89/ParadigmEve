#!/usr/bin/env node
// Commits the staged changes on top of the published branch tip and pushes them, fast-forward only.
//
//   git add <your files>
//   node scripts/publish-commit.mjs -m "Message" [--remote NAME] [--dry-run]
//
// The remote defaults to PARADIGMEVE_REMOTE, then `git config paradigmeve.remote`, then origin.
// Refuses unless HEAD equals <remote>/<branch> after a fresh fetch, so a commit can never be built on a
// stale or private base and silently revert someone else's published work. Runs the privacy check on the
// staged tree and the result, commits as the maintainer identity of the published tip (a GitHub noreply
// address), and pushes without force. Unstaged and untracked files are left alone.
import { spawnSync } from 'node:child_process';
import { compareWithRemote, currentBranch, fail, git, localSetting, parseFlags } from './release-checkout.mjs';

const argv = process.argv.slice(2).map(arg => (arg === '-m' ? '--message' : arg));
const { flags } = parseFlags(argv, { message: 'string', remote: 'string', 'dry-run': 'boolean' });
const message = String(flags.message ?? '').trim();
if (!message) fail('usage: node scripts/publish-commit.mjs -m "Message" [--remote NAME] [--dry-run]');
if (/co-authored-by|generated with|claude\.ai\/code|claude-session/i.test(message)) fail('the message carries attribution or a session link; the maintainer is the only author.');

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout;
const remote = flags.remote ?? localSetting(root, 'remote', 'PARADIGMEVE_REMOTE', 'origin');
const branch = currentBranch(root);
if (!branch) fail('HEAD is detached; check out the branch you publish to.');
const tip = compareWithRemote(root, { remote, branch });
if (!tip.remote) fail(`${tip.ref} does not exist; create the remote branch deliberately first.`);
if (tip.local !== tip.remote) {
  const counts = git(root, ['rev-list', '--left-right', '--count', `HEAD...${tip.ref}`]).stdout.split(/\s+/);
  fail(`HEAD is ${counts[0]} ahead / ${counts[1]} behind ${tip.ref}. Bring this checkout to the published tip ` +
    `(e.g. \`git merge --ff-only ${tip.ref}\`, or rebuild your change on it) and stage again.`);
}
if (git(root, ['diff', '--cached', '--quiet'], { allowFailure: true }).ok) fail('nothing is staged.');

const [name, email] = git(root, ['log', '-1', '--format=%an%x00%ae', tip.remote]).stdout.split('\0');
if (!/@users\.noreply\.github\.com$/i.test(email)) fail(`the published tip's author <${email}> is not a GitHub noreply address; set the identity by hand.`);

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) fail(`${label} failed.`);
}

const staged = git(root, ['diff', '--cached', '--name-status']).stdout;
console.log(`publish to ${tip.ref} on top of ${tip.remote.slice(0, 10)} as ${name} <${email}>:\n${staged}\n`);
run('privacy check of the staged tree', process.execPath, ['scripts/verify-public-history.mjs', '--staged']);
if (flags['dry-run']) { console.log('dry run: nothing committed or pushed.'); process.exit(0); }

run('commit', 'git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', message]);
const commit = git(root, ['rev-parse', 'HEAD']).stdout;
run('privacy check of the history', process.execPath, ['scripts/verify-public-history.mjs']);
run('fast-forward push', 'git', ['push', remote, `HEAD:refs/heads/${branch}`]);
console.log(`\npublished ${commit.slice(0, 10)} to ${tip.ref}`);
