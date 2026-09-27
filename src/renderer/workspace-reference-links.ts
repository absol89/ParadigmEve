import type { PinsLibrarySnapshot } from '../shared/pins.js';
import { pinsContextReferenceSpans, resolvePinsReference } from '../shared/pins-context.js';
import {
  exactSourceWorkspaceNavigation,
  navigateWorkspace,
  type WorkspaceNavigationState
} from './workspace-navigation.js';

type Navigate = (state: WorkspaceNavigationState) => void;
type OpenThreadDestination = (threadId: string) => void;
export type WorkspaceReferenceTarget =
  | { kind: 'workspace'; state: WorkspaceNavigationState }
  | { kind: 'thread-destination'; threadId: string };

export function workspaceReferenceTarget(
  snapshot: PinsLibrarySnapshot,
  reference: string
): WorkspaceReferenceTarget | null {
  const resolved = resolvePinsReference(snapshot, reference);
  if (!resolved) return null;
  if (resolved.kind === 'concept-thread') {
    return { kind: 'workspace', state: { screen: 'pins', conceptId: resolved.id } };
  }
  if (resolved.kind === 'thread') {
    const thread = snapshot.quilts.find(row => row.id === resolved.id);
    if (!thread) return null;
    return thread.link
      ? { kind: 'thread-destination', threadId: resolved.id }
      : { kind: 'workspace', state: { screen: 'pins', quiltId: resolved.id } };
  }
  return { kind: 'workspace', state: { screen: 'pins', collectionId: resolved.id } };
}

export function workspaceReferenceNavigation(
  snapshot: PinsLibrarySnapshot,
  reference: string
): WorkspaceNavigationState | null {
  const target = workspaceReferenceTarget(snapshot, reference);
  return target?.kind === 'workspace' ? target.state : null;
}

function bindInternalLink(anchor: HTMLAnchorElement, target: WorkspaceNavigationState, navigate: Navigate): void {
  const open = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(target);
  };
  anchor.href = '#';
  anchor.addEventListener('click', open);
  anchor.addEventListener('auxclick', open);
}

function bindThreadDestination(anchor: HTMLAnchorElement, threadId: string, openDestination: OpenThreadDestination): void {
  const open = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openDestination(threadId);
  };
  anchor.href = '#';
  anchor.addEventListener('click', open);
  anchor.addEventListener('auxclick', open);
}

/**
 * Adds local workspace navigation to plain product references after Markdown sanitisation.
 * Existing links and code are left alone, and unresolved/ambiguous names remain inert text.
 */
export function decorateWorkspaceReferenceLinks(
  root: HTMLElement,
  snapshot: PinsLibrarySnapshot,
  navigate: Navigate = state => navigateWorkspace(state),
  openDestination?: OpenThreadDestination
): void {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const walker = document.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!(current instanceof view.Text)) continue;
    const parent = current.parentElement;
    if (!parent || parent.closest('a,code,pre,kbd')) continue;
    nodes.push(current);
  }

  for (const node of nodes) {
    const value = node.data;
    const resolved = pinsContextReferenceSpans(value).flatMap(span => {
      const target = workspaceReferenceTarget(snapshot, span.reference);
      if (target?.kind === 'thread-destination' && !openDestination) return [];
      return target ? [{ ...span, target }] : [];
    });
    if (!resolved.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const span of resolved) {
      if (span.start > offset) fragment.append(value.slice(offset, span.start));
      const anchor = document.createElement('a');
      anchor.className = 'workspace-reference-link';
      anchor.textContent = span.reference;
      if (span.target.kind === 'workspace') bindInternalLink(anchor, span.target.state, navigate);
      else bindThreadDestination(anchor, span.target.threadId, openDestination!);
      fragment.append(anchor);
      offset = span.end;
    }
    if (offset < value.length) fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  }
}

/** A reusable exact source link for request/result surfaces that already have durable provenance. */
export function createExactSourceLink(
  document: Document,
  label: string,
  sessionId: string,
  eventSeq: number,
  navigate: Navigate = state => navigateWorkspace(state)
): HTMLAnchorElement | null {
  const target = exactSourceWorkspaceNavigation(sessionId, eventSeq);
  if (!target) return null;
  const anchor = document.createElement('a');
  anchor.className = 'workspace-source-link';
  anchor.textContent = label;
  bindInternalLink(anchor, target, navigate);
  return anchor;
}
