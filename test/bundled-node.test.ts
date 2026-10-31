import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledNodeDirectory, configureBundledNode, resetBundledNodeForTests } from '../src/main/bundled-node.js';
import { childEnv } from '../src/main/exec.js';
import { pathEntries } from '../src/main/env.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'eve-bundled-node-'));
const holdsNode = (folder: string) => ['node.exe', 'node'].some((name) => {
  try { return statSync(path.join(folder, name)).isFile(); } catch { return false; }
});
afterEach(() => resetBundledNodeForTests());

// Run `node` the way a command does: by name, found on the child's PATH, through the platform shell.
function nodeVersionVia(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'node -p process.versions.node'], { env, encoding: 'utf8' }).trim()
    : execFileSync('/bin/sh', ['-c', 'node -p process.versions.node'], { env, encoding: 'utf8' }).trim();
}

it('gives commands Eve\'s own Node when none is on PATH', async () => {
  const shims = await temp();
  configureBundledNode(shims);
  expect(bundledNodeDirectory()).toBe(shims);
  const env = childEnv();
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')!;
  // Keep every folder except those holding a real node, so only the bundled one can answer.
  env[pathKey] = pathEntries(env).filter((entry) => entry === shims || !holdsNode(entry)).join(path.delimiter);
  expect(pathEntries(env).at(-1)).toBe(shims);
  expect(nodeVersionVia(env)).toBe(process.versions.node);
});

it('puts the bundled Node last and only once, so a Node the user installed always wins', async () => {
  const shims = await temp();
  configureBundledNode(shims);
  const entries = pathEntries(childEnv());
  expect(entries.at(-1)).toBe(shims);
  expect(entries.filter((entry) => entry === shims)).toHaveLength(1);
  const user = ['first', 'second'].map((name) => path.join(os.tmpdir(), name));
  const overridden = pathEntries(childEnv({ PATH: [user[0], shims, user[1]].join(path.delimiter) }));
  expect(overridden.filter((entry) => entry === shims)).toHaveLength(1);
  expect(overridden.indexOf(user[0]!)).toBeLessThan(overridden.indexOf(shims));
});

it('adds nothing when it could not write the shim', () => {
  configureBundledNode(path.join(os.tmpdir(), 'eve-bundled-node-missing', 'bad\0name'));
  expect(bundledNodeDirectory()).toBeNull();
  expect(pathEntries(childEnv()).some((entry) => entry.includes('eve-bundled-node-missing'))).toBe(false);
});
