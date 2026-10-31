import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Eve's own Node for commands on a computer that has none.
 *
 * ParadigmEve already carries Node 24 inside Electron. A `node` shim that runs this executable with
 * ELECTRON_RUN_AS_NODE goes at the end of a command's PATH, so any Node the user installed still wins
 * and a local model's `node reveal.mjs` works where no Node exists. It has no npm; a plugin that
 * needs npm still asks for the full Node.js 24 LTS (see node-install.ts).
 */
let directory: string | null = null;

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Writes the shim into a folder only this user can write (Electron's userData). Called once at startup. */
export function configureBundledNode(folder: string, executable: string = process.execPath): void {
  directory = null;
  try {
    mkdirSync(folder, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(path.join(folder, 'node.cmd'), `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" %*\r\n`);
    } else {
      writeFileSync(path.join(folder, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} "$@"\n`, { mode: 0o755 });
    }
    directory = folder;
  } catch {
    directory = null;
  }
}

export function bundledNodeDirectory(): string | null {
  return directory;
}

export function resetBundledNodeForTests(): void {
  directory = null;
}
