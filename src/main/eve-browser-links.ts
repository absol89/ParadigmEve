import { shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { safeExternalLink } from '../shared/external-link.js';
import { openParadigmEveChromeProfile } from './setup-assistant.js';

/** Web navigation from Eve belongs to the user's deliberately signed-in Eve Browser profile.
 * Never send a web URL to the OS default browser as a fallback: it may hold an unrelated
 * person's cookies, accounts and passwords. Mailto is a separate, explicitly clicked
 * mail-app action; it does not grant permission to browse a personal profile.
 */
export async function openEveWebLink(url: string): Promise<void> {
  if (!safeExternalLink(url)) throw new Error('That link is not allowed');
  if (new URL(url).protocol === 'mailto:') {
    await shell.openExternal(url);
    return;
  }
  await openParadigmEveChromeProfile(url);
}

/** Call only with a previously verified app-owned file or validated local Thread file. */
export async function openEveBrowserFile(path: string): Promise<void> {
  await openParadigmEveChromeProfile(pathToFileURL(path).href);
}
