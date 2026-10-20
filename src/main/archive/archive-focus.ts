import { focusWindow, listWindows, type WindowInfo } from '../computer/index.js';
import { dedicatedParadigmEveChromeWindow } from '../setup-assistant.js';

/** The generated archive page's `<title>`; a browser shows it in its window title. */
export const ARCHIVE_PAGE_TITLE = 'ParadigmEve Archive';

export interface ArchiveFocusDeps {
  platform?: NodeJS.Platform;
  list?: () => Promise<{ windows: WindowInfo[] }>;
  focus?: (id: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam. Production always uses the same exact Eve Browser identity fence as recovery. */
  dedicatedWindow?: (window: WindowInfo) => boolean;
}

function isArchiveBrowserWindow(window: WindowInfo, dedicatedWindow: (window: WindowInfo) => boolean): boolean {
  return window.title.includes(ARCHIVE_PAGE_TITLE) && dedicatedWindow(window);
}

/**
 * Bring the browser window that just opened the static archive to the front.
 *
 * Eve Browser can take the page in a window behind ParadigmEve. Only a window proven to
 * belong to the dedicated Eve profile is eligible: an old same-title Archive in someone's
 * personal browser must never receive focus. On unsupported hosts or failed observation,
 * leave the window as opened rather than guessing a browser owner.
 */
export async function focusOpenedArchiveBrowser(deps: ArchiveFocusDeps = {}, timeoutMs = 4000): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32') return false;
  const list = deps.list ?? listWindows;
  const focus = deps.focus ?? focusWindow;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const dedicatedWindow = deps.dedicatedWindow ?? dedicatedParadigmEveChromeWindow;
  const deadline = now() + timeoutMs;
  try {
    do {
      const windows = (await list()).windows.filter(window => isArchiveBrowserWindow(window, dedicatedWindow));
      const target = windows.find(window => window.state === 'foreground') ?? windows[0];
      if (target) return await focus(target.id);
      if (now() >= deadline) return false;
      await sleep(250);
    } while (true);
  } catch {
    return false;
  }
}
