import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo } from '../logger.js';

/** Installer-owned TMPDIR can disappear while the app remains running on macOS. */
export async function createTunnelWorkDir(): Promise<string> {
  try {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-'));
  } catch (error) {
    // Do not create arbitrary inherited directories or retry permissions/disk failures.
    if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const canonical = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 3_000 }, (err, stdout) => {
        if (err) { reject(err); return; }
        const dir = stdout.trim();
        if (!path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) {
          reject(new Error('macOS returned no usable user temporary directory'));
          return;
        }
        resolve(dir);
      });
    });
    const workDir = await fs.mkdtemp(path.join(canonical, 'cglf-'));
    logInfo('tunnel: inherited temporary directory is missing; using the macOS user temporary directory');
    return workDir;
  }
}
