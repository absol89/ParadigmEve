import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore plain ESM build helper.
import { assertPackageGitProvenance } from '../scripts/package-git-provenance.mjs';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(branch = 'release/2.2.2-cumulative') {
  const root = mkdtempSync(path.join(tmpdir(), 'paradigmeve-git-provenance-'));
  mkdirSync(path.join(root, 'docs', 'release-notes'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.2.2' }));
  writeFileSync(path.join(root, 'docs', 'release-notes', 'v2.2.2.md'), '# Release\n\n## 2.2.2\n');
  git(root, 'init');
  git(root, 'config', 'user.name', 'ParadigmEve Test');
  git(root, 'config', 'user.email', 'test@paradigmeve.invalid');
  git(root, 'checkout', '-b', branch);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'checkpoint');
  return root;
}

describe('package Git provenance', () => {
  it('accepts a clean target-version branch with tracked release notes', () => {
    const root = fixture();
    expect(assertPackageGitProvenance({ root })).toMatchObject({
      version: '2.2.2',
      branch: 'release/2.2.2-cumulative',
      dirty: false,
      releaseNotesTracked: true
    });
  });

  it('rejects stale release branches and dirty cumulative state', () => {
    const stale = fixture('release/2.2.0-free-regressions');
    expect(() => assertPackageGitProvenance({ root: stale })).toThrow(/does not match Git release provenance/);

    const dirty = fixture();
    writeFileSync(path.join(dirty, 'work-in-progress.txt'), 'uncommitted cumulative work');
    expect(() => assertPackageGitProvenance({ root: dirty })).toThrow(/requires a clean checkpoint/);
  });

  it('allows an explicit uncheckpointed development package while reporting it as dirty', () => {
    const root = fixture('feature/local-package');
    writeFileSync(path.join(root, 'work-in-progress.txt'), 'development only');
    expect(assertPackageGitProvenance({ root, allowUncheckpointed: true })).toMatchObject({
      version: '2.2.2',
      branch: 'feature/local-package',
      dirty: true,
      releaseNotesTracked: true
    });
  });

  it('accepts the repository bare-version tag convention on a detached clean checkpoint', () => {
    const root = fixture();
    git(root, 'tag', '2.2.2');
    git(root, 'checkout', '--detach');
    expect(assertPackageGitProvenance({ root })).toMatchObject({
      version: '2.2.2',
      branch: '',
      dirty: false,
      releaseNotesTracked: true
    });
  });
});
