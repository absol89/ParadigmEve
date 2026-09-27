import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim()
  };
}

function branchCarriesVersion(branch, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[/_-])${escaped}(?:$|[/_-])`).test(branch);
}

export function assertPackageGitProvenance({ root, allowUncheckpointed = false }) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) throw new Error('package.json has no version; refusing to package without release identity.');

  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    if (allowUncheckpointed) return { version, branch: '', commit: '', dirty: true, releaseNotesTracked: false };
    throw new Error('Packaging requires Git provenance. Re-run with --allow-uncheckpointed only for an explicitly non-release development package.');
  }

  const branch = git(root, ['branch', '--show-current']).stdout;
  const commit = git(root, ['rev-parse', '--short=12', 'HEAD']).stdout;
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']).stdout;
  const releaseNotes = `docs/release-notes/v${version}.md`;
  const releaseNotesTracked = git(root, ['ls-files', '--error-unmatch', '--', releaseNotes]).ok;
  const tags = git(root, ['tag', '--points-at', 'HEAD']).stdout.split(/\r?\n/).filter(Boolean);
  const exactVersionTag = tags.includes(version) || tags.includes(`v${version}`);
  const branchMatches = branch ? branchCarriesVersion(branch, version) : exactVersionTag;

  if (!allowUncheckpointed) {
    if (status) {
      throw new Error('Packaging requires a clean checkpoint. Commit the settled cumulative release tree first, or use --allow-uncheckpointed only for an explicitly non-release development package.');
    }
    if (!releaseNotesTracked) {
      throw new Error(`${releaseNotes} is not tracked by Git. Track the current release notes before packaging.`);
    }
    if (!branchMatches) {
      const location = branch ? `branch ${branch}` : `detached HEAD (${tags.join(', ') || 'no exact tag'})`;
      throw new Error(`Package version ${version} does not match Git release provenance at ${location}. Use a target-version branch or exact ${version} (or v${version}) tag before packaging.`);
    }
  }

  return { version, branch, commit, dirty: Boolean(status), releaseNotesTracked };
}
