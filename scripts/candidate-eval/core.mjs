/**
 * Candidate-eval Phase 0 — shared primitives.
 *
 * Deliberately outside `src/`: this is an operator-run experiment harness, not app surface.
 * Every file the harness relies on is identified by content hash, every state change is an
 * fsynced journal line, and every refusal is a coded error so tests can assert the reason.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export class HarnessError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** JSON with sorted keys and no whitespace, so equal values always hash equally. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HarnessError('CANONICAL_JSON', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new HarnessError('CANONICAL_JSON', `unsupported value of type ${typeof value}`);
}

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const sha256File = file => sha256(fs.readFileSync(file));

/**
 * Hash of a whole package directory: sorted POSIX relative paths, each as path, byte length and
 * bytes. A SKILL.md package with helper files therefore changes revision when any file changes,
 * not only when SKILL.md does.
 */
export function packageHash(dir) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new HarnessError('PACKAGE_LINK', `${child} is a link`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk('');
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(dir, file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Write a temp file, fsync it and rename it over the target. */
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/** Create-only write. Throws EEXIST when another owner already holds the path. */
export function writeExclusive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Git with hooks and fsmonitor disabled: candidate-controlled repos must never run code here. */
export function gitArgs(args, noHooksDir) {
  return ['-c', `core.hooksPath=${noHooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args];
}

/** Synchronous git. Returns stdout; throws GIT_FAILED unless allowFail. */
export function git(cwd, args, { env, input, allowFail = false, noHooksDir, encoding = 'utf8' } = {}) {
  const hooks = noHooksDir ?? path.join(cwd, '.candidate-eval-no-hooks');
  const result = spawnSync('git', gitArgs(args, hooks), {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new HarnessError('GIT_FAILED', `git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    throw new HarnessError('GIT_FAILED', `git ${args.join(' ')} (exit ${result.status}): ${String(result.stderr).trim().slice(0, 2000)}`);
  }
  return allowFail ? { status: result.status, stdout: result.stdout, stderr: String(result.stderr ?? '') } : result.stdout;
}

/**
 * Run one evaluation command with a hard timeout. On Windows the whole process tree is killed,
 * because vitest and tsc leave workers behind a plain kill.
 */
export function runCommand(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    const chunks = [];
    let timedOut = false;
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: null, output: Buffer.from(String(error)), durationMs: Date.now() - started, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks), durationMs: Date.now() - started, timedOut });
    });
  });
}

/** Minimal glob: `**` spans directories, `*` stays inside one segment, everything else is literal. */
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

export const matchesAny = (file, globs) => globs.some(glob => globToRegExp(glob).test(file));

export const toPosix = value => value.split(path.sep).join('/');
