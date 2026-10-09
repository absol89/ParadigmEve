import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderArchiveHtml, renderLazyArchiveHtml } from '../src/main/archive/archive-html.js';
import type { ArchiveHtmlViewModel } from '../src/main/archive/archive-view-model.js';

function fixture(): ArchiveHtmlViewModel {
  return {
    archiveTitle: 'My local archive',
    generatedAtLabel: 'Generated offline',
    selectedChatId: 'session-b',
    chats: [
      {
        id: 'session-a',
        title: 'First chat',
        subtitle: 'Project Alpha',
        providerConversationId: '6a000003-0000-83ed-8000-000000000003',
        updatedAt: 100,
        captureState: 'partial',
        transcript: [
          {
            kind: 'message',
            id: 'message-a',
            role: 'user',
            text: '<img src="https://evil.example/x" onerror="alert(1)"><script>globalThis.pwned=true</script>',
            assets: [
              {
                kind: 'image',
                label: 'diagram <final>.png',
                captureState: 'retained',
                localPath: 'assets/sha256/ab/diagram final.png',
                mimeType: 'image/png',
                byteLength: 2048,
                width: 800,
                height: 600
              },
              {
                kind: 'file',
                label: 'provider.pdf',
                captureState: 'provider-only',
                mimeType: 'application/pdf'
              }
            ]
          },
          {
            kind: 'tool-group',
            id: 'tools-a',
            label: '2 tool calls',
            summary: 'Local evidence',
            calls: [
              { name: 'read', argumentsText: '{"path":"<secret>"}', resultText: '<b>not markup</b>', status: 'completed' },
              { name: 'image', assets: [{ kind: 'image', label: 'Missing pixels', captureState: 'missing', detail: 'Blob hash exists but bytes are gone.' }] }
            ]
          },
          { kind: 'continuation', id: 'continue-a', label: 'Continued in next chat', targetChatId: 'session-b' }
        ]
      },
      {
        id: 'session-b',
        title: 'Second chat',
        subtitle: 'After Compact & Resume',
        updatedAt: 200,
        metadata: [
          { label: 'Model', value: 'Local model' },
          { label: 'Provider', value: '<provider>' }
        ],
        transcript: [
          {
            kind: 'message', id: 'message-b', role: 'assistant', text: 'Offline answer', assets: [
              { kind: 'file', label: 'report final.pdf', captureState: 'retained', localPath: 'assets/files/report final.pdf', mimeType: 'application/pdf', byteLength: 4096 }
            ]
          },
          { kind: 'notice', id: 'notice-b', tone: 'missing', title: 'Attachment unavailable', text: 'Historical bytes were never captured.' },
          { kind: 'continuation', id: 'continue-missing', label: 'Earlier branch', targetChatId: 'not-exported' }
        ]
      }
    ]
  };
}

describe('static archive HTML', () => {
  it('renders inert authored content and never turns hostile chat HTML into executable markup', () => {
    const html = renderArchiveHtml(fixture());
    const dom = new JSDOM(html);

    expect(dom.window.document.querySelectorAll('script')).toHaveLength(1);
    expect(dom.window.document.querySelector('script[src], link[rel="stylesheet"], iframe, object, embed')).toBeNull();
    expect(dom.window.document.querySelector('.message-text')?.textContent).toContain('<img src="https://evil.example/x" onerror="alert(1)">');
    expect(dom.window.document.querySelector('.message-text img, .message-text script')).toBeNull();
    expect(dom.window.document.querySelector('.tool-call pre')?.textContent).toContain('<secret>');
    expect(dom.window.document.querySelector('.tool-call b')).toBeNull();
    expect(dom.window.document.querySelector('.chat-metadata')?.textContent).toContain('<provider>');
    dom.window.close();
  });

  it('contains no network resource dependency and uses no fetch/XHR/module loading', () => {
    const html = renderArchiveHtml(fixture());
    const dom = new JSDOM(html);
    const resourceUrls = [...dom.window.document.querySelectorAll('[src], [href]')]
      .map(node => node.getAttribute('src') ?? node.getAttribute('href') ?? '');

    expect(resourceUrls.filter(url => /^(?:https?:)?\/\//iu.test(url))).toEqual([]);
    expect(dom.window.document.querySelectorAll('script[src], link[href]')).toHaveLength(0);
    expect(html).not.toMatch(/\bfetch\s*\(/u);
    expect(html).not.toMatch(/\bXMLHttpRequest\b/u);
    expect(html).not.toMatch(/<script[^>]+type=["']module["']/iu);
    expect(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("connect-src 'none'");
    dom.window.close();
  });

  it('keeps the chat-link display rule from overriding hidden so search filtering removes entries', () => {
    const html = renderArchiveHtml(fixture());
    expect(html).toMatch(/\.chat-link\[hidden\]\{display:none\}/u);
    expect(html.indexOf('.chat-link[hidden]')).toBeGreaterThan(html.indexOf('.chat-link{display:block'));
  });

  it('navigates chats and retained local assets directly from a file URL with back/forward-friendly hashes', async () => {
    const dom = new JSDOM(renderArchiveHtml(fixture()), {
      url: 'file:///C:/ParadigmEve/archive/site/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));

    const panels = [...dom.window.document.querySelectorAll<HTMLElement>('[data-chat-panel]')];
    expect(panels.map(panel => panel.hidden)).toEqual([true, false]);
    const firstLink = dom.window.document.querySelector<HTMLAnchorElement>('.chat-link[href="#chat-0/c/6a000003-0000-83ed-8000-000000000003"]')!;
    const changed = new Promise<void>(resolve => {
      dom.window.addEventListener('hashchange', () => resolve(), { once: true });
    });
    firstLink.click();
    await changed;
    expect(dom.window.location.hash).toBe('#chat-0/c/6a000003-0000-83ed-8000-000000000003');
    expect(panels.map(panel => panel.hidden)).toEqual([false, true]);

    const image = dom.window.document.querySelector<HTMLImageElement>('img[alt="diagram <final>.png"]')!;
    const imageLink = image.closest('a') as HTMLAnchorElement;
    expect(image.getAttribute('src')).toBe('assets/sha256/ab/diagram%20final.png');
    expect(image.src).toBe('file:///C:/ParadigmEve/archive/site/assets/sha256/ab/diagram%20final.png');
    expect(imageLink.href).toBe(image.src);
    const fileLink = dom.window.document.querySelector<HTMLAnchorElement>('a.asset-open[href="assets/files/report%20final.pdf"]')!;
    expect(fileLink.textContent).toBe('Open local file');
    expect(fileLink.href).toBe('file:///C:/ParadigmEve/archive/site/assets/files/report%20final.pdf');
    expect(dom.window.document.querySelector<HTMLAnchorElement>('.continuation-card a')?.getAttribute('href')).toBe('#chat-1');
    dom.window.close();
  });

  it('keeps the sortable chat number first and appends the original provider /c/ slug while accepting legacy numbered hashes', async () => {
    const dom = new JSDOM(renderArchiveHtml(fixture()), {
      url: 'file:///C:/ParadigmEve/archive/site/index.html#chat-0',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    const first = dom.window.document.querySelector<HTMLAnchorElement>('.chat-link[href="#chat-0/c/6a000003-0000-83ed-8000-000000000003"]')!;
    expect(first.getAttribute('href')).toBe('#chat-0/c/6a000003-0000-83ed-8000-000000000003');
    expect(dom.window.document.querySelector<HTMLElement>('[data-chat-panel="chat-0/c/6a000003-0000-83ed-8000-000000000003"]')?.hidden).toBe(false);
    dom.window.close();
  });

  it('toggles the archived chat list between newer-first and older-first without disturbing selection or search', async () => {
    const dom = new JSDOM(renderArchiveHtml(fixture()), {
      url: 'file:///C:/ParadigmEve/archive/site/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));

    const titles = () => [...dom.window.document.querySelectorAll('.chat-list .chat-link-title')]
      .map(node => node.textContent);
    const sort = dom.window.document.querySelector<HTMLButtonElement>('[data-chat-sort]')!;
    expect(sort.parentElement?.classList.contains('brand-row')).toBe(true);
    expect(sort.parentElement?.querySelector('strong')?.textContent).toBe('My local archive');
    expect(sort.closest('.brand')?.querySelector('.chat-generated')?.textContent).toBe('Generated offline');
    const selected = dom.window.document.querySelector<HTMLAnchorElement>('.chat-link[aria-current="page"]')!;
    expect(titles()).toEqual(['Second chat', 'First chat']);
    expect(sort.textContent).toBe('Newer first');
    expect(selected.textContent).toContain('Second chat');

    sort.click();
    expect(titles()).toEqual(['First chat', 'Second chat']);
    expect(sort.textContent).toBe('Older first');
    expect(dom.window.document.querySelector('.chat-link[aria-current="page"]')?.textContent).toContain('Second chat');
    expect(dom.window.document.querySelector<HTMLElement>('[data-chat-panel="chat-1"]')?.hidden).toBe(false);

    const search = dom.window.document.querySelector<HTMLInputElement>('[data-chat-search]')!;
    search.value = 'Second';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.chat-link')];
    expect(links.find(link => link.textContent?.includes('First chat'))?.hidden).toBe(true);
    expect(links.find(link => link.textContent?.includes('Second chat'))?.hidden).toBe(false);

    sort.click();
    expect(titles()).toEqual(['Second chat', 'First chat']);
    expect(sort.textContent).toBe('Newer first');
    expect(links.find(link => link.textContent?.includes('First chat'))?.hidden).toBe(true);
    dom.window.close();
  });

  it('uses the requested Swedish chronology labels when the static browser language is Swedish', async () => {
    const dom = new JSDOM(renderArchiveHtml(fixture()), {
      url: 'file:///C:/ParadigmEve/archive/site/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['sv-SE', 'sv'] });
        Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'sv-SE' });
      }
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));

    const sort = dom.window.document.querySelector<HTMLButtonElement>('[data-chat-sort]')!;
    expect(sort.textContent).toBe('Nyare först');
    sort.click();
    expect(sort.textContent).toBe('Äldre först');
    dom.window.close();
  });

  it('keeps tool groups collapsed by default and renders explicit partial/missing capture states', () => {
    const dom = new JSDOM(renderArchiveHtml(fixture()));
    const group = dom.window.document.querySelector<HTMLDetailsElement>('details.tool-group')!;
    expect(group.open).toBe(false);
    expect(group.querySelectorAll('.tool-call')).toHaveLength(2);
    expect(dom.window.document.querySelector('[data-capture-state="partial"]')?.textContent).toContain('partially captured');
    expect(dom.window.document.querySelector('[data-asset-state="provider-only"]')?.textContent).toContain('not captured locally');
    expect(dom.window.document.querySelector('[data-asset-state="missing"]')?.textContent).toContain('Blob hash exists but bytes are gone.');
    expect(dom.window.document.body.textContent).toContain('Linked chat is not present in this generated archive view.');
    dom.window.close();
  });

  it('rejects unsafe local paths instead of emitting traversal, absolute, or provider links', () => {
    const unsafe: ArchiveHtmlViewModel = {
      chats: [{
        id: 'unsafe',
        title: 'Unsafe paths',
        transcript: [{
          kind: 'message', id: 'm', role: 'assistant', text: 'Assets', assets: [
            { kind: 'image', label: 'traversal', captureState: 'retained', localPath: '../outside.png' },
            { kind: 'file', label: 'provider url', captureState: 'retained', localPath: 'https://evil.example/a.pdf' },
            { kind: 'file', label: 'drive path', captureState: 'retained', localPath: 'C:/secret.txt' },
            { kind: 'image', label: 'UNC path', captureState: 'retained', localPath: '\\\\server\\share\\x.png' }
          ]
        }]
      }]
    };
    const dom = new JSDOM(renderArchiveHtml(unsafe));
    expect(dom.window.document.querySelectorAll('.asset-card')).toHaveLength(4);
    expect(dom.window.document.querySelectorAll('.asset-card a, .asset-card img')).toHaveLength(0);
    expect([...dom.window.document.querySelectorAll('.asset-card')].every(card => card.textContent?.includes('no safe archive-relative asset path'))).toBe(true);
    dom.window.close();
  });

  it('fails duplicate chat identity closed and renders an explicit empty archive state', () => {
    expect(() => renderArchiveHtml({ chats: [
      { id: 'same', title: 'A', transcript: [] },
      { id: 'same', title: 'B', transcript: [] }
    ] })).toThrow('Archive chat ids must be unique');

    const dom = new JSDOM(renderArchiveHtml({ chats: [] }));
    expect(dom.window.document.body.textContent).toContain('No archived chats are available');
    dom.window.close();
  });

  it('says when the archive is updating and moves to a newer generation the app published', async () => {
    const generation = `g-${'a'.repeat(32)}`;
    const newer = `g-${'b'.repeat(32)}`;
    const html = renderLazyArchiveHtml({
      searchPath: `data/${generation}/search.js`,
      chats: [{ id: 'only', title: 'Only chat', chunkPath: `data/${generation}/chat-0-segment-0.js`, segmentCount: 1 }]
    });
    const dom = new JSDOM(html, { url: 'file:///C:/ParadigmEve/archive/site/index.html', runScripts: 'dangerously', pretendToBeVisual: true });
    const window = dom.window as unknown as Window & Record<string, any>;
    // It asks the published status script, a local file, never the network.
    expect([...window.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src'))).toContain('status.js?1');
    const banner = window.document.querySelector<HTMLElement>('.archive-status')!;
    expect(banner.hidden).toBe(true);
    window.__EVE_ARCHIVE_STATUS__({ generation, updating: true });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('Updating the archive with your newest chats');
    window.__EVE_ARCHIVE_STATUS__({ generation, updating: false });
    expect(banner.hidden).toBe(true);
    // Once the reader is using the page, a newer generation is offered rather than forced.
    window.dispatchEvent(new window.Event('pointerdown'));
    window.__EVE_ARCHIVE_STATUS__({ generation: newer, updating: false });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('Newer chats are ready.');
    expect(banner.querySelector('button')?.textContent).toBe('Reload');
    window.close();
  });

  it('lazy-loads only the selected local chat and searches transcript-only authored text without retaining previous DOM', async () => {
    const generation = `g-${'a'.repeat(32)}`;
    const html = renderLazyArchiveHtml({
      archiveTitle: 'My local archive',
      generatedAtLabel: 'Generated offline',
      searchPath: `data/${generation}/search.js`,
      chats: [
        { id: 'session-a', title: 'First chat', subtitle: 'Project Alpha', updatedAt: 100, chunkPath: `data/${generation}/chat-0-segment-0.js`, segmentCount: 2 },
        { id: 'session-b', title: 'Second chat', subtitle: 'Project Beta', updatedAt: 200, chunkPath: `data/${generation}/chat-1-segment-0.js`, segmentCount: 1 }
      ]
    });
    const dom = new JSDOM(html, {
      url: 'file:///C:/ParadigmEve/archive/site/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as Record<string, unknown>).__EVE_ARCHIVE_SEARCH__ = {
          'chat-0': ['a phrase found only inside the first user message'],
          'chat-1': ['second transcript words']
        };
      }
    });
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    const runtime = dom.window as unknown as {
      __EVE_ARCHIVE_SEGMENT__: (token: string, index: number, html: string) => void;
    };
    runtime.__EVE_ARCHIVE_SEGMENT__('chat-0', 0, '<article class="message"><div class="message-text">first loaded transcript</div></article>');

    const host = dom.window.document.querySelector<HTMLElement>('[data-chat-host]')!;
    expect(host.textContent).toContain('first loaded transcript');
    expect(host.querySelectorAll('[data-chat-panel]')).toHaveLength(1);
    expect(host.querySelector('[data-chat-segment-status]')?.textContent).toBe('Part 1 of 2');
    const next = host.querySelector<HTMLButtonElement>('[data-chat-segment-next]')!;
    next.click();
    expect(host.textContent).not.toContain('first loaded transcript');
    expect(host.textContent).toContain('Loading archived chat');
    runtime.__EVE_ARCHIVE_SEGMENT__('chat-0', 1, '<article class="tool-group"><pre>second heavy segment only</pre></article>');
    expect(host.textContent).toContain('second heavy segment only');
    expect(host.textContent).not.toContain('first loaded transcript');
    expect(host.querySelector('[data-chat-segment-status]')?.textContent).toBe('Part 2 of 2');
    expect(host.querySelector<HTMLButtonElement>('[data-chat-segment-next]')?.disabled).toBe(true);
    const sort = dom.window.document.querySelector<HTMLButtonElement>('[data-chat-sort]')!;
    expect(sort.parentElement?.classList.contains('brand-row')).toBe(true);
    expect(sort.parentElement?.querySelector('strong')?.textContent).toBe('My local archive');

    const search = dom.window.document.querySelector<HTMLInputElement>('[data-chat-search]')!;
    search.value = 'phrase found only inside';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.chat-link')];
    expect(links.find(link => link.textContent?.includes('First chat'))?.hidden).toBe(false);
    expect(links.find(link => link.textContent?.includes('Second chat'))?.hidden).toBe(true);
    search.value = 'Project Beta';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(links.find(link => link.textContent?.includes('First chat'))?.hidden).toBe(true);
    expect(links.find(link => link.textContent?.includes('Second chat'))?.hidden).toBe(false);

    dom.window.location.hash = '#chat-1';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    runtime.__EVE_ARCHIVE_SEGMENT__('chat-1', 0, '<article class="message"><div class="message-text">second loaded transcript</div></article>');
    expect(host.textContent).toContain('second loaded transcript');
    expect(host.textContent).not.toContain('first loaded transcript');
    expect(host.textContent).not.toContain('second heavy segment only');
    expect(host.querySelectorAll('[data-chat-panel]')).toHaveLength(1);
    expect(dom.window.document.querySelector('.chat-link[aria-current="page"]')?.textContent).toContain('Second chat');
    dom.window.close();
  });

  it('permits only local generation scripts in the lazy shell and keeps connect/network APIs disabled', () => {
    const generation = `g-${'b'.repeat(32)}`;
    const html = renderLazyArchiveHtml({
      searchPath: `data/${generation}/search.js`,
      chats: [{ id: 'safe', title: 'Safe', chunkPath: `data/${generation}/chat-0-segment-0.js`, segmentCount: 1 }]
    });
    const dom = new JSDOM(html);
    expect([...dom.window.document.querySelectorAll<HTMLScriptElement>('script[src]')].map(script => script.getAttribute('src')))
      .toEqual([`data/${generation}/search.js`]);
    expect(html).not.toMatch(/\bfetch\s*\(/u);
    expect(html).not.toMatch(/\bXMLHttpRequest\b/u);
    const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'none'");
    expect(() => renderLazyArchiveHtml({ searchPath: '../search.js', chats: [] })).toThrow(/search path/i);
    expect(() => renderLazyArchiveHtml({
      searchPath: `data/${generation}/search.js`,
      chats: [{ id: 'unsafe', title: 'Unsafe', chunkPath: 'https://provider.invalid/chat.js', segmentCount: 1 }]
    })).toThrow(/chunk path/i);
    expect(() => renderLazyArchiveHtml({
      searchPath: `data/${generation}/search.js`,
      chats: [{ id: 'unsafe-count', title: 'Unsafe count', chunkPath: `data/${generation}/chat-0-segment-0.js`, segmentCount: 0 }]
    })).toThrow(/segment count/i);
    dom.window.close();
  });
});
