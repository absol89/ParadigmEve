export type StartupSplashTheme = 'light' | 'dark';

/**
 * Static startup presentation for the short gap while the real renderer loads.
 *
 * This document has no script, preload bridge, remote asset, or state. The main process owns its
 * lifetime and destroys it as soon as the workspace is ready, so it can never become a second UI
 * authority. Keep the CSP here because data: documents do not receive the file renderer's response
 * headers.
 */
export function startupSplashDocument(theme: StartupSplashTheme): string {
  const dark = theme === 'dark';
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
        shadow: 'rgba(88, 60, 34, .18)'
      };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'">
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
      --shadow: ${palette.shadow};
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      position: relative;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 18% 12%, var(--glow), transparent 42%),
        radial-gradient(circle at 88% 82%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 36%),
        var(--page);
      color: var(--ink);
      font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      user-select: none;
    }
    body::after {
      content: "";
      position: absolute;
      inset: 20px;
      border: 1px solid var(--line);
      border-radius: 30px;
      pointer-events: none;
    }
    main {
      position: relative;
      z-index: 1;
      display: grid;
      justify-items: center;
      width: calc(100% - 64px);
      min-height: 250px;
      padding: 34px 44px 30px;
      border: 1px solid var(--line);
      border-radius: 28px;
      background: color-mix(in srgb, var(--card) 91%, transparent);
      box-shadow: 0 24px 70px var(--shadow);
      text-align: center;
    }
    .mark {
      position: relative;
      display: grid;
      place-items: center;
      width: 78px;
      height: 78px;
      margin-bottom: 20px;
      border: 1px solid var(--line);
      border-radius: 50%;
      background: radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 67%);
      color: var(--accent);
      box-shadow: 0 0 44px color-mix(in srgb, var(--accent) 14%, transparent);
      animation: breathe 2.4s ease-in-out infinite alternate;
    }
    .mark::before,
    .mark::after {
      content: "";
      position: absolute;
      border: 1px solid color-mix(in srgb, var(--accent) 44%, transparent);
      border-radius: 50%;
    }
    .mark::before { inset: 8px; opacity: .55; }
    .mark::after { inset: 17px; opacity: .32; }
    svg { width: 42px; height: 42px; fill: none; stroke: currentColor; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; }
    .coffee-steam { opacity: .72; }
    .coffee-surface {
      fill: color-mix(in srgb, var(--accent) 34%, var(--card));
      stroke: currentColor;
      stroke-width: 1.05;
    }
    .brand {
      margin: 0 0 8px;
      color: var(--accent-soft);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: .22em;
    }
    h1 { margin: 0; font-size: 27px; font-weight: 600; letter-spacing: -.025em; }
    p { margin: 9px 0 0; color: var(--soft); font-size: 13px; line-height: 1.55; }
    .warmth { color: var(--accent); }
    @keyframes breathe {
      from { transform: translateY(0) scale(.985); box-shadow: 0 0 34px color-mix(in srgb, var(--accent) 11%, transparent); }
      to { transform: translateY(-2px) scale(1); box-shadow: 0 0 52px color-mix(in srgb, var(--accent) 18%, transparent); }
    }
    @media (prefers-reduced-motion: reduce) { .mark { animation: none; } }
  </style>
</head>
<body>
  <main aria-labelledby="welcome-title">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path class="coffee-steam" d="M8.2 6.2c-1-1-.5-2 .3-2.8M12 6.2c-1-1-.5-2 .3-2.8"></path>
        <path class="coffee-cup" d="M5 8.5h11v5.2a5.3 5.3 0 0 1-5.3 5.3h-.4A5.3 5.3 0 0 1 5 13.7Z"></path>
        <path class="coffee-handle" d="M16 10h1.4a2.6 2.6 0 0 1 0 5.2H16"></path>
        <ellipse class="coffee-surface" cx="10.5" cy="10.6" rx="4.2" ry="1.25"></ellipse>
      </svg>
    </div>
    <div class="brand">ParadigmEve</div>
    <h1 id="welcome-title">Welcome back.</h1>
    <p>Keeping things <span class="warmth">warm</span> for you…</p>
  </main>
</body>
</html>`;
}
