import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_FLAVOR_SUFFIX_ENV,
  BUILD_FLAVOR_ENV,
  artifactFlavorSuffix,
  buildEnvironmentForFlavor,
  normalizeBuildFlavor
} from './build-flavor.mjs';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';
import { assertPackageGitProvenance } from './package-git-provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function value(name, fallback) {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const platform = normalizePlatform(value('platform', process.platform));
const arches = value('arch', process.arch).split(',').map((item) => normalizeArch(item.trim()));
const dirOnly = args.includes('--dir');
const flavor = normalizeBuildFlavor(value('flavor', process.env[BUILD_FLAVOR_ENV]));
const allowUncheckpointed = args.includes('--allow-uncheckpointed');
const provenance = assertPackageGitProvenance({ root, allowUncheckpointed });
if (allowUncheckpointed) {
  process.stderr.write(`WARNING: packaging uncheckpointed development state for ${provenance.version}; do not present this artifact as release provenance.\n`);
} else {
  process.stdout.write(`Packaging Git checkpoint ${provenance.commit} on ${provenance.branch || `v${provenance.version}`}.\n`);
}
const preparedBuild = await buildEnvironmentForFlavor(flavor, { cwd: root });
if (preparedBuild.repository) {
  process.stdout.write(`Dev package authorized by public GitHub repository ${preparedBuild.repository}.\n`);
}
const artifactSuffix = artifactFlavorSuffix(flavor);

const connectorIcon = path.join(root, 'artwork', 'icon.png');
const connectorIconBytes = statSync(connectorIcon).size;
if (connectorIconBytes <= 0 || connectorIconBytes > 10 * 1024) {
  throw new Error(`artwork/icon.png must be a non-empty PNG no larger than 10 KiB; got ${connectorIconBytes} bytes`);
}
const pngSignature = readFileSync(connectorIcon).subarray(0, 8).toString('hex');
if (pngSignature !== '89504e470d0a1a0a') throw new Error('artwork/icon.png is not a PNG file');

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const node = process.execPath;
run(node, ['scripts/generate-third-party-notices.mjs']);
run(node, ['scripts/make-icon.mjs']);
if (platform === 'win32') run(node, ['scripts/make-installer-art.mjs']);
run(node, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], preparedBuild.env);

for (const arch of arches) {
  const targetArgs = ['--platform', platform, '--arch', arch];
  run(node, ['scripts/fetch-tunnel-client.mjs', ...targetArgs]);
  run(node, ['scripts/fetch-ripgrep.mjs', ...targetArgs]);
  run(node, ['scripts/prepare-packaging-native.mjs', ...targetArgs]);
  run(node, ['scripts/prepare-macos-desktop-helper.mjs', ...targetArgs]);

  const builderArgs = [
    path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    PLATFORM_INFO[platform].builderFlag,
    `--${arch}`,
    '--publish',
    'never'
  ];
  if (dirOnly) builderArgs.push('--dir');
  run(node, builderArgs, {
    ...process.env,
    COS_PACKAGE_ARCH: arch,
    [ARTIFACT_FLAVOR_SUFFIX_ENV]: artifactSuffix
  });
  run(node, ['scripts/smoke-packaged-runtime.mjs', '--platform', platform, '--arch', arch]);
  if (platform === 'win32' && !dirOnly) {
    run(node, [
      'scripts/smoke-windows-installer-vault.mjs',
      '--arch', arch,
      '--installer', path.join('release', `ParadigmEve-Windows-${arch}${artifactSuffix}.exe`)
    ]);
  }
}
