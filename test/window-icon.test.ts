import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserWindowIconPath } from '../src/main/window-icon.js';

describe('native BrowserWindow icon policy', () => {
  it('uses the packaged branded runtime PNG on Linux', () => {
    expect(browserWindowIconPath('linux', true, '/opt/chat/resources')).toBe(
      path.join('/opt/chat/resources', 'runtime-icon.png')
    );
  });

  it('uses the packaged goddess PNG explicitly for Windows taskbar/window identity', () => {
    expect(browserWindowIconPath('win32', true, 'C:\\Program Files\\ParadigmEve\\resources')).toBe(
      path.join('C:\\Program Files\\ParadigmEve\\resources', 'connector', 'icon.png')
    );
  });

  it('preserves native app-bundle icon semantics on macOS', () => {
    expect(browserWindowIconPath('darwin', true, '/irrelevant/resources')).toBeUndefined();
  });

  it.each(['linux', 'win32'] as const)('does not impose a packaged icon path on %s development runs', (platform) => {
    expect(browserWindowIconPath(platform, false, '/electron/resources')).toBeUndefined();
  });
});
