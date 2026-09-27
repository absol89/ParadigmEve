import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  request: null as any,
  pins: { version: 1, quilts: [] as any[], pins: [], collections: [] },
  plans: { live: [] as any[], done: [] as any[] },
  setPlanThreadSource: vi.fn(async () => ({}))
}));

vi.mock('../src/main/request-trail.js', () => ({
  listRequestTrail: vi.fn(async () => fixture.request ? [fixture.request] : []),
  requestTrailById: vi.fn(async (id: string) => fixture.request?.id === id ? fixture.request : null)
}));
vi.mock('../src/main/pins.js', () => ({ pinsLibrary: vi.fn(async () => fixture.pins) }));
vi.mock('../src/main/plans.js', () => ({
  listPlans: vi.fn(async () => fixture.plans),
  setPlanThreadSource: fixture.setPlanThreadSource
}));

import { reconcileRequestPlanThreadSource } from '../src/main/plan-source.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const planId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  fixture.setPlanThreadSource.mockClear();
  fixture.request = {
    id: requestId,
    planId,
    threadId
  };
  fixture.pins = {
    version: 1,
    quilts: [{ id: threadId, title: 'Requests', state: 'pinned', collectionIds: [], createdAt: 1, updatedAt: 1 }],
    pins: [],
    collections: []
  };
  fixture.plans = {
    live: [{ id: planId, audience: 'human', provenance: { kind: 'plan', sessionId: 'session-source' } }],
    done: []
  };
});

it('projects the exact Request Trail Thread id onto its linked human Plan', async () => {
  expect(await reconcileRequestPlanThreadSource(requestId)).toBe(true);
  expect(fixture.setPlanThreadSource).toHaveBeenCalledExactlyOnceWith(planId, threadId);
});

it('fails closed when only a same-titled different Thread exists', async () => {
  fixture.pins.quilts = [{
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Requests',
    state: 'pinned',
    collectionIds: [],
    createdAt: 1,
    updatedAt: 1
  }];

  await expect(reconcileRequestPlanThreadSource(requestId)).rejects.toThrow('Owning request Thread was not found');
  expect(fixture.setPlanThreadSource).not.toHaveBeenCalled();
});

it('clears a projected Thread when the Request Trail no longer owns one', async () => {
  fixture.request.threadId = null;
  fixture.plans.live[0].provenance.threadId = threadId;

  expect(await reconcileRequestPlanThreadSource(requestId)).toBe(true);
  expect(fixture.setPlanThreadSource).toHaveBeenCalledExactlyOnceWith(planId, null);
});
