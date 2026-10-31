import { expect, it } from 'vitest';
import path from 'node:path';
import { strayVirtualPath, translateEvealRunPaths } from '../src/main/sandbox.js';

const run = path.join(path.parse(process.cwd()).root, 'Users', 'eve', 'AppData', 'Roaming', 'ParadigmEve', 'eveal-runs', 'eveal-run-1');
const roots = [{ name: 'projects', path: path.join(path.parse(process.cwd()).root, 'projects') }, { name: 'eveal-run', path: run }];

it('turns the chat\'s own /eveal-run into its native path, at path boundaries only', () => {
  expect(translateEvealRunPaths('Copy-Item -Recurse src /eveal-run/probe', roots)).toBe(`Copy-Item -Recurse src ${path.join(run, 'probe')}`);
  expect(translateEvealRunPaths('node check.mjs "/eveal-run/fix/work"', roots)).toBe(`node check.mjs "${path.join(run, 'fix', 'work')}"`);
  expect(translateEvealRunPaths('dir /eveal-run', roots)).toBe(`dir ${run}`);
  for (const untouched of ['curl https://host/eveal-run/x', 'rg "a/eveal-run/b"', 'echo /eveal-runs/x', 'type /projects/a.txt']) {
    expect(translateEvealRunPaths(untouched, roots)).toBe(untouched);
  }
});

it('never translates a path that climbs out, so the virtual-path check still refuses it', () => {
  for (const escape of ['type /eveal-run/../secrets.txt', 'type /eveal-run/./x', 'type /eveal-run/a\\..\\b']) {
    const translated = translateEvealRunPaths(escape, roots);
    expect(translated).toBe(escape);
    expect(strayVirtualPath(translated, roots)).toMatch(/^\/eveal-run\//);
  }
});

it('does nothing without a run folder, or when its native path would need quoting', () => {
  expect(translateEvealRunPaths('dir /eveal-run', roots.slice(0, 1))).toBe('dir /eveal-run');
  const spaced = [{ name: 'eveal-run', path: path.join(path.parse(process.cwd()).root, 'Users', 'Eve Q', 'run') }];
  expect(translateEvealRunPaths('dir /eveal-run', spaced)).toBe('dir /eveal-run');
});
