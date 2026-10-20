import { describe, expect, it, vi } from 'vitest';
import { focusOpenedArchiveBrowser, ARCHIVE_PAGE_TITLE } from '../src/main/archive/archive-focus.js';
import type { WindowInfo } from '../src/main/computer/index.js';

const OWN = 'C:\\Program Files\\ParadigmEve\\ParadigmEve.exe';
const window = (id: number, title: string, processPath: string, state?: string): WindowInfo =>
  ({ id, title, process: processPath.split('\\').pop()!, processPath, state, x: 0, y: 0, width: 800, height: 600 }) as unknown as WindowInfo;
const dedicatedWindow = (win: WindowInfo) => win.app === 'chrome.setupbrowserprofile.default';
const eveWindow = (id: number, title: string, state?: string): WindowInfo => ({
  ...window(id, title, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', state),
  app: 'chrome.setupbrowserprofile.default', process: 'chrome'
});

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

describe('focusing the browser that opened the static archive', () => {
  it('focuses the browser window showing the archive page, never ParadigmEve itself', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    const done = await focusOpenedArchiveBrowser({
      platform: 'win32',
      dedicatedWindow,
      now, sleep, focus,
      list: async () => ({ windows: [
        window(1, `${ARCHIVE_PAGE_TITLE} – ParadigmEve`, OWN),
        window(2, 'Inbox - Mail', 'C:\\Apps\\mail.exe'),
        eveWindow(3, `${ARCHIVE_PAGE_TITLE} - Google Chrome`)
      ] })
    });
    expect(done).toBe(true);
    expect(focus).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('waits for the page title to appear and prefers the window already in front', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    let polls = 0;
    const done = await focusOpenedArchiveBrowser({
      platform: 'win32', dedicatedWindow, now, sleep, focus,
      list: async () => ({ windows: ++polls < 3
        ? [eveWindow(5, 'New Tab - Google Chrome')]
        : [eveWindow(5, `${ARCHIVE_PAGE_TITLE} - Google Chrome`), eveWindow(6, `${ARCHIVE_PAGE_TITLE} - Google Chrome`, 'foreground')] })
    });
    expect(done).toBe(true);
    expect(polls).toBe(3);
    expect(focus).toHaveBeenCalledExactlyOnceWith(6);
  });

  it('ignores an older Archive in personal Chrome even when that window is already in front', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    const personal = window(20, `${ARCHIVE_PAGE_TITLE} - Google Chrome`, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'foreground');
    const done = await focusOpenedArchiveBrowser({
      platform: 'win32', dedicatedWindow, now, sleep, focus,
      list: async () => ({ windows: [personal, eveWindow(21, `${ARCHIVE_PAGE_TITLE} - Google Chrome`)] })
    });
    expect(done).toBe(true);
    expect(focus).toHaveBeenCalledExactlyOnceWith(21);
  });

  it('never activates the personal browser when it is the only window displaying Archive', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    expect(await focusOpenedArchiveBrowser({
      platform: 'win32', dedicatedWindow, now, sleep, focus,
      list: async () => ({ windows: [window(20, `${ARCHIVE_PAGE_TITLE} - Google Chrome`, 'C:\\Chrome\\chrome.exe')] })
    }, 750)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('gives up quietly when no window ever shows the page, off Windows, or when the helper fails', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    expect(await focusOpenedArchiveBrowser({ platform: 'win32', dedicatedWindow, now, sleep, focus, list: async () => ({ windows: [] }) }, 1000)).toBe(false);
    expect(await focusOpenedArchiveBrowser({ platform: 'darwin', focus, list: async () => { throw new Error('must not be called'); } })).toBe(false);
    expect(await focusOpenedArchiveBrowser({ platform: 'win32', dedicatedWindow, now, sleep, focus, list: async () => { throw new Error('helper missing'); } })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
