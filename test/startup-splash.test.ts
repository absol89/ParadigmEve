import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startupSplashDocument } from '../src/main/startup-splash.js';
import { normalizeUiLanguage, readUiLanguage, writeUiLanguage } from '../src/main/ui-language.js';

describe('startup splash', () => {
  it.each(['light', 'dark'] as const)('is a scriptless local presentation in %s mode', (theme) => {
    const document = startupSplashDocument(theme);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("img-src data:");
    expect(document).not.toContain('<script');
    expect(document).not.toContain('http://');
    expect(document).not.toContain('https://');
    expect(document).toContain('Welcome back</h1>');
    expect(document).not.toContain('Welcome back.');
    expect(document).toContain('Keeping things');
  });

  it('shows Eve\'s portrait and the coffee cup beside the wordmark from inline images only', () => {
    const document = startupSplashDocument('dark');
    const sources = [...document.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map(match => match[1]!);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(sources[1]).toMatch(/^data:image\/png;base64,/);
    expect(document).toContain('class="portrait"');
    expect(document).toContain('<span>ParadigmEve</span>');
  });

  it('greets in the app language from the shared catalogs', () => {
    const english = startupSplashDocument('dark');
    expect(english).toContain('<html lang="en">');
    expect(english).toContain('<h1 id="welcome-title">Welcome back</h1>');
    expect(english).toContain('Keeping things <span class="warmth">warm</span> for you…');

    const swedish = startupSplashDocument('dark', 'sv-SE');
    expect(swedish).toContain('<html lang="sv-SE">');
    expect(swedish).toContain('<h1 id="welcome-title">Välkommen tillbaka</h1>');
    expect(swedish).toContain('Håller det <span class="warmth">varmt</span> åt dig…');
    expect(swedish).not.toContain('Welcome back');

    const spanish = startupSplashDocument('light', 'es-419');
    expect(spanish).toContain('<html lang="es-419">');
    expect(spanish).toContain('<h1 id="welcome-title">Bienvenido de nuevo</h1>');
    expect(spanish).toContain('Manteniendo todo <span class="warmth">cálido</span> para ti…');
    for (const document of [swedish, spanish]) {
      expect(document).not.toContain('<script');
      expect(document).toContain('<span>ParadigmEve</span>');
    }
  });

  it('remembers the app language in one small file and falls back to English', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'paradigmeve-ui-language-'));
    try {
      expect(readUiLanguage(folder)).toBe('en');
      writeUiLanguage(folder, 'es-419');
      expect(readUiLanguage(folder)).toBe('es-419');
      writeUiLanguage(folder, 'sv-SE');
      expect(readUiLanguage(folder)).toBe('sv-SE');
      fs.writeFileSync(path.join(folder, 'ui-language.txt'), 'klingon');
      expect(readUiLanguage(folder)).toBe('en');
      expect(readUiLanguage(path.join(folder, 'missing'))).toBe('en');
      expect(normalizeUiLanguage(42)).toBe('en');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('keeps light and dark startup atmospheres distinct', () => {
    expect(startupSplashDocument('light')).toContain('--page: #f4eadc');
    expect(startupSplashDocument('dark')).toContain('--page: #07111f');
    expect(startupSplashDocument('dark')).toContain('--accent: #c9ad70');
  });
});
