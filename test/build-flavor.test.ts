import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
const buildFlavorModule = await import('../scripts/build-flavor.mjs');
const {
  BUILD_FLAVOR_ENV,
  BUILD_FLAVOR_PROOF_ENV,
  PUBLIC_GITHUB_PROOF,
  artifactFlavorSuffix,
  buildEnvironmentForFlavor,
  githubRepositoryFromRemoteUrl,
  normalizeBuildFlavor,
  provePublicGithubRepository,
  viteFlavorFromEnvironment
} = buildFlavorModule;

const repositories: string[] = [];

function repository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'paradigmeve-build-flavor-'));
  repositories.push(cwd);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd });
  return cwd;
}

afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('build flavor authority', () => {
  it('defaults local builds to debug and keeps shipping artifact names canonical', () => {
    expect(normalizeBuildFlavor(undefined)).toBe('debug');
    expect(normalizeBuildFlavor('DEV')).toBe('dev');
    expect(() => normalizeBuildFlavor('release')).toThrow(/expected debug, dev, shipping/);
    expect(artifactFlavorSuffix('debug')).toBe('-debug');
    expect(artifactFlavorSuffix('dev')).toBe('-dev');
    expect(artifactFlavorSuffix('shipping')).toBe('');
  });

  it('recognizes configured GitHub remote URL forms without accepting lookalike hosts', () => {
    expect(githubRepositoryFromRemoteUrl('https://github.com/example/project.git')).toBe('example/project');
    expect(githubRepositoryFromRemoteUrl('git@github.com:example/project.git')).toBe('example/project');
    expect(githubRepositoryFromRemoteUrl('ssh://git@github.com/example/project')).toBe('example/project');
    expect(githubRepositoryFromRemoteUrl('https://github.com.example/example/project.git')).toBeNull();
    expect(githubRepositoryFromRemoteUrl('https://example.com/example/project.git')).toBeNull();
  });

  it('proves dev eligibility with an anonymous public GitHub repository lookup', async () => {
    const cwd = repository();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Example/Public-Project.git'], { cwd });
    let requestedUrl = '';
    let requestedHeaders: Record<string, string> = {};
    const fetchImpl = async (url: string, options: { headers: Record<string, string> }) => {
      requestedUrl = url;
      requestedHeaders = options.headers;
      return Response.json({ full_name: 'Example/Public-Project', private: false });
    };

    await expect(provePublicGithubRepository({ cwd, fetchImpl })).resolves.toBe('Example/Public-Project');
    expect(requestedUrl).toBe('https://api.github.com/repos/Example/Public-Project');
    expect(requestedHeaders).not.toHaveProperty('Authorization');
  });

  it('fails dev closed for missing, private, or unauthenticated-inaccessible GitHub remotes', async () => {
    const noRemote = repository();
    await expect(provePublicGithubRepository({ cwd: noRemote })).rejects.toThrow(/configured GitHub remote/);

    const privateRepo = repository();
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/private-project.git'], { cwd: privateRepo });
    await expect(provePublicGithubRepository({
      cwd: privateRepo,
      fetchImpl: async () => Response.json({ full_name: 'example/private-project', private: true })
    })).rejects.toThrow(/resolves anonymously to a public repository/);

    const unavailable = repository();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/missing.git'], { cwd: unavailable });
    await expect(provePublicGithubRepository({
      cwd: unavailable,
      fetchImpl: async () => new Response('', { status: 404 })
    })).rejects.toThrow(/resolves anonymously to a public repository/);
  });

  it('requires wrapper proof for Vite dev flavor and scrubs inherited proof before authorizing', async () => {
    expect(viteFlavorFromEnvironment({ [BUILD_FLAVOR_ENV]: 'debug' })).toBe('debug');
    expect(() => viteFlavorFromEnvironment({ [BUILD_FLAVOR_ENV]: 'dev' })).toThrow(/wrapper proof/);
    expect(viteFlavorFromEnvironment({
      [BUILD_FLAVOR_ENV]: 'dev',
      [BUILD_FLAVOR_PROOF_ENV]: PUBLIC_GITHUB_PROOF
    })).toBe('dev');

    const cwd = repository();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/private-project.git'], { cwd });
    await expect(buildEnvironmentForFlavor('dev', {
      cwd,
      env: { [BUILD_FLAVOR_PROOF_ENV]: PUBLIC_GITHUB_PROOF },
      fetchImpl: async () => Response.json({ full_name: 'example/private-project', private: true })
    })).rejects.toThrow(/resolves anonymously to a public repository/);
  });
});
