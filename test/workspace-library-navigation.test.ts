import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { PinsLibrarySnapshot } from '../src/shared/pins.js';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('reapplies a durable #Quilt route after the Pins snapshot loads and selects that overview filter', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });

  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [
      { id: 'thread-release', title: 'Release', state: 'pinned', collectionIds: ['quilt-eve'], createdAt: 1, updatedAt: 2 },
      { id: 'thread-other', title: 'Other', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 }
    ],
    pins: [{
      id: 'pin-release',
      quiltId: 'thread-release',
      kind: 'plan',
      createdAt: 2,
      title: 'Release evidence',
      provenance: { planId: '11111111-1111-4111-8111-111111111111' }
    }],
    collections: [{ id: 'quilt-eve', name: 'Eve', createdAt: 1 }]
  };
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok(snapshot),
      listPlans: () => ok({ live: [], done: [] })
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'chat' });
  navigation.navigateWorkspace({ screen: 'pins', collectionId: 'quilt-eve' });

  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPinsSurface();

  const selected = [...w.document.querySelectorAll<HTMLButtonElement>('.collection-chip')]
    .find(button => button.textContent?.startsWith('#Eve'));
  expect(selected?.getAttribute('aria-pressed')).toBe('true');
  expect([...w.document.querySelectorAll('.quilt-title-button')].map(node => node.textContent))
    .toEqual(['%Release']);
});

it('renders a pinned Plan from the current Plans catalog instead of its saved summary snapshot', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });

  const threadId = '11111111-1111-4111-8111-111111111111';
  const planId = '22222222-2222-4222-8222-222222222222';
  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [{ id: threadId, title: 'Bugs', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 2 }],
    pins: [{
      id: 'pin-plan',
      quiltId: threadId,
      kind: 'plan',
      createdAt: 3,
      title: 'Old saved title',
      excerpt: '0 / 1 complete',
      sticky: true,
      provenance: { planId }
    }],
    collections: []
  };
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok(snapshot),
      listPlans: () => ok({
        live: [{
          id: planId,
          title: 'Current plan title',
          items: [
            { id: '33333333-3333-4333-8333-333333333333', text: 'Already done', status: 'done' },
            { id: '44444444-4444-4444-8444-444444444444', text: 'Working now', status: 'in_progress', priority: 'high' },
            { id: '55555555-5555-4555-8555-555555555555', text: 'Verify next', status: 'todo' }
          ],
          createdAt: 1,
          updatedAt: 4,
          archivedAt: null,
          section: 'live',
          audience: 'human',
          readyToArchive: false,
          currentItemId: '44444444-4444-4444-8444-444444444444',
          nextItemId: '55555555-5555-4555-8555-555555555555',
          nextReminderAt: null
        }],
        done: []
      })
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'pins', quiltId: threadId });
  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPinsSurface();
  await library.refreshPlansSurface();

  const rows = [...w.document.querySelectorAll<HTMLElement>('[data-pin-id="pin-plan"]')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.querySelector('.quilt-pin-primary')?.textContent).toBe('Current plan title');
    expect(row.querySelector('.quilt-pin-secondary')?.textContent).toBe('1 / 3 complete');
    expect([...row.querySelectorAll('.quilt-pin-plan-title')].map(node => node.textContent))
      .toEqual(['Already done', 'Working now', 'Verify next']);
  }
  expect(rows[0]?.querySelector('[data-relation="current"]')?.textContent).toContain('Working now');
  expect(rows[0]?.querySelector('[data-relation="next"]')?.textContent).toContain('Verify next');
});

it('opens #Concept in the Concepts overview, selects only that Concept, then zooms out additively with Quilt pills', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><textarea id="chatInput"></textarea><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });
  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [
      {
        id: 'concept-architecture',
        title: 'Architecture',
        description: 'Architecture concept.',
        state: 'pinned',
        collectionIds: ['quilt-eve'],
        createdAt: 1,
        updatedAt: 3
      },
      {
        id: 'concept-evidence',
        title: 'Evidence',
        description: 'Evidence concept.',
        state: 'pinned',
        collectionIds: ['quilt-research'],
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'concept-other',
        title: 'Other',
        description: 'Other concept.',
        state: 'pinned',
        collectionIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'thread-draft',
        title: 'Draft',
        state: 'pinned',
        collectionIds: ['quilt-research'],
        createdAt: 1,
        updatedAt: 2
      }
    ],
    pins: [],
    collections: [
      { id: 'quilt-eve', name: 'Eve', createdAt: 1 },
      { id: 'quilt-research', name: 'Research', createdAt: 1 }
    ]
  };
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok(snapshot),
      listPlans: () => ok({ live: [], done: [] })
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'chat' });
  navigation.navigateWorkspace({ screen: 'pins', conceptId: 'concept-architecture' });
  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPinsSurface();

  const tabs = [...w.document.querySelectorAll<HTMLButtonElement>('.pins-tab')];
  expect(tabs.find(button => button.textContent?.startsWith('#Concept'))?.getAttribute('aria-selected')).toBe('true');
  const initialChips = [...w.document.querySelectorAll<HTMLButtonElement>('.collection-chip')];
  expect(initialChips.map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
    ['#Architecture', 'true'],
    ['All Quilts', 'false'],
    ['#Eve1', 'false'],
    ['#Research2', 'false']
  ]);
  expect([...w.document.querySelectorAll<HTMLElement>('.quilt-card')].map(card => card.dataset.quiltId))
    .toEqual(['concept-architecture']);

  initialChips.find(button => button.textContent?.startsWith('#Research'))!.click();
  expect([...w.document.querySelectorAll<HTMLElement>('.quilt-card')].map(card => card.dataset.quiltId))
    .toEqual(['concept-architecture', 'concept-evidence', 'thread-draft']);
  expect(w.document.querySelector<HTMLElement>('[data-quilt-id="thread-draft"] .quilt-title-button')?.textContent)
    .toBe('#Draft');
  expect(w.document.querySelector<HTMLElement>('[data-quilt-id="thread-draft"] .quilt-concept-description-cta')?.textContent)
    .toBe('Create\ndescription');
  const zoomedChips = [...w.document.querySelectorAll<HTMLButtonElement>('.collection-chip')];
  expect(zoomedChips.find(button => button.textContent?.startsWith('#Research'))?.getAttribute('aria-pressed')).toBe('true');
  expect(zoomedChips.find(button => button.textContent === '#Architecture')?.getAttribute('aria-pressed')).toBe('true');

  w.document.querySelector<HTMLButtonElement>('[data-quilt-id="thread-draft"] .quilt-concept-description-cta')!.click();
  expect(navigation.currentWorkspaceNavigation()).toEqual({ screen: 'chat' });
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toContain(
    'Generate a concise durable description for %Draft.'
  );
});

it('keeps per-Thread preview privacy across renderer repaints as a local UI preference', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });
  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [{
      id: 'thread-private', title: 'Private notes', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 2
    }],
    pins: [{
      id: 'pin-private', quiltId: 'thread-private', kind: 'message', createdAt: 2,
      excerpt: 'Keep this preview private on screen.',
      provenance: {
        sessionId: 'session-private-preview', conversationId: 'conversation-private-preview',
        eventSeq: 1, messageId: 'message-private-preview', turnId: 'turn-private-preview'
      }
    }],
    collections: []
  };
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  const getPinsLibrary = vi.fn(() => ok(snapshot));
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary,
      listPlans: () => ok({ live: [], done: [] })
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'pins' });
  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPinsSurface();
  expect(w.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
    .toContain('%Hotlinks');
  const threadsTab = [...w.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(button => button.textContent?.startsWith('%Threads'))!;
  threadsTab.click();
  expect(w.document.body.textContent).toContain('Keep this preview private on screen.');

  const eye = w.document.querySelector<HTMLButtonElement>('.quilt-card-preview-privacy')!;
  expect(eye.getAttribute('aria-pressed')).toBe('true');
  eye.click();
  expect(w.document.body.textContent).not.toContain('Keep this preview private on screen.');
  expect(w.document.querySelector('.quilt-card-preview-privacy')?.getAttribute('aria-pressed')).toBe('false');
  expect(JSON.parse(w.localStorage.getItem('cos.ui.hidden-thread-message-previews') ?? '[]'))
    .toEqual(['thread-private']);

  await library.refreshPinsSurface();
  expect(getPinsLibrary).toHaveBeenCalledTimes(2);
  expect(w.document.body.textContent).not.toContain('Keep this preview private on screen.');
  expect(w.document.querySelector('.quilt-card-preview-privacy')?.getAttribute('aria-pressed')).toBe('false');
});

it('opens a Plan Source at its exact owning Thread and keeps legacy source navigation in-app', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });

  const threadId = '33333333-3333-4333-8333-333333333333';
  const sessionId = 'session-source-123';
  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [{ id: threadId, title: 'Requests', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 }],
    pins: [],
    collections: []
  };
  let sourceThreadId: string | undefined = threadId;
  const openSessionChat = vi.fn();
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok(snapshot),
      listPlans: () => ok({
        live: [{
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Implement request navigation',
          items: [{ id: '55555555-5555-4555-8555-555555555555', text: 'Wire source', status: 'in_progress' }],
          provenance: {
            kind: 'plan',
            ...(sourceThreadId ? { threadId: sourceThreadId } : {}),
            sessionId,
            conversationId: 'conversation-source'
          },
          createdAt: 1,
          updatedAt: 2,
          archivedAt: null,
          section: 'live',
          audience: 'human',
          readyToArchive: false,
          currentItemId: '55555555-5555-4555-8555-555555555555',
          nextItemId: null,
          nextReminderAt: null
        }],
        done: []
      }),
      openSessionChat
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'plans' });
  const visited: unknown[] = [];
  navigation.onWorkspaceNavigation(state => visited.push(state));

  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPinsSurface();
  await library.refreshPlansSurface();
  w.document.querySelector<HTMLButtonElement>('.plans-source-open')!.click();
  expect(visited.at(-1)).toEqual({ screen: 'pins', quiltId: threadId });
  expect(openSessionChat).not.toHaveBeenCalled();

  sourceThreadId = undefined;
  await library.refreshPlansSurface();
  w.document.querySelector<HTMLButtonElement>('.plans-source-open')!.click();
  expect(visited.at(-1)).toEqual({ screen: 'chat', sessionId });
  expect(openSessionChat).not.toHaveBeenCalled();
});

it('refreshes a pinned Plan when source-session activity changes while its Thread is open', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });

  const threadId = '66666666-6666-4666-8666-666666666666';
  const planId = '77777777-7777-4777-8777-777777777777';
  const firstItem = '88888888-8888-4888-8888-888888888888';
  const secondItem = '99999999-9999-4999-8999-999999999999';
  const snapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [{ id: threadId, title: 'Live plan', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 2 }],
    pins: [{
      id: 'pin-live-plan', quiltId: threadId, kind: 'plan', createdAt: 3,
      title: 'Live plan', provenance: { planId }
    }],
    collections: []
  };
  let currentItemId: string | null = firstItem;
  const listeners: { sessionChanged?: () => void } = {};
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  const listPlans = vi.fn(() => ok({
    live: [{
      id: planId,
      title: 'Live plan',
      items: [
        { id: firstItem, text: 'First item', status: currentItemId === firstItem ? 'in_progress' : 'done' },
        { id: secondItem, text: 'Second item', status: currentItemId === secondItem ? 'in_progress' : 'todo' }
      ],
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      section: 'live',
      audience: 'human',
      readyToArchive: false,
      currentItemId,
      nextItemId: currentItemId === firstItem ? secondItem : null,
      nextReminderAt: null
    }],
    done: []
  }));
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok(snapshot),
      listPlans,
      onPlansChanged: () => () => undefined,
      onPinsChanged: () => () => undefined,
      onSessionChanged(listener: () => void) { listeners.sessionChanged = listener; return () => { delete listeners.sessionChanged; }; }
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'pins', quiltId: threadId });
  const library = await import('../src/renderer/workspace-library.js');
  library.initWorkspaceLibrary();
  await vi.waitFor(() => expect(w.document.querySelector('[data-relation="current"]')?.textContent).toContain('First item'));

  currentItemId = secondItem;
  listeners.sessionChanged?.();
  await vi.waitFor(() => expect(w.document.querySelector('[data-relation="current"]')?.textContent).toContain('Second item'));
  expect(w.document.querySelector('[data-relation="next"]')).toBeNull();
  expect(listPlans.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it('starts Plans Create through the durable starter Thread while Review stays an editable chat draft', async () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><textarea id="chatInput"></textarea><div id="pinsLibraryHost"></div><div id="plansLibraryHost"></div></body></html>', {
    url: 'https://eve.local/'
  });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    Element: w.Element,
    Node: w.Node
  });
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  Object.defineProperty(w, 'api', {
    configurable: true,
    value: {
      getPinsLibrary: () => ok({ version: 1, quilts: [], pins: [], collections: [] }),
      listPlans: () => ok({ live: [], done: [] }),
      getStarterThread: (starterId: string) => ok(starterId === 'plans'
        ? { starterId: 'plans', threadId: 'starter-plans', title: 'Renamed plans starter' }
        : null)
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  navigation.initWorkspaceNavigation({ screen: 'plans' });
  const visited: unknown[] = [];
  const openings: unknown[] = [];
  navigation.onWorkspaceNavigation(state => visited.push(state));
  navigation.onWorkspaceThreadChatOpening(opening => openings.push(opening));
  const library = await import('../src/renderer/workspace-library.js');
  await library.refreshPlansSurface();

  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  let inputEvents = 0;
  input.addEventListener('input', () => { inputEvents += 1; });
  w.document.querySelector<HTMLButtonElement>('.plans-header-create')!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(visited.at(-1)).toEqual({ screen: 'chat', quiltId: 'starter-plans' });
  expect(openings).toEqual([{ quiltId: 'starter-plans', text: 'Make me a 3 step plan to get started with %plans' }]);
  expect(input.value).toBe('');
  expect(inputEvents).toBe(0);

  const shortcuts = [...w.document.querySelectorAll<HTMLButtonElement>('.plans-chat-shortcut')];
  expect(shortcuts).toHaveLength(1);
  shortcuts[0]!.click();
  expect(visited.at(-1)).toEqual({ screen: 'chat' });
  expect(input.value).toBe('Review #plans with me.');
  expect(inputEvents).toBe(1);
});
