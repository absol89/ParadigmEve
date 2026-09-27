import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_FLAVOR_ENV,
  buildEnvironmentForFlavor,
  normalizeBuildFlavor
} from './build-flavor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function value(name) {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const command = value('command') ?? 'build';
if (command !== 'build' && command !== 'dev') throw new Error(`Unsupported electron-vite command ${JSON.stringify(command)}.`);
const flavor = normalizeBuildFlavor(value('flavor') ?? process.env[BUILD_FLAVOR_ENV]);
const passthrough = args.filter((arg, index) => {
  if (arg === '--flavor' || arg === '--command') return false;
  if (index > 0 && (args[index - 1] === '--flavor' || args[index - 1] === '--command')) return false;
  return !arg.startsWith('--flavor=') && !arg.startsWith('--command=');
});

const prepared = await buildEnvironmentForFlavor(flavor, { cwd: root });
if (prepared.repository) process.stdout.write(`Dev build authorized by public GitHub repository ${prepared.repository}.\n`);

const executable = process.execPath;
const commandArgs = [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), command, ...passthrough];
const result = spawnSync(executable, commandArgs, { cwd: root, stdio: 'inherit', env: prepared.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
