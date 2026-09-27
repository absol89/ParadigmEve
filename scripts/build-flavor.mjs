import { spawnSync } from 'node:child_process';

export const BUILD_FLAVORS = ['debug', 'dev', 'shipping'];
export const BUILD_FLAVOR_ENV = 'PARADIGMEVE_BUILD_FLAVOR';
export const BUILD_FLAVOR_PROOF_ENV = 'PARADIGMEVE_BUILD_FLAVOR_PROOF';
export const ARTIFACT_FLAVOR_SUFFIX_ENV = 'PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX';
export const PUBLIC_GITHUB_PROOF = 'public-github';

const GITHUB_REMOTE = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export function normalizeBuildFlavor(value, fallback = 'debug') {
  const normalized = String(value ?? '').trim().toLowerCase() || fallback;
  if (!BUILD_FLAVORS.includes(normalized)) {
    throw new Error(`Unsupported build flavor ${JSON.stringify(value)}; expected ${BUILD_FLAVORS.join(', ')}.`);
  }
  return normalized;
}

export function artifactFlavorSuffix(flavor) {
  const normalized = normalizeBuildFlavor(flavor);
  return normalized === 'shipping' ? '' : `-${normalized}`;
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

export function githubRepositoryFromRemoteUrl(url) {
  const match = String(url ?? '').trim().match(GITHUB_REMOTE);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  return owner && repo ? `${owner}/${repo}` : null;
}

export async function provePublicGithubRepository({ cwd = process.cwd(), fetchImpl = fetch } = {}) {
  const remotes = runGit(['remote'], cwd);
  if (remotes.status !== 0) throw new Error('Could not inspect configured Git remotes for a public GitHub deployment.');

  const names = String(remotes.stdout ?? '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const repositories = [];
  for (const name of names) {
    const resolved = runGit(['remote', 'get-url', name], cwd);
    if (resolved.status !== 0) continue;
    const repository = githubRepositoryFromRemoteUrl(resolved.stdout);
    if (repository && !repositories.includes(repository)) repositories.push(repository);
  }

  if (repositories.length === 0) {
    throw new Error('Dev build requires a configured GitHub remote whose repository is publicly reachable.');
  }

  for (const repository of repositories) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'paradigmeve-build-flavor'
      }
    });
    if (response.status !== 200) continue;
    const body = await response.json();
    if (
      body &&
      body.private === false &&
      typeof body.full_name === 'string' &&
      body.full_name.toLowerCase() === repository.toLowerCase()
    ) return body.full_name;
  }

  throw new Error('Dev build requires a configured GitHub remote that resolves anonymously to a public repository.');
}

export function viteFlavorFromEnvironment(env = process.env) {
  const flavor = normalizeBuildFlavor(env[BUILD_FLAVOR_ENV]);
  if (flavor === 'dev' && env[BUILD_FLAVOR_PROOF_ENV] !== PUBLIC_GITHUB_PROOF) {
    throw new Error('Dev build flavor requires build-wrapper proof of a public GitHub repository.');
  }
  return flavor;
}

export async function buildEnvironmentForFlavor(flavor, {
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const normalized = normalizeBuildFlavor(flavor);
  const buildEnv = { ...env, [BUILD_FLAVOR_ENV]: normalized };
  delete buildEnv[BUILD_FLAVOR_PROOF_ENV];
  if (normalized === 'dev') {
    const repository = await provePublicGithubRepository({ cwd, fetchImpl });
    buildEnv[BUILD_FLAVOR_PROOF_ENV] = PUBLIC_GITHUB_PROOF;
    return { flavor: normalized, repository, env: buildEnv };
  }
  return { flavor: normalized, repository: null, env: buildEnv };
}
