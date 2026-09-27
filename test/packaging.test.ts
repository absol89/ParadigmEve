import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertReleaseAbsent } from '../scripts/check-release-absent.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertCurrentTunnelRelease } from '../scripts/verify-current-tunnel.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as macOSAuditUtils from '../scripts/macos-audit-utils.mjs';
const { RIPGREP, TUNNEL_CLIENT } = packagingVersions;
const {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  macOSDeploymentTargetsFromOtool,
  withOtoolSafePath
} = macOSAuditUtils;
const {
  normalizeArch,
  normalizePlatform,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = packagingTargets;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The notes that ship with this tree's version, so the checks below read what the release will say. */
const currentReleaseNotes = () => {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  return readFileSync(path.join(root, 'docs', 'release-notes', `v${version}.md`), 'utf8');
};

function yamlFile(relative: string): any {
  return loadYaml(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

function bitmapInfo(relative: string) {
  const data = readFileSync(path.join(root, ...relative.split('/')));
  return {
    signature: data.toString('ascii', 0, 2),
    fileSize: data.readUInt32LE(2),
    dataOffset: data.readUInt32LE(10),
    dibSize: data.readUInt32LE(14),
    width: data.readInt32LE(18),
    height: data.readInt32LE(22),
    planes: data.readUInt16LE(26),
    bitsPerPixel: data.readUInt16LE(28),
    compression: data.readUInt32LE(30),
    actualSize: data.length
  };
}

describe('cross-platform packaging targets', () => {
  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('pins tunnel-client and ripgrep for every release OS/CPU pair', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(TUNNEL_CLIENT.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('fails closed unless the pinned tunnel-client is OpenAI\'s current stable release', async () => {
    const response = (body: Record<string, unknown>, status = 200) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });

    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).resolves.toMatchObject({ tag_name: 'v0.0.14' });
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.13',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).rejects.toThrow(/v0\.0\.13 is stale.*v0\.0\.14/);
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ message: 'rate limited' }, 403)
    })).rejects.toThrow(/refusing to publish without proving the pin is current/);
  });

  it('selects only target Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every CI operating system', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('keeps scripts for all six release targets and legacy Windows aliases', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const script of [
      'dist', 'dist:x64', 'dist:arm64',
      'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux:x64', 'dist:linux:arm64'
    ]) expect(pkg.scripts[script]).toBeTypeOf('string');
  });

  it('defaults local entrypoints to debug while release packaging selects shipping explicitly', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const vite = readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8');
    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    const buildScript = readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
    const release = yamlFile('.github/workflows/release.yml');
    const builder = yamlFile('electron-builder.yml');

    expect(pkg.scripts.dev).toBe('node scripts/build.mjs --command dev');
    expect(pkg.scripts.build).toBe('node scripts/build.mjs');
    expect(pkg.scripts.dist).toContain('node scripts/package.mjs');
    expect(buildScript).toContain("normalizeBuildFlavor(value('flavor') ?? process.env[BUILD_FLAVOR_ENV])");
    expect(packageScript).toContain("normalizeBuildFlavor(value('flavor', process.env[BUILD_FLAVOR_ENV]))");
    expect(vite).toContain('__PARADIGMEVE_BUILD_FLAVOR__');
    expect(vite.match(/define: compileTimeFlavor/g)).toHaveLength(3);
    expect(release.jobs.package.env.PARADIGMEVE_BUILD_FLAVOR).toBe('shipping');
    expect(builder.nsis.artifactName).toBe('ParadigmEve-Setup-${arch}${env.PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX}.${ext}');
    expect(builder.mac.artifactName).toBe('ParadigmEve-macOS-${arch}${env.PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX}.${ext}');
    expect(builder.linux.artifactName).toBe('ParadigmEve-Linux-${env.COS_PACKAGE_ARCH}${env.PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX}.${ext}');
  });

  it('keeps the local-network lab out of static non-debug-visible markup and gates its renderer and IPC entrypoints on debug', () => {
    const html = readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
    const renderer = readFileSync(path.join(root, 'src', 'renderer', 'main.ts'), 'utf8');
    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');

    expect(html).not.toContain('Local network lab');
    expect(html).not.toContain('Create group');
    expect(html).not.toContain('Join group');
    expect(renderer).toContain("if (BUILD_FLAVOR !== 'debug') return;");
    expect(ipc).toContain('if (lanPeerRuntimeAvailable(BUILD_FLAVOR))');
  });

  it('pins Electron 43.4.1 exactly and proves packaged runners use those runtime bytes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');

    expect(pkg.devDependencies.electron).toBe('43.4.1');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('43.4.1');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('43.4.1');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
  });

  it('keeps common release resources on an explicit ParadigmEve allowlist', () => {
    const builder = yamlFile('electron-builder.yml');
    const packagedRuntime = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    const installerVaultSmoke = readFileSync(path.join(root, 'scripts', 'smoke-windows-installer-vault.mjs'), 'utf8');
    expect((builder.extraResources ?? []).map((entry: any) => entry.from)).toEqual([
      'LICENSE',
      'THIRD-PARTY-NOTICES.txt',
      'node_modules/electron/dist/LICENSE',
      'node_modules/electron/dist/LICENSES.chromium.html',
      'extension',
      'docs/vault',
      'artwork/icon.png'
    ]);
    expect(builder.extraResources ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'docs/vault', to: 'docs/vault', filter: ['*.md'] })
    ]));
    expect(builder.extraResources ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from: expect.stringMatching(/^resources(?:[\\/]|$)/i) })
    ]));
    expect(packagedRuntime).toContain("const sourceVaultDir = path.join(repository, 'docs', 'vault');");
    expect(packagedRuntime).toContain("const packagedVaultDir = path.join(resourcesDir, 'docs', 'vault');");
    expect(packagedRuntime).toContain('Packaged Vault page set');
    expect(packagedRuntime).toContain('does not match the source bytes');
    expect(packageScript).toContain("run(node, ['scripts/smoke-packaged-runtime.mjs', '--platform', platform, '--arch', arch]);");
    expect(packageScript).toContain("scripts/smoke-windows-installer-vault.mjs");
    expect(packageScript).toContain("`ParadigmEve-Setup-${arch}${artifactSuffix}.exe`");
    expect(installerVaultSmoke).toContain("arch === 'x64' ? 'app-64.7z' : 'app-arm64.7z'");
    expect(installerVaultSmoke).toContain('$PLUGINSDIR\\\\${appArchiveName}');
    expect(installerVaultSmoke).toContain("'resources\\\\docs\\\\vault\\\\*.md'");
    expect(installerVaultSmoke).toContain('Installer Vault page set');
    expect(installerVaultSmoke).toContain('does not match source bytes');
  });

  it('packages the %how Vault with current Thread and Quilt vocabulary', () => {
    const vault = path.join(root, 'docs', 'vault');
    const manual = readdirSync(vault)
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFileSync(path.join(vault, name), 'utf8'))
      .join('\n');

    expect(manual).toContain('`%thread`');
    expect(manual).toContain('`#quilt`');
    expect(manual).toContain('Quilt');
    expect(manual).toContain('legacy `collections`/`collectionIds` field names internally');
  });

  it('grants sandbox read access only to the Windows install tree and fails on ACL errors', () => {
    const config = yamlFile('electron-builder.yml');
    const installer = readFileSync(path.join(root, 'scripts/windows-installer-acl.nsh'), 'utf8');
    const selfReinstall = readFileSync(path.join(root, 'scripts/windows-self-reinstall.ps1'), 'utf8');
    expect(config.nsis.include).toBe('scripts/windows-installer-acl.nsh');
    expect(config.nsis.runAfterFinish).toBe(true);
    // Per-install LAN identity lives in OS-protected userData. Updating/reinstalling the app must
    // not silently rotate that fingerprint by deleting the secret store.
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(installer).toContain('SetFont "Segoe UI" 10');
    expect(installer).toContain('!macro customInit');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(installer).toContain('Var ParadigmEveHadExistingInstall');
    expect(installer).toContain('StrCpy $ParadigmEveHadExistingInstall "1"');
    expect(installer).toContain('ExecWait');
    expect(installer).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"');
    expect(installer).toContain('${If} ${Errors}');
    expect(installer).toContain('${If} $0 != 0');
    expect(installer).toContain('SetErrorLevel 2');
    expect(installer).toContain('Abort "Windows could not set the folder access needed');
    expect(installer).toContain('CreateDirectory "$APPDATA\\ParadigmEve"');
    expect(installer).toContain('FileOpen $2 "$APPDATA\\ParadigmEve\\install-path.txt" w');
    expect(installer).toContain('FileWrite $2 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}$\\r$\\n"');
    expect(selfReinstall).toContain("Join-Path $env:APPDATA 'ParadigmEve\\install-path.txt'");
    expect(selfReinstall.indexOf("ParadigmEve\\install-path.txt")).toBeLessThan(
      selfReinstall.indexOf("Programs\\ParadigmEve\\ParadigmEve.exe")
    );
    expect(selfReinstall).toContain('[IO.Path]::GetFullPath($recorded)');
    expect(selfReinstall).toContain("[IO.Path]::GetFileName($candidate) -ine 'ParadigmEve.exe'");
    expect(installer).toContain('!macro customFinishPage');
    expect(installer).toContain('${IfNot} ${Silent}');
    expect(installer).toContain('SetAutoClose true');
    expect(installer).toContain('HideWindow');
    expect(installer).toContain('${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"');
    expect(installer).toContain('StrCpy $1 "--updated --recover-companion-browser"');
    expect(installer).toContain('${elseIf} $ParadigmEveHadExistingInstall == "1"');
    expect(installer).toContain('StrCpy $1 "--recover-companion-browser"');
    expect(installer).toContain('StrCpy $1 ""');
    expect(installer).not.toContain('--connect-on-start');
    // A silent install run from inside ParadigmEve force-closes its own caller. The installer must
    // bring back an app it closed itself, but never second-guess the updater's --updated handoff or
    // double-launch next to electron-builder's --force-run path.
    const init = installer.slice(installer.indexOf('!macro customInit'), installer.indexOf('!macro customInstall'));
    expect(init).toContain('StrCpy $ParadigmEveWasRunning "0"');
    expect(init).toMatch(/\$\{If\} \$\{Silent\}\s+nsExec::Exec [^\n]*Get-CimInstance -ClassName Win32_Process[^\n]*\$\$_\.Path -ieq '\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}'/);
    expect(init.indexOf('StrCpy $ParadigmEveWasRunning "1"')).toBeGreaterThan(init.indexOf('nsExec::Exec'));
    const launch = installer.slice(installer.indexOf('StrCpy $ParadigmEveLaunchAfterInstall "0"'), installer.indexOf('!macro customFinishPage'));
    expect(launch).toMatch(
      /\$\{IfNot\} \$\{Silent\}\s+StrCpy \$ParadigmEveLaunchAfterInstall "1"[\s\S]*?\$\{ElseIf\} \$ParadigmEveWasRunning == "1"\s+\$\{AndIfNot\} \$\{isUpdated\}\s+\$\{AndIfNot\} \$\{isForceRun\}\s+StrCpy \$ParadigmEveLaunchAfterInstall "1"\s+\$\{EndIf\}\s+\$\{If\} \$ParadigmEveLaunchAfterInstall == "1"/
    );
    expect(launch.indexOf('${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"')).toBeGreaterThan(
      launch.indexOf('${If} $ParadigmEveLaunchAfterInstall == "1"')
    );
    expect(launch.match(/ExecShellAsUser/g)).toHaveLength(1);
    expect(installer).not.toContain('MUI_PAGE_FINISH');
    expect(installer).not.toMatch(/\/(?:reset|remove|T)\b/i);
    expect(installer).not.toMatch(/(?:no-sandbox|disable-gpu-sandbox)/i);
    expect(selfReinstall).toContain('[int]$RetrySeconds = 30');
    expect(selfReinstall).toContain('[int]$RecoverySeconds = 120');
    expect(selfReinstall).toContain("@('--connect-on-start', '--recover-companion-browser')");
    expect(selfReinstall).not.toContain("@('--background', '--connect-on-start', '--recover-companion-browser')");
    expect(selfReinstall).toContain('/recovery');
    expect(selfReinstall).toContain('$recovery.ready -eq $true');
    expect(selfReinstall).toContain("$snapshot -match 'Installation Complete'");
    expect(selfReinstall).toContain("HasButton([uint32]$installerProcess.Id, 'Close')");
    expect(selfReinstall).not.toContain('Test-BridgeHello');
  });

  it('ships deterministic premium ParadigmEve artwork for the assisted NSIS installer', () => {
    const config = yamlFile('electron-builder.yml');
    expect(config.nsis.oneClick).toBe(false);
    expect(config.win.icon).toBe('build/icon.ico');
    expect(config.nsis.installerIcon).toBe('build/icon.ico');
    expect(config.nsis.uninstallerIcon).toBe('build/icon.ico');
    expect(config.nsis.installerHeader).toBe('build/installer-art/goddess-header.bmp');
    expect(config.nsis.installerSidebar).toBe('build/installer-art/goddess-sidebar.bmp');
    expect(config.nsis.uninstallerSidebar).toBe('build/installer-art/goddess-uninstaller-sidebar.bmp');

    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain("if (platform === 'win32') run(node, ['scripts/make-installer-art.mjs']);");

    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(iconScript).toContain("path.join(root, 'artwork', 'icon.png')");
    expect(iconScript).toContain("writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages))");
    expect(iconScript).toContain("writeFileSync(path.join(iconsDir, `icon${size}.png`), await windowsPngFor(size))");

    const generated = spawnSync(process.execPath, ['scripts/make-installer-art.mjs'], {
      cwd: root,
      encoding: 'utf8'
    });
    expect(generated.status, generated.stderr || generated.stdout).toBe(0);

    const expected = [
      ['build/installer-art/goddess-header.bmp', 150, 57],
      ['build/installer-art/goddess-sidebar.bmp', 164, 314],
      ['build/installer-art/goddess-uninstaller-sidebar.bmp', 164, 314]
    ] as const;
    for (const [file, width, height] of expected) {
      expect(bitmapInfo(file)).toEqual({
        signature: 'BM',
        fileSize: bitmapInfo(file).actualSize,
        dataOffset: 54,
        dibSize: 40,
        width,
        height,
        planes: 1,
        bitsPerPixel: 24,
        compression: 0,
        actualSize: bitmapInfo(file).actualSize
      });
    }

    const check = spawnSync(process.execPath, ['scripts/make-installer-art.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8'
    });
    expect(check.status, check.stderr || check.stdout).toBe(0);
  });

  it('assembles every platform artifact in the reusable release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const parsed = yamlFile('.github/workflows/release.yml');
    const matrix = parsed.jobs.package.strategy.matrix.include;
    expect(matrix).toHaveLength(6);
    expect(matrix).toEqual([
      {
        name: 'Windows x64', platform: 'win32', arch: 'x64', runner: 'windows-2025',
        script: 'dist:x64', artifact: 'package-windows-x64', files: 'release/ParadigmEve-Setup-x64.exe'
      },
      {
        name: 'Windows arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm',
        script: 'dist:arm64', artifact: 'package-windows-arm64', files: 'release/ParadigmEve-Setup-arm64.exe'
      },
      {
        name: 'macOS x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel',
        script: 'dist:mac:x64', artifact: 'package-macos-x64',
        files: 'release/ParadigmEve-macOS-x64.dmg\nrelease/ParadigmEve-macOS-x64.zip\n'
      },
      {
        name: 'macOS arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15',
        script: 'dist:mac:arm64', artifact: 'package-macos-arm64',
        files: 'release/ParadigmEve-macOS-arm64.dmg\nrelease/ParadigmEve-macOS-arm64.zip\n'
      },
      {
        name: 'Linux x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04',
        script: 'dist:linux:x64', artifact: 'package-linux-x64',
        files: 'release/ParadigmEve-Linux-x64.AppImage\nrelease/ParadigmEve-Linux-x64.deb\n'
      },
      {
        name: 'Linux arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm',
        script: 'dist:linux:arm64', artifact: 'package-linux-arm64',
        files: 'release/ParadigmEve-Linux-arm64.AppImage\nrelease/ParadigmEve-Linux-arm64.deb\n'
      }
    ]);
    expect(parsed.jobs.package['runs-on']).toBe('${{ matrix.runner }}');
    expect(workflow).toContain('name: paradigmeve-candidate-${{ github.run_id }}');
    expect(workflow).toContain('Install generated DEB on target distro');
    expect(workflow).toContain('Launch installed DEB normally under Xvfb');
    expect(workflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/paradigmeve');
    expect(workflow).toContain('Execute generated static-runtime AppImage');
    expect(workflow).toContain('Verify generated macOS archives');
    expect(workflow).toContain('hdiutil verify "$dmg"');
    expect(workflow).toContain('codesign --display --verbose=4 "$dmg" >dmg-codesign.log 2>&1');
    expect(workflow).toContain('dmg_codesign_status=$?');
    expect(workflow).toContain("grep -Eqi 'code object is not signed( at all)?' dmg-codesign.log");
    expect(workflow).toContain('test -L "$mount_dir/Applications"');
    expect(workflow).toContain('test "$(readlink "$mount_dir/Applications")" = /Applications');
    expect(workflow).toContain('ditto -x -k "$zip" "$zip_dir"');
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$mount_dir/ParadigmEve.app\"");
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$zip_dir/ParadigmEve.app\"");
    expect(workflow).toContain('Audit packaged macOS bundle metadata and Mach-O payloads');
    expect(workflow).toContain('node scripts/smoke-macos-bundle.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('Launch packaged macOS app normally');
    expect(workflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('architecture: ${{ matrix.arch }}');

    const macGui = workflow.slice(
      workflow.indexOf('      - name: Launch packaged macOS app normally'),
      workflow.indexOf('      - name: Install generated DEB on target distro')
    );
    expect(macGui).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(macGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const macGuiScript = readFileSync(path.join(root, 'scripts', 'smoke-macos-gui.mjs'), 'utf8');
    expect(macGuiScript).toContain("CLF_DEBUG: '1'");
    expect(macGuiScript).toContain("output.includes('[info] app started')");
    expect(macGuiScript).toContain("output.includes('[info] window loaded')");
    expect(macGuiScript).toContain("output.includes('[info] renderer state ready')");
    expect(macGuiScript).toContain("output.includes('[error] window failed to load')");
    expect(macGuiScript).toContain("output.includes('[error] renderer:')");
    expect(macGuiScript).toContain('minimumSurvivalMs = 10_000');
    expect(macGuiScript).toContain('startupDeadlineMs = 15_000');
    expect(macGuiScript).toContain("child.kill('SIGTERM')");
    expect(macGuiScript).toContain("child.kill('SIGKILL')");
    expect(macGuiScript).not.toContain('ELECTRON_RUN_AS_NODE');

    const debGui = workflow.slice(
      workflow.indexOf('      - name: Launch installed DEB normally under Xvfb'),
      workflow.indexOf('      - name: Execute generated static-runtime AppImage')
    );
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain("grep -Fxq 'Name=ParadigmEve' \"$desktop\"");
    expect(workflow).toContain("grep -Fxq 'Icon=paradigmeve' \"$desktop\"");
    expect(debGui).toContain('deb_smoke_root="$(mktemp -d)"');
    // Same shape the AppImage smoke below is held to: the teardown may retry, and may fail,
    // but it may never decide the step. Only the assertions under it do that.
    expect(debGui).toContain('cleanup_path_with_retries()');
    expect(debGui).toContain("trap 'cleanup_path_with_retries \"$deb_smoke_root\"' EXIT");
    expect(debGui).toContain('rm -rf "$target" 2>/dev/null || true');
    expect(debGui).toContain('HOME="$deb_smoke_root/home"');
    expect(debGui).toContain('XDG_CONFIG_HOME="$deb_smoke_root/config"');
    expect(debGui).toContain('XDG_CACHE_HOME="$deb_smoke_root/cache"');
    expect(debGui).toContain('XDG_DATA_HOME="$deb_smoke_root/data"');
    expect(debGui).toContain('XDG_STATE_HOME="$deb_smoke_root/state"');
    expect(debGui).toContain('xvfb-run -a /usr/bin/paradigmeve');
    expect(debGui).toContain('--kill-after=5s 12s');
    expect(debGui).toContain("grep -Fq '[info] app started' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] window loaded' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] renderer state ready' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] window failed to load' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] renderer:' deb-gui.log");
    expect(debGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const appImageGui = workflow.slice(
      workflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      workflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageGui).toContain('xvfb-run -a "$appimage"');
    expect(appImageGui).toContain('normal_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('fallback_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('rm -rf "$fake_bin" "$normal_smoke_root" "$fallback_smoke_root"');
    expect(appImageGui).toContain('HOME="$smoke_root/home"');
    expect(appImageGui).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(appImageGui).toContain('XDG_CACHE_HOME="$smoke_root/cache"');
    expect(appImageGui).toContain('XDG_DATA_HOME="$smoke_root/data"');
    expect(appImageGui).toContain('XDG_STATE_HOME="$smoke_root/state"');
    expect(appImageGui).toContain("printf '#!/bin/sh\\nexit 1\\n' > \"$fake_bin/unshare\"");
    expect(appImageGui).toContain('PATH="$launch_path"');
    expect(appImageGui).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(appImageGui).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] renderer state ready' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] window failed to load' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] renderer:' \"$log\"");
    expect(appImageGui).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(appImageGui).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(appImageGui.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('only reports renderer readiness after the initial state snapshot has completed', () => {
    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    const returned = ipc.indexOf('return state;', ready);

    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
    expect(returned).toBeGreaterThan(ready);
  });

  it('keeps a losing second instance out of the async primary bootstrap', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const canonicalUserData = main.indexOf("app.setPath('userData', path.join(app.getPath('appData'), 'ParadigmEve'));");
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const losingBranch = main.indexOf('if (!hasSingleInstanceLock) {', lock);
    const markQuitting = main.indexOf('quitting = true;', losingBranch);
    const ready = main.indexOf('void app.whenReady().then(async () => {', losingBranch);
    const readyGuard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstSharedStateRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(canonicalUserData).toBeGreaterThan(-1);
    expect(canonicalUserData).toBeLessThan(lock);
    expect(lock).toBeGreaterThan(-1);
    expect(losingBranch).toBeGreaterThan(lock);
    expect(markQuitting).toBeGreaterThan(losingBranch);
    expect(markQuitting).toBeLessThan(ready);
    expect(readyGuard).toBeGreaterThan(ready);
    expect(readyGuard).toBeLessThan(firstSharedStateRead);
    expect(main).toContain('appDataPath: userData');
    expect(main).toContain('installationPath: installationDirectory');
    expect(main).toContain('initConfigPath(userData);');
    expect(main).not.toContain("freshRoots: [");

    const beforeQuit = main.indexOf("app.on('before-quit', () => {");
    const beforeQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', beforeQuit);
    const beforeQuitMutation = main.indexOf('quitting = true;', beforeQuit);
    const windowAllClosed = main.indexOf("app.on('window-all-closed', () => {");
    const windowAllOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', windowAllClosed);
    const windowAllConfig = main.indexOf('getConfig().ui.minimizeToTray', windowAllClosed);
    const willQuit = main.indexOf("app.on('will-quit', (event) => {");
    const willQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', willQuit);
    const preventDefault = main.indexOf('event.preventDefault();', willQuit);

    expect(beforeQuitOwner).toBeGreaterThan(beforeQuit);
    expect(beforeQuitOwner).toBeLessThan(beforeQuitMutation);
    expect(windowAllOwner).toBeGreaterThan(windowAllClosed);
    expect(windowAllOwner).toBeLessThan(windowAllConfig);
    expect(willQuitOwner).toBeGreaterThan(willQuit);
    expect(willQuitOwner).toBeLessThan(preventDefault);
  });

  it('applies the persisted native theme before the first packaged BrowserWindow can be created', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const ready = main.indexOf('void app.whenReady().then(async () => {');
    const loadConfig = main.indexOf('await loadConfig();', ready);
    const theme = main.indexOf('nativeTheme.themeSource = getConfig().ui.theme;', loadConfig);
    const enableActivation = main.indexOf('windowActivation.enable();', theme);
    const firstWindowRequest = main.indexOf('windowActivation.request();', enableActivation);

    expect(ready).toBeGreaterThan(-1);
    expect(loadConfig).toBeGreaterThan(ready);
    expect(theme).toBeGreaterThan(loadConfig);
    expect(enableActivation).toBeGreaterThan(theme);
    expect(firstWindowRequest).toBeGreaterThan(enableActivation);

    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const save = ipc.indexOf("handle('settings:save', async (payload) => {");
    const liveTheme = ipc.indexOf('nativeTheme.themeSource = next.ui.theme;', save);
    const background = ipc.indexOf("getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');", liveTheme);
    expect(save).toBeGreaterThan(-1);
    expect(liveTheme).toBeGreaterThan(save);
    expect(background).toBeGreaterThan(liveTheme);
  });

  it('uses Noble-compatible Linux packages and a FUSE-independent AppImage runtime', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(builder.toolsets.appimage).toBe('1.0.3');
    expect(builder.linux.artifactName).toBe('ParadigmEve-Linux-${env.COS_PACKAGE_ARCH}${env.PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX}.${ext}');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.appId).toBe('com.paradigmeve.app');
    expect(builder.linux.executableName).toBe('paradigmeve');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(builder.linux.maintainer).toMatch(/^ParadigmEve private build <[^>]+@users\.noreply\.github\.com>$/);
    expect(pkg.desktopName).toBe('com.paradigmeve.app.desktop');
    expect(pkg).not.toHaveProperty('homepage');
    expect(iconScript).toContain("build', 'icon.png'), pngFor(1024)");

    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    expect(main).toContain("if (process.platform === 'win32')");
    expect(main).toContain('const brandedPath = connectorIconPath();');
    expect(main).toContain("source.resize({ width: 16, height: 16, quality: 'best' })");
    expect(main).toContain("source.resize({ width: 32, height: 32, quality: 'best' })");

    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain('COS_PACKAGE_ARCH: arch');
    const releaseWorkflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseWorkflow).toContain('HOME="$deb_smoke_root/home"');
    expect(releaseWorkflow).toContain('HOME="$smoke_root/home"');
    expect(releaseWorkflow).toContain('PATH="$launch_path"');
    expect(releaseWorkflow).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(releaseWorkflow).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/paradigmeve');
    expect(releaseWorkflow).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(releaseWorkflow).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Package)\" = paradigmeve");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Version)\" = \"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('expected_deb_arch=amd64');
    expect(releaseWorkflow).toContain("dpkg-query -W -f='${Status}\\n' paradigmeve");
    expect(releaseWorkflow).toContain('desktop=/usr/share/applications/com.paradigmeve.app.desktop');
    expect(releaseWorkflow).toContain("grep -Fxq 'StartupWMClass=com.paradigmeve.app' \"$desktop\"");
    expect(releaseWorkflow).toContain('test -L /usr/bin/paradigmeve');
    expect(releaseWorkflow).toContain('installed_executable="$(readlink -f /usr/bin/paradigmeve)"');
    expect(releaseWorkflow).toContain('test -x "$installed_executable"');
    expect(releaseWorkflow).toContain('dpkg-query -S "$installed_executable"');
    expect(releaseWorkflow).toContain("node scripts/smoke-packaged-runtime.mjs --platform linux --arch '${{ matrix.arch }}' --root \"$(dirname \"$installed_executable\")\"");
    expect(releaseWorkflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');

    const appImageSection = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      releaseWorkflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageSection.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');

    // The user-facing platform notes live in the setup guide; the README is the product front page.
    const setup = readFileSync(path.join(root, 'docs', 'setup.md'), 'utf8');
    const security = readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
    const notes = currentReleaseNotes();
    for (const document of [setup, security, notes]) {
      expect(document).toContain('--no-sandbox');
      expect(document).toMatch(/unprivileged user namespaces/i);
    }
  });

  it('keeps the static AppImage sandbox fallback conditional and duplicate-safe', () => {
    // Read the shipped template rather than requiring app-builder-lib to render it. The
    // assertions below are on the template's own text, so loading that dependency graph buys
    // no coverage and is the reason this case could hit the global 30s timeout under full-suite
    // contention while passing in about 1.5s alone.
    const source = readFileSync(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js'),
      'utf8'
    );

    expect(source).toContain('HAVE_NO_SANDBOX=0');
    expect(source).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(source).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(source).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(source).toContain('exec "$BIN" "\\${NO_SANDBOX[@]}" "\\${args[@]}"');
  });

  it('pins the current macOS release to unsigned thin native bundles with explicit metadata checks', () => {
    const builder = yamlFile('electron-builder.yml');
    const macSmoke = readFileSync(path.join(root, 'scripts', 'smoke-macos-bundle.mjs'), 'utf8');
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.appId).toBe('com.paradigmeve.app');
    expect(builder.mac.category).toBe('public.app-category.developer-tools');
    expect(builder.mac.minimumSystemVersion).toBe('13.0');
    expect(builder.mac.artifactName).toBe('ParadigmEve-macOS-${arch}${env.PARADIGMEVE_ARTIFACT_FLAVOR_SUFFIX}.${ext}');
    expect(builder.mac.extendInfo.NSUserNotificationAlertStyle).toBe('alert');
    const nativePrep = readFileSync(path.join(root, 'scripts', 'prepare-packaging-native.mjs'), 'utf8');
    expect(nativePrep).toContain("await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755)");
    for (const marker of [
      "CFBundleIdentifier: 'com.paradigmeve.app'",
      "CFBundleExecutable: 'ParadigmEve'",
      "CFBundleName: 'ParadigmEve'",
      "CFBundleDisplayName: 'ParadigmEve'",
      "CFBundleIconFile: 'icon.icns'",
      'CFBundleShortVersionString: packageVersion',
      'CFBundleVersion: packageVersion',
      "LSApplicationCategoryType: 'public.app-category.developer-tools'",
      "LSMinimumSystemVersion: '13.0'",
      'NSScreenCaptureUsageDescription:',
      "path.join(resources, 'desktop', 'macos-desktop-addon.node')",
      "path.join(resources, 'desktop', 'libcos-desktop.dylib')",
      "path.join(ptyDir, 'spawn-helper')",
      "path.join(nodeModules, 'tree-sitter', 'prebuilds'",
      "path.join(nodeModules, 'tree-sitter-bash', 'prebuilds'",
      "relative of ['tunnel/tunnel-client', 'tunnel/cloudflared', 'rg/rg']",
      "run('lipo', ['-archs', file])",
      "withOtoolSafePath(file, (otoolPath) => run('otool', ['-l', otoolPath]).stdout)",
      'walkFiles(contents)',
      "normalized.includes('.app/Contents/MacOS/')",
      "path.basename(file) === 'chrome_crashpad_handler'",
      "path.basename(file) === 'macos-desktop-addon.node'",
      'desktopPayload ? \'12.3\'',
      'launchedMachOCount < 6',
      "run('plutil', ['-extract', key, 'raw', plist])",
      "run('codesign', ['--display', '--verbose=4', app]",
      "run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])",
      'assertNoTrustBearingMacCodeSignature(',
      "path.join(contents, '_CodeSignature', 'CodeResources')"
    ]) expect(macSmoke).toContain(marker);
    expect(macSmoke).toContain("requireFile(path.join(resources, 'icon.icns'))");
    expect(macSmoke).toContain("iconBytes.toString('ascii', 0, 4) !== 'icns'");
    const packagedRuntime = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(packagedRuntime).toContain("for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash'])");
    expect(packagedRuntime).toContain('directories.length !== 1 || directories[0] !== nativeDir');
    expect(packagedRuntime).toContain("required('desktop/macos-desktop-addon.node')");
    expect(packagedRuntime).toContain("required('desktop/libcos-desktop.dylib')");
    expect(packagedRuntime).toContain("addon.handle('{\"op\":\"warm\"}')");

    const setup = readFileSync(path.join(root, 'docs', 'setup.md'), 'utf8');
    const notes = currentReleaseNotes();
    expect(setup).toContain('macOS 13 Ventura or newer');
    expect(notes).toContain('macOS 13');
    expect(notes).toContain('Ventura or newer');
  });

  it('hides Electron helper parentheses from otool-classic without changing the inspected file', () => {
    const file = '/Applications/ParadigmEve.app/Contents/Frameworks/ParadigmEve Helper (GPU).app/Contents/MacOS/ParadigmEve Helper (GPU)';
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const result = withOtoolSafePath(
      file,
      (safePath: string) => {
        calls.push({ kind: 'inspect', args: [safePath] });
        expect(path.basename(safePath)).toBe('payload');
        expect(safePath).not.toMatch(/[()]/);
        return 'otool-output';
      },
      {
        tmpdir: '/tmp',
        mkdtempSync: (prefix: string) => {
          calls.push({ kind: 'mkdtemp', args: [prefix] });
          return '/tmp/cos-otool-safe';
        },
        symlinkSync: (target: string, alias: string) => {
          calls.push({ kind: 'symlink', args: [target, alias] });
        },
        rmSync: (target: string, options: unknown) => {
          calls.push({ kind: 'remove', args: [target, options] });
        }
      }
    );

    expect(result).toBe('otool-output');
    const safePrefix = path.join('/tmp', 'cos-otool-');
    const safeDirectory = '/tmp/cos-otool-safe';
    const safePayload = path.join(safeDirectory, 'payload');
    expect(calls).toEqual([
      { kind: 'mkdtemp', args: [safePrefix] },
      { kind: 'symlink', args: [file, safePayload] },
      { kind: 'inspect', args: [safePayload] },
      { kind: 'remove', args: [safeDirectory, { recursive: true, force: true }] }
    ]);
  });

  it('rejects Mach-O payloads whose deployment target exceeds the declared macOS floor', () => {
    const modern = `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 11
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
`;
    expect(macOSDeploymentTargetsFromOtool(modern)).toEqual(['11.0', '10.15']);
    expect(() => assertCompatibleMacOSDeploymentTargets('good.node', modern, '12.0')).not.toThrow();

    const tooNew = modern.replace('minos 11.0', 'minos 13.0');
    expect(() => assertCompatibleMacOSDeploymentTargets('bad.node', tooNew, '12.0')).toThrow(
      /requires macOS 13\.0, newer than Info\.plist LSMinimumSystemVersion 12\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('missing.node', 'Load command 1\n cmd LC_SEGMENT_64', '12.0')).toThrow(
      /no macOS deployment target load command/
    );
  });

  it('allows Apple-Silicon ad-hoc signatures but rejects publisher-bearing macOS signatures', () => {
    // The sealed ad-hoc bundle, which is what ships: no Authority, no TeamIdentifier, and the
    // resource envelope its own executables imply.
    expect(() => assertNoTrustBearingMacCodeSignature('adhoc.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, true)).not.toThrow();

    expect(() => assertNoTrustBearingMacCodeSignature('developer-id.app', {
      status: 0,
      stdout: '',
      stderr: 'Signature size=9000\nAuthority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('unknown-success.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('inspection-failed.app', {
      status: null,
      stdout: '',
      stderr: 'codesign was terminated unexpectedly'
    }, true)).toThrow(/inspection failed unexpectedly/);
  });

  /**
   * Issue #66: the shape that shipped twice and would not launch.
   *
   * arm64 Mach-Os are ad-hoc signed by the linker whether anyone asks or not, so a bundle with no
   * CodeResources is one whose executables claim a resource seal the bundle does not have. macOS
   * reads that contradiction as damage — with Gatekeeper assessment already disabled, and no
   * crash report to show for it. This assertion used to *demand* that state, which is why two
   * releases shipped it and nothing caught them.
   */
  it('rejects a bundle whose executables are signed but which has no resource seal', () => {
    expect(() => assertNoTrustBearingMacCodeSignature('linker-signed.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, false)).toThrow(/no bundle CodeResources envelope/);

    // "Never signed at all" earns the same refusal. The seal is what macOS needs, and a packaged
    // arm64 app cannot reach that state anyway — the linker signs it regardless.
    expect(() => assertNoTrustBearingMacCodeSignature('unsigned.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    }, false)).toThrow(/no bundle CodeResources envelope/);
  });

  it('fails release-existence preflight closed on API errors instead of spending packaging runners', async () => {
    const options = {
      repository: 'owner/repo',
      tag: 'v2.0.2',
      token: 'test-token'
    };
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('', { status: 404 })
    })).resolves.toBeUndefined();
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toThrow(/already exists/);
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 })
    })).rejects.toThrow(/refusing to assume the release is absent/);
  });

  it('rejects invalid publishes before allocating the reusable six-runner build', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const preflight = workflow.indexOf('  preflight:');
    const candidate = workflow.indexOf('  candidate:');
    const publish = workflow.indexOf('  publish:');
    expect(preflight).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(candidate);
    expect(workflow.slice(preflight, candidate)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(preflight, candidate)).toContain('npm run verify:tunnel-current');
    expect(workflow.slice(preflight, candidate)).toContain('Verify release metadata agrees');
    expect(workflow.slice(preflight, candidate)).toContain("APP_VERSION = '([^']+)'");
    expect(workflow.slice(preflight, candidate)).toContain('must disclose unsigned and unnotarized macOS artifacts');
    expect(workflow.slice(candidate, publish)).toContain('needs: preflight');
    expect(workflow.slice(publish)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(publish).match(/npm run verify:tunnel-current/g)).toHaveLength(1);
    expect(workflow).toContain('name: paradigmeve-candidate-${{ github.run_id }}');
  });

  it('keeps the current changelog and reviewed release notes aligned with every published artifact', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'src', 'main', 'version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1]).toBe(pkg.version);
    expect(notes).toContain(`## ${pkg.version}`);
    expect(notes).toMatch(/unsigned/i);
    expect(notes).toMatch(/unnotarized/i);

    const artifacts = [
      'ParadigmEve-Setup-x64.exe',
      'ParadigmEve-Setup-arm64.exe',
      'ParadigmEve-macOS-x64.dmg',
      'ParadigmEve-macOS-x64.zip',
      'ParadigmEve-macOS-arm64.dmg',
      'ParadigmEve-macOS-arm64.zip',
      'ParadigmEve-Linux-x64.AppImage',
      'ParadigmEve-Linux-x64.deb',
      'ParadigmEve-Linux-arm64.AppImage',
      'ParadigmEve-Linux-arm64.deb',
      'ParadigmEve-Extension.zip',
      'ParadigmEve-Native-Sources.tar.gz',
      'SHA256SUMS.txt'
    ];
    const checksumStep = release.slice(
      release.indexOf('      - name: Create SHA-256 checksums'),
      release.indexOf('      - name: Upload release candidate')
    );
    const candidateUpload = release.slice(release.indexOf('      - name: Upload release candidate'));
    const publishStep = publish.slice(publish.indexOf('      - name: Publish the release'));
    for (const artifact of artifacts) {
      expect(notes).toContain(`\`${artifact}\``);
      expect(candidateUpload).toContain(artifact);
      expect(publishStep).toContain(artifact);
    }
    for (const artifact of artifacts.filter((artifact) => artifact !== 'SHA256SUMS.txt')) {
      expect(checksumStep).toContain(artifact);
    }
  });
});
