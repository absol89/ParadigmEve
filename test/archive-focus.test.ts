import { describe, expect, it, vi } from 'vitest';
import { focusOpenedArchiveBrowser, ARCHIVE_PAGE_TITLE } from '../src/main/archive/archive-focus.js';
import type { WindowInfo } from '../src/main/computer/index.js';

const OWN = 'C:\\Program Files\\ParadigmEve\\ParadigmEve.exe';
const window = (id: number, title: string, processPath: string, state?: string): WindowInfo =>
  ({ id, title, process: processPath.split('\\').pop()!, processPath, state, x: 0, y: 0, width: 800, height: 600 }) as unknown as WindowInfo;

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
      ownExecutable: OWN,
      now, sleep, focus,
      list: async () => ({ windows: [
        window(1, `${ARCHIVE_PAGE_TITLE} – ParadigmEve`, OWN),
        window(2, 'Inbox - Mail', 'C:\\Apps\\mail.exe'),
        window(3, `${ARCHIVE_PAGE_TITLE} - Google Chrome`, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
      ] })
    });
    expect(done).toBe(true);
    expect(focus).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('waits for the page title to appear and prefers the window already in front', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    let polls = 0;
    const chrome = 'C:\\Chrome\\chrome.exe';
    const done = await focusOpenedArchiveBrowser({
      platform: 'win32', ownExecutable: OWN, now, sleep, focus,
      list: async () => ({ windows: ++polls < 3
        ? [window(5, 'New Tab - Google Chrome', chrome)]
        : [window(5, `${ARCHIVE_PAGE_TITLE} - Google Chrome`, chrome), window(6, `${ARCHIVE_PAGE_TITLE} - Edge`, 'C:\\Edge\\msedge.exe', 'foreground')] })
    });
    expect(done).toBe(true);
    expect(polls).toBe(3);
    expect(focus).toHaveBeenCalledExactlyOnceWith(6);
  });

  it('gives up quietly when no window ever shows the page, off Windows, or when the helper fails', async () => {
    const focus = vi.fn(async () => true);
    const { now, sleep } = clock();
    expect(await focusOpenedArchiveBrowser({ platform: 'win32', ownExecutable: OWN, now, sleep, focus, list: async () => ({ windows: [] }) }, 1000)).toBe(false);
    expect(await focusOpenedArchiveBrowser({ platform: 'darwin', focus, list: async () => { throw new Error('must not be called'); } })).toBe(false);
    expect(await focusOpenedArchiveBrowser({ platform: 'win32', ownExecutable: OWN, now, sleep, focus, list: async () => { throw new Error('helper missing'); } })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
