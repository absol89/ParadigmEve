import { describe, expect, it, vi } from 'vitest';
import type { PlanLibrary, PlanView } from '../src/shared/plans.js';
import type { SessionSummary } from '../src/shared/session.js';
import type { ChatReviewAttention } from '../src/main/session/input.js';
import type { PlanReviewExpectation } from '../src/main/plans.js';
import {
  CHAT_REVIEW_HEARTBEAT_MS,
  CHAT_REVIEW_INITIAL_LOOKBACK_MS,
  CHAT_REVIEW_PLAN_BATCH_SIZE,
  CHAT_REVIEW_RETRY_MS,
  acknowledgeChatReviewPlan,
  chatReviewCoordinatorCandidates,
  completeChatReviewHeartbeat,
  resolveChatReviewContinuity,
  runChatReviewHeartbeat,
  startChatReviewHeartbeatMaintenance,
  type ChatReviewCompletionReceipt,
  type ChatReviewDebt,
  type ChatReviewHeartbeatState
} from '../src/main/chat-review-heartbeat.js';

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  const defaultConversationId = overrides.conversationId ?? `${overrides.id}-conversation`;
  return {
    title: overrides.title ?? overrides.id,
    conversationId: defaultConversationId,
    chatIds: overrides.chatIds ?? [defaultConversationId],
    startedAt: overrides.startedAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    endedAt: overrides.endedAt ?? null,
    events: overrides.events ?? 1,
    userMessages: overrides.userMessages ?? 1,
    toolCalls: overrides.toolCalls ?? 1,
    lastToolCallAt: overrides.lastToolCallAt ?? 1,
    processExitNonzero: overrides.processExitNonzero ?? 0,
    toolRejected: overrides.toolRejected ?? 0,
    toolInternalErrors: overrides.toolInternalErrors ?? 0,
    errors: overrides.errors ?? 0,
    estimatedTokens: overrides.estimatedTokens ?? 0,
    contextTokens: overrides.contextTokens ?? 0,
    lastHandoffId: overrides.lastHandoffId ?? null,
    lastHandoffAt: overrides.lastHandoffAt ?? null,
    lastTurnOutcome: overrides.lastTurnOutcome ?? null,
    agents: overrides.agents ?? [],
    origin: overrides.origin ?? null,
    ...overrides,
    id: overrides.id
  } as SessionSummary;
}

const conversationId = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const emptyPlans = async () => ({ live: [], done: [] });
const openPlanFence = async <T>(_targets: readonly unknown[], commit: () => Promise<T>): Promise<T> => commit();
const planUuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function plan(value: number, overrides: Partial<PlanView> = {}): PlanView {
  const itemId = planUuid(10_000 + value);
  const updatedAt = overrides.updatedAt ?? 1_000 + value;
  const archivedAt = overrides.archivedAt ?? null;
  const items = overrides.items ?? [{ id: itemId, text: `Item ${value}`, status: 'todo' as const }];
  return {
    id: planUuid(value),
    title: `Plan ${value}`,
    items,
    provenance: { kind: 'manual', sessionId: `source-${value}`, conversationId: `source-chat-${value}` },
    createdAt: 500 + value,
    updatedAt,
    archivedAt,
    section: archivedAt === null ? 'live' : 'done',
    audience: 'human',
    readyToArchive: archivedAt === null && items.every(item => item.status === 'done'),
    currentItemId: null,
    nextItemId: items.find(item => item.status !== 'done')?.id ?? null,
    nextReminderAt: null,
    ...overrides
  };
}
function planTargetFor(plan: PlanView) {
  return {
    planId: plan.id,
    updatedAt: plan.updatedAt,
    ...(plan.provenance?.sessionId ? { sourceSessionId: plan.provenance.sessionId } : {}),
    ...(plan.provenance?.conversationId ? { sourceConversationId: plan.provenance.conversationId } : {}),
    ...(plan.provenance?.threadId ? { sourceThreadId: plan.provenance.threadId } : {})
  };
}
function requiredState(value: ChatReviewHeartbeatState | null): ChatReviewHeartbeatState {
  if (!value) throw new Error('Expected heartbeat state');
  return value;
}
function debt(overrides: Partial<ChatReviewDebt> = {}): ChatReviewDebt {
  return {
    key: 'heartbeat:first',
    sinceAt: 1_000,
    untilAt: 2_000,
    sessionId: 'prime-session',
    conversationId,
    ...overrides
  };
}
function receipt(review: ChatReviewDebt, overrides: Partial<ChatReviewCompletionReceipt> = {}): ChatReviewCompletionReceipt {
  return {
    key: review.key,
    sessionId: review.sessionId,
    conversationId: review.conversationId,
    requestId: 'review-complete-request',
    completedAt: review.untilAt + 5,
    result: 'completed',
    ...overrides
  };
}

describe('chat review heartbeat', () => {
  it('prefers the newest exact ordinary Eve caller and excludes worker/helper or tool-free chats', () => {
    const rows = chatReviewCoordinatorCandidates([
      session({ id: 'older', conversationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', lastToolCallAt: 100 }),
      session({ id: 'worker', conversationId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', lastToolCallAt: 500, origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'x' } }),
      session({ id: 'helper', conversationId: 'cccccccc-1111-4111-8111-cccccccccccc', lastToolCallAt: 400, origin: { kind: 'helper', fromSessionId: null, agentId: null, task: 'x' } }),
      session({ id: 'stalled', conversationId: 'ffffffff-1111-4111-8111-ffffffffffff', lastToolCallAt: 450, lastTurnOutcome: 'stalled', activeTurnId: null }),
      session({ id: 'failed', conversationId: 'abababab-1111-4111-8111-abababababab', lastToolCallAt: 440, lastTurnOutcome: 'failed', activeTurnId: null }),
      session({ id: 'ended', conversationId: '12121212-1111-4111-8111-121212121212', lastToolCallAt: 425, endedAt: 500 }),
      session({ id: 'resumed', conversationId: '99999999-1111-4111-8111-999999999999', lastToolCallAt: 350, lastTurnOutcome: 'stalled', activeTurnId: 'turn-resumed' }),
      session({ id: 'tool-free', conversationId: 'dddddddd-1111-4111-8111-dddddddddddd', toolCalls: 0, lastToolCallAt: null }),
      session({ id: 'newest', conversationId: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', lastToolCallAt: 300 })
    ]);
    expect(rows.map(row => row.id)).toEqual(['resumed', 'newest', 'older']);
  });

  it('prefers the dedicated Eve/Eva conversation even when recent tool calls lost page attribution', async () => {
    const now = 1_000_000;
    const installationConversation = 'abababab-2222-4222-8222-abababababab';
    const installation = session({
      id: 'installation-agent',
      conversationId: installationConversation,
      toolCalls: 0,
      lastToolCallAt: null,
      updatedAt: 100
    });
    const unrelatedRecent = session({
      id: 'recent-ordinary',
      conversationId: 'cdcdcdcd-2222-4222-8222-cdcdcdcdcdcd',
      toolCalls: 5,
      lastToolCallAt: now - 1,
      updatedAt: now - 1
    });
    let state: ChatReviewHeartbeatState | null = null;
    const enqueue = vi.fn(async () => ({ state: 'queued' }));

    const result = await runChatReviewHeartbeat(now, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      sessions: async () => [unrelatedRecent, installation],
      uniqueSession: async (id) => id === installationConversation ? installation : unrelatedRecent,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey: () => 'heartbeat:installation-identity',
      agentConversation: () => installationConversation
    });

    expect(result).toMatchObject({
      status: 'queued',
      sessionId: installation.id,
      conversationId: installationConversation
    });
    expect(state).toEqual({
      debt: {
        key: 'heartbeat:installation-identity',
        sinceAt: now - CHAT_REVIEW_INITIAL_LOOKBACK_MS < 0 ? 0 : now - CHAT_REVIEW_INITIAL_LOOKBACK_MS,
        untilAt: now,
        sessionId: installation.id,
        conversationId: installationConversation,
        planBatch: [],
        planAcks: []
      },
      planSweep: { remainingPlanIds: [] }
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(installation.id, {
      key: 'heartbeat:installation-identity',
      sinceAt: 0,
      untilAt: now,
      plans: []
    });
  });

  it('follows stale pre-CLF Eve/Eva identity through the exact session lineage to current chat B', async () => {
    const now = 2_000_000;
    const chatA = '6a000004-0000-83eb-8000-000000000004';
    const chatB = '6a000005-0000-83eb-8000-000000000005';
    const resumed = session({
      id: 'resumed-installation-session',
      conversationId: chatB,
      chatIds: [chatA, chatB],
      toolCalls: 0,
      lastToolCallAt: null,
      updatedAt: now - 100
    });
    const unrelatedRecent = session({
      id: 'recent-but-unrelated',
      conversationId: 'dededede-2222-4222-8222-dededededede',
      toolCalls: 10,
      lastToolCallAt: now - 1,
      updatedAt: now - 1
    });
    let state: ChatReviewHeartbeatState | null = null;
    const enqueue = vi.fn(async () => ({ state: 'queued' }));

    const result = await runChatReviewHeartbeat(now, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      sessions: async () => [unrelatedRecent, resumed],
      // This mirrors the production includeHistorical + requireUnique lookup: asking for stale A
      // returns the one durable session whose current executable attachment is B.
      uniqueSession: async (id) => id === chatA || id === chatB ? resumed : unrelatedRecent,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey: () => 'heartbeat:stale-clf-owner',
      agentConversation: () => chatA
    });

    expect(result).toMatchObject({
      status: 'queued',
      sessionId: resumed.id,
      conversationId: chatB
    });
    expect(state).toEqual({
      debt: {
        key: 'heartbeat:stale-clf-owner',
        sinceAt: 0,
        untilAt: now,
        sessionId: resumed.id,
        conversationId: chatB,
        planBatch: [],
        planAcks: []
      },
      planSweep: { remainingPlanIds: [] }
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(resumed.id, {
      key: 'heartbeat:stale-clf-owner',
      sinceAt: 0,
      untilAt: now,
      plans: []
    });
  });

  it('fails closed instead of waking a recent chat when explicit Eve/Eva identity lineage is ambiguous', async () => {
    const now = 3_000_000;
    const staleIdentity = 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa';
    const unrelatedRecent = session({
      id: 'recent-but-not-eve',
      conversationId: 'bbbbbbbb-5555-4555-8555-bbbbbbbbbbbb',
      lastToolCallAt: now - 1,
      updatedAt: now - 1
    });
    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    const result = await runChatReviewHeartbeat(now, {
      readState: async () => null,
      writeState: vi.fn(async () => undefined),
      sessions: async () => [unrelatedRecent],
      uniqueSession: async () => null,
      blocked: () => false,
      enqueue,
      agentConversation: () => staleIdentity
    });

    expect(result).toEqual({
      status: 'no-coordinator',
      reason: 'no-fresh-coordinator',
      nextAt: now + CHAT_REVIEW_RETRY_MS
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('persists review debt before queueing and does not advance the cursor on queue or browser ACK', async () => {
    const now = 2_000_000_000;
    const coordinator = session({ id: 'prime', conversationId, lastToolCallAt: now - 1 });
    let state: ChatReviewHeartbeatState | null = null;
    const order: string[] = [];
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { order.push('state'); state = next; });
    const enqueue = vi.fn(async () => { order.push('enqueue'); return { state: 'queued' }; });
    const dependencies = {
      readState: async () => state,
      writeState,
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey: () => 'heartbeat:opaque-first-token'
    };

    const first = await runChatReviewHeartbeat(now, dependencies);
    expect(first).toMatchObject({ status: 'queued', sessionId: 'prime', conversationId, nextAt: now + CHAT_REVIEW_RETRY_MS });
    expect(order).toEqual(['state', 'enqueue']);
    expect(state).toEqual({
      debt: {
        key: 'heartbeat:opaque-first-token',
        sinceAt: now - CHAT_REVIEW_INITIAL_LOOKBACK_MS,
        untilAt: now,
        sessionId: 'prime',
        conversationId,
        planBatch: [],
        planAcks: []
      },
      planSweep: { remainingPlanIds: [] }
    });
    expect(state).not.toHaveProperty('lastCompletedAt');

    // A native send ACK and an ordinary assistant final change browser/session evidence only.
    // Without the explicit semantic-review receipt a retry/restart retains the same durable debt.
    enqueue.mockResolvedValue({ state: 'sent' });
    order.length = 0;
    const afterAck = await runChatReviewHeartbeat(now + CHAT_REVIEW_RETRY_MS, dependencies);
    expect(afterAck).toMatchObject({ status: 'pending', sessionId: 'prime', conversationId });
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenLastCalledWith('prime', {
      key: 'heartbeat:opaque-first-token',
      sinceAt: now - CHAT_REVIEW_INITIAL_LOOKBACK_MS,
      untilAt: now,
      plans: []
    });
    expect(state).not.toHaveProperty('lastCompletedAt');
  });

  it('resolves only the current opaque debt key to its exact durable coordinator lineage', async () => {
    const pending = debt({ key: 'heartbeat:scheduled-continuity' });
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId });
    const dependencies = {
      readState: async () => ({ debt: pending }),
      uniqueSession: async () => coordinator,
      blocked: () => false
    };
    expect(await resolveChatReviewContinuity(pending.key, dependencies)).toEqual({
      sessionId: pending.sessionId,
      conversationId: pending.conversationId
    });
    expect(await resolveChatReviewContinuity('heartbeat:wrong-key', dependencies)).toBeNull();
    expect(await resolveChatReviewContinuity(pending.key, { ...dependencies, uniqueSession: async () => null })).toBeNull();
    expect(await resolveChatReviewContinuity(pending.key, { ...dependencies, blocked: () => true })).toBeNull();
  });

  it('reissues the exact durable debt after restart without minting a new review window', async () => {
    const pending = debt({ key: 'heartbeat:after:500', sinceAt: 500, untilAt: 1_820 });
    const enqueue = vi.fn(async () => ({ state: 'queued' }));
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId, lastToolCallAt: 1_800 });
    const result = await runChatReviewHeartbeat(9_000, {
      readState: async () => ({ lastCompletedAt: 500, debt: pending }),
      writeState: vi.fn(async () => undefined),
      sessions: vi.fn(async () => []),
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue
    });
    expect(result).toMatchObject({ status: 'pending', nextAt: 9_000 + CHAT_REVIEW_RETRY_MS });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(pending.sessionId, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
  });

  it('carries one pending debt across an exact same-session Compact & Resume rebind', async () => {
    const oldConversation = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
    const newConversation = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
    const pending = debt({ conversationId: oldConversation });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const resumed = session({
      id: pending.sessionId,
      conversationId: newConversation,
      chatIds: [oldConversation, newConversation]
    });
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    const dependencies = {
      readState: async () => state,
      writeState,
      sessions: async () => [] as SessionSummary[],
      // Historical lookup for A resolves the one durable session whose current authority is B.
      uniqueSession: async (id: string) => id === oldConversation || id === newConversation ? resumed : null,
      blocked: () => false,
      enqueue
    };

    const result = await runChatReviewHeartbeat(9_000, dependencies);
    expect(result).toMatchObject({ status: 'pending', sessionId: pending.sessionId, conversationId: newConversation });
    expect(state).toEqual({ debt: { ...pending, conversationId: newConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(pending.sessionId, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });

    const completed = receipt(pending, { conversationId: newConversation, requestId: 'resume-receipt' });
    expect(await completeChatReviewHeartbeat(completed, dependencies)).toBe('completed');
    expect(state).toEqual({ lastCompletedAt: pending.untilAt, lastReceipt: completed });
  });

  it('hands the same debt to another exact coordinator only after a canonical stalled turn', async () => {
    const pending = debt({ key: 'heartbeat:stalled-owner' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const stalledOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      lastToolCallAt: 900,
      lastTurnOutcome: 'stalled',
      activeTurnId: null
    });
    const successorConversation = 'cccccccc-3333-4333-8333-cccccccccccc';
    const successor = session({ id: 'successor-session', conversationId: successorConversation, lastToolCallAt: 800 });
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      readState: async () => state,
      writeState,
      sessions: async () => [stalledOwner, successor],
      uniqueSession: async (id: string) => id === pending.conversationId ? stalledOwner : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue
    };

    const result = await runChatReviewHeartbeat(10_000, dependencies);
    expect(result).toMatchObject({ status: 'pending', sessionId: successor.id, conversationId: successorConversation });
    expect(state).toEqual({ debt: { ...pending, sessionId: successor.id, conversationId: successorConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(successor.id, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });

    expect(await completeChatReviewHeartbeat(receipt(pending), dependencies)).toBe('rejected');
    const successorReceipt = receipt(pending, {
      sessionId: successor.id,
      conversationId: successorConversation,
      requestId: 'successor-review-receipt'
    });
    expect(await completeChatReviewHeartbeat(successorReceipt, dependencies)).toBe('completed');
    expect(state).toEqual({ lastCompletedAt: pending.untilAt, lastReceipt: successorReceipt });
  });

  it('moves the same durable debt off an ended owner to the newest exact live coordinator', async () => {
    const pending = debt({ key: 'heartbeat:ended-owner' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const endedOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      lastToolCallAt: 900,
      endedAt: 950
    });
    const successorConversation = 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee';
    const successor = session({ id: 'live-successor', conversationId: successorConversation, lastToolCallAt: 800 });
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      readState: async () => state,
      writeState,
      sessions: async () => [endedOwner, successor],
      uniqueSession: async (id: string) => id === pending.conversationId ? endedOwner : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue
    };

    const result = await runChatReviewHeartbeat(10_000, dependencies);
    expect(result).toMatchObject({ status: 'pending', sessionId: successor.id, conversationId: successorConversation });
    expect(state).toEqual({ debt: { ...pending, sessionId: successor.id, conversationId: successorConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(successor.id, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
    expect(await completeChatReviewHeartbeat(receipt(pending), dependencies)).toBe('rejected');
  });

  it('moves the same durable debt off a canonically failed owner with no active turn', async () => {
    const pending = debt({ key: 'heartbeat:failed-owner' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const failedOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      lastToolCallAt: 900,
      lastTurnOutcome: 'failed',
      activeTurnId: null
    });
    const successorConversation = 'fefefefe-3333-4333-8333-fefefefefefe';
    const successor = session({ id: 'failed-owner-successor', conversationId: successorConversation, lastToolCallAt: 800 });
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      readState: async () => state,
      writeState,
      sessions: async () => [failedOwner, successor],
      uniqueSession: async (id: string) => id === pending.conversationId ? failedOwner : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue
    };

    const result = await runChatReviewHeartbeat(10_000, dependencies);
    expect(result).toMatchObject({ status: 'pending', sessionId: successor.id, conversationId: successorConversation });
    expect(state).toEqual({ debt: { ...pending, sessionId: successor.id, conversationId: successorConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(successor.id, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
  });

  it('transfers pending debt to the dedicated Eve/Eva successor without attributed tool history', async () => {
    const pending = debt({ key: 'heartbeat:unattributed-successor' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const stalledOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      lastToolCallAt: 900,
      lastTurnOutcome: 'stalled',
      activeTurnId: null
    });
    const successorConversation = 'edededed-3333-4333-8333-edededededed';
    const successor = session({
      id: 'installation-successor',
      conversationId: successorConversation,
      toolCalls: 0,
      lastToolCallAt: null,
      updatedAt: 1_000
    });
    const enqueue = vi.fn(async () => undefined);
    const result = await runChatReviewHeartbeat(10_000, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      sessions: async () => [stalledOwner, successor],
      uniqueSession: async (id) => id === pending.conversationId ? stalledOwner : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue,
      agentConversation: () => successorConversation
    });

    expect(result).toMatchObject({ status: 'pending', sessionId: successor.id, conversationId: successorConversation });
    expect(state).toEqual({ debt: { ...pending, sessionId: successor.id, conversationId: successorConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(successor.id, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
  });

  it('moves stale debt to a newly proven installation-agent identity even when the legacy owner still appears active', async () => {
    const pending = debt({ key: 'heartbeat:installation-rebound' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const legacyOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      activeTurnId: 'legacy-turn-that-never-closed',
      lastToolCallAt: 900
    });
    const successorConversation = 'abababab-3333-4333-8333-abababababab';
    const successor = session({
      id: 'current-installation-agent',
      conversationId: successorConversation,
      toolCalls: 0,
      lastToolCallAt: null,
      updatedAt: 1_000
    });
    const enqueue = vi.fn(async () => undefined);

    const result = await runChatReviewHeartbeat(10_000, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      sessions: async () => [legacyOwner, successor],
      uniqueSession: async (id) => id === pending.conversationId ? legacyOwner : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue,
      agentConversation: () => successorConversation
    });

    expect(result).toMatchObject({ status: 'pending', sessionId: successor.id, conversationId: successorConversation });
    expect(state).toEqual({ debt: { ...pending, sessionId: successor.id, conversationId: successorConversation } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(successor.id, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
  });

  it('does not transfer debt from a chat that has started working again after an earlier stall', async () => {
    const pending = debt({ key: 'heartbeat:resumed-owner' });
    const resumedOwner = session({
      id: pending.sessionId,
      conversationId: pending.conversationId,
      lastToolCallAt: 900,
      lastTurnOutcome: 'stalled',
      activeTurnId: 'new-active-turn'
    });
    const successor = session({
      id: 'would-be-successor',
      conversationId: 'dddddddd-3333-4333-8333-dddddddddddd',
      lastToolCallAt: 800
    });
    const enqueue = vi.fn(async () => undefined);
    const writeState = vi.fn(async () => undefined);
    const result = await runChatReviewHeartbeat(10_000, {
      readState: async () => ({ debt: pending }),
      writeState,
      sessions: async () => [resumedOwner, successor],
      uniqueSession: async (id: string) => id === pending.conversationId ? resumedOwner : successor,
      blocked: () => false,
      enqueue
    });
    expect(result).toMatchObject({ status: 'pending', sessionId: pending.sessionId, conversationId: pending.conversationId });
    expect(writeState).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(pending.sessionId, {
      key: pending.key,
      sinceAt: pending.sinceAt,
      untilAt: pending.untilAt
    });
  });

  it('advances the cursor exactly once from the exact coordinator-authenticated completion receipt', async () => {
    const pending = debt();
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const exactReceipt = receipt(pending);
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId });
    const dependencies = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false
    };

    expect(await completeChatReviewHeartbeat(exactReceipt, dependencies)).toBe('completed');
    expect(state).toEqual({ lastCompletedAt: pending.untilAt, lastReceipt: exactReceipt });
    expect(await completeChatReviewHeartbeat({ ...exactReceipt, requestId: 'receipt-retry' }, dependencies)).toBe('already-completed');
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it('persists only a bounded privacy-safe completion result with the exact receipt', async () => {
    const pending = debt({ key: 'heartbeat:dispatched-result' });
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const dispatched = receipt(pending, { result: 'dispatched' });
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId });
    expect(await completeChatReviewHeartbeat(dispatched, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      uniqueSession: async () => coordinator,
      blocked: () => false
    })).toBe('completed');
    expect(state).toEqual({ lastCompletedAt: pending.untilAt, lastReceipt: dispatched });
    expect(Object.keys((state as ChatReviewHeartbeatState).lastReceipt!).sort()).toEqual([
      'completedAt', 'conversationId', 'key', 'requestId', 'result', 'sessionId'
    ]);
  });

  it('keeps debt when receipt persistence fails and accepts the same exact receipt on retry', async () => {
    const pending = debt();
    let state: ChatReviewHeartbeatState | null = { debt: pending };
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId });
    const exactReceipt = receipt(pending);
    let fail = true;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => {
      if (fail) throw new Error('disk full');
      state = next;
    });
    const dependencies = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false
    };
    await expect(completeChatReviewHeartbeat(exactReceipt, dependencies)).rejects.toThrow('disk full');
    expect(state).toEqual({ debt: pending });
    fail = false;
    expect(await completeChatReviewHeartbeat(exactReceipt, dependencies)).toBe('completed');
    expect(state).toEqual({ lastCompletedAt: pending.untilAt, lastReceipt: exactReceipt });
  });

  it('fails closed on the wrong key/session/conversation or a worker/helper coordinator', async () => {
    const pending = debt();
    const writeState = vi.fn(async () => undefined);
    const ordinary = session({ id: pending.sessionId, conversationId: pending.conversationId });
    const dependencies = {
      readState: async () => ({ debt: pending }), writeState, uniqueSession: async () => ordinary,
      blocked: () => false
    };
    expect(await completeChatReviewHeartbeat(receipt(pending, { key: 'wrong-key' }), dependencies)).toBe('rejected');
    expect(await completeChatReviewHeartbeat(receipt(pending, { sessionId: 'wrong-session' }), dependencies)).toBe('rejected');
    expect(await completeChatReviewHeartbeat(receipt(pending, {
      conversationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    }), dependencies)).toBe('rejected');

    for (const kind of ['worker', 'helper'] as const) {
      const owned = session({ id: pending.sessionId, conversationId: pending.conversationId,
        origin: { kind, fromSessionId: null, agentId: kind === 'worker' ? 'worker-1' : null, task: 'x' } });
      expect(await completeChatReviewHeartbeat(receipt(pending), {
        readState: async () => ({ debt: pending }), writeState, uniqueSession: async () => owned,
        blocked: () => false
      })).toBe('rejected');
    }
    expect(writeState).not.toHaveBeenCalled();
  });

  it('builds a stable human-first four-Plan batch and keeps the full cycle debt durable', async () => {
    const now = 20_000_000;
    const coordinator = session({ id: 'prime-batch', conversationId, lastToolCallAt: now - 1 });
    const live = [
      plan(1, { audience: 'eve' }),
      plan(2),
      plan(3, { audience: 'eve' }),
      plan(4),
      plan(5),
      plan(6)
    ];
    let state: ChatReviewHeartbeatState | null = null;
    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    await runChatReviewHeartbeat(now, {
      readState: async () => state,
      writeState: async (next) => { state = next; },
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: async () => ({ live, done: [] }),
      makeKey: () => 'heartbeat:plan-batch'
    });

    const expectedCycle = [live[1]!, live[3]!, live[4]!, live[5]!, live[0]!, live[2]!].map(row => row.id);
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual(expectedCycle);
    expect(requiredState(state).debt?.planBatch?.map(target => target.planId)).toEqual(
      expectedCycle.slice(0, CHAT_REVIEW_PLAN_BATCH_SIZE)
    );
    expect(requiredState(state).debt?.planAcks).toEqual([]);
    const firstEnqueue = enqueue.mock.calls[0]!;
    expect(firstEnqueue[1].plans?.map(snapshot => snapshot.id)).toEqual(
      expectedCycle.slice(0, CHAT_REVIEW_PLAN_BATCH_SIZE)
    );
  });

  it('rejects a pending Plan debt whose selected batch no longer belongs to the durable sweep', async () => {
    const current = plan(9);
    const target = planTargetFor(current);
    const pending = debt({ planBatch: [target], planAcks: [] });
    const coordinator = session({ id: pending.sessionId, conversationId: pending.conversationId });
    const state: ChatReviewHeartbeatState = {
      debt: pending,
      planSweep: { remainingPlanIds: [] }
    };
    const enqueue = vi.fn(async () => undefined);
    const dependencies = {
      readState: async () => state,
      writeState: vi.fn(async () => undefined),
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: async () => ({ live: [current], done: [] }),
      planFence: openPlanFence
    };

    expect(await acknowledgeChatReviewPlan({
      key: pending.key,
      sessionId: pending.sessionId,
      conversationId: pending.conversationId,
      planId: current.id,
      expectedUpdatedAt: current.updatedAt,
      classification: 'tbd'
    }, { dependencies })).toBe('rejected');
    expect(await completeChatReviewHeartbeat(receipt(pending), dependencies)).toBe('rejected');
    await expect(runChatReviewHeartbeat(10_000, dependencies)).rejects.toThrow('outside the sweep cursor');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('advances Plan rotation only after every exact acknowledgement and an accepted receipt', async () => {
    const now = 30_000_000;
    const coordinator = session({ id: 'prime-rotation', conversationId, lastToolCallAt: now - 1 });
    const initial = [plan(11), plan(12), plan(13), plan(14), plan(15)];
    let library: PlanLibrary = { live: [...initial], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:rotation-one'
    });
    const firstDebt = requiredState(state).debt!;
    expect(firstDebt.planBatch).toHaveLength(4);
    const firstReceipt = receipt(firstDebt);
    expect(await completeChatReviewHeartbeat(firstReceipt, base)).toBe('rejected');
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual(initial.map(row => row.id));

    // A Plan created mid-cycle waits until the next full cycle; it does not splice into the debt.
    const newcomer = plan(16);
    library = { live: [...initial, newcomer], done: [] };
    for (const [index, target] of firstDebt.planBatch!.entries()) {
      expect(await acknowledgeChatReviewPlan({
        key: firstDebt.key,
        sessionId: firstDebt.sessionId,
        conversationId: firstDebt.conversationId,
        planId: target.planId,
        expectedUpdatedAt: target.updatedAt,
        classification: 'tbd'
      }, { dependencies: base })).toBe('acknowledged');
      if (index === 0) {
        expect(await acknowledgeChatReviewPlan({
          key: firstDebt.key,
          sessionId: firstDebt.sessionId,
          conversationId: firstDebt.conversationId,
          planId: target.planId,
          expectedUpdatedAt: target.updatedAt,
          classification: 'tbd'
        }, { dependencies: base })).toBe('already-acknowledged');
        expect(await acknowledgeChatReviewPlan({
          key: firstDebt.key,
          sessionId: firstDebt.sessionId,
          conversationId: firstDebt.conversationId,
          planId: target.planId,
          expectedUpdatedAt: target.updatedAt,
          classification: 'blocked'
        }, { dependencies: base })).toBe('rejected');
      }
    }
    expect(await completeChatReviewHeartbeat(firstReceipt, base)).toBe('completed');
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual([initial[4]!.id]);

    const nextAt = firstReceipt.completedAt + CHAT_REVIEW_HEARTBEAT_MS;
    await runChatReviewHeartbeat(nextAt, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:rotation-two'
    });
    expect(requiredState(state).debt?.planBatch?.map(target => target.planId)).toEqual([initial[4]!.id]);
  });

  it('holds live Plan validation inside the Plans fence through the final heartbeat receipt write', async () => {
    const now = 35_000_000;
    const coordinator = session({ id: 'prime-receipt-fence', conversationId, lastToolCallAt: now - 1 });
    const current = plan(18, {
      provenance: {
        kind: 'message',
        sessionId: 'receipt-source-session',
        conversationId: 'receipt-source-conversation',
        messageId: 'receipt-source-message',
        label: 'Receipt source'
      }
    });
    const library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const initialWrite = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState: initialWrite,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:receipt-fence'
    });
    const pending = requiredState(state).debt!;
    expect(await acknowledgeChatReviewPlan({
      key: pending.key,
      sessionId: pending.sessionId,
      conversationId: pending.conversationId,
      planId: current.id,
      expectedUpdatedAt: current.updatedAt,
      classification: 'tbd'
    }, { dependencies: base })).toBe('acknowledged');

    const beforeReceipt = requiredState(state);
    const rejectedWrite = vi.fn(async (_next: ChatReviewHeartbeatState) => undefined);
    expect(await completeChatReviewHeartbeat(receipt(pending), {
      ...base,
      writeState: rejectedWrite,
      planFence: async () => { throw new Error('Plan source changed; refresh before receipt'); }
    })).toBe('rejected');
    expect(rejectedWrite).not.toHaveBeenCalled();
    expect(state).toEqual(beforeReceipt);

    const order: string[] = [];
    const finalWrite = vi.fn(async (next: ChatReviewHeartbeatState) => {
      order.push('write');
      state = next;
    });
    let fenceCalls = 0;
    const fence = async <T>(targets: readonly PlanReviewExpectation[], commit: () => Promise<T>): Promise<T> => {
      fenceCalls += 1;
      order.push('fence');
      expect(targets).toEqual([{
        planId: current.id,
        updatedAt: current.updatedAt,
        provenance: current.provenance
      }]);
      const result = await commit();
      order.push('release');
      return result;
    };
    expect(await completeChatReviewHeartbeat(receipt(pending), {
      ...base,
      writeState: finalWrite,
      planFence: fence
    })).toBe('completed');
    expect(order).toEqual(['fence', 'write', 'release']);
    expect(fenceCalls).toBe(1);
    expect(finalWrite).toHaveBeenCalledTimes(1);
  });

  it('preserves a partial Plan acknowledgement across an installation-owner transfer', async () => {
    const now = 40_000_000;
    const live = [plan(21), plan(22)];
    let library: PlanLibrary = { live, done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const original = session({ id: 'prime-before-transfer', conversationId, lastToolCallAt: now - 1 });
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    await runChatReviewHeartbeat(now, {
      readState: async () => state,
      writeState,
      sessions: async () => [original],
      uniqueSession: async () => original,
      blocked: () => false,
      enqueue: vi.fn(async () => undefined),
      plans: async () => library,
      makeKey: () => 'heartbeat:partial-transfer'
    });
    const pending = requiredState(state).debt!;
    expect(await acknowledgeChatReviewPlan({
      key: pending.key,
      sessionId: pending.sessionId,
      conversationId: pending.conversationId,
      planId: live[0]!.id,
      expectedUpdatedAt: live[0]!.updatedAt,
      classification: 'blocked'
    }, { dependencies: {
      readState: async () => state,
      writeState,
      uniqueSession: async () => original,
      blocked: () => false,
      plans: async () => library
    } })).toBe('acknowledged');

    writeState.mockClear();
    const restartEnqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    await runChatReviewHeartbeat(now + CHAT_REVIEW_RETRY_MS, {
      readState: async () => state,
      writeState,
      sessions: async () => [original],
      uniqueSession: async () => original,
      blocked: () => false,
      enqueue: restartEnqueue,
      plans: async () => library
    });
    expect(requiredState(state).debt?.planAcks).toEqual([
      expect.objectContaining({ planId: live[0]!.id, classification: 'blocked' })
    ]);
    expect(writeState).not.toHaveBeenCalled();
    expect(restartEnqueue).toHaveBeenCalledTimes(1);
    expect(restartEnqueue.mock.calls[0]![1].plans?.map(snapshot => snapshot.id)).toEqual([live[1]!.id]);

    const successorConversation = 'abababab-6666-4666-8666-abababababab';
    const successor = session({
      id: 'prime-after-transfer', conversationId: successorConversation,
      toolCalls: 0, lastToolCallAt: null, updatedAt: now + 1
    });
    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    await runChatReviewHeartbeat(now + CHAT_REVIEW_RETRY_MS, {
      readState: async () => state,
      writeState,
      sessions: async () => [original, successor],
      uniqueSession: async (id) => id === conversationId ? original : id === successorConversation ? successor : null,
      blocked: () => false,
      enqueue,
      plans: async () => library,
      agentConversation: () => successorConversation
    });
    expect(requiredState(state).debt).toMatchObject({
      key: pending.key,
      sessionId: successor.id,
      conversationId: successorConversation,
      planAcks: [expect.objectContaining({ planId: live[0]!.id, classification: 'blocked' })]
    });
    expect(enqueue.mock.calls[0]?.[1].plans?.map(snapshot => snapshot.id)).toEqual([live[1]!.id]);
  });

  it('rejects a stale Plan revision after acknowledgement, refreshes it on retry, and requires re-review', async () => {
    const now = 50_000_000;
    const coordinator = session({ id: 'prime-revision-race', conversationId, lastToolCallAt: now - 1 });
    let current = plan(31);
    let library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:revision-race'
    });
    let pending = requiredState(state).debt!;
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'tbd'
    }, { dependencies: base })).toBe('acknowledged');

    current = { ...current, updatedAt: current.updatedAt + 1 };
    library = { live: [current], done: [] };
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('rejected');
    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    await runChatReviewHeartbeat(now + CHAT_REVIEW_RETRY_MS, {
      ...base,
      sessions: async () => [coordinator],
      enqueue
    });
    pending = requiredState(state).debt!;
    expect(pending.planBatch).toEqual([planTargetFor(current)]);
    expect(pending.planAcks).toEqual([]);
    const refreshedRevision = enqueue.mock.calls[0]![1].plans?.[0];
    expect(refreshedRevision?.updatedAt).toBe(current.updatedAt);
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'tbd'
    }, { dependencies: base })).toBe('acknowledged');
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('completed');
  });

  it('fails closed on source provenance drift without updatedAt and refreshes the source before re-review', async () => {
    const now = 60_000_000;
    const coordinator = session({ id: 'prime-source-race', conversationId, lastToolCallAt: now - 1 });
    const oldThread = planUuid(90_001);
    const newThread = planUuid(90_002);
    let current = plan(41, { provenance: { kind: 'manual', sessionId: 'source-41', conversationId: 'source-chat-41', threadId: oldThread } });
    let library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:source-race'
    });
    let pending = requiredState(state).debt!;
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'tbd'
    }, { dependencies: base })).toBe('acknowledged');

    current = { ...current, provenance: { ...current.provenance!, threadId: newThread } };
    library = { live: [current], done: [] };
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('rejected');
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'tbd'
    }, { dependencies: base })).toBe('rejected');

    const enqueue = vi.fn(async (_sessionId: string, _review: ChatReviewAttention) => undefined);
    await runChatReviewHeartbeat(now + CHAT_REVIEW_RETRY_MS, {
      ...base,
      sessions: async () => [coordinator],
      enqueue
    });
    pending = requiredState(state).debt!;
    expect(pending.planBatch).toEqual([planTargetFor(current)]);
    expect(pending.planAcks).toEqual([]);
    const refreshedSource = enqueue.mock.calls[0]![1].plans?.[0];
    expect(refreshedSource?.provenance?.threadId).toBe(newThread);
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'tbd'
    }, { dependencies: base })).toBe('acknowledged');
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('completed');
  });

  it('runs a Plan mutation callback only after exact heartbeat authority and acknowledges the post-mutation revision', async () => {
    const now = 70_000_000;
    const coordinator = session({ id: 'prime-plan-mutation', conversationId, lastToolCallAt: now - 1 });
    let current = plan(51);
    let library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:mutation-authority'
    });
    let pending = requiredState(state).debt!;
    const originalUpdatedAt = current.updatedAt;
    const completedItemId = current.items[0]!.id;
    const mutationMetadata = { requestId: 'wfr-plan-mutation', completedItemIds: [completedItemId] };
    const forbiddenMutation = vi.fn(async () => undefined);
    expect(await acknowledgeChatReviewPlan({
      key: 'heartbeat:wrong-key', sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: originalUpdatedAt, classification: 'ready-to-archive',
      ...mutationMetadata
    }, { dependencies: base, mutate: forbiddenMutation })).toBe('rejected');
    expect(forbiddenMutation).not.toHaveBeenCalled();

    const mutation = vi.fn(async (before: PlanView) => {
      current = {
        ...before,
        updatedAt: before.updatedAt + 1,
        items: before.items.map(item => ({ ...item, status: 'done' as const })),
        readyToArchive: true,
        nextItemId: null
      };
      library = { live: [current], done: [] };
    });
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: originalUpdatedAt, classification: 'ready-to-archive',
      ...mutationMetadata
    }, { dependencies: base, mutate: mutation })).toBe('acknowledged');
    expect(mutation).toHaveBeenCalledTimes(1);
    pending = requiredState(state).debt!;
    expect(pending.planBatch).toEqual([planTargetFor(current)]);
    expect(pending.planAcks).toEqual([{
      ...planTargetFor(current),
      classification: 'ready-to-archive',
      mutationRequest: {
        requestId: mutationMetadata.requestId,
        expectedUpdatedAt: originalUpdatedAt,
        completedItemIds: [completedItemId]
      }
    }]);
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: originalUpdatedAt, classification: 'ready-to-archive',
      ...mutationMetadata
    }, { dependencies: base, mutate: mutation })).toBe('already-acknowledged');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: originalUpdatedAt, classification: 'ready-to-archive',
      requestId: mutationMetadata.requestId, completedItemIds: []
    }, { dependencies: base, mutate: mutation })).toBe('rejected');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('completed');
  });

  it('accepts a newer authoritative archive after acknowledgement without requiring another review', async () => {
    const now = 80_000_000;
    const coordinator = session({ id: 'prime-archive-race', conversationId, lastToolCallAt: now - 1 });
    const doneItem = { id: planUuid(90_101), text: 'Done', status: 'done' as const };
    let current = plan(61, { items: [doneItem], readyToArchive: true, nextItemId: null });
    let library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:archive-race'
    });
    const pending = requiredState(state).debt!;
    expect(await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'ready-to-archive'
    }, { dependencies: base })).toBe('acknowledged');
    const archivedAt = current.updatedAt + 1;
    current = { ...current, updatedAt: archivedAt, archivedAt, section: 'done', readyToArchive: false };
    library = { live: [], done: [current] };
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('completed');
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual([]);
  });

  it('does not advance Plan rotation when final receipt persistence fails', async () => {
    const now = 90_000_000;
    const coordinator = session({ id: 'prime-plan-persist-failure', conversationId, lastToolCallAt: now - 1 });
    const current = plan(71);
    const library: PlanLibrary = { live: [current], done: [] };
    let state: ChatReviewHeartbeatState | null = null;
    let failWrites = false;
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => {
      if (failWrites) throw new Error('disk full');
      state = next;
    });
    const base = {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library,
      planFence: openPlanFence
    };
    await runChatReviewHeartbeat(now, {
      ...base,
      sessions: async () => [coordinator],
      enqueue: vi.fn(async () => undefined),
      makeKey: () => 'heartbeat:plan-persist-failure'
    });
    const pending = requiredState(state).debt!;
    await acknowledgeChatReviewPlan({
      key: pending.key, sessionId: pending.sessionId, conversationId: pending.conversationId,
      planId: current.id, expectedUpdatedAt: current.updatedAt, classification: 'blocked'
    }, { dependencies: base });
    const beforeReceipt = state;
    failWrites = true;
    await expect(completeChatReviewHeartbeat(receipt(pending), base)).rejects.toThrow('disk full');
    expect(state).toEqual(beforeReceipt);
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual([current.id]);
    failWrites = false;
    expect(await completeChatReviewHeartbeat(receipt(pending), base)).toBe('completed');
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual([]);
  });

  it('keeps legacy receipt semantics and starts a Plan sweep only on the next new epoch', async () => {
    const coordinator = session({ id: 'prime-legacy-plan-state', conversationId, lastToolCallAt: 1 });
    const legacyDebt = debt({ key: 'heartbeat:legacy-plan-state', sessionId: coordinator.id });
    let state: ChatReviewHeartbeatState | null = { debt: legacyDebt };
    const writeState = vi.fn(async (next: ChatReviewHeartbeatState) => { state = next; });
    const current = plan(81);
    const library: PlanLibrary = { live: [current], done: [] };
    const legacyReceipt = receipt(legacyDebt);
    expect(await completeChatReviewHeartbeat(legacyReceipt, {
      readState: async () => state,
      writeState,
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: async () => library
    })).toBe('completed');
    expect(requiredState(state).planSweep).toBeUndefined();

    await runChatReviewHeartbeat(legacyReceipt.completedAt + CHAT_REVIEW_HEARTBEAT_MS, {
      readState: async () => state,
      writeState,
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue: vi.fn(async () => undefined),
      plans: async () => library,
      makeKey: () => 'heartbeat:post-legacy-plan-state'
    });
    expect(requiredState(state).planSweep?.remainingPlanIds).toEqual([current.id]);
    expect(requiredState(state).debt?.planBatch).toEqual([planTargetFor(current)]);
  });

  it('does nothing before the 22-minute cadence and uses the prior completed cursor as the next review window', async () => {
    const lastCompletedAt = 5_000_000;
    const sessions = vi.fn(async () => [] as SessionSummary[]);
    const early = await runChatReviewHeartbeat(lastCompletedAt + CHAT_REVIEW_HEARTBEAT_MS - 1, {
      readState: async () => ({ lastCompletedAt }),
      sessions
    });
    expect(early).toEqual({ status: 'not-due', nextAt: lastCompletedAt + CHAT_REVIEW_HEARTBEAT_MS });
    expect(sessions).not.toHaveBeenCalled();

    const coordinator = session({ id: 'prime', conversationId, lastToolCallAt: lastCompletedAt + 10 });
    const enqueue = vi.fn(async () => undefined);
    const writeState = vi.fn(async () => undefined);
    const now = lastCompletedAt + CHAT_REVIEW_HEARTBEAT_MS;
    await runChatReviewHeartbeat(now, {
      readState: async () => ({ lastCompletedAt }),
      writeState,
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey: () => 'heartbeat:opaque-next-token'
    });
    expect(writeState).toHaveBeenCalledWith({
      lastCompletedAt,
      planSweep: { remainingPlanIds: [] },
      debt: {
        key: 'heartbeat:opaque-next-token', sinceAt: lastCompletedAt, untilAt: now,
        sessionId: 'prime', conversationId, planBatch: [], planAcks: []
      }
    });
    expect(enqueue).toHaveBeenCalledWith('prime', {
      key: 'heartbeat:opaque-next-token', sinceAt: lastCompletedAt, untilAt: now, plans: []
    });
  });

  it('waits 22 minutes from a late semantic receipt without losing the uncovered review interval', async () => {
    const reviewedThrough = 5_000_000;
    const receiptAt = reviewedThrough + 37 * 60 * 1000;
    const previousReceipt = receipt(debt({ untilAt: reviewedThrough }), { completedAt: receiptAt });
    const coordinator = session({ id: 'prime', conversationId, lastToolCallAt: receiptAt + 10 });
    const enqueue = vi.fn(async () => ({ state: 'queued' }));
    const makeKey = vi.fn(() => 'heartbeat:after-late-receipt');

    const early = await runChatReviewHeartbeat(receiptAt + CHAT_REVIEW_HEARTBEAT_MS - 1, {
      readState: async () => ({ lastCompletedAt: reviewedThrough, lastReceipt: previousReceipt }),
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey
    });
    expect(early).toEqual({ status: 'not-due', nextAt: receiptAt + CHAT_REVIEW_HEARTBEAT_MS });
    expect(enqueue).not.toHaveBeenCalled();

    const due = receiptAt + CHAT_REVIEW_HEARTBEAT_MS;
    const queued = await runChatReviewHeartbeat(due, {
      readState: async () => ({ lastCompletedAt: reviewedThrough, lastReceipt: previousReceipt }),
      writeState: vi.fn(async () => undefined),
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      enqueue,
      plans: emptyPlans,
      makeKey
    });
    expect(queued).toMatchObject({ status: 'queued', sessionId: 'prime', conversationId });
    expect(enqueue).toHaveBeenCalledWith('prime', {
      key: 'heartbeat:after-late-receipt',
      sinceAt: reviewedThrough,
      untilAt: due,
      plans: []
    });
  });

  it('fails closed on ambiguous or blocked ownership and retries without creating debt', async () => {
    const now = 9_000_000;
    const blocked = session({ id: 'blocked', conversationId: 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa', lastToolCallAt: 300 });
    const ambiguous = session({ id: 'ambiguous', conversationId: 'bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb', lastToolCallAt: 200 });
    const writeState = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const result = await runChatReviewHeartbeat(now, {
      readState: async () => null,
      writeState,
      sessions: async () => [blocked, ambiguous],
      uniqueSession: async () => null,
      blocked: (id) => id === blocked.conversationId,
      enqueue
    });
    expect(result).toEqual({
      status: 'no-coordinator',
      reason: 'no-fresh-coordinator',
      nextAt: now + CHAT_REVIEW_RETRY_MS
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('does not cross into browser transport when the durable debt write fails', async () => {
    const now = 12_000_000;
    const lastCompletedAt = 10_000_000;
    const coordinator = session({ id: 'prime', conversationId, lastToolCallAt: now - 1 });
    const enqueue = vi.fn(async () => undefined);
    await expect(runChatReviewHeartbeat(now, {
      readState: async () => ({ lastCompletedAt }),
      writeState: async () => { throw new Error('disk full'); },
      sessions: async () => [coordinator],
      uniqueSession: async () => coordinator,
      blocked: () => false,
      plans: emptyPlans,
      enqueue
    })).rejects.toThrow('disk full');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps retrying and reports a no-coordinator maintenance result for diagnostics', async () => {
    vi.useFakeTimers();
    try {
      let now = 50_000;
      const onResult = vi.fn();
      const run = vi.fn(async (at: number) => ({
        status: 'no-coordinator' as const,
        reason: 'no-fresh-coordinator' as const,
        nextAt: at + CHAT_REVIEW_RETRY_MS
      }));
      const stop = startChatReviewHeartbeatMaintenance({ now: () => now, run, onResult });
      await Promise.resolve();
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      expect(onResult).toHaveBeenLastCalledWith({
        status: 'no-coordinator',
        reason: 'no-fresh-coordinator',
        nextAt: now + CHAT_REVIEW_RETRY_MS
      });

      now += CHAT_REVIEW_RETRY_MS;
      await vi.advanceTimersByTimeAsync(CHAT_REVIEW_RETRY_MS);
      expect(run).toHaveBeenCalledTimes(2);
      expect(onResult).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
