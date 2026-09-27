import { beforeEach, expect, it } from 'vitest';
import {
  claimNativeNotification,
  resetNativeNotificationDedupeForTests
} from '../src/main/native-notification-dedupe.js';

beforeEach(() => resetNativeNotificationDedupeForTests());

it('shows one native notification for one exact delivery key', () => {
  expect(claimNativeNotification('finish:session:turn')).toBe(true);
  expect(claimNativeNotification('finish:session:turn')).toBe(false);
});

it('does not merge distinct turns or request states', () => {
  expect(claimNativeNotification('finish:session:turn-a')).toBe(true);
  expect(claimNativeNotification('finish:session:turn-b')).toBe(true);
  expect(claimNativeNotification('request:progress:request-a:working')).toBe(true);
  expect(claimNativeNotification('request:progress:request-a:done')).toBe(true);
});

it('keeps the process-local dedupe set bounded', () => {
  for (let index = 0; index < 513; index++) {
    expect(claimNativeNotification(`notice:${index}`)).toBe(true);
  }
  expect(claimNativeNotification('notice:0')).toBe(true);
  expect(claimNativeNotification('notice:512')).toBe(false);
});
