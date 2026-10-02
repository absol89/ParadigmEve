import fs from 'node:fs';
import path from 'node:path';

/**
 * The app language, as far as the main process needs to know it before the renderer exists.
 *
 * The renderer owns the choice (`cos.ui.language`). The startup splash is drawn before the renderer
 * loads and from a script-free document, so the renderer reports each change here and the main
 * process keeps one small file it can read synchronously at launch. It is a hint for the splash only:
 * a missing or unreadable file means English, and nothing else depends on it.
 */
export type UiLanguage = 'en' | 'sv-SE' | 'es-419';

const FILE_NAME = 'ui-language.txt';

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === 'sv-SE' || value === 'es-419' ? value : 'en';
}

export function readUiLanguage(userData: string): UiLanguage {
  try {
    return normalizeUiLanguage(fs.readFileSync(path.join(userData, FILE_NAME), 'utf8').trim());
  } catch {
    return 'en';
  }
}

export function writeUiLanguage(userData: string, language: UiLanguage): void {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, FILE_NAME), language, 'utf8');
  } catch {
    // The splash falls back to English; a read-only profile must never break changing language.
  }
}
