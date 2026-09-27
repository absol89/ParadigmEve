import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Windows installer Vault smoke must run on Windows.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const installerArg = value('installer');
const arch = value('arch') ?? 'x64';
if (!installerArg) throw new Error('Pass --installer <path>.');
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows installer arch ${arch}.`);

const installer = path.resolve(root, installerArg);
if (!existsSync(installer)) throw new Error(`Installer does not exist: ${installer}`);
const appArchiveName = arch === 'x64' ? 'app-64.7z' : 'app-arm64.7z';

// electron-winstaller is a locked electron-builder dependency in package-lock.json. Its bundled
// 7-Zip understands both the outer NSIS executable and electron-builder's embedded app-<arch>.7z.
// Newer releases ship host-architecture-suffixed exe/dll pairs and normally materialize 7z.exe +
// 7z.dll during install. The smoke must also work when that postinstall materialization is absent.
const vendorDir = path.join(root, 'node_modules', 'electron-winstaller', 'vendor');
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const legacySevenZip = path.join(vendorDir, '7z.exe');
const legacySevenZipDll = path.join(vendorDir, '7z.dll');
const suffixedSevenZip = path.join(vendorDir, `7z-${hostArch}.exe`);
const suffixedSevenZipDll = path.join(vendorDir, `7z-${hostArch}.dll`);

function run7z(sevenZip, commandArgs) {
  const result = spawnSync(sevenZip, commandArgs, { cwd: path.dirname(sevenZip), encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`7-Zip failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

const temporary = mkdtempSync(path.join(os.tmpdir(), 'paradigmeve-installer-vault-'));
try {
  let sevenZip = legacySevenZip;
  if (!existsSync(legacySevenZip) || !existsSync(legacySevenZipDll)) {
    if (!existsSync(suffixedSevenZip) || !existsSync(suffixedSevenZipDll)) {
      throw new Error(`Bundled 7-Zip is missing for host architecture ${hostArch}.`);
    }
    const sevenZipDir = path.join(temporary, '7zip');
    mkdirSync(sevenZipDir);
    sevenZip = path.join(sevenZipDir, '7z.exe');
    copyFileSync(suffixedSevenZip, sevenZip);
    copyFileSync(suffixedSevenZipDll, path.join(sevenZipDir, '7z.dll'));
  }
  const outer = path.join(temporary, 'outer');
  const inner = path.join(temporary, 'inner');
  run7z(sevenZip, ['e', installer, `-o${outer}`, '-y', `$PLUGINSDIR\\${appArchiveName}`]);
  const appArchive = path.join(outer, appArchiveName);
  if (!existsSync(appArchive)) throw new Error(`NSIS payload is missing ${appArchiveName}`);

  run7z(sevenZip, ['x', appArchive, `-o${inner}`, '-y', 'resources\\docs\\vault\\*.md']);
  const sourceDir = path.join(root, 'docs', 'vault');
  const payloadDir = path.join(inner, 'resources', 'docs', 'vault');
  if (!existsSync(payloadDir)) throw new Error('Installer app payload is missing resources/docs/vault.');

  const markdown = (directory) => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
  const sourcePages = markdown(sourceDir);
  const payloadPages = markdown(payloadDir);
  if (JSON.stringify(sourcePages) !== JSON.stringify(payloadPages)) {
    throw new Error(`Installer Vault page set ${JSON.stringify(payloadPages)} != source ${JSON.stringify(sourcePages)}`);
  }
  for (const name of sourcePages) {
    if (!readFileSync(path.join(payloadDir, name)).equals(readFileSync(path.join(sourceDir, name)))) {
      throw new Error(`Installer Vault page ${name} does not match source bytes.`);
    }
  }
  process.stdout.write(`Verified ${sourcePages.length} Vault Markdown pages inside NSIS installer ${path.basename(installer)}.\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
