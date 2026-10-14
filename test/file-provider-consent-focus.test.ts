import { expect, it, vi } from 'vitest';
import { focusNativeProviderConsentWindow } from '../src/main/file-provider-consent.js';

it('restores and foregrounds minimized Eve before Windows native install consent', () => {
  const calls: string[] = [];
  const window = {
    isMinimized: () => true, restore: () => calls.push('restore'),
    isVisible: () => false, show: () => calls.push('show'),
    focus: () => calls.push('focus'), moveTop: () => calls.push('moveTop')
  };
  focusNativeProviderConsentWindow(window, 'win32');
  expect(calls).toEqual(['restore', 'show', 'focus', 'moveTop']);
});

it('does not alter other platforms or touch an absent window', () => {
  const focus = vi.fn();
  const window = { isMinimized: () => false, restore: vi.fn(), isVisible: () => true, show: vi.fn(), focus, moveTop: vi.fn() };
  focusNativeProviderConsentWindow(window, 'darwin');
  focusNativeProviderConsentWindow(null, 'win32');
  expect(focus).not.toHaveBeenCalled();
});
