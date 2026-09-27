export type WorkspaceScreen = 'chat' | 'pins' | 'plans' | 'schedule' | 'archive';

export interface WorkspaceNavigationState {
  screen: WorkspaceScreen;
  sessionId?: string;
  quiltId?: string;
  /** Exact Concept backing Thread selected in the Concepts overview. */
  conceptId?: string;
  /** Multi-select Quilt filters. Legacy collectionId remains readable as a one-item filter. */
  collectionIds?: string[];
  collectionId?: string;
  eventSeq?: number;
}

const HISTORY_KEY = 'paradigmEveWorkspace';
const NAVIGATE_EVENT = 'paradigmeve:workspace-navigate';
const THREAD_CHAT_OPENING_EVENT = 'paradigmeve:thread-chat-opening';
let initialized = false;

export interface ThreadChatOpening {
  quiltId: string;
  text: string;
}

function historyPayload(state: WorkspaceNavigationState): Record<string, unknown> {
  const current = window.history.state;
  const base = current && typeof current === 'object' ? current as Record<string, unknown> : {};
  return { ...base, [HISTORY_KEY]: state };
}

function stateFrom(value: unknown): WorkspaceNavigationState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[HISTORY_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  const row = candidate as Record<string, unknown>;
  if (row.screen !== 'chat' && row.screen !== 'pins' && row.screen !== 'plans' && row.screen !== 'schedule' && row.screen !== 'archive') return null;
  return {
    screen: row.screen,
    ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
    ...(typeof row.quiltId === 'string' ? { quiltId: row.quiltId } : {}),
    ...(typeof row.conceptId === 'string' ? { conceptId: row.conceptId } : {}),
    ...(Array.isArray(row.collectionIds) && row.collectionIds.every(value => typeof value === 'string')
      ? { collectionIds: row.collectionIds as string[] } : {}),
    ...(typeof row.collectionId === 'string' ? { collectionId: row.collectionId } : {}),
    ...(typeof row.eventSeq === 'number' ? { eventSeq: row.eventSeq } : {})
  };
}

/** Exact recorded source target shared by Pins and any future in-app request/result notice. */
export function exactSourceWorkspaceNavigation(sessionId: string, eventSeq: number): WorkspaceNavigationState | null {
  if (!/^[0-9a-z-]{8,64}$/i.test(sessionId) || !Number.isSafeInteger(eventSeq) || eventSeq < 1 || eventSeq > 10_000_000) {
    return null;
  }
  return { screen: 'chat', sessionId, eventSeq };
}

function announce(state: WorkspaceNavigationState): void {
  window.dispatchEvent(new window.CustomEvent<WorkspaceNavigationState>(NAVIGATE_EVENT, { detail: state }));
}

export function initWorkspaceNavigation(initial: WorkspaceNavigationState = { screen: 'chat' }): void {
  if (initialized) return;
  initialized = true;
  window.history.replaceState(historyPayload(initial), document.title);
  window.addEventListener('popstate', event => {
    const state = stateFrom(event.state);
    if (state) announce(state);
  });
}

export function navigateWorkspace(state: WorkspaceNavigationState, options: { replace?: boolean } = {}): void {
  const payload = historyPayload(state);
  if (options.replace) window.history.replaceState(payload, document.title);
  else window.history.pushState(payload, document.title);
  announce(state);
}

/** Fresh Thread chat plus one transient authored opening. The opening is intentionally not history state. */
export function startWorkspaceThreadChat(quiltId: string, text: string): void {
  navigateWorkspace({ screen: 'chat', quiltId });
  window.dispatchEvent(new window.CustomEvent<ThreadChatOpening>(THREAD_CHAT_OPENING_EVENT, {
    detail: { quiltId, text }
  }));
}

export function onWorkspaceNavigation(listener: (state: WorkspaceNavigationState) => void): () => void {
  const wrapped = (event: Event): void => listener((event as CustomEvent<WorkspaceNavigationState>).detail);
  window.addEventListener(NAVIGATE_EVENT, wrapped);
  return () => window.removeEventListener(NAVIGATE_EVENT, wrapped);
}

export function onWorkspaceThreadChatOpening(listener: (opening: ThreadChatOpening) => void): () => void {
  const wrapped = (event: Event): void => listener((event as CustomEvent<ThreadChatOpening>).detail);
  window.addEventListener(THREAD_CHAT_OPENING_EVENT, wrapped);
  return () => window.removeEventListener(THREAD_CHAT_OPENING_EVENT, wrapped);
}

export function currentWorkspaceNavigation(): WorkspaceNavigationState | null {
  return stateFrom(window.history.state);
}
