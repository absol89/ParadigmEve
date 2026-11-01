// Offline code scorer. Re-runs the ORIGINAL visible tests and the reviewer's hidden tests against a
// submitted fixture copy, and diffs the submission against the pristine fixture. Nothing is trusted from
// the submission except its files.
//
// Contestant code runs here. Use a disposable VM or container with no network and no secrets. The Node
// permission flags below are defence in depth (no fs access outside the temp copy, no child processes),
// not a sandbox.
//
// usage: node score-code.mjs --pristine <fixture> --submitted <dir> --hidden <dir> [--allow-test-edit <rel>]... [--out receipt.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'test-hidden']);
const sha = data => createHash('sha256').update(data).digest('hex');

export function walk(root) {
  const files = new Map();
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symbolic link in submission: ' + path.relative(root, full));
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) visit(full); continue; }
      if (entry.isFile()) files.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  visit(root);
  return files;
}

export const treeHash = files => sha([...files.keys()].sort().map(k => k + '\0' + sha(files.get(k)) + '\n').join(''));

// Lines added plus lines removed, by longest common subsequence. Fixture files are small.
export function lineDelta(a, b) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const row = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) row[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return x.length + y.length - 2 * prev[y.length];
}

export function parseTap(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(line); // top level only: no indent
    if (!m) continue;
    const tag = /^\[([^\]]+)\]/.exec(m[2])?.[1] ?? 'untagged';
    results.push({ name: m[2], tag, ok: m[1] === 'ok' && !m[3] });
  }
  return results;
}

function runTests(dir, files, timeoutMs) {
  if (!files.length) return { results: [], timedOut: false, exitCode: null };
  const args = ['--permission', '--allow-fs-read=' + dir, '--allow-fs-write=' + dir,
    '--test', '--test-isolation=none', '--test-reporter=tap', ...files];
  const run = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH ?? '' } });
  return { results: parseTap(run.stdout ?? ''), timedOut: run.error?.code === 'ETIMEDOUT', exitCode: run.status, stderr: (run.stderr ?? '').slice(0, 2000) };
}

export function scoreCode({ pristine, submitted, hidden, allowTestEdits = [], timeoutMs = 60_000 }) {
  const original = walk(pristine), sub = walk(submitted), hid = walk(hidden);
  const added = [...sub.keys()].filter(k => !original.has(k)).sort();
  const removed = [...original.keys()].filter(k => !sub.has(k)).sort();
  const modified = [...sub.keys()].filter(k => original.has(k) && !original.get(k).equals(sub.get(k))).sort();
  let linesChanged = 0;
  for (const k of modified) linesChanged += lineDelta(original.get(k).toString('utf8'), sub.get(k).toString('utf8'));
  for (const k of added) linesChanged += sub.get(k).toString('utf8').split(/\r?\n/).length;
  const isTest = k => /^test\//.test(k);
  const testFilesTouched = [...modified, ...removed, ...added].filter(k => isTest(k) && !allowTestEdits.includes(k));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-score-'));
  try {
    for (const [k, data] of sub) {
      if (isTest(k) && !allowTestEdits.includes(k)) continue; // visible tests always come from the pristine copy
      fs.mkdirSync(path.dirname(path.join(work, k)), { recursive: true });
      fs.writeFileSync(path.join(work, k), data);
    }
    const visibleFiles = [...original.keys()].filter(k => isTest(k) && k.endsWith('.test.js'));
    for (const k of visibleFiles) {
      const source = allowTestEdits.includes(k) && sub.has(k) ? sub.get(k) : original.get(k);
      fs.mkdirSync(path.dirname(path.join(work, k)), { recursive: true });
      fs.writeFileSync(path.join(work, k), source);
    }
    fs.mkdirSync(path.join(work, 'test-hidden'));
    for (const [k, data] of hid) fs.writeFileSync(path.join(work, 'test-hidden', path.basename(k)), data);
    const visible = runTests(work, visibleFiles, timeoutMs);
    const hiddenRun = runTests(work, [...hid.keys()].map(k => 'test-hidden/' + path.basename(k)), timeoutMs);
    return {
      schema: 'arena-code-receipt/0.2',
      node: process.version,
      trees: { pristine: treeHash(original), submitted: treeHash(sub), hidden: treeHash(hid) },
      visible: { pass: visible.results.filter(r => r.ok).length, fail: visible.results.filter(r => !r.ok).length, timed_out: visible.timedOut },
      hidden: { results: hiddenRun.results, timed_out: hiddenRun.timedOut, stderr: hiddenRun.results.length ? undefined : hiddenRun.stderr },
      diff: { added, removed, modified, lines_changed: linesChanged, test_files_touched: testFilesTouched, unchanged: !added.length && !removed.length && !modified.length }
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Tag groups that failed at least one hidden test.
export const failedTags = receipt => [...new Set(receipt.hidden.results.filter(r => !r.ok).map(r => r.tag))].sort();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opts = { allowTestEdits: [] };
  let out = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--pristine') opts.pristine = value;
    else if (flag === '--submitted') opts.submitted = value;
    else if (flag === '--hidden') opts.hidden = value;
    else if (flag === '--allow-test-edit') opts.allowTestEdits.push(value);
    else if (flag === '--out') out = value;
    else { console.error('unknown flag ' + flag); process.exit(2); }
  }
  if (!opts.pristine || !opts.submitted || !opts.hidden) {
    console.error('usage: node score-code.mjs --pristine <fixture> --submitted <dir> --hidden <dir> [--allow-test-edit <rel>] [--out receipt.json]');
    process.exit(2);
  }
  const receipt = scoreCode(opts);
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
}
