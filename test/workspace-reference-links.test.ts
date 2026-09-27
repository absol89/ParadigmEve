import { afterEach, beforeEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import type { PinsLibrarySnapshot } from '../src/shared/pins.js';
import {
  createExactSourceLink,
  decorateWorkspaceReferenceLinks,
  workspaceReferenceNavigation,
  workspaceReferenceTarget
} from '../src/renderer/workspace-reference-links.js';
import type { WorkspaceNavigationState } from '../src/renderer/workspace-navigation.js';

let dom: JSDOM;

const snapshot: PinsLibrarySnapshot = {
  version: 1,
  quilts: [
    { id: 'thread-release', title: 'Release', state: 'pinned', collectionIds: ['quilt-eve'], createdAt: 1, updatedAt: 1 },
    { id: 'thread-dup-a', title: 'Duplicate', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 },
    { id: 'thread-dup-b', title: '%duplicate', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 }
  ],
  pins: [],
  collections: [
    { id: 'quilt-eve', name: 'Eve', createdAt: 1 },
    { id: 'quilt-dup-a', name: 'Duplicate', createdAt: 1 },
    { id: 'quilt-dup-b', name: '#duplicate', createdAt: 1 }
  ]
};

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://eve.local/' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLAnchorElement: dom.window.HTMLAnchorElement
  });
});

afterEach(() => dom.window.close());

it('turns only uniquely resolved %Thread and #Quilt text into local workspace links', () => {
  const root = dom.window.document.createElement('div');
  root.innerHTML = '<p>Open %Release and #Eve, then %Release again. Leave %Duplicate and #Duplicate alone. <code>%Release</code> <a href="https://example.test/#Eve">#Eve</a></p>';
  const visited: WorkspaceNavigationState[] = [];

  decorateWorkspaceReferenceLinks(root, snapshot, state => visited.push(state));

  const links = [...root.querySelectorAll<HTMLAnchorElement>('.workspace-reference-link')];
  expect(links.map(link => link.textContent)).toEqual(['%Release', '#Eve', '%Release']);
  expect(links.every(link => link.getAttribute('href') === '#')).toBe(true);
  expect(root.querySelector('code')?.querySelector('.workspace-reference-link')).toBeNull();
  expect(root.querySelector('a[href="https://example.test/#Eve"]')?.textContent).toBe('#Eve');
  expect(root.textContent).toContain('%Duplicate');
  expect(root.textContent).toContain('#Duplicate');

  links[0]!.click();
  links[1]!.click();
  expect(visited).toEqual([
    { screen: 'pins', quiltId: 'thread-release' },
    { screen: 'pins', collectionId: 'quilt-eve' }
  ]);
});

it('resolves reference names exactly and fails closed on missing or ambiguous legacy titles', () => {
  expect(workspaceReferenceNavigation(snapshot, '%release')).toEqual({ screen: 'pins', quiltId: 'thread-release' });
  expect(workspaceReferenceNavigation(snapshot, '#EVE')).toEqual({ screen: 'pins', collectionId: 'quilt-eve' });
  expect(workspaceReferenceNavigation(snapshot, '%Duplicate')).toBeNull();
  expect(workspaceReferenceNavigation(snapshot, '#Duplicate')).toBeNull();
  expect(workspaceReferenceNavigation(snapshot, '%Missing')).toBeNull();
  expect(workspaceReferenceNavigation(snapshot, 'https://example.test/#Eve')).toBeNull();
});

it('keeps a linked #Concept inside its backing Concept workspace instead of following the destination URL', () => {
  const conceptSnapshot: PinsLibrarySnapshot = {
    version: 1,
    quilts: [{
      id: 'thread-concept',
      title: 'Architecture',
      description: 'Concept description',
      link: 'https://example.com/architecture',
      state: 'pinned',
      collectionIds: [],
      createdAt: 1,
      updatedAt: 1
    }],
    pins: [],
    collections: []
  };
  expect(workspaceReferenceNavigation(conceptSnapshot, '#Architecture')).toEqual({
    screen: 'pins',
    conceptId: 'thread-concept'
  });
  expect(workspaceReferenceTarget(conceptSnapshot, '#Architecture')).toEqual({
    kind: 'workspace',
    state: { screen: 'pins', conceptId: 'thread-concept' }
  });
  expect(workspaceReferenceNavigation({
    ...conceptSnapshot,
    quilts: [
      ...conceptSnapshot.quilts,
      { ...conceptSnapshot.quilts[0]!, id: 'thread-concept-duplicate' }
    ]
  }, '#Architecture')).toBeNull();
});

it('keeps %Thread on its exact edit view by default and delegates an authored destination by durable Thread id', () => {
  const linked: PinsLibrarySnapshot = {
    ...snapshot,
    quilts: [
      { id: 'thread-default', title: 'Default', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 },
      {
        id: 'thread-link',
        title: 'Docs',
        link: 'https://example.com/docs',
        state: 'pinned',
        collectionIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  };
  expect(workspaceReferenceTarget(linked, '%Default')).toEqual({
    kind: 'workspace',
    state: { screen: 'pins', quiltId: 'thread-default' }
  });
  expect(workspaceReferenceTarget(linked, '%Docs')).toEqual({
    kind: 'thread-destination',
    threadId: 'thread-link'
  });
  expect(workspaceReferenceNavigation(linked, '%Docs')).toBeNull();

  const root = dom.window.document.createElement('div');
  root.textContent = 'Open %Docs.';
  const opened: string[] = [];
  decorateWorkspaceReferenceLinks(root, linked, () => undefined, threadId => opened.push(threadId));
  const anchor = root.querySelector<HTMLAnchorElement>('.workspace-reference-link')!;
  anchor.click();
  expect(opened).toEqual(['thread-link']);
});

it('delegates an absolute local %Thread destination without exposing the native path to the opener callback', () => {
  const local: PinsLibrarySnapshot = {
    ...snapshot,
    quilts: [{
      id: 'thread-local',
      title: 'Installers',
      link: 'C:\\Builds\\Example-installers',
      state: 'pinned',
      collectionIds: [],
      createdAt: 1,
      updatedAt: 1
    }]
  };
  expect(workspaceReferenceTarget(local, '%Installers')).toEqual({
    kind: 'thread-destination',
    threadId: 'thread-local'
  });
  const root = dom.window.document.createElement('div');
  root.textContent = 'Open %Installers.';
  const opened: string[] = [];
  decorateWorkspaceReferenceLinks(root, local, () => undefined, threadId => opened.push(threadId));
  root.querySelector<HTMLAnchorElement>('.workspace-reference-link')!.click();
  expect(opened).toEqual(['thread-local']);
});

it('creates an exact source-message link only from valid durable session/event provenance', () => {
  const visited: WorkspaceNavigationState[] = [];
  const link = createExactSourceLink(
    dom.window.document,
    'Open original request',
    'session-source-123',
    42,
    state => visited.push(state)
  );
  expect(link?.textContent).toBe('Open original request');
  expect(link?.getAttribute('href')).toBe('#');
  link?.click();
  expect(visited).toEqual([{ screen: 'chat', sessionId: 'session-source-123', eventSeq: 42 }]);
  expect(createExactSourceLink(dom.window.document, 'Bad source', 'x', 42)).toBeNull();
  expect(createExactSourceLink(dom.window.document, 'Bad event', 'session-source-123', 0)).toBeNull();
});
