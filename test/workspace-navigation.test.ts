import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  currentWorkspaceNavigation,
  exactSourceWorkspaceNavigation,
  initWorkspaceNavigation,
  navigateWorkspace,
  onWorkspaceNavigation,
  onWorkspaceThreadChatOpening,
  startWorkspaceThreadChat
} from '../src/renderer/workspace-navigation.js';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
});

it('keeps workspace destinations in browser-style history for Back and Forward mouse navigation', () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body></body></html>', {
    url: 'https://eve.local/'
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document
  });

  const visited: string[] = [];
  onWorkspaceNavigation(state => visited.push(`${state.screen}:${state.quiltId ?? state.sessionId ?? ''}`));
  initWorkspaceNavigation({ screen: 'chat', sessionId: 'chat-before' });

  navigateWorkspace({ screen: 'pins', quiltId: 'quilt-a' });
  const quiltHistoryEntry = dom.window.history.state;
  navigateWorkspace({ screen: 'pins', collectionId: 'collection-a' });
  expect(currentWorkspaceNavigation()).toEqual({ screen: 'pins', collectionId: 'collection-a' });
  navigateWorkspace({ screen: 'pins', conceptId: 'concept-a', collectionIds: ['collection-a', 'collection-b'] });
  expect(currentWorkspaceNavigation()).toEqual({
    screen: 'pins',
    conceptId: 'concept-a',
    collectionIds: ['collection-a', 'collection-b']
  });
  navigateWorkspace({ screen: 'chat', quiltId: 'quilt-a' });
  expect(currentWorkspaceNavigation()).toEqual({ screen: 'chat', quiltId: 'quilt-a' });
  navigateWorkspace({ screen: 'chat', sessionId: 'chat-source', eventSeq: 42 });
  navigateWorkspace({ screen: 'archive' });

  expect(currentWorkspaceNavigation()).toEqual({ screen: 'archive' });
  expect(visited).toEqual(['pins:quilt-a', 'pins:', 'pins:', 'chat:quilt-a', 'chat:chat-source', 'archive:']);

  // Chromium's Back/Forward commands (including mouse thumb buttons) surface as popstate for
  // same-document History API entries. Replaying the captured Quilt entry proves that handler.
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: quiltHistoryEntry }));
  expect(visited.at(-1)).toBe('pins:quilt-a');
});

it('builds exact source-message navigation only from bounded durable provenance', () => {
  expect(exactSourceWorkspaceNavigation('session-source-123', 42))
    .toEqual({ screen: 'chat', sessionId: 'session-source-123', eventSeq: 42 });
  expect(exactSourceWorkspaceNavigation('short', 42)).toBeNull();
  expect(exactSourceWorkspaceNavigation('session-source-123', 0)).toBeNull();
  expect(exactSourceWorkspaceNavigation('session-source-123', Number.MAX_SAFE_INTEGER)).toBeNull();
});

it('keeps an automatic Thread-chat opening transient so browser history cannot replay it', () => {
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body></body></html>', {
    url: 'https://eve.local/'
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document
  });

  const openings: Array<{ quiltId: string; text: string }> = [];
  const visited: string[] = [];
  onWorkspaceNavigation(state => visited.push(state.screen + ':' + (state.quiltId ?? '')));
  onWorkspaceThreadChatOpening(opening => openings.push(opening));
  initWorkspaceNavigation({ screen: 'plans' });

  startWorkspaceThreadChat('thread-plans', 'Start a new %Plan.');
  const chatHistoryEntry = dom.window.history.state;
  expect(currentWorkspaceNavigation()).toEqual({ screen: 'chat', quiltId: 'thread-plans' });
  expect(openings).toEqual([{ quiltId: 'thread-plans', text: 'Start a new %Plan.' }]);
  expect(JSON.stringify(chatHistoryEntry)).not.toContain('Start a new %Plan.');

  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: chatHistoryEntry }));
  expect(visited).toEqual(['chat:thread-plans']);
  expect(openings).toHaveLength(1);
});
