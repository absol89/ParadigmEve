import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  allowOtherChats: true,
  inbound: true,
  owner: 'prime-chat' as string | null,
  caller: { requestId: 'wfr_remote', conversationId: null as string | null, localPrincipal: null as any },
  worker: false,
  retired: false,
  helper: false
}));

vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ eveAuthority: { allowOtherChats: mock.allowOtherChats } }) }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => ({ caller: mock.caller }) }));
vi.mock('../src/main/mcp/inbound.js', () => ({ inboundToolEvidence: () => mock.inbound }));
vi.mock('../src/main/agent-identity.js', () => ({ currentAgentConversationId: () => mock.owner }));
vi.mock('../src/main/agents.js', () => ({
  isWorkerConversation: () => mock.worker,
  retiredWorkerForConversation: () => mock.retired ? { conversationId: mock.caller.conversationId } : null
}));
vi.mock('../src/main/goal.js', () => ({ isGoalDecisionChat: () => mock.helper }));

import { currentCallMayUseEveAuthority, sharedEveOwnerForCurrentCall } from '../src/main/eve-access.js';

beforeEach(() => {
  mock.allowOtherChats = true;
  mock.inbound = true;
  mock.owner = 'prime-chat';
  mock.caller = { requestId: 'wfr_remote', conversationId: null, localPrincipal: null };
  mock.worker = false;
  mock.retired = false;
  mock.helper = false;
});

it('lets an authenticated remote connector call borrow Eve authority by default', () => {
  expect(sharedEveOwnerForCurrentCall()).toBe('prime-chat');
  expect(currentCallMayUseEveAuthority()).toBe(true);
});

it('keeps exact owner authority when cross-chat access is disabled', () => {
  mock.allowOtherChats = false;
  mock.caller.conversationId = 'prime-chat';
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  expect(currentCallMayUseEveAuthority()).toBe(true);
});

it('honours the strict opt-out for other chats', () => {
  mock.allowOtherChats = false;
  mock.caller.conversationId = 'other-chat';
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  expect(currentCallMayUseEveAuthority()).toBe(false);
});

it('does not let app probes, missing request ids or local workers borrow Eve', () => {
  mock.inbound = false;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  mock.inbound = true;
  mock.caller.requestId = null as any;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  mock.caller.requestId = 'wfr_remote';
  mock.caller.localPrincipal = { runId: 'run', agentId: 'worker-1' };
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
});

it('does not let exact helper, active-worker or retired-worker chats borrow Eve authority', () => {
  mock.caller.conversationId = 'worker-chat';
  mock.helper = true;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  mock.helper = false;
  mock.worker = true;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  mock.worker = false;
  mock.retired = true;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
});

it('requires an installation Eve owner before sharing authority', () => {
  mock.owner = null;
  expect(sharedEveOwnerForCurrentCall()).toBeNull();
  expect(currentCallMayUseEveAuthority()).toBe(false);
});
