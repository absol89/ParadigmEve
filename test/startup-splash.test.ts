import { describe, expect, it } from 'vitest';
import { startupSplashDocument } from '../src/main/startup-splash.js';

describe('startup splash', () => {
  it.each(['light', 'dark'] as const)('is a scriptless local presentation in %s mode', (theme) => {
    const document = startupSplashDocument(theme);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).not.toContain('<script');
    expect(document).not.toContain('http://');
    expect(document).not.toContain('https://');
    expect(document).toContain('Welcome back.');
    expect(document).toContain('Keeping things');
  });

  it('keeps light and dark startup atmospheres distinct', () => {
    expect(startupSplashDocument('light')).toContain('--page: #f4eadc');
    expect(startupSplashDocument('dark')).toContain('--page: #07111f');
    expect(startupSplashDocument('dark')).toContain('--accent: #c9ad70');
  });
});
