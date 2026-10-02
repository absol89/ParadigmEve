import path from 'node:path';
import { focusWindow, listWindows, type WindowInfo } from '../computer/index.js';

/** The generated archive page's `<title>`; a browser shows it in its window title. */
export const ARCHIVE_PAGE_TITLE = 'ParadigmEve Archive';

export interface ArchiveFocusDeps {
  platform?: NodeJS.Platform;
  list?: () => Promise<{ windows: WindowInfo[] }>;
  focus?: (id: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** This app's own executable, so ParadigmEve's window is never mistaken for the browser. */
  ownExecutable?: string;
}

function isArchiveBrowserWindow(window: WindowInfo, ownExecutable: string): boolean {
  if (!window.title.includes(ARCHIVE_PAGE_TITLE)) return false;
  const executable = window.processPath ?? window.process;
  return !(executable && path.resolve(executable).toLowerCase() === path.resolve(ownExecutable).toLowerCase());
}

/**
 * Bring the browser window that just opened the static archive to the front.
 *
 * `shell.openPath` hands the file to the system's default browser, which may open the tab behind
 * ParadigmEve. Once the page's title shows up in a window we focus that window, best effort: a
 * non-Windows host, a missing helper or a browser that never shows the title simply leaves the OS's
 * own behavior. The page is already open either way, so a failure here is never an error to the user.
 */
export async function focusOpenedArchiveBrowser(deps: ArchiveFocusDeps = {}, timeoutMs = 4000): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return false;
  const list = deps.list ?? listWindows;
  const focus = deps.focus ?? focusWindow;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const own = deps.ownExecutable ?? process.execPath;
  const deadline = now() + timeoutMs;
  try {
    do {
      const windows = (await list()).windows.filter(window => isArchiveBrowserWindow(window, own));
      const target = windows.find(window => window.state === 'foreground') ?? windows[0];
      if (target) return await focus(target.id);
      if (now() >= deadline) return false;
      await sleep(250);
    } while (true);
  } catch {
    return false;
  }
}
