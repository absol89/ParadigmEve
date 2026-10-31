import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Node.js 24 LTS for a computer that has no Node, when a plugin needs npm.
 *
 * Commands already get Eve's own Node (bundled-node.ts), but that has no npm. Here the user is asked
 * first; on yes, the official installer for one exact release is downloaded from nodejs.org, checked
 * against the SHA-256 pinned below (from that release's SHASUMS256.txt), and opened for the user to
 * finish. Nothing installs silently. The release is pinned because "LTS" alone now means Node 26.
 */
export const NODE_LTS_VERSION = '24.22.2';

const INSTALLERS: Record<string, { file: string; sha256: string }> = {
  'win32-x64': { file: `node-v${NODE_LTS_VERSION}-x64.msi`, sha256: '9231bf64d19bef391dd5ee8af65411d3799c3c44a842d2320849cc1da60b6b6d' },
  'win32-arm64': { file: `node-v${NODE_LTS_VERSION}-arm64.msi`, sha256: 'f08a17daf9be2671801724a9fe91b8e43d5800d610c61909b3f68fd2e983ad53' },
  // One universal macOS package serves both architectures.
  'darwin-x64': { file: `node-v${NODE_LTS_VERSION}.pkg`, sha256: 'e975e566b13aaa6b4b10689d0fea6fd8332b43a1474b9f0c970242e0c2b99bf9' },
  'darwin-arm64': { file: `node-v${NODE_LTS_VERSION}.pkg`, sha256: 'e975e566b13aaa6b4b10689d0fea6fd8332b43a1474b9f0c970242e0c2b99bf9' }
};

export interface NodeInstaller { url: string; file: string; sha256: string }

/** The official installer for this computer, or null where Node comes from the system's packages (Linux). */
export function nodeInstallerFor(platform: string = process.platform, arch: string = process.arch): NodeInstaller | null {
  const found = INSTALLERS[`${platform}-${arch}`];
  return found ? { ...found, url: `https://nodejs.org/dist/v${NODE_LTS_VERSION}/${found.file}` } : null;
}

/** The safe answer owns Enter and Escape. */
export function nodeInstallDialogOptions() {
  return {
    type: 'question' as const,
    title: 'Install Node.js 24 LTS?',
    message: 'This plugin needs Node.js with npm, and none was found on this computer.',
    detail:
      `ParadigmEve can download the official Node.js ${NODE_LTS_VERSION} (LTS) installer from nodejs.org, check it against the ` +
      'SHA-256 published with that release, and open it. You finish the installation in its own window, then restart ParadigmEve.',
    buttons: ['Download and open installer', 'Not now'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
}

/** Downloads one installer into `dir` and keeps it only if its SHA-256 matches. Returns its path. */
export async function downloadNodeInstaller(dir: string, installer: NodeInstaller, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
  const response = await fetchImpl(installer.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Node.js installer download failed (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== installer.sha256) throw new Error(`The Node.js installer did not match its published SHA-256, so it was not kept or opened (got ${actual}).`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, installer.file);
  await fs.writeFile(file, bytes);
  return file;
}

export interface NodeInstallDeps {
  confirm: () => Promise<boolean>;
  download: (installer: NodeInstaller) => Promise<string>;
  open: (file: string) => Promise<void>;
  platform?: string;
  arch?: string;
}

export async function offerNodeLtsInstall(deps: NodeInstallDeps): Promise<'opened' | 'declined' | 'unsupported'> {
  const installer = nodeInstallerFor(deps.platform, deps.arch);
  if (!installer) return 'unsupported';
  if (!(await deps.confirm())) return 'declined';
  await deps.open(await deps.download(installer));
  return 'opened';
}

/** The app's wiring: a native dialog in front of Eve, a download under userData, the OS opening the installer. */
export async function offerNodeLtsInstallInApp(): Promise<'opened' | 'declined' | 'unsupported'> {
  const { app, BrowserWindow, dialog, shell } = await import('electron');
  const downloadsDir = path.join(app.getPath('userData'), 'runtime', 'downloads');
  return offerNodeLtsInstall({
    confirm: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null;
      const options = nodeInstallDialogOptions();
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      return response === 0;
    },
    download: (installer) => downloadNodeInstaller(downloadsDir, installer),
    open: async (file) => {
      const failure = await shell.openPath(file);
      if (failure) throw new Error(`The Node.js installer could not be opened: ${failure}`);
    }
  });
}
