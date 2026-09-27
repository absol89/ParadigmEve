import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const sessions = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  events: new Map<string, any[]>()
}));
const plans = vi.hoisted(() => ({ library: { live: [] as any[], done: [] as any[] } }));

vi.mock('../src/main/session/store.js', () => ({
  getSession: async (id: string) => sessions.rows.get(id) ?? null,
  readEvents: async (id: string, options: { from?: number; kinds?: SessionEvent['kind'][] } = {}) =>
    (sessions.events.get(id) ?? []).filter((event: SessionEvent) =>
      event.seq >= (options.from ?? 0) && (!options.kinds || options.kinds.includes(event.kind)))
}));
vi.mock('../src/main/plans.js', () => ({ listPlans: async () => plans.library }));

import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  ensureRequestTrail,
  completeRequestImplementationFromResult,
  listRequestTrail,
  refreshRequestTrailPlanMilestones,
  requestTrailById,
  requestTrailByOrigin,
  resetRequestTrailForTests,
  updateRequestTrail
} from '../src/main/request-trail.js';
import { requestTrailMilestoneStates, requestTrailOriginKey } from '../src/shared/request-trail.js';

let dir = '';
const sessionId = 'session-aaaa';
const conversationId = 'conversation-aaaa';
const planId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const quiltId = '44444444-4444-4444-8444-444444444444';
const evePlanId = '55555555-5555-4555-8555-555555555555';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sessionId,
    title: 'request trail test',
    conversationId,
    chatIds: [conversationId],
    startedAt: 1,
    updatedAt: 1,
    endedAt: null,
    events: 1,
    userMessages: 1,
    toolCalls: 0,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null,
    ...overrides
  } as SessionSummary;
}

function user(seq = 10, overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    seq,
    time: 100,
    source: 'extension',
    kind: 'user_message',
    messageId: 'user-message-1',
    turnId: 'turn-1',
    message: { text: 'Do the long-running work', chars: 24, truncated: false },
    ...overrides
  } as SessionEvent;
}

function assistant(seq = 20): SessionEvent {
  return {
    seq,
    time: 200,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'assistant-result-1',
    turnId: 'turn-1',
    message: { text: 'Here is the result', chars: 18, truncated: false },
    state: 'final',
    final: true
  } as SessionEvent;
}

beforeEach(async () => {
  dir = await makeTempDir('paradigmeve-request-trail-');
  initDurableStore(dir);
  resetRequestTrailForTests();
  sessions.rows.clear();
  sessions.events.clear();
  sessions.rows.set(sessionId, summary());
  sessions.events.set(sessionId, [user(), assistant()]);
  plans.library = { live: [], done: [] };
});

afterEach(async () => {
  resetRequestTrailForTests();
  resetDurableForTests();
  sessions.rows.clear();
  sessions.events.clear();
  plans.library = { live: [], done: [] };
  await removeTempDir(dir);
});

describe('durable request trail', () => {
  it('accepts one exact user event, dedupes retries by session+canonical event, and survives a reload', async () => {
    const origin = { sessionId, conversationId, eventSeq: 10 };
    const first = await ensureRequestTrail({ origin, summary: 'Audit the long-running request' });
    const retry = await ensureRequestTrail({ origin: { ...origin, messageId: 'user-message-1' }, summary: 'Different retry prose' });
    expect(retry).toEqual(first);
    expect(first.origin).toMatchObject({ ...origin, messageId: 'user-message-1', turnId: 'turn-1' });
    expect(requestTrailOriginKey(first.origin)).toBe(`${sessionId}:10`);

    resetRequestTrailForTests();
    expect(await requestTrailById(first.id)).toEqual(first);
    expect(await requestTrailByOrigin(first.origin)).toEqual(first);
    expect(await fs.stat(path.join(dir, 'state', 'request-trail.json'))).toBeTruthy();
  });

  it('still dedupes the same source when a provider conversation locator becomes available later', async () => {
    const first = await ensureRequestTrail({
      origin: { sessionId, conversationId: null, eventSeq: 10 },
      summary: 'Accepted before the provider route settled'
    });
    const later = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10, messageId: 'user-message-1' },
      summary: 'Retry after provider route settled'
    });
    expect(later.id).toBe(first.id);
    expect(await listRequestTrail()).toHaveLength(1);
  });

  it('uses the first canonical user-message sequence even when the stored revision moved later', async () => {
    sessions.events.set(sessionId, [user(14, { origin: 10, message: { text: 'edited request', chars: 14, truncated: false } })]);
    const accepted = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10, messageId: 'user-message-1' },
      summary: 'Edited request still has one identity'
    });
    expect(accepted.origin.eventSeq).toBe(10);
    await expect(ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 14 }, summary: 'Wrong revision sequence'
    })).rejects.toThrow(/exact recorded event/i);
  });

  it('rejects guessed provenance instead of deriving authority from nearby prose', async () => {
    await expect(ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 20 }, summary: 'Assistant prose is not the request'
    })).rejects.toThrow(/exact recorded event/i);
    await expect(ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10, messageId: 'some-similar-message' }, summary: 'Wrong message id'
    })).rejects.toThrow(/message id does not match/i);
    await expect(ensureRequestTrail({
      origin: { sessionId, conversationId: 'conversation-elsewhere', eventSeq: 10 }, summary: 'Wrong chat'
    })).rejects.toThrow(/does not belong/i);
  });

  it('retains explicit Plan, worker-status, result, Needs-you, Thread and Quilt refs without copying their authority', async () => {
    const row = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 },
      summary: 'Coordinate the long job',
      planId,
      workers: [{ runId, workerId: 'worker-3', conversationId: 'conversation-worker-3' }],
      threadId,
      quiltIds: [quiltId]
    });
    const resultRef = { sessionId, conversationId, eventSeq: 20, kind: 'assistant_message' as const, messageId: 'assistant-result-1', turnId: 'turn-1' };
    const needs = await updateRequestTrail(row.id, { state: 'needs_user', needsUserRef: resultRef });
    expect(needs).toMatchObject({ state: 'needs_user', planId, threadId, quiltIds: [quiltId] });
    expect(needs.workers).toEqual([{ runId, workerId: 'worker-3', conversationId: 'conversation-worker-3' }]);
    expect(needs.needsUserRef).toEqual(resultRef);
    expect(needs.stateChangedAt).toBeGreaterThanOrEqual(row.stateChangedAt);
    expect(requestTrailMilestoneStates(needs)).toEqual({ implementation: 'pending', eveActivity: 'open', userPlanSignoff: 'pending' });
  });

  it('treats a user Plan final checkbox as implementation complete but not signoff until structural archive', async () => {
    const row = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 },
      summary: 'Finish the high-level Plan',
      planId
    });
    plans.library.live = [{
      id: planId, audience: 'human', readyToArchive: true, archivedAt: null, updatedAt: 500,
      section: 'live', items: [{ status: 'done' }]
    }];
    const ready = await refreshRequestTrailPlanMilestones(row.id);
    expect(ready.implementationCompletedAt).toBe(500);
    expect(ready.userPlanArchivedAt).toBeNull();
    expect(ready.eveActivityClosedAt).toBeNull();
    expect(requestTrailMilestoneStates(ready)).toEqual({ implementation: 'complete', eveActivity: 'open', userPlanSignoff: 'pending' });

    plans.library.live = [{
      ...plans.library.live[0], readyToArchive: false, updatedAt: 550,
      items: [{ status: 'done' }, { status: 'todo' }]
    }];
    const reopened = await refreshRequestTrailPlanMilestones(row.id);
    expect(reopened.implementationCompletedAt).toBeNull();
    expect(requestTrailMilestoneStates(reopened)).toEqual({ implementation: 'pending', eveActivity: 'open', userPlanSignoff: 'pending' });

    plans.library.live = [{
      ...plans.library.live[0], readyToArchive: true, updatedAt: 600,
      items: [{ status: 'done' }, { status: 'done' }]
    }];
    const readyAgain = await refreshRequestTrailPlanMilestones(row.id);
    expect(readyAgain.implementationCompletedAt).toBe(600);

    plans.library = { live: [], done: [{
      ...plans.library.live[0], section: 'done', readyToArchive: false, archivedAt: 650, updatedAt: 650
    }] };
    const signedOff = await refreshRequestTrailPlanMilestones(row.id);
    expect(signedOff.implementationCompletedAt).toBe(600);
    expect(signedOff.userPlanArchivedAt).toBe(650);
    expect(requestTrailMilestoneStates(signedOff)).toEqual({ implementation: 'complete', eveActivity: 'open', userPlanSignoff: 'archived' });
  });

  it('does not close Eve Activity when its Plan is merely ready to archive, only after structural archive', async () => {
    const row = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 },
      summary: 'Track Eve Activity independently',
      eveActivityPlanIds: [evePlanId]
    });
    plans.library.live = [{
      id: evePlanId, audience: 'eve', readyToArchive: true, archivedAt: null, updatedAt: 700,
      section: 'live', items: [{ status: 'done' }]
    }];
    const ready = await refreshRequestTrailPlanMilestones(row.id);
    expect(ready.eveActivityClosedAt).toBeNull();
    expect(requestTrailMilestoneStates(ready).eveActivity).toBe('open');

    plans.library = { live: [], done: [{
      ...plans.library.live[0], section: 'done', readyToArchive: false, archivedAt: 800, updatedAt: 800
    }] };
    const closed = await refreshRequestTrailPlanMilestones(row.id);
    expect(closed.eveActivityClosedAt).toBe(800);
    expect(requestTrailMilestoneStates(closed).eveActivity).toBe('closed');
    expect(requestTrailMilestoneStates(closed).userPlanSignoff).toBe('none');
  });

  it('reopens Eve Activity when the linked Activity Plan set changes until the new set is structurally closed', async () => {
    const secondEvePlanId = '66666666-6666-4666-8666-666666666666';
    const row = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 },
      summary: 'Expand Eve Activity',
      eveActivityPlanIds: [evePlanId]
    });
    plans.library.done = [{
      id: evePlanId, audience: 'eve', readyToArchive: false, archivedAt: 800, updatedAt: 800,
      section: 'done', items: [{ status: 'done' }]
    }];
    const closed = await refreshRequestTrailPlanMilestones(row.id);
    expect(closed.eveActivityClosedAt).toBe(800);

    const expanded = await updateRequestTrail(row.id, { eveActivityPlanIds: [evePlanId, secondEvePlanId] });
    expect(expanded.eveActivityClosedAt).toBeNull();
    plans.library.live = [{
      id: secondEvePlanId, audience: 'eve', readyToArchive: true, archivedAt: null, updatedAt: 850,
      section: 'live', items: [{ status: 'done' }]
    }];
    expect((await refreshRequestTrailPlanMilestones(row.id)).eveActivityClosedAt).toBeNull();
  });

  it('allows an exact result event to complete implementation only when no high-level Plan owns that boundary', async () => {
    const noPlan = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 }, summary: 'Small request without a Plan'
    });
    const resultRef = { sessionId, conversationId, eventSeq: 20, kind: 'assistant_message' as const, messageId: 'assistant-result-1', turnId: 'turn-1' };
    const completed = await completeRequestImplementationFromResult(noPlan.id, resultRef);
    expect(completed.implementationCompletedAt).toBe(200);
    expect(completed.resultRef).toEqual(resultRef);
    expect(requestTrailMilestoneStates(completed).userPlanSignoff).toBe('none');

    const withPlan = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10, messageId: 'user-message-1' },
      summary: 'Retry returns existing request'
    });
    expect(withPlan.id).toBe(noPlan.id);

    const secondSession = 'session-plan-owner';
    sessions.rows.set(secondSession, summary({ id: secondSession, conversationId: 'conversation-plan-owner', chatIds: ['conversation-plan-owner'] }));
    sessions.events.set(secondSession, [user(10), assistant(20)]);
    const linked = await ensureRequestTrail({
      origin: { sessionId: secondSession, conversationId: 'conversation-plan-owner', eventSeq: 10 },
      summary: 'Plan owns completion', planId
    });
    await expect(completeRequestImplementationFromResult(linked.id, {
      ...resultRef, sessionId: secondSession, conversationId: 'conversation-plan-owner'
    })).rejects.toThrow(/Plan owns implementation completion/i);
  });

  it('rejects audience confusion instead of treating Eve Activity archive as user Plan signoff', async () => {
    const row = await ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 }, summary: 'Wrong Plan audience', planId
    });
    plans.library.done = [{
      id: planId, audience: 'eve', readyToArchive: false, archivedAt: 900, updatedAt: 900,
      section: 'done', items: [{ status: 'done' }]
    }];
    await expect(refreshRequestTrailPlanMilestones(row.id)).rejects.toThrow(/high-level Plan must be user-owned/i);
  });

  it('requires exact event refs and a concrete Needs-you locator for needs_user state', async () => {
    const row = await ensureRequestTrail({ origin: { sessionId, conversationId, eventSeq: 10 }, summary: 'Needs evidence' });
    await expect(updateRequestTrail(row.id, { state: 'needs_user' })).rejects.toThrow(/exact session-event reference/i);
    await expect(updateRequestTrail(row.id, {
      resultRef: { sessionId, conversationId, eventSeq: 20, kind: 'tool_call', messageId: 'assistant-result-1' }
    })).rejects.toThrow(/exact recorded event/i);
  });

  it('rejects duplicate worker status refs instead of fabricating two workers from one broker identity', async () => {
    await expect(ensureRequestTrail({
      origin: { sessionId, conversationId, eventSeq: 10 },
      summary: 'Duplicate worker ref',
      workers: [
        { runId, workerId: 'worker-3' },
        { runId, workerId: 'worker-3', conversationId: 'conversation-worker-3' }
      ]
    })).rejects.toThrow(/worker status refs must be unique/i);
  });

  it('keeps different source sessions distinct even when their event sequence and prose match', async () => {
    const otherSession = 'session-bbbb';
    sessions.rows.set(otherSession, summary({ id: otherSession, conversationId: 'conversation-bbbb', chatIds: ['conversation-bbbb'] }));
    sessions.events.set(otherSession, [user(10)]);
    const first = await ensureRequestTrail({ origin: { sessionId, conversationId, eventSeq: 10 }, summary: 'Same prose' });
    const second = await ensureRequestTrail({ origin: { sessionId: otherSession, conversationId: 'conversation-bbbb', eventSeq: 10 }, summary: 'Same prose' });
    expect(second.id).not.toBe(first.id);
    expect(await listRequestTrail()).toHaveLength(2);
  });

  it('fails closed on malformed durable state instead of replacing the trail with an empty catalog', async () => {
    await writeDurableNow('request-trail', { version: 1, requests: [{ prose: 'looks close enough' }] });
    await expect(listRequestTrail()).rejects.toThrow(/request trail is invalid/i);
  });
});
