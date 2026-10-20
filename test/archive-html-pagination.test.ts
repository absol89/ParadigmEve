import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderLazyArchiveHtml } from '../src/main/archive/archive-html.js';

const generation = `g-${'a'.repeat(32)}`;
const firstChunk = `data/${generation}/chat-0-segment-0.js`;

function openArchive(
  partCount: number,
  options: { hash?: string; language?: string; providerConversationId?: string } = {}
): { dom: JSDOM; scrolls: [number, number][] } {
  const scrolls: [number, number][] = [];
  const html = renderLazyArchiveHtml({
    archiveTitle: 'Offline archive',
    searchPath: `data/${generation}/search.js`,
    chats: [{
      id: 'conversation',
      title: 'Long conversation',
      ...(options.providerConversationId ? { providerConversationId: options.providerConversationId } : {}),
      chunkPath: firstChunk,
      segmentCount: partCount
    }]
  });
  const dom = new JSDOM(html, {
    url: 'file:///C:/ParadigmEve/archive/site/index.html' + (options.hash || ''),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no scrollTo implementation; observe the runtime request itself.
      Object.defineProperty(window, 'scrollTo', {
        configurable: true,
        value: (x: number, y: number) => { scrolls.push([x, y]); }
      });
      if (options.language) {
        Object.defineProperty(window.navigator, 'languages', { configurable: true, value: [options.language] });
        Object.defineProperty(window.navigator, 'language', { configurable: true, value: options.language });
      }
    }
  });
  Object.defineProperty(dom.window.document.documentElement, 'scrollHeight', { configurable: true, value: 19_000 });
  return { dom, scrolls };
}

function requestedSegment(dom: JSDOM): string[] {
  return [...dom.window.document.querySelectorAll<HTMLScriptElement>('[data-archive-chunk-loader]')]
    .map(script => script.getAttribute('data-archive-chunk-loader') || '');
}

function segmentArrives(dom: JSDOM, token: string, index: number, html: string): void {
  (dom.window as unknown as {
    __EVE_ARCHIVE_SEGMENT__: (token: string, index: number, html: string) => void;
  }).__EVE_ARCHIVE_SEGMENT__(token, index, html);
}

describe('generated Archive Browser pagination runtime', () => {
  it('opens a 57-part chat at part 57 and its bottom, with a visible sticky four-button pager', () => {
    const { dom, scrolls } = openArchive(57);
    try {
      const host = dom.window.document.querySelector<HTMLElement>('[data-chat-host]')!;
      const nav = host.querySelector<HTMLElement>('[data-chat-segment-nav]')!;
      const first = host.querySelector<HTMLButtonElement>('[data-chat-segment-first]')!;
      const previous = host.querySelector<HTMLButtonElement>('[data-chat-segment-prev]')!;
      const next = host.querySelector<HTMLButtonElement>('[data-chat-segment-next]')!;
      const last = host.querySelector<HTMLButtonElement>('[data-chat-segment-last]')!;
      const status = host.querySelector<HTMLElement>('[data-chat-segment-status]')!;

      expect(nav.hidden).toBe(false);
      expect(dom.window.getComputedStyle(nav).position).toBe('sticky');
      expect(nav.getAttribute('aria-label')).toBe('Archived chat parts');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect([first, previous, next, last].map(button => button.textContent)).toEqual(['First', 'Previous', 'Next', 'Last']);
      expect([first, previous, next, last].every(button => button.type === 'button')).toBe(true);
      expect([first.disabled, previous.disabled, next.disabled, last.disabled]).toEqual([false, false, true, true]);
      expect(status.textContent).toBe('Part 57 of 57');
      expect(requestedSegment(dom)).toEqual(['chat-0:56']);
      expect(host.textContent).toContain('Loading archived chat');

      // No 56-segment eager loop; only the last local segment is fetched.
      segmentArrives(dom, 'chat-0', 56, '<article class="message">Newest message</article>');
      expect(host.textContent).toContain('Newest message');
      expect(scrolls).toEqual([[0, 19_000]]);
      dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
      expect(requestedSegment(dom)).toEqual(['chat-0:56']);

      first.click();
      expect(requestedSegment(dom)).toEqual(['chat-0:0']);
      expect(status.textContent).toBe('Part 1 of 57');
      expect([first.disabled, previous.disabled, next.disabled, last.disabled]).toEqual([true, true, false, false]);
      expect(host.textContent).not.toContain('Newest message');
      segmentArrives(dom, 'chat-0', 0, '<article class="message">Oldest message</article>');
      expect(host.textContent).toContain('Oldest message');
      expect(scrolls.at(-1)).toEqual([0, 0]);
      first.click(); // Disabled boundary and same selected segment never schedule another fetch.
      expect(requestedSegment(dom)).toEqual(['chat-0:0']);

      last.click();
      expect(requestedSegment(dom)).toEqual(['chat-0:56']);
      expect(status.textContent).toBe('Part 57 of 57');
      segmentArrives(dom, 'chat-0', 0, '<article>Stale first-part response</article>');
      expect(host.textContent).not.toContain('Stale first-part response');
      segmentArrives(dom, 'chat-0', 56, '<article class="message">Newest message again</article>');
      expect(scrolls.at(-1)).toEqual([0, 19_000]); // Last and initial open share the same behavior.

      previous.click();
      expect(status.textContent).toBe('Part 56 of 57');
      expect(requestedSegment(dom)).toEqual(['chat-0:55']);
      segmentArrives(dom, 'chat-0', 55, '<article>Part 56</article>');
      expect(scrolls.at(-1)).toEqual([0, 0]);
      next.click();
      expect(status.textContent).toBe('Part 57 of 57');
      expect(requestedSegment(dom)).toEqual(['chat-0:56']);
    } finally {
      dom.window.close();
    }
  });

  it('preserves a legacy chat bookmark while switching parts and localizes controls in Swedish', () => {
    const { dom, scrolls } = openArchive(3, {
      hash: '#chat-0',
      language: 'sv-SE',
      providerConversationId: 'provider-123'
    });
    try {
      const host = dom.window.document.querySelector<HTMLElement>('[data-chat-host]')!;
      const nav = host.querySelector<HTMLElement>('[data-chat-segment-nav]')!;
      expect(host.querySelector('[data-chat-panel]')?.id).toBe('chat-0/c/provider-123');
      expect(nav.getAttribute('aria-label')).toBe('Arkiverade chattdelar');
      expect([...nav.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Första', 'Föregående', 'Nästa', 'Sista']);
      expect(nav.querySelector('[data-chat-segment-status]')?.textContent).toBe('Del 3 av 3');
      expect(requestedSegment(dom)).toEqual(['chat-0/c/provider-123:2']);

      segmentArrives(dom, 'chat-0/c/provider-123', 2, '<article>Last part</article>');
      expect(scrolls.at(-1)).toEqual([0, 19_000]);
      nav.querySelector<HTMLButtonElement>('[data-chat-segment-first]')!.click();
      expect(requestedSegment(dom)).toEqual(['chat-0/c/provider-123:0']);
      expect(dom.window.location.hash).toBe('#chat-0');
      segmentArrives(dom, 'chat-0/c/provider-123', 0, '<article>First part</article>');
      expect(scrolls.at(-1)).toEqual([0, 0]);
      nav.querySelector<HTMLButtonElement>('[data-chat-segment-last]')!.click();
      expect(dom.window.location.hash).toBe('#chat-0');
    } finally {
      dom.window.close();
    }
  });

  it('keeps the pager hidden for a single-part chat and loads that single local segment', () => {
    const { dom } = openArchive(1);
    try {
      expect(dom.window.document.querySelector<HTMLElement>('[data-chat-segment-nav]')?.hidden).toBe(true);
      expect(requestedSegment(dom)).toEqual(['chat-0:0']);
      expect(dom.window.document.querySelector('[data-chat-segment-status]')?.textContent).toBe('Part 1 of 1');
    } finally {
      dom.window.close();
    }
  });
});
