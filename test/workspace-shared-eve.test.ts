import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ owner: 'owner-chat' as string | null }));
vi.mock('../src/main/eve-access.js', () => ({ sharedEveOwnerForCurrentCall: () => mock.owner }));

import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { currentWorkspace, resetWorkspaces, setWorkspaceFor, workspaceKey } from '../src/main/workspace.js';

function remote(): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: 'wfr_remote', conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  } as CallContext;
}

function exact(conversationId: string): CallContext {
  const ctx = remote();
  ctx.caller.conversationId = conversationId;
  return ctx;
}

beforeEach(() => {
  mock.owner = 'owner-chat';
  resetWorkspaces();
});

it('lets a shared remote Eve call fall back to the installation owner workspace without changing identity', () => {
  setWorkspaceFor('chat:owner-chat', { virtual: '/work/main', real: 'C:/work/main' });
  const ctx = remote();
  expect(runInCallContext(ctx, workspaceKey)).toBe('shared-eve:owner-chat');
  expect(runInCallContext(ctx, currentWorkspace)?.virtual).toBe('/work/main');
  expect(ctx.caller.conversationId).toBeNull();
});

it('keeps an exact unrelated chat on its own workspace instead of borrowing Eve', () => {
  setWorkspaceFor('chat:owner-chat', { virtual: '/work/main', real: 'C:/work/main' });
  setWorkspaceFor('chat:other-chat', { virtual: '/work/other', real: 'C:/work/other' });
  expect(runInCallContext(exact('other-chat'), currentWorkspace)?.virtual).toBe('/work/other');
});

it('has no shared workspace when the cross-chat authority predicate declines the call', () => {
  mock.owner = null;
  const ctx = remote();
  expect(runInCallContext(ctx, workspaceKey)).toBeNull();
  expect(runInCallContext(ctx, currentWorkspace)).toBeNull();
});
