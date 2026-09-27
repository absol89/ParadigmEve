import { beforeEach, describe, expect, it, vi } from 'vitest';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';

const fixture = vi.hoisted(() => ({
  agent: null as string | null,
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
  reviewedPlan: {
    id: '11111111-1111-4111-8111-111111111111',
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
  archivePlan: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', section: 'done' })),
  listPlans: vi.fn(async () => ({
    live: fixture.reviewedPlan.archivedAt === null ? [{ ...fixture.reviewedPlan }] : [],
    done: fixture.reviewedPlan.archivedAt === null ? [] : [{ ...fixture.reviewedPlan }]
  })),
  resolveContinuity: vi.fn(async () => fixture.continuity)
}));

vi.mock('../src/main/agents.js', () => ({ PRIME_ID: 'prime' }));

vi.mock('../src/main/mcp/call-context.js', () => ({
  currentAgent: () => fixture.agent,
  currentCaller: () => fixture.caller,
  currentCall: () => fixture.call
}));

vi.mock('../src/main/chat-review-heartbeat.js', () => ({
  CHAT_REVIEW_PLAN_CLASSIFICATIONS: ['ready-to-archive', 'tbd', 'blocked', 'superseded', 'awaiting-user'],
  acknowledgeChatReviewPlan: fixture.acknowledge,
  resolveChatReviewContinuity: fixture.resolveContinuity
}));

vi.mock('../src/main/plans.js', () => ({
  archivePlan: fixture.archivePlan,
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

const { registerChatReviewPlanTool } = await import('../src/main/mcp/chat-review-plan-tool.js');

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

const input = {
  key: 'heartbeat:review',
  plan_id: PLAN_ID,
  expected_updated_at: 10,
  classification: 'tbd' as const
};

describe('chat_review_plan lifecycle tool', () => {
  beforeEach(() => {
    fixture.agent = null;
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
    fixture.reviewedPlan = {
      id: PLAN_ID,
      audience: 'human',
      readyToArchive: false,
      archivedAt: null
    };
    fixture.acknowledge.mockClear();
    fixture.completeItems.mockClear();
    fixture.archivePlan.mockClear();
    fixture.listPlans.mockClear();
    fixture.resolveContinuity.mockClear();
  });

  it('publishes the exact bounded lifecycle schema', () => {
    const schema = registered().declaration.inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, classification: 'done' }).success).toBe(false);
    expect(schema.safeParse({ ...input, completed_item_ids: [ITEM_ID, ITEM_ID] }).success).toBe(false);
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
    expect(fixture.archivePlan).not.toHaveBeenCalled();
  });

  it('archives an exact reviewed Eve Plan when it is ready and archive authority is enabled', async () => {
    fixture.reviewedPlan = {
      id: PLAN_ID,
      audience: 'eve',
      readyToArchive: true,
      archivedAt: null
    };

    const reply = await registered().handler({ ...input, classification: 'ready-to-archive' });

    expect(reply.isError).not.toBe(true);
    expect(fixture.acknowledge.mock.calls[0]![0]).toMatchObject({
      requestId: 'wfr_review',
      completedItemIds: []
    });
    expect(fixture.listPlans).toHaveBeenCalledTimes(1);
    expect(fixture.archivePlan).toHaveBeenCalledExactlyOnceWith(PLAN_ID);
  });

  it('never auto-archives a reviewed human Plan', async () => {
    fixture.reviewedPlan = {
      id: PLAN_ID,
      audience: 'human',
      readyToArchive: true,
      archivedAt: null
    };

    const reply = await registered().handler({ ...input, classification: 'ready-to-archive' });

    expect(reply.isError).not.toBe(true);
    expect(fixture.archivePlan).not.toHaveBeenCalled();
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
});
