import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;

beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<!doctype html><html><body><div id="archiveLibraryHost"></div></body></html>', { url: 'https://eve.local/' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement
  });
});

afterEach(() => dom.window.close());

it('renders honest local status and wires rebuild/open through the narrow archive API only', async () => {
  const status = {
    initialized: true,
    disposed: false,
    queuedSessions: 2,
    reconcilingSessions: 1,
    lastReconciledAt: Date.now() - 1_000,
    lastDerivedAt: Date.now() - 2_000,
    lastError: null,
    indexedDocuments: 14
  };
  const archiveStatus = vi.fn(async () => ({ ok: true as const, data: status }));
  const archiveRebuild = vi.fn(async () => ({ ok: true as const, data: { chats: 7, indexedDocuments: 21 } }));
  const archiveOpenStatic = vi.fn(async () => ({ ok: true as const, data: { ok: true } }));
  Object.defineProperty(dom.window, 'api', { configurable: true, value: { archiveStatus, archiveRebuild, archiveOpenStatic } });

  const surface = await import('../src/renderer/archive-surface.js');
  surface.initArchiveSurface();
  await surface.refreshArchiveSurface();

  expect(dom.window.document.getElementById('archiveSummary')?.textContent).toBe('Archive is catching up.');
  expect(dom.window.document.getElementById('archiveMetrics')?.textContent).toContain('14');
  expect(dom.window.document.querySelector('iframe, input[type="file"], input[type="text"]')).toBeNull();

  dom.window.document.getElementById('archiveRebuild')!.click();
  await vi.waitFor(() => expect(archiveRebuild).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(archiveStatus).toHaveBeenCalledTimes(2));
  expect(dom.window.document.getElementById('archiveActionStatus')?.textContent).toContain('7 chats');

  dom.window.document.getElementById('archiveOpenStatic')!.click();
  await vi.waitFor(() => expect(archiveOpenStatic).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(dom.window.document.getElementById('archiveActionStatus')?.textContent).toBe('Archive browser opened.'));
});

it('shows runtime and open failures without inventing local-file authority', async () => {
  Object.defineProperty(dom.window, 'api', {
    configurable: true,
    value: {
      archiveStatus: async () => ({ ok: true as const, data: {
        initialized: true, disposed: false, queuedSessions: 0, reconcilingSessions: 0,
        lastReconciledAt: null, lastDerivedAt: null,
        lastError: 'integrity scan failed', indexedDocuments: null
      } }),
      archiveRebuild: async () => ({ ok: false as const, error: 'rebuild failed' }),
      archiveOpenStatic: async () => ({ ok: true as const, data: { ok: false, error: 'site missing' } })
    }
  });
  const surface = await import('../src/renderer/archive-surface.js');
  surface.initArchiveSurface();
  await surface.refreshArchiveSurface();
  expect(dom.window.document.getElementById('archiveSummary')?.textContent).toBe('Archive needs attention.');
  expect(dom.window.document.getElementById('archiveError')?.textContent).toContain('integrity scan failed');

  dom.window.document.getElementById('archiveOpenStatic')!.click();
  await vi.waitFor(() => expect(dom.window.document.getElementById('archiveActionStatus')?.textContent).toContain('site missing'));
});

it('localizes Archive chrome in Swedish without translating runtime evidence', async () => {
  dom.window.localStorage.setItem('cos.ui.language', 'sv-SE');
  Object.defineProperty(dom.window, 'api', {
    configurable: true,
    value: {
      archiveStatus: async () => ({ ok: true as const, data: {
        initialized: true, disposed: false, queuedSessions: 0, reconcilingSessions: 0,
        lastReconciledAt: null, lastDerivedAt: null,
        lastError: 'EXACT_RUNTIME_ERROR', indexedDocuments: 1
      } }),
      archiveRebuild: async () => ({ ok: false as const, error: 'unused' }),
      archiveOpenStatic: async () => ({ ok: true as const, data: { ok: true } })
    }
  });
  const surface = await import('../src/renderer/archive-surface.js');
  surface.initArchiveSurface();
  await surface.refreshArchiveSurface();
  expect(dom.window.document.querySelector('.archive-heading h1')?.textContent).toBe('Arkiv');
  expect(dom.window.document.getElementById('archiveRebuild')?.textContent).toBe('Bygg om arkivet');
  expect(dom.window.document.getElementById('archiveError')?.textContent).toContain('EXACT_RUNTIME_ERROR');
});
