import type { ChatBrowser } from './types.js';

export interface ChatBrowserFamily {
  id: ChatBrowser;
  /** Product-facing family name. Chromium intentionally shares the Chrome choice. */
  label: string;
  /** Native Chromium-family management page used to load the unpacked Companion. */
  extensionsUrl: string;
}

const CHAT_BROWSER_FAMILIES: Readonly<Record<ChatBrowser, ChatBrowserFamily>> = {
  chrome: { id: 'chrome', label: 'Google Chrome / Chromium', extensionsUrl: 'chrome://extensions/' },
  edge: { id: 'edge', label: 'Microsoft Edge', extensionsUrl: 'edge://extensions/' },
  brave: { id: 'brave', label: 'Brave Browser', extensionsUrl: 'brave://extensions/' },
};

/** Chrome stays the compatibility/default family for omitted legacy preferences. */
export function chatBrowserFamily(browser: ChatBrowser | null | undefined): ChatBrowserFamily {
  return CHAT_BROWSER_FAMILIES[browser ?? 'chrome'];
}

export function chatBrowserForExtensionsUrl(url: string): ChatBrowser | null {
  for (const browser of Object.keys(CHAT_BROWSER_FAMILIES) as ChatBrowser[]) {
    if (CHAT_BROWSER_FAMILIES[browser].extensionsUrl === url) return browser;
  }
  return null;
}
