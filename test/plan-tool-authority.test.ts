import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  authority: true,
  sharedOwner: null as string | null,
  currentAgentConversationId: 'conversation-worker' as string | null,
  caller: { sessionId: 'session-worker', conversationId: 'conversation-worker' },
  sessions: new Map<string, any>(),
  accepted: true,
  projected: { id: 'plan-1', readyToArchive: true, audience: 'human' as 'human' | 'eve', archivedAt: null as number | null },
  archivePlan: vi.fn(async () => ({ id: 'plan-1', section: 'done' })),
  syncSessionAgentPlan: vi.fn(async () => ({ ...fixture.projected })),
  listPlans: vi.fn(async () => ({
    live: fixture.projected.archivedAt === null ? [{ ...fixture.projected }] : [],
    done: fixture.projected.archivedAt === null ? [] : [{ ...fixture.projected }]
  })),
  ensureRequestTrailForAcceptedPlan: vi.fn(async () => null),
  updateSessionPlan: vi.fn(async () => fixture.accepted)
}));

vi.mock('../src/main/mcp/call-context.js', () => ({
  currentAgent: () => null,
  currentCaller: () => fixture.caller,
  currentCall: () => ({ startedAt: 123 })
}));

vi.mock('../src/main/session/store.js', () => ({
  getSession: async (id: string) => fixture.sessions.get(id) ?? null,
  findSessionByConversation: async (conversationId: string) =>
    [...fixture.sessions.values()].find((session: any) => session.conversationId === conversationId) ?? null,
  updateSessionPlan: fixture.updateSessionPlan
}));

vi.mock('../src/main/eve-access.js', () => ({
  sharedEveOwnerForCurrentCall: () => fixture.sharedOwner
}));

vi.mock('../src/main/plans.js', () => ({
  archivePlan: fixture.archivePlan,
  listPlans: fixture.listPlans,
  syncSessionAgentPlan: fixture.syncSessionAgentPlan
}));

vi.mock('../src/main/request-trail-admission.js', () => ({
  ensureRequestTrailForAcceptedPlan: fixture.ensureRequestTrailForAcceptedPlan
}));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ eveAuthority: { archiveCompletedWork: fixture.authority } })
}));

vi.mock('../src/main/agent-identity.js', () => ({
  currentAgentConversationId: () => fixture.currentAgentConversationId
}));

vi.mock('../src/main/mcp/tool-declarations.js', () => ({
  toolDeclaration: (_name: string, create: () => unknown) => create()
}));

vi.mock('../src/main/mcp/kernel.js', () => ({
  guard: (_name: string, fn: () => unknown) => fn(),
  ok: (text: string) => ({ content: [{ type: 'text', text }] }),
  fail: (text: string) => ({ isError: true, content: [{ type: 'text', text }] })
}));

const { registerPlanTool } = await import('../src/main/mcp/plan-tool.js');

function registeredHandler() {
  const capture: { handler?: (args: any) => Promise<any> } = {};
  registerPlanTool({
    sessionToolsLive: true,
    register: (_name: string, _declaration: unknown, next: (args: any) => Promise<any>) => {
      capture.handler = next;
    },
    featureDisabled: () => ({ isError: true })
  } as any);
  if (!capture.handler) throw new Error('update_plan handler was not registered');
  return capture.handler;
}

const complete = { plan: [{ step: 'Finish it', status: 'completed' as const }] };

describe('update_plan archive boundary', () => {
  beforeEach(() => {
    fixture.authority = true;
    fixture.sharedOwner = null;
    fixture.currentAgentConversationId = 'conversation-worker';
    fixture.caller = { sessionId: 'session-worker', conversationId: 'conversation-worker' };
    fixture.sessions.clear();
    fixture.sessions.set('session-worker', {
      id: 'session-worker',
      title: 'worker-1 · Finish polish',
      origin: { kind: 'worker', fromSessionId: 'session-prime', agentId: 'worker-1', task: 'Finish polish' }
    });
    fixture.accepted = true;
    fixture.projected = { id: 'plan-1', readyToArchive: true, audience: 'human', archivedAt: null };
    fixture.archivePlan.mockClear();
    fixture.listPlans.mockClear();
    fixture.syncSessionAgentPlan.mockClear();
    fixture.ensureRequestTrailForAcceptedPlan.mockClear();
    fixture.updateSessionPlan.mockClear();
  });

  it('keeps completed worker Activity live for lifecycle evidence even when Eve archive authority is enabled', async () => {
    fixture.projected = { id: 'plan-1', readyToArchive: true, audience: 'eve', archivedAt: null };
    const reply = await registeredHandler()(complete);
    expect(fixture.syncSessionAgentPlan).toHaveBeenCalledTimes(1);
    expect(fixture.ensureRequestTrailForAcceptedPlan).toHaveBeenCalledTimes(1);
    expect(fixture.archivePlan).not.toHaveBeenCalled();
    expect(reply.content[0].text).toBe('Plan updated');
  });

  it('leaves the exact Eve Prime human Plan Ready to archive instead of signing it off', async () => {
    fixture.sessions.set('session-worker', { id: 'session-worker', title: 'Ordinary chat', origin: null });
    const reply = await registeredHandler()(complete);
    expect(fixture.syncSessionAgentPlan).toHaveBeenCalledTimes(1);
    expect(fixture.ensureRequestTrailForAcceptedPlan).toHaveBeenCalledWith({
      sessionId: 'session-worker',
      conversationId: 'conversation-worker',
      plan: fixture.projected
    });
    expect(fixture.projected).toMatchObject({ readyToArchive: true, audience: 'human' });
    expect(fixture.archivePlan).not.toHaveBeenCalled();
    expect(reply.content[0].text).toBe('Plan updated');
  });

  it('keeps completed Eve-owned helper Activity live until its lifecycle owner has closure evidence', async () => {
    fixture.projected = { id: 'plan-1', readyToArchive: true, audience: 'eve', archivedAt: null };
    fixture.sessions.set('session-worker', {
      id: 'session-worker',
      title: 'Helper activity',
      origin: { kind: 'helper', fromSessionId: 'session-prime' }
    });
    const reply = await registeredHandler()(complete);
    expect(fixture.syncSessionAgentPlan).toHaveBeenCalledTimes(1);
    expect(fixture.archivePlan).not.toHaveBeenCalled();
    expect(reply.content[0].text).toBe('Plan updated');
  });

  it('keeps completed Eve Activity live when archive authority is disabled', async () => {
    fixture.authority = false;
    fixture.projected = { id: 'plan-1', readyToArchive: true, audience: 'eve', archivedAt: null };
    const reply = await registeredHandler()(complete);
    expect(reply.content[0].text).toBe('Plan updated');
    expect(fixture.archivePlan).not.toHaveBeenCalled();
  });

  it('does not admit a Request Trail when the exact session rejects a stale plan update', async () => {
    fixture.accepted = false;
    const reply = await registeredHandler()(complete);
    expect(reply.isError).toBe(true);
    expect(fixture.syncSessionAgentPlan).not.toHaveBeenCalled();
    expect(fixture.ensureRequestTrailForAcceptedPlan).not.toHaveBeenCalled();
  });

  it('keeps an accepted Plan successful when only Request Trail continuity needs repair', async () => {
    fixture.sessions.set('session-worker', { id: 'session-worker', title: 'Ordinary chat', origin: null });
    fixture.ensureRequestTrailForAcceptedPlan.mockRejectedValueOnce(
      new Error('Accepted Plan does not have one exact canonical user request message on its active turn')
    );

    const reply = await registeredHandler()(complete);

    expect(reply.isError).not.toBe(true);
    expect(reply.content[0].text).toBe('Plan updated');
    expect(fixture.syncSessionAgentPlan).toHaveBeenCalledTimes(1);
    expect(fixture.ensureRequestTrailForAcceptedPlan).toHaveBeenCalledTimes(1);
  });

  it('lets connector-authenticated shared Eve update the durable Prime plan when exact Companion proof is unavailable', async () => {
    fixture.caller = { sessionId: null, conversationId: null } as any;
    fixture.sharedOwner = 'conversation-prime';
    fixture.sessions.set('session-prime', {
      id: 'session-prime',
      conversationId: 'conversation-prime',
      title: 'Prime Eve',
      origin: null
    });

    const reply = await registeredHandler()({ plan: [{ step: 'Voice plan update', status: 'in_progress' }] });

    expect(reply.isError).not.toBe(true);
    expect(fixture.updateSessionPlan).toHaveBeenCalledWith(
      'session-prime',
      'conversation-prime',
      expect.anything(),
      123
    );
    expect(fixture.syncSessionAgentPlan).toHaveBeenCalledWith(
      'session-prime',
      'conversation-prime',
      'Prime Eve',
      expect.anything()
    );
  });

  it('still refuses an unproven caller when shared Eve authority does not resolve one unique Prime session', async () => {
    fixture.caller = { sessionId: null, conversationId: null } as any;
    fixture.sharedOwner = 'conversation-missing';

    const reply = await registeredHandler()({ plan: [{ step: 'Should not write', status: 'pending' }] });

    expect(reply.isError).toBe(true);
    expect(fixture.updateSessionPlan).not.toHaveBeenCalled();
  });
});
