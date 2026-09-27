import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  completePlanItemsForReview,
  createPlan,
  resetPlansForTests,
  setPlanThreadSource,
  withPlanReviewValidationFence
} from '../src/main/plans.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-plan-review-'));
  resetPlansForTests();
  resetDurableForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetPlansForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('completes only exact open items while preserving Plan identity, metadata, order, and provenance', async () => {
  const plan = await createPlan({
    title: 'Review durable work',
    provenance: {
      kind: 'message',
      threadId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'session-review',
      conversationId: 'conversation-review',
      messageId: 'message-review',
      label: 'Exact review source'
    },
    items: [
      { text: 'Verify first result', status: 'todo', priority: 'low', reminderAt: 100 },
      { text: 'Finish active work', status: 'in_progress', priority: 'high', reminderAt: 200 },
      { text: 'Keep prior completion', status: 'done', priority: 'medium', reminderAt: 300 }
    ]
  });
  const beforeItems = plan.items.map(item => ({ ...item }));

  const reconciled = await completePlanItemsForReview(
    plan.id,
    [plan.items[0]!.id, plan.items[1]!.id],
    plan.updatedAt,
    { provenance: plan.provenance }
  );

  expect(reconciled.updatedAt).toBeGreaterThan(plan.updatedAt);
  expect(reconciled).toMatchObject({
    id: plan.id,
    title: plan.title,
    createdAt: plan.createdAt,
    archivedAt: null,
    provenance: plan.provenance
  });
  expect(reconciled).not.toHaveProperty('audience');
  expect(reconciled).not.toHaveProperty('section');
  expect(reconciled).not.toHaveProperty('worker');
  expect(reconciled).not.toHaveProperty('readyToArchive');
  expect(reconciled.items.map(item => item.id)).toEqual(beforeItems.map(item => item.id));
  expect(reconciled.items.map(item => item.text)).toEqual(beforeItems.map(item => item.text));
  expect(reconciled.items.map(item => item.priority)).toEqual(beforeItems.map(item => item.priority));
  expect(reconciled.items.map(item => item.reminderAt)).toEqual(beforeItems.map(item => item.reminderAt));
  expect(reconciled.items.map(item => item.status)).toEqual(['done', 'done', 'done']);

  const noOp = await completePlanItemsForReview(plan.id, [], reconciled.updatedAt, { provenance: reconciled.provenance });
  const repeatedNoOp = await completePlanItemsForReview(plan.id, [], noOp.updatedAt, { provenance: noOp.provenance });
  expect(noOp.updatedAt).toBe(reconciled.updatedAt);
  expect(repeatedNoOp.updatedAt).toBe(reconciled.updatedAt);
  expect(repeatedNoOp.items).toEqual(reconciled.items);
});

it('fails duplicate, unknown, completed, and stale item requests closed without partial mutation', async () => {
  const plan = await createPlan({
    title: 'Reject unsafe reconciliation',
    items: [
      { text: 'First open item', status: 'todo' },
      { text: 'Second open item', status: 'todo' },
      { text: 'Already complete', status: 'done' }
    ]
  });
  const firstId = plan.items[0]!.id;
  const doneId = plan.items[2]!.id;
  const unknownId = '22222222-2222-4222-8222-222222222222';
  const unknownPlanId = '33333333-3333-4333-8333-333333333333';

  await expect(completePlanItemsForReview(unknownPlanId, [firstId], plan.updatedAt, { provenance: plan.provenance }))
    .rejects.toThrow('Plan not found');
  await expect(completePlanItemsForReview(plan.id, [firstId, firstId], plan.updatedAt, { provenance: plan.provenance }))
    .rejects.toThrow('must be unique');
  await expect(completePlanItemsForReview(plan.id, [firstId, unknownId], plan.updatedAt, { provenance: plan.provenance }))
    .rejects.toThrow('does not belong');
  await expect(completePlanItemsForReview(plan.id, [firstId, doneId], plan.updatedAt, { provenance: plan.provenance }))
    .rejects.toThrow('already complete');

  const progressed = await completePlanItemsForReview(plan.id, [firstId], plan.updatedAt, { provenance: plan.provenance });
  expect(progressed.items.map(item => item.status)).toEqual(['done', 'todo', 'done']);
  await expect(completePlanItemsForReview(plan.id, [plan.items[1]!.id], plan.updatedAt, { provenance: plan.provenance }))
    .rejects.toThrow('Plan changed; refresh');

  const unchanged = await completePlanItemsForReview(plan.id, [], progressed.updatedAt, { provenance: progressed.provenance });
  expect(unchanged.updatedAt).toBe(progressed.updatedAt);
  expect(unchanged.items.map(item => item.status)).toEqual(['done', 'todo', 'done']);
});

it('serializes concurrent review writes so only one caller can consume an exact revision', async () => {
  const plan = await createPlan({
    title: 'Fence concurrent review',
    items: [
      { text: 'Left item', status: 'todo' },
      { text: 'Right item', status: 'todo' }
    ]
  });

  const [left, right] = await Promise.allSettled([
    completePlanItemsForReview(plan.id, [plan.items[0]!.id], plan.updatedAt, { provenance: plan.provenance }),
    completePlanItemsForReview(plan.id, [plan.items[1]!.id], plan.updatedAt, { provenance: plan.provenance })
  ]);

  expect(left.status).toBe('fulfilled');
  expect(right.status).toBe('rejected');
  if (left.status !== 'fulfilled' || right.status !== 'rejected') throw new Error('Unexpected reconciliation race result');
  expect(right.reason).toBeInstanceOf(Error);
  expect((right.reason as Error).message).toContain('Plan changed; refresh');

  const current = await completePlanItemsForReview(plan.id, [], left.value.updatedAt, { provenance: left.value.provenance });
  expect(current.items.map(item => item.status)).toEqual(['done', 'todo']);
  expect(current.updatedAt).toBe(left.value.updatedAt);
});

it('rejects source drift inside the serialized done-only mutation even when updatedAt did not change', async () => {
  const oldThreadId = '44444444-4444-4444-8444-444444444444';
  const newThreadId = '55555555-5555-4555-8555-555555555555';
  const plan = await createPlan({
    title: 'Fence source drift',
    provenance: {
      kind: 'message',
      threadId: oldThreadId,
      sessionId: 'source-session',
      conversationId: 'source-conversation',
      messageId: 'source-message',
      label: 'Original source'
    },
    items: [{ text: 'Evidence-backed item', status: 'todo' }]
  });

  const sourceChange = setPlanThreadSource(plan.id, newThreadId);
  const staleReconciliation = completePlanItemsForReview(
    plan.id,
    [plan.items[0]!.id],
    plan.updatedAt,
    { provenance: plan.provenance }
  );
  const [changed, reconciled] = await Promise.allSettled([sourceChange, staleReconciliation]);

  expect(changed.status).toBe('fulfilled');
  expect(reconciled.status).toBe('rejected');
  if (changed.status !== 'fulfilled' || reconciled.status !== 'rejected') throw new Error('Unexpected source-race result');
  expect(changed.value.updatedAt).toBe(plan.updatedAt);
  expect((reconciled.reason as Error).message).toContain('Plan source changed; refresh');
  expect(changed.value.items[0]!.status).toBe('todo');

  const current = await completePlanItemsForReview(
    plan.id,
    [plan.items[0]!.id],
    changed.value.updatedAt,
    { provenance: changed.value.provenance }
  );
  expect(current.items[0]!.status).toBe('done');
  expect(current.provenance?.threadId).toBe(newThreadId);
});

it('holds exact Plan validation through an awaited external commit before later Plan mutations may run', async () => {
  const oldThreadId = '66666666-6666-4666-8666-666666666666';
  const newThreadId = '77777777-7777-4777-8777-777777777777';
  const plan = await createPlan({
    title: 'Fence receipt commit',
    provenance: { kind: 'manual', threadId: oldThreadId, label: 'Receipt source' },
    items: [{ text: 'Stay open', status: 'todo' }]
  });

  let enterCommit!: () => void;
  const entered = new Promise<void>(resolve => { enterCommit = resolve; });
  let releaseCommit!: () => void;
  const release = new Promise<void>(resolve => { releaseCommit = resolve; });
  let sourceMutationSettled = false;

  const fenced = withPlanReviewValidationFence([{
    planId: plan.id,
    updatedAt: plan.updatedAt,
    provenance: plan.provenance
  }], async () => {
    enterCommit();
    await release;
    return 'receipt-committed';
  });
  await entered;

  const sourceMutation = setPlanThreadSource(plan.id, newThreadId).then(value => {
    sourceMutationSettled = true;
    return value;
  });
  await Promise.resolve();
  expect(sourceMutationSettled).toBe(false);

  releaseCommit();
  expect(await fenced).toBe('receipt-committed');
  const changed = await sourceMutation;
  expect(changed.provenance?.threadId).toBe(newThreadId);
});

it('does not invoke a fenced receipt commit when revision or provenance no longer matches', async () => {
  const plan = await createPlan({
    title: 'Reject stale receipt fence',
    provenance: { kind: 'manual', sessionId: 'receipt-session', label: 'Receipt source' },
    items: [{ text: 'Stay open', status: 'todo' }]
  });
  const commit = vi.fn(async () => 'committed');

  await expect(withPlanReviewValidationFence([{
    planId: plan.id,
    updatedAt: plan.updatedAt + 1,
    provenance: plan.provenance
  }], commit)).rejects.toThrow('Plan changed; refresh');
  expect(commit).not.toHaveBeenCalled();

  await expect(withPlanReviewValidationFence([{
    planId: plan.id,
    updatedAt: plan.updatedAt,
    provenance: { ...plan.provenance!, label: 'Different source' }
  }], commit)).rejects.toThrow('Plan source changed; refresh');
  expect(commit).not.toHaveBeenCalled();
});
