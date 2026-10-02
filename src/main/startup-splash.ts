import { GUIDE_COFFEE_ICON_DATA_URI } from './setup-guide-icon.js';
import { SPLASH_PORTRAIT_DATA_URI } from './startup-splash-portrait.js';
import svSE from '../renderer/locales/sv-SE.json';
import es419 from '../renderer/locales/es-419.json';
import type { UiLanguage } from './ui-language.js';

export type StartupSplashTheme = 'light' | 'dark';

const catalogs: Readonly<Record<Exclude<UiLanguage, 'en'>, Readonly<Record<string, string>>>> = { 'sv-SE': svSE, 'es-419': es419 };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** The greeting in the app language, from the same catalogs as the rest of the app. */
function splashText(language: UiLanguage): { title: string; subtitle: string } {
  const catalog = language === 'en' ? null : catalogs[language];
  const translate = (source: string): string => (catalog && Object.hasOwn(catalog, source) ? catalog[source]! : source);
  const warm = `<span class="warmth">${escapeHtml(translate('warm'))}</span>`;
  return {
    title: escapeHtml(translate('Welcome back')),
    subtitle: escapeHtml(translate('Keeping things {0} for you…')).replace('{0}', warm)
  };
}

/**
 * Static startup presentation for the short gap while the real renderer loads.
 *
 * Eve's approved portrait fills the left panel; the coffee cup, wordmark and greeting sit beside it.
 * This document has no script, preload bridge, remote asset, or state. Its two images are inlined
 * `data:` URIs, which is why the policy admits `img-src data:` and nothing else. The main process
 * owns its lifetime and destroys it as soon as the workspace is ready, so it can never become a
 * second UI authority. Keep the CSP here because data: documents do not receive the file renderer's
 * response headers.
 */
export function startupSplashDocument(theme: StartupSplashTheme, language: UiLanguage = 'en'): string {
  const dark = theme === 'dark';
  const text = splashText(language);
  const palette = dark
    ? {
        page: '#07111f',
        card: '#0b1b2f',
        ink: '#f7f2e8',
        soft: '#b9c3d1',
        line: 'rgba(202, 177, 112, .24)',
        glow: 'rgba(52, 105, 176, .28)',
        accent: '#c9ad70',
        accentSoft: '#8ca7ca',
        brand: '#c9d6e8',
        gold: '#e6c673',
        bar: 'rgba(201, 173, 112, .22)',
        fade: 'linear-gradient(90deg, rgba(7, 17, 31, 0) 55%, #07111f 100%)',
        shadow: 'rgba(0, 0, 0, .42)'
      }
    : {
        page: '#f4eadc',
        card: '#fffaf1',
        ink: '#332f2a',
        soft: '#766e64',
        line: 'rgba(153, 112, 72, .20)',
        glow: 'rgba(221, 172, 116, .24)',
        accent: '#a46f47',
        accentSoft: '#8d765e',
        brand: '#5b4631',
        gold: '#b9854f',
        bar: 'rgba(153, 112, 72, .22)',
        // The portrait is navy art; on the cream page it keeps a clean edge instead of a muddy fade.
        fade: 'none',
        shadow: 'rgba(88, 60, 34, .18)'
      };

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'">
  <meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
  <title>ParadigmEve</title>
  <style>
    :root {
      color-scheme: ${dark ? 'dark' : 'light'};
      --page: ${palette.page};
      --card: ${palette.card};
      --ink: ${palette.ink};
      --soft: ${palette.soft};
      --line: ${palette.line};
      --glow: ${palette.glow};
      --accent: ${palette.accent};
      --accent-soft: ${palette.accentSoft};
      --brand: ${palette.brand};
      --gold: ${palette.gold};
      --bar: ${palette.bar};
      --shadow: ${palette.shadow};
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      position: relative;
      display: grid;
      grid-template-columns: 270px minmax(0, 1fr);
      background: var(--page);
      color: var(--ink);
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      user-select: none;
    }
    body::after {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid var(--line);
      pointer-events: none;
    }
    .portrait {
      position: relative;
      overflow: hidden;
      background: #07111f;
    }
    .portrait img { display: block; width: 270px; height: 360px; object-fit: cover; }
    .portrait::after {
      content: "";
      position: absolute;
      inset: 0;
      background: ${palette.fade};
    }
    main {
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      padding: 0 28px 0 4px;
    }
    .brand { display: flex; align-items: center; gap: 10px; height: 34px; }
    .brand img { display: block; flex: none; width: 34px; height: 34px; }
    .brand span {
      color: var(--brand);
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -.01em;
      line-height: 34px;
      white-space: nowrap;
    }
    h1 {
      margin: 18px 0 0;
      font: 400 34px/1.1 Georgia, "Times New Roman", serif;
      letter-spacing: -.015em;
      white-space: nowrap;
    }
    p { margin: 10px 0 0; color: var(--soft); font-size: 13px; line-height: 1.5; }
    .warmth { color: var(--accent); }
    .bar {
      position: relative;
      width: 120px;
      height: 2px;
      margin-top: 26px;
      overflow: hidden;
      border-radius: 1px;
      background: var(--bar);
    }
    .bar i {
      position: absolute;
      left: 0;
      top: 0;
      width: 46px;
      height: 2px;
      border-radius: 1px;
      background: var(--gold);
      animation: slide 1.6s ease-in-out infinite alternate;
    }
    @keyframes slide { from { transform: translateX(0); } to { transform: translateX(74px); } }
    @media (prefers-reduced-motion: reduce) { .bar i { animation: none; } }
  </style>
</head>
<body>
  <div class="portrait" aria-hidden="true"><img src="${SPLASH_PORTRAIT_DATA_URI}" alt="" width="270" height="360"></div>
  <main aria-labelledby="welcome-title">
    <div class="brand">
      <img src="${GUIDE_COFFEE_ICON_DATA_URI}" alt="" width="34" height="34">
      <span>ParadigmEve</span>
    </div>
    <h1 id="welcome-title">${text.title}</h1>
    <p>${text.subtitle}</p>
    <div class="bar" aria-hidden="true"><i></i></div>
  </main>
</body>
</html>`;
}
