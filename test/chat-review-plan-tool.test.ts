import { beforeEach, describe, expect, it, vi } from 'vitest';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

const fixture = vi.hoisted(() => ({
  agent: null as string | null,
  reviewWorker: false,
  caller: {
    transportKey: null as string | null,
    requestId: 'wfr_review',
    sessionId: 'session-prime',
    conversationId: 'conversation-prime',
    localPrincipal: null as unknown
  },
  call: null as any,
  continuity: { sessionId: 'session-prime', conversationId: 'conversation-prime' } as { sessionId: string; conversationId: string } | null,
  sessions: new Map<string, any>(),
  currentPlan: {
    id: '11111111-1111-4111-8111-111111111111',
    updatedAt: 10,
    provenance: {
      kind: 'message',
      threadId: '33333333-3333-4333-8333-333333333333',
      sessionId: 'source-session',
      conversationId: 'source-conversation',
      messageId: 'source-message',
      label: 'Exact source'
    }
  },
  acknowledgement: 'acknowledged' as 'acknowledged' | 'already-acknowledged' | 'rejected',
  archiveAuthority: true,
  workerRequired: false,
  reviewedPlan: {
    id: '11111111-1111-4111-8111-111111111111',
    updatedAt: 10,
    provenance: { kind: 'plan', sessionId: 'source-session', conversationId: 'source-conversation' },
    audience: 'human' as 'human' | 'eve',
    readyToArchive: false,
    archivedAt: null as number | null
  },
  acknowledge: vi.fn(async (_input: any, options: any = {}) => {
    if (fixture.acknowledgement !== 'acknowledged') return fixture.acknowledgement;
    if (options.mutate) await options.mutate(fixture.currentPlan);
    return fixture.acknowledgement;
  }),
  completeItems: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', updatedAt: 11 })),
  archiveExact: vi.fn(async () => 'archived'),
  pendingHousekeeping: vi.fn(async () => [{
    planId: '11111111-1111-4111-8111-111111111111', updatedAt: 10,
    itemIds: ['22222222-2222-4222-8222-222222222222'], sourceSessionId: 'source-session'
  }]),
  reconcileHousekeeping: vi.fn(async () => 'reconciled'),
  listPlans: vi.fn(async () => ({
    live: fixture.reviewedPlan.archivedAt === null ? [{ ...fixture.reviewedPlan }] : [],
    done: fixture.reviewedPlan.archivedAt === null ? [] : [{ ...fixture.reviewedPlan }]
  })),
  resolveContinuity: vi.fn(async () => fixture.continuity)
}));

vi.mock('../src/main/agents.js', () => ({
  PRIME_ID: 'prime',
  heartbeatReviewWorkerCall: () => fixture.reviewWorker
}));

vi.mock('../src/main/mcp/call-context.js', () => ({
  currentAgent: () => fixture.agent,
  currentCaller: () => fixture.caller,
  currentCall: () => fixture.call
}));

vi.mock('../src/main/chat-review-heartbeat.js', () => ({
  CHAT_REVIEW_PLAN_CLASSIFICATIONS: ['ready-to-archive', 'stale-checklist', 'tbd', 'blocked', 'superseded', 'awaiting-user'],
  acknowledgeChatReviewPlan: fixture.acknowledge,
  chatReviewRequiresWorker: vi.fn(async () => fixture.workerRequired),
  listChatReviewPlanReconciliations: fixture.pendingHousekeeping,
  reconcileChatReviewPlanHousekeeping: fixture.reconcileHousekeeping,
  resolveChatReviewContinuity: fixture.resolveContinuity
}));

vi.mock('../src/main/plans.js', () => ({
  archiveExactReadyEvePlan: fixture.archiveExact,
  completePlanItemsForReview: fixture.completeItems,
  listPlans: fixture.listPlans
}));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ eveAuthority: { archiveCompletedWork: fixture.archiveAuthority } })
}));

vi.mock('../src/main/session/store.js', () => ({
  getSession: async (id: string) => fixture.sessions.get(id) ?? null
}));

vi.mock('../src/main/mcp/tool-declarations.js', () => ({
  toolDeclaration: (_name: string, create: () => unknown) => create()
}));

vi.mock('../src/main/mcp/kernel.js', () => ({
  guard: (_name: string, fn: () => unknown) => fn(),
  ok: (text: string) => ({ content: [{ type: 'text', text }] }),
  fail: (text: string) => ({ isError: true, content: [{ type: 'text', text }] })
}));

const { registerChatReviewPlanTool, registerChatReviewHousekeepingTool } = await import('../src/main/mcp/chat-review-plan-tool.js');

function registered() {
  const capture: { declaration?: any; handler?: (args: any) => Promise<any> } = {};
  registerChatReviewPlanTool({
    sessionToolsLive: true,
    register: (_name: string, declaration: unknown, handler: (args: any) => Promise<any>) => {
      capture.declaration = declaration;
      capture.handler = handler;
    },
    featureDisabled: () => ({ isError: true })
  } as any);
  if (!capture.handler || !capture.declaration) throw new Error('chat_review_plan was not registered');
  return capture as { declaration: any; handler: (args: any) => Promise<any> };
}

function housekeeping() {
  let handler: ((args: any) => Promise<any>) | undefined;
  registerChatReviewHousekeepingTool({
    sessionToolsLive: true,
    register: (_name: string, _declaration: unknown, handle: (args: any) => Promise<any>) => { handler = handle; },
    featureDisabled: () => ({ isError: true })
  } as any);
  if (!handler) throw new Error('chat_review_housekeeping was not registered');
  return handler;
}

const input = {
  key: 'heartbeat:review',
  plan_id: PLAN_ID,
  expected_updated_at: 10,
  classification: 'tbd' as const
};

describe('chat_review_plan lifecycle tool', () => {
  beforeEach(() => {
    fixture.agent = null;
    fixture.reviewWorker = false;
    fixture.caller = {
      transportKey: null,
      requestId: 'wfr_review',
      sessionId: 'session-prime',
      conversationId: 'conversation-prime',
      localPrincipal: null
    };
    fixture.call = { startedAt: 123, caller: fixture.caller };
    fixture.continuity = { sessionId: 'session-prime', conversationId: 'conversation-prime' };
    fixture.sessions.clear();
    fixture.sessions.set('session-prime', {
      id: 'session-prime',
      conversationId: 'conversation-prime',
      origin: null
    });
    fixture.currentPlan = {
      id: PLAN_ID,
      updatedAt: 10,
      provenance: {
        kind: 'message',
        threadId: '33333333-3333-4333-8333-333333333333',
        sessionId: 'source-session',
        conversationId: 'source-conversation',
        messageId: 'source-message',
        label: 'Exact source'
      }
    };
    fixture.acknowledgement = 'acknowledged';
    fixture.archiveAuthority = true;
    fixture.workerRequired = false;
    fixture.reviewedPlan = {
      id: PLAN_ID,
      updatedAt: 10,
      provenance: { kind: 'plan', sessionId: 'source-session', conversationId: 'source-conversation' },
      audience: 'human',
      readyToArchive: false,
      archivedAt: null
    };
    fixture.acknowledge.mockClear();
    fixture.completeItems.mockClear();
    fixture.archiveExact.mockClear();
    fixture.archiveExact.mockResolvedValue('archived');
    fixture.pendingHousekeeping.mockClear();
    fixture.reconcileHousekeeping.mockClear();
    fixture.listPlans.mockClear();
    fixture.resolveContinuity.mockClear();
  });

  it('publishes the exact bounded lifecycle schema', () => {
    const schema = registered().declaration.inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, classification: 'done' }).success).toBe(false);
    expect(schema.safeParse({ ...input, completed_item_ids: [ITEM_ID, ITEM_ID] }).success).toBe(false);
    expect(schema.safeParse({ ...input, classification: 'stale-checklist', stale_item_ids: [ITEM_ID] }).success).toBe(true);
    expect(schema.safeParse({ ...input, classification: 'stale-checklist' }).success).toBe(true);
    expect(schema.safeParse({ ...input, extra: true }).success).toBe(false);
  });

  it('validates heartbeat authority before applying the bounded done-only mutation and acknowledges the post-mutation Plan', async () => {
    const reply = await registered().handler({ ...input, completed_item_ids: [ITEM_ID] });

    expect(reply.isError).not.toBe(true);
    expect(reply.content[0].text).toBe('Heartbeat Plan review acknowledged.');
    expect(fixture.acknowledge).toHaveBeenCalledTimes(1);
    expect(fixture.acknowledge.mock.calls[0]![0]).toEqual({
      key: input.key,
      sessionId: 'session-prime',
      conversationId: 'conversation-prime',
      planId: PLAN_ID,
      expectedUpdatedAt: 10,
      classification: 'tbd',
      requestId: 'wfr_review',
      completedItemIds: [ITEM_ID]
    });
    expect(fixture.completeItems).toHaveBeenCalledExactlyOnceWith(PLAN_ID, [ITEM_ID], 10, {
      provenance: fixture.currentPlan.provenance
    });
    expect(fixture.archiveExact).not.toHaveBeenCalled();
  });

  it('archives an exact reviewed Eve Plan when it is ready and archive authority is enabled', async () => {
    fixture.reviewedPlan = {
      id: PLAN_ID,
      updatedAt: 10,
      provenance: { kind: 'plan', sessionId: 'source-session', conversationId: 'source-conversation' },
      audience: 'eve',
      readyToArchive: true,
      archivedAt: null
    };

    const reply = await registered().handler({ ...input, classification: 'ready-to-archive' });

    expect(reply.isError).not.toBe(true);
    expect(fixture.acknowledge.mock.calls[0]![0]).not.toHaveProperty('completedItemIds');
    expect(fixture.listPlans).toHaveBeenCalledTimes(1);
    expect(fixture.archiveExact).toHaveBeenCalledExactlyOnceWith({
      planId: PLAN_ID,
      updatedAt: 10,
      provenance: fixture.reviewedPlan.provenance,
      sessionId: 'source-session'
    });
  });

  it('reports exact Eve archive drift instead of quietly acknowledging successful cleanup', async () => {
    fixture.reviewedPlan = {
      id: PLAN_ID,
      updatedAt: 10,
      provenance: { kind: 'plan', sessionId: 'source-session', conversationId: 'source-conversation' },
      audience: 'eve',
      readyToArchive: true,
      archivedAt: null
    };
    fixture.archiveExact.mockResolvedValue('stale');
    const reply = await registered().handler({ ...input, classification: 'ready-to-archive' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_ARCHIVE_DEFERRED');
    expect(fixture.archiveExact).toHaveBeenCalledTimes(1);
  });

  it('never auto-archives a reviewed human Plan', async () => {
    fixture.reviewedPlan = {
      id: PLAN_ID,
      updatedAt: 10,
      provenance: { kind: 'plan', sessionId: 'source-session', conversationId: 'source-conversation' },
      audience: 'human',
      readyToArchive: true,
      archivedAt: null
    };

    const reply = await registered().handler({ ...input, classification: 'ready-to-archive' });

    expect(reply.isError).not.toBe(true);
    expect(fixture.archiveExact).not.toHaveBeenCalled();
  });

  it('records stale checklist evidence for the exact heartbeat worker without mutation authority', async () => {
    fixture.reviewWorker = true;
    fixture.workerRequired = true;
    const reply = await registered().handler({
      ...input,
      classification: 'stale-checklist',
      stale_item_ids: [ITEM_ID]
    });

    expect(reply.isError).not.toBe(true);
    expect(fixture.acknowledge.mock.calls[0]![0]).toMatchObject({
      classification: 'stale-checklist',
      staleItemIds: [ITEM_ID]
    });
    expect(fixture.acknowledge.mock.calls[0]![0]).not.toHaveProperty('completedItemIds');
    expect(fixture.completeItems).not.toHaveBeenCalled();
    expect(fixture.archiveExact).not.toHaveBeenCalled();
  });

  it('recovers only the exact heartbeat continuity for a headless request before acknowledging', async () => {
    fixture.caller = {
      transportKey: null,
      requestId: 'wfr_headless',
      sessionId: null as any,
      conversationId: null as any,
      localPrincipal: null
    };
    fixture.call = { startedAt: 123, caller: fixture.caller };

    const reply = await registered().handler(input);

    expect(reply.isError).not.toBe(true);
    expect(fixture.resolveContinuity).toHaveBeenCalledExactlyOnceWith(input.key);
    expect(fixture.call.caller).toMatchObject({ sessionId: 'session-prime', conversationId: 'conversation-prime' });
    expect(fixture.acknowledge.mock.calls[0]![0]).not.toHaveProperty('requestId');
    expect(fixture.acknowledge.mock.calls[0]![0]).not.toHaveProperty('completedItemIds');
    expect(fixture.completeItems).not.toHaveBeenCalled();
  });

  it('rejects worker and helper callers before any Plan or heartbeat mutation', async () => {
    fixture.agent = 'worker-5';
    let reply = await registered().handler(input);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_CALLER_REJECTED');
    expect(fixture.acknowledge).not.toHaveBeenCalled();

    fixture.agent = null;
    fixture.sessions.set('session-prime', {
      id: 'session-prime',
      conversationId: 'conversation-prime',
      origin: { kind: 'helper', fromSessionId: 'other' }
    });
    reply = await registered().handler(input);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_CALLER_REJECTED');
    expect(fixture.acknowledge).not.toHaveBeenCalled();
  });

  it('allows only the exact app-owned heartbeat worker to classify without mutating the Plan', async () => {
    fixture.agent = 'worker-5';
    fixture.reviewWorker = true;
    fixture.workerRequired = true;
    fixture.caller = {
      transportKey: null,
      requestId: 'wfr_worker_review',
      sessionId: 'worker-session',
      conversationId: 'worker-conversation',
      localPrincipal: null
    };
    fixture.call = { startedAt: 123, caller: fixture.caller };

    const reply = await registered().handler(input);
    expect(reply.isError).not.toBe(true);
    expect(fixture.acknowledge.mock.calls[0]![0]).toMatchObject({
      sessionId: 'session-prime',
      conversationId: 'conversation-prime',
      classification: 'tbd'
    });
    expect(fixture.acknowledge.mock.calls[0]![0]).not.toHaveProperty('requestId');
    expect(fixture.completeItems).not.toHaveBeenCalled();
    expect(fixture.archiveExact).not.toHaveBeenCalled();

    const mutation = await registered().handler({ ...input, completed_item_ids: [ITEM_ID] });
    expect(mutation.isError).toBe(true);
    expect(mutation.content[0].text).toContain('CHAT_REVIEW_PLAN_READ_ONLY');
  });

  it('rejects Prime on a new worker-owned heartbeat Plan epoch', async () => {
    fixture.workerRequired = true;
    const reply = await registered().handler(input);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_WORKER_REQUIRED');
    expect(fixture.acknowledge).not.toHaveBeenCalled();
  });

  it('returns actionable stale and authority conflict messages without inventing a recovery target', async () => {
    fixture.completeItems.mockRejectedValueOnce(new Error('Plan changed; refresh before editing it again'));
    let reply = await registered().handler({ ...input, completed_item_ids: [ITEM_ID] });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_STALE');
    expect(reply.content[0].text).toContain('Re-read this exact Plan');

    fixture.completeItems.mockRejectedValueOnce(new Error('Plan source changed; refresh before editing it again'));
    reply = await registered().handler({ ...input, completed_item_ids: [ITEM_ID] });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_CONFLICT');
    expect(reply.content[0].text).toContain('Plan source changed');

    fixture.acknowledgement = 'rejected';
    reply = await registered().handler(input);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_REJECTED');
    expect(reply.content[0].text).toContain('current heartbeat prompt');
  });

  it('treats an identical durable acknowledgement as an idempotent success', async () => {
    fixture.acknowledgement = 'already-acknowledged';
    const reply = await registered().handler({ ...input, completed_item_ids: [ITEM_ID] });
    expect(reply.isError).not.toBe(true);
    expect(reply.content[0].text).toBe('Heartbeat Plan review was already acknowledged.');
    expect(fixture.acknowledge.mock.calls[0]![0]).toMatchObject({
      expectedUpdatedAt: 10,
      classification: 'tbd',
      requestId: 'wfr_review',
      completedItemIds: [ITEM_ID]
    });
    expect(fixture.completeItems).not.toHaveBeenCalled();
  });

  it('fails a conflicting replay without rerunning Plan reconciliation', async () => {
    fixture.acknowledgement = 'rejected';
    const reply = await registered().handler({ ...input, classification: 'blocked', completed_item_ids: [ITEM_ID] });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('CHAT_REVIEW_PLAN_REJECTED');
    expect(fixture.acknowledge.mock.calls[0]![0]).toMatchObject({
      expectedUpdatedAt: 10,
      classification: 'blocked',
      requestId: 'wfr_review',
      completedItemIds: [ITEM_ID]
    });
    expect(fixture.completeItems).not.toHaveBeenCalled();
  });

  it('allows exact ordinary Prime to list and consume only durable housekeeping targets', async () => {
    const list = await housekeeping()({ action: 'list' });
    expect(list.isError).not.toBe(true);
    expect(list.content[0].text).toContain(PLAN_ID);
    expect(fixture.pendingHousekeeping).toHaveBeenCalledWith('session-prime');

    const reconcile = await housekeeping()({ action: 'reconcile', plan_id: PLAN_ID });
    expect(reconcile.isError).not.toBe(true);
    expect(fixture.reconcileHousekeeping).toHaveBeenCalledWith('session-prime', PLAN_ID);
    expect(fixture.reconcileHousekeeping).toHaveBeenCalledTimes(1);
  });

  it('refuses housekeeping from workers, helpers, local, and unattributed callers', async () => {
    fixture.agent = 'worker-5';
    let reply = await housekeeping()({ action: 'reconcile', plan_id: PLAN_ID });
    expect(reply.isError).toBe(true);
    fixture.agent = null;
    fixture.sessions.get('session-prime').origin = { kind: 'helper' };
    reply = await housekeeping()({ action: 'reconcile', plan_id: PLAN_ID });
    expect(reply.isError).toBe(true);
    fixture.sessions.get('session-prime').origin = null;
    fixture.caller.localPrincipal = { kind: 'local' };
    reply = await housekeeping()({ action: 'reconcile', plan_id: PLAN_ID });
    expect(reply.isError).toBe(true);
    fixture.caller.localPrincipal = null;
    fixture.caller.requestId = '';
    reply = await housekeeping()({ action: 'reconcile', plan_id: PLAN_ID });
    expect(reply.isError).toBe(true);
    expect(fixture.reconcileHousekeeping).not.toHaveBeenCalled();
  });
});
