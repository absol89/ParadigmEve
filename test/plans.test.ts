import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { archivePlan, backfillSessionPlans, cancelPlan, createPlan, listPlans, resetPlansForTests, setPlanThreadSource, syncSessionAgentPlan, updatePlan } from '../src/main/plans.js';
import { appendEvent, createSession, initSessionStore, readSessionPlan, rebindSession, resetSessionStoreForTests, updateSessionPlan } from '../src/main/session/store.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-plans-'));
  resetPlansForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);
});

afterEach(async () => {
  resetPlansForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('backfills durable pre-upgrade session plans and fails closed on Compact & Resume provenance', async () => {
  const session = await createSession({ title: 'Existing local plan', conversationId: 'conversation-before' });
  const startedAt = Date.now();
  expect(await updateSessionPlan(session.id, 'conversation-before', {
    plan: [
      { step: 'Keep the existing plan', status: 'completed' },
      { step: 'Make it visible globally', status: 'in_progress' }
    ]
  }, startedAt)).toBe(true);
  expect(await rebindSession(session.id, 'conversation-before', 'conversation-after')).toBe(true);

  expect((await listPlans()).live).toEqual([]);
  await backfillSessionPlans();
  const library = await listPlans();
  expect(library.live).toHaveLength(1);
  expect(library.live[0]).toMatchObject({
    title: 'Existing local plan',
    provenance: { kind: 'plan', sessionId: session.id, label: 'Existing local plan' }
  });
  expect(library.live[0]!.provenance).not.toHaveProperty('conversationId');

  // Reopening the surface again must not create a second Plan or a fake newer revision.
  const updatedAt = library.live[0]!.updatedAt;
  await backfillSessionPlans();
  expect((await listPlans()).live).toEqual([expect.objectContaining({ id: library.live[0]!.id, updatedAt })]);
});

it('round-trips Plan task descriptions and Plans-surface status changes to the exact source chat', async () => {
  const session = await createSession({ title: 'Shared Plan', conversationId: 'shared-plan-chat' });
  expect(await updateSessionPlan(session.id, 'shared-plan-chat', {
    explanation: 'Keep both editing surfaces synchronized.',
    plan: [
      { step: 'Inspect the source', status: 'in_progress', details: 'Read the exact session and repository state.' },
      { step: 'Verify the mutation', status: 'pending', details: 'Confirm the same checklist is visible from both surfaces.' }
    ]
  }, Date.now())).toBe(true);

  const projected = await syncSessionAgentPlan(session.id, 'shared-plan-chat', session.title, {
    explanation: 'Keep both editing surfaces synchronized.',
    plan: [
      { step: 'Inspect the source', status: 'in_progress', details: 'Read the exact session and repository state.' },
      { step: 'Verify the mutation', status: 'pending', details: 'Confirm the same checklist is visible from both surfaces.' }
    ]
  });
  expect(projected).not.toBeNull();
  expect(projected!.items[0]!.details).toBe('Read the exact session and repository state.');

  const completed = await updatePlan(projected!.id, {
    items: projected!.items.map(item => ({ ...item, status: item.id === projected!.items[0]!.id ? 'done' as const : item.status }))
  }, projected!.updatedAt);
  expect(completed.items[0]!.status).toBe('done');
  expect(completed.items[0]!.details).toBe('Read the exact session and repository state.');
  const sourceAfterPlanEdit = await readSessionPlan(session.id);
  expect(sourceAfterPlanEdit?.plan).toEqual([
    { step: 'Inspect the source', status: 'completed', details: 'Read the exact session and repository state.' },
    { step: 'Verify the mutation', status: 'pending', details: 'Confirm the same checklist is visible from both surfaces.' }
  ]);

  const chatUpdate = await updateSessionPlan(session.id, 'shared-plan-chat', {
    explanation: 'Keep both editing surfaces synchronized.',
    plan: [
      { step: 'Inspect the source', status: 'completed', details: 'Updated from chat.' },
      { step: 'Verify the mutation', status: 'completed', details: 'Confirm the same checklist is visible from both surfaces.' }
    ]
  }, Date.now() + 10);
  expect(chatUpdate).toBe(true);
  const refreshed = await syncSessionAgentPlan(session.id, 'shared-plan-chat', session.title, {
    explanation: 'Keep both editing surfaces synchronized.',
    plan: [
      { step: 'Inspect the source', status: 'completed', details: 'Updated from chat.' },
      { step: 'Verify the mutation', status: 'completed', details: 'Confirm the same checklist is visible from both surfaces.' }
    ]
  });
  expect(refreshed!.id).toBe(projected!.id);
  expect(refreshed!.items.map(item => item.status)).toEqual(['done', 'done']);
  expect(refreshed!.items[0]!.details).toBe('Updated from chat.');
});

it('fails closed when Plans provenance is ambiguous and never guesses the current conversation', async () => {
  const session = await createSession({ title: 'Ambiguous Plan', conversationId: 'chat-a' });
  expect(await updateSessionPlan(session.id, 'chat-a', {
    plan: [{ step: 'Do not guess', status: 'in_progress', details: 'This must not be routed to another chat.' }]
  }, Date.now())).toBe(true);
  const projected = await syncSessionAgentPlan(session.id, null, session.title, {
    plan: [{ step: 'Do not guess', status: 'in_progress', details: 'This must not be routed to another chat.' }]
  });
  expect(projected!.provenance).not.toHaveProperty('conversationId');
  const changed = await updatePlan(projected!.id, {
    items: [{ ...projected!.items[0]!, status: 'done' }]
  }, projected!.updatedAt);
  expect(changed.items[0]!.status).toBe('done');
  expect((await readSessionPlan(session.id))?.plan[0]?.status)
    .toBe('in_progress');
});

it('clears the exact source chat when a shared Plan is cancelled or archived', async () => {
  const session = await createSession({ title: 'Lifecycle Plan', conversationId: 'lifecycle-chat' });
  const source = {
    plan: [{ step: 'Finish the work', status: 'completed' as const, details: 'Already verified.' }]
  };
  expect(await updateSessionPlan(session.id, 'lifecycle-chat', source, Date.now())).toBe(true);
  const projected = await syncSessionAgentPlan(session.id, 'lifecycle-chat', session.title, source);
  const archived = await archivePlan(projected!.id);
  expect(archived.section).toBe('done');
  expect((await readSessionPlan(session.id))?.plan).toEqual([]);

  const cancelSession = await createSession({ title: 'Cancelled Lifecycle Plan', conversationId: 'cancel-lifecycle-chat' });
  const cancelSource = {
    plan: [{ step: 'Cancel this work', status: 'in_progress' as const, details: 'No longer needed.' }]
  };
  expect(await updateSessionPlan(cancelSession.id, 'cancel-lifecycle-chat', cancelSource, Date.now())).toBe(true);
  const second = await syncSessionAgentPlan(cancelSession.id, 'cancel-lifecycle-chat', cancelSession.title, cancelSource);
  const cancelled = await cancelPlan(second!.id);
  expect(cancelled.section).toBe('done');
  expect(cancelled.cancelledAt).toBe(cancelled.archivedAt);
  expect((await readSessionPlan(cancelSession.id))?.plan).toEqual([]);
});

it('never rolls first-class progress or archive state back from stale legacy session plan backfill', async () => {
  const session = await createSession({ title: 'Dogfood checklist', conversationId: 'conversation-dogfood' });
  expect(await updateSessionPlan(session.id, 'conversation-dogfood', {
    plan: [
      { step: 'Inspect the plan', status: 'completed' },
      { step: 'Exercise Pin state', status: 'in_progress' },
      { step: 'Exercise live progress', status: 'pending' },
      { step: 'Restart and repaint', status: 'pending' },
      { step: 'Fix regressions', status: 'pending' }
    ]
  }, Date.now())).toBe(true);

  await backfillSessionPlans();
  const imported = (await listPlans()).live[0]!;
  expect(imported.items.map(item => item.status)).toEqual(['done', 'in_progress', 'todo', 'todo', 'todo']);

  const advanced = await updatePlan(imported.id, {
    items: imported.items.map((item, index) => ({
      ...item,
      status: index < 4 ? 'done' as const : 'in_progress' as const
    }))
  }, imported.updatedAt);
  expect(advanced.items.map(item => item.status)).toEqual(['done', 'done', 'done', 'done', 'in_progress']);

  // Simulate a new process: backfill is eligible again, while the durable first-class Plan and
  // older session-local plan.json both remain on disk. The import must preserve the newer Plan.
  resetPlansForTests();
  await backfillSessionPlans();
  const afterRestart = (await listPlans()).live;
  expect(afterRestart).toHaveLength(1);
  expect(afterRestart[0]).toMatchObject({ id: imported.id, updatedAt: advanced.updatedAt });
  expect(afterRestart[0]!.items.map(item => item.status)).toEqual(['done', 'done', 'done', 'done', 'in_progress']);

  const ready = await updatePlan(imported.id, {
    items: afterRestart[0]!.items.map(item => ({ ...item, status: 'done' as const }))
  }, afterRestart[0]!.updatedAt);
  const archived = await archivePlan(ready.id);

  resetPlansForTests();
  await backfillSessionPlans();
  const library = await listPlans();
  expect(library.live).toEqual([]);
  expect(library.done).toHaveLength(1);
  expect(library.done[0]).toMatchObject({
    id: imported.id,
    updatedAt: archived.updatedAt,
    archivedAt: archived.archivedAt
  });
});

it('keeps ordered first-class Plans durable through completion and explicit archive', async () => {
  const plan = await createPlan({
    title: 'Ship the dogfood slice',
    provenance: {
      kind: 'message',
      sessionId: 'session-42',
      conversationId: 'conversation-42',
      messageId: 'message-7',
      label: 'Workshop decision'
    },
    items: [
      { text: 'Persist the plan', status: 'todo', reminderAt: 500 },
      { text: 'Wire IPC', status: 'in_progress', priority: 'high', reminderAt: 300 },
      { text: 'Render it', status: 'todo' }
    ]
  });

  expect(plan.section).toBe('live');
  expect(plan.readyToArchive).toBe(false);
  expect(plan.currentItemId).toBe(plan.items[1]!.id);
  expect(plan.nextItemId).toBe(plan.items[2]!.id);
  expect(plan.nextReminderAt).toBe(300);
  expect((await listPlans()).live.map(row => row.id)).toEqual([plan.id]);
  await expect(archivePlan(plan.id)).rejects.toThrow('not ready to archive');

  const progressed = await updatePlan(plan.id, {
    title: 'Ship 2.1.1 dogfood slice',
    items: [
      { id: plan.items[1]!.id, text: 'Wire IPC', status: 'done', priority: 'high' },
      { id: plan.items[0]!.id, text: 'Persist the plan', status: 'in_progress', priority: 'high', reminderAt: 450 },
      { text: 'Add focused tests', status: 'todo', reminderAt: 400 }
    ]
  }, plan.updatedAt);

  expect(progressed.items.slice(0, 2).map(item => item.id)).toEqual([plan.items[1]!.id, plan.items[0]!.id]);
  expect(progressed.items[2]!.id).not.toBe(plan.items[2]!.id);
  expect(progressed.currentItemId).toBe(plan.items[0]!.id);
  expect(progressed.nextItemId).toBe(progressed.items[2]!.id);
  expect(progressed.nextReminderAt).toBe(400);
  expect(progressed.provenance).toEqual(plan.provenance);

  const ready = await updatePlan(plan.id, {
    items: progressed.items.map(item => ({ ...item, status: 'done' as const }))
  }, progressed.updatedAt);
  expect(ready.readyToArchive).toBe(true);
  expect(ready.currentItemId).toBeNull();
  expect(ready.nextItemId).toBeNull();
  expect(ready.nextReminderAt).toBeNull();
  expect((await listPlans()).done).toEqual([]);

  const archived = await archivePlan(plan.id);
  expect(archived.section).toBe('done');
  expect(archived.readyToArchive).toBe(false);
  expect(archived.archivedAt).not.toBeNull();
  expect((await listPlans()).live).toEqual([]);
  expect((await listPlans()).done.map(row => row.id)).toEqual([plan.id]);
  await expect(updatePlan(plan.id, { title: 'Rewrite history' }, archived.updatedAt)).rejects.toThrow('Archived Plans cannot be edited');

  resetPlansForTests();
  resetDurableForTests();
  initDurableStore(directory);
  const restored = await listPlans();
  expect(restored.live).toEqual([]);
  expect(restored.done).toHaveLength(1);
  expect(restored.done[0]).toMatchObject({
    id: plan.id,
    title: 'Ship 2.1.1 dogfood slice',
    provenance: plan.provenance,
    section: 'done',
    readyToArchive: false
  });
});

it('adds an exact Thread source without replacing historical Plan provenance or revision', async () => {
  const plan = await createPlan({
    title: 'Keep request provenance',
    provenance: {
      kind: 'message',
      sessionId: 'session-source',
      conversationId: 'conversation-source',
      messageId: 'message-source',
      label: 'Original request'
    },
    items: [{ text: 'Keep the source evidence', status: 'in_progress' }]
  });
  const updatedAt = plan.updatedAt;
  const threadId = '33333333-3333-4333-8333-333333333333';

  const anchored = await setPlanThreadSource(plan.id, threadId);

  expect(anchored.updatedAt).toBe(updatedAt);
  expect(anchored.provenance).toEqual({
    kind: 'message',
    threadId,
    sessionId: 'session-source',
    conversationId: 'conversation-source',
    messageId: 'message-source',
    label: 'Original request'
  });

  const fallback = await setPlanThreadSource(plan.id, null);
  expect(fallback.updatedAt).toBe(updatedAt);
  expect(fallback.provenance).toEqual({
    kind: 'message',
    sessionId: 'session-source',
    conversationId: 'conversation-source',
    messageId: 'message-source',
    label: 'Original request'
  });
});

it('keeps Live Plan order stable across progress updates and only closes the gap on archive', async () => {
  const first = await createPlan({
    title: 'First plan',
    items: [{ text: 'First step', status: 'todo' }]
  });
  const second = await createPlan({
    title: 'Second plan',
    items: [{ text: 'Second step', status: 'todo' }]
  });
  const third = await createPlan({
    title: 'Third plan',
    items: [{ text: 'Third step', status: 'todo' }]
  });

  const ids = async () => (await listPlans()).live.map(plan => plan.id);
  expect(await ids()).toEqual([third.id, second.id, first.id]);

  const progressed = await updatePlan(second.id, {
    items: second.items.map(item => ({ ...item, status: 'in_progress' as const }))
  }, second.updatedAt);
  expect(await ids()).toEqual([third.id, second.id, first.id]);

  const ready = await updatePlan(second.id, {
    items: progressed.items.map(item => ({ ...item, status: 'done' as const }))
  }, progressed.updatedAt);
  expect(await ids()).toEqual([third.id, second.id, first.id]);

  await archivePlan(ready.id);
  expect(await ids()).toEqual([third.id, first.id]);
});

it('serializes mutations and rejects invalid item ownership or ambiguous current state', async () => {
  const plan = await createPlan({
    title: 'One current step',
    items: [
      { text: 'First', status: 'in_progress' },
      { text: 'Second', status: 'todo' }
    ]
  });

  await expect(updatePlan(plan.id, {
    items: [
      { id: plan.items[0]!.id, text: 'First', status: 'in_progress' },
      { id: plan.items[1]!.id, text: 'Second', status: 'in_progress' }
    ]
  } as any, plan.updatedAt)).rejects.toThrow(/at most one item can be in progress/i);

  await expect(updatePlan(plan.id, {
    items: [{ id: '00000000-0000-4000-8000-000000000000', text: 'Foreign', status: 'todo' }]
  }, plan.updatedAt)).rejects.toThrow('does not belong');

  const first = updatePlan(plan.id, { title: 'First accepted update' }, plan.updatedAt);
  const second = updatePlan(plan.id, { title: 'Second stale update' }, plan.updatedAt);
  const firstResult = await first;
  await expect(second).rejects.toThrow('Plan changed; refresh');
  expect(firstResult.title).toBe('First accepted update');
  expect(firstResult.updatedAt).toBeGreaterThan(plan.updatedAt);
  expect((await listPlans()).live[0]!.title).toBe('First accepted update');
});

it('fails closed on structurally invalid durable Plan catalogs', async () => {
  await writeDurableNow('plans', {
    version: 1,
    plans: [{
      id: '00000000-0000-4000-8000-000000000000',
      title: 'Corrupt plan',
      items: [{ id: '00000000-0000-4000-8000-000000000001', text: 'Impossible', status: 'blocked' }],
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null
    }]
  });
  await expect(listPlans()).rejects.toThrow('Plan catalog is invalid');

  await writeDurableNow('plans', {
    version: 1,
    plans: [{
      id: '00000000-0000-4000-8000-000000000000',
      title: 'Impossible archive',
      items: [{ id: '00000000-0000-4000-8000-000000000001', text: 'Still pending', status: 'todo' }],
      createdAt: 1,
      updatedAt: 2,
      archivedAt: 2
    }]
  });
  await expect(listPlans()).rejects.toThrow('Plan catalog is invalid');
});

it('preserves malformed durable Plan bytes instead of treating corruption as an empty library', async () => {
  const state = path.join(directory, 'state');
  const filename = path.join(state, 'plans.json');
  await fs.mkdir(state, { recursive: true });
  const malformed = '{"version":1,"plans":[';
  await fs.writeFile(filename, malformed, 'utf8');

  await expect(listPlans()).rejects.toThrow('Could not read plans state');
  await expect(createPlan({ title: 'Must not overwrite corruption', items: [{ text: 'Nope', status: 'todo' }] }))
    .rejects.toThrow('Could not read plans state');
  expect(await fs.readFile(filename, 'utf8')).toBe(malformed);
});

it('projects accepted session update_plan progress into Live without auto-archiving it', async () => {
  const first = await syncSessionAgentPlan('session-live', 'conversation-a', 'Pins and plans workshop', {
    plan: [
      { step: 'Wire Pins', status: 'completed' },
      { step: 'Wire Plans', status: 'in_progress' },
      { step: 'Review the dogfood build', status: 'pending' }
    ]
  });
  expect(first).not.toBeNull();
  expect(first).toMatchObject({ section: 'live', readyToArchive: false });
  expect(first!.items.map(item => item.status)).toEqual(['done', 'in_progress', 'todo']);

  const moved = await syncSessionAgentPlan('session-live', 'conversation-b', 'Pins and plans workshop', {
    plan: [
      { step: 'Wire Pins', status: 'completed' },
      { step: 'Wire Plans', status: 'completed' },
      { step: 'Review the dogfood build', status: 'completed' }
    ]
  });
  expect(moved!.id).toBe(first!.id);
  expect(moved).toMatchObject({ section: 'live', readyToArchive: true });
  // Compact & Resume changes the frontend conversation, not the Plan's original provenance.
  expect(moved!.provenance?.conversationId).toBe('conversation-a');

  const next = await syncSessionAgentPlan('session-live', 'conversation-b', 'Follow-up work', {
    plan: [{ step: 'Start the next checklist', status: 'in_progress' }]
  });
  expect(next!.id).not.toBe(first!.id);
  expect((await listPlans()).live).toHaveLength(2);

  const archived = await archivePlan(first!.id);
  expect(archived.section).toBe('done');
  const repeated = await syncSessionAgentPlan('session-live', 'conversation-b', 'Pins and plans workshop', {
    plan: [
      { step: 'Wire Pins', status: 'completed' },
      { step: 'Wire Plans', status: 'completed' },
      { step: 'Review the dogfood build', status: 'completed' }
    ]
  });
  expect(repeated!.id).toBe(first!.id);
  expect(repeated!.section).toBe('done');
});

it('keeps prime plans human-facing and groups worker ancestry for Eve activity', async () => {
  const prime = await createSession({ title: 'Ship the release', conversationId: 'prime-chat' });
  const worker = await createSession({
    title: 'worker-1 · Audit startup',
    conversationId: 'worker-chat',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Audit startup' }
  });
  const resumedWorker = await createSession({
    title: 'Resumed · worker-1',
    conversationId: 'worker-resume-chat',
    origin: { kind: 'resume', fromSessionId: worker.id, agentId: null, task: '' }
  });

  await syncSessionAgentPlan(prime.id, 'prime-chat', prime.title, {
    plan: [{ step: 'Ship 2.1.2', status: 'in_progress' }]
  });
  await syncSessionAgentPlan(worker.id, 'worker-chat', worker.title, {
    plan: [{ step: 'Inspect startup injection', status: 'in_progress' }]
  });
  await syncSessionAgentPlan(resumedWorker.id, 'worker-resume-chat', resumedWorker.title, {
    plan: [{ step: 'Finish the worker audit', status: 'in_progress' }]
  });

  const library = await listPlans();
  expect(library.live.find(plan => plan.provenance?.sessionId === prime.id)?.audience).toBe('human');
  expect(library.live.find(plan => plan.provenance?.sessionId === worker.id)?.audience).toBe('eve');
  expect(library.live.find(plan => plan.provenance?.sessionId === resumedWorker.id)?.audience).toBe('eve');
});

it('keeps recipient-side Prime delivery as informational worker metadata, not an archive gate', async () => {
  const prime = await createSession({ title: 'Release gate', conversationId: 'prime-report-chat' });
  const worker = await createSession({
    title: 'worker-7 · Audit release gate',
    conversationId: 'worker-report-chat',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-7', task: 'Audit release gate' }
  });
  await syncSessionAgentPlan(worker.id, 'worker-report-chat', worker.title, {
    plan: [{ step: 'Verify the release gate', status: 'completed' }]
  });

  const before = (await listPlans()).live.find(plan => plan.provenance?.sessionId === worker.id)!;
  expect(before.worker).toEqual({ id: 'worker-7', reportedToPrime: false });
  expect(before.readyToArchive).toBe(true);

  const finishAt = Math.max(Date.now(), before.updatedAt + 1);
  await appendEvent(worker.id, {
    time: finishAt + 1,
    source: 'app',
    kind: 'agent_message',
    messageId: 'worker-report-message',
    from: 'worker-7',
    to: 'prime',
    message: { text: '[worker-7 reported] release gate verified', truncated: false, chars: 40 },
    delivery: 'sent',
    finishReport: true
  });
  await appendEvent(worker.id, {
    time: finishAt,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId: 'worker-report-finish',
      tool: 'agents',
      attribution: 'exact',
      requestId: 'worker-report-finish',
      conversationId: 'worker-report-chat',
      attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'reported', truncated: false, chars: 8 },
      outcome: 'ok',
      durationMs: 1,
      summary: { kind: 'agent', tone: 'good', title: 'Reported to prime' },
      endsActivity: true
    }
  } as any);

  const sentOnly = (await listPlans()).live.find(plan => plan.id === before.id)!;
  expect(sentOnly.worker).toEqual({ id: 'worker-7', reportedToPrime: false });
  expect(sentOnly.readyToArchive).toBe(true);

  await appendEvent(prime.id, {
    time: finishAt + 2,
    source: 'app',
    kind: 'agent_message',
    messageId: 'worker-report-message',
    from: 'worker-7',
    to: 'prime',
    message: { text: '[worker-7 reported] release gate verified', truncated: false, chars: 40 },
    delivery: 'delivered',
    finishReport: true
  });

  const reported = (await listPlans()).live.find(plan => plan.id === before.id)!;
  expect(reported.worker).toEqual({
    id: 'worker-7',
    reportedToPrime: true,
    reportMessageId: 'worker-report-message'
  });
  expect(reported.readyToArchive).toBe(true);

  // The edit must be a revision after the delivered report (stamped finishAt + 2). A fast runner
  // (macOS CI) reached updatePlan within those milliseconds, so the report still counted.
  while (Date.now() <= finishAt + 2) await new Promise(resolve => setTimeout(resolve, 1));
  await updatePlan(reported.id, { title: 'Follow-up after report' }, reported.updatedAt);
  const changedAfterReport = (await listPlans()).live.find(plan => plan.id === before.id)!;
  expect(changedAfterReport.worker).toEqual({ id: 'worker-7', reportedToPrime: false });
  expect(changedAfterReport.readyToArchive).toBe(true);
});

it('archives legacy report-only debt from Eve Activity without requiring that synthetic handoff step', async () => {
  const prime = await createSession({ title: 'Prime handoff consumer', conversationId: 'prime-handoff-chat' });
  const worker = await createSession({
    title: 'worker-4 · Handoff reconciliation',
    conversationId: 'worker-handoff-chat',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-4', task: 'Reconcile the handoff' }
  });
  const planUpdate = {
    plan: [
      { step: 'Finish the bounded task', status: 'completed' as const },
      { step: 'Report to Prime', status: 'in_progress' as const }
    ]
  };
  const sourceRevision = Date.now();
  expect(await updateSessionPlan(worker.id, 'worker-handoff-chat', planUpdate, sourceRevision)).toBe(true);
  await syncSessionAgentPlan(worker.id, 'worker-handoff-chat', worker.title, planUpdate);

  const before = (await listPlans()).live.find(plan => plan.provenance?.sessionId === worker.id)!;
  const finishAt = Math.max(Date.now() + 100, before.updatedAt + 1);
  await appendEvent(worker.id, {
    time: finishAt + 1,
    source: 'app',
    kind: 'agent_message',
    messageId: 'worker-handoff-report',
    from: 'worker-4',
    to: 'prime',
    message: { text: '[worker-4 reported] bounded task complete', truncated: false, chars: 41 },
    delivery: 'sent',
    finishReport: true
  });
  await appendEvent(worker.id, {
    time: finishAt,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId: 'worker-handoff-finish',
      tool: 'agents',
      attribution: 'exact',
      requestId: 'worker-handoff-finish',
      conversationId: 'worker-handoff-chat',
      attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'reported', truncated: false, chars: 8 },
      outcome: 'ok',
      durationMs: 1,
      summary: { kind: 'agent', tone: 'good', title: 'Reported to prime' },
      endsActivity: true
    }
  } as any);
  await appendEvent(prime.id, {
    time: finishAt + 2,
    source: 'app',
    kind: 'agent_message',
    messageId: 'worker-handoff-report',
    from: 'worker-4',
    to: 'prime',
    message: { text: '[worker-4 reported] bounded task complete', truncated: false, chars: 41 },
    delivery: 'delivered',
    finishReport: true
  });

  const delivered = (await listPlans()).live.find(plan => plan.id === before.id)!;
  expect(delivered.worker).toMatchObject({ id: 'worker-4', reportedToPrime: true, reportMessageId: 'worker-handoff-report' });
  expect(delivered.readyToArchive).toBe(true);
  const handoff = delivered.items.find(item => item.text === 'Report to Prime')!;
  expect(handoff.status).toBe('in_progress');

  // In real use the report is always older than the user's archive click. Archiving clears the
  // chat's plan.json, so the proof must survive on the Plan record itself (it used to pass only
  // when the archive happened within the report's future-dated window).
  await new Promise(resolve => setTimeout(resolve, Math.max(0, finishAt + 20 - Date.now())));
  await archivePlan(delivered.id);
  const archived = (await listPlans()).done.find(plan => plan.id === delivered.id)!;
  expect(archived.items.find(item => item.id === handoff.id)?.status).toBe('done');
  expect(archived.worker).toMatchObject({ id: 'worker-4', reportedToPrime: true, reportMessageId: 'worker-handoff-report' });
  expect(archived.section).toBe('done');
});

it('does not let a delivered report from a sibling resumed worker chat satisfy another branch', async () => {
  const prime = await createSession({ title: 'Prime', conversationId: 'prime-branch-chat' });
  const worker = await createSession({
    title: 'worker-3 · Root task',
    conversationId: 'worker-root-chat',
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-3', task: 'Root task' }
  });
  const branchA = await createSession({
    title: 'Resumed · worker-3 A',
    conversationId: 'worker-branch-a',
    origin: { kind: 'resume', fromSessionId: worker.id, agentId: null, task: '' }
  });
  const branchB = await createSession({
    title: 'Resumed · worker-3 B',
    conversationId: 'worker-branch-b',
    origin: { kind: 'resume', fromSessionId: worker.id, agentId: null, task: '' }
  });
  await syncSessionAgentPlan(branchA.id, 'worker-branch-a', branchA.title, {
    plan: [{ step: 'Complete branch A', status: 'completed' }]
  });
  const planA = (await listPlans()).live.find(plan => plan.provenance?.sessionId === branchA.id)!;
  const finishAt = planA.updatedAt + 10;
  await appendEvent(branchB.id, {
    time: finishAt + 1,
    source: 'app', kind: 'agent_message', messageId: 'branch-b-report', from: 'worker-3', to: 'prime',
    message: { text: '[worker-3 reported] branch B', truncated: false, chars: 28 }, delivery: 'sent', finishReport: true
  });
  await appendEvent(branchB.id, {
    time: finishAt, source: 'mcp', kind: 'tool_call',
    call: {
      callId: 'branch-b-finish', tool: 'agents', attribution: 'exact', requestId: 'branch-b-finish',
      conversationId: 'worker-branch-b', attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'queued', truncated: false, chars: 6 },
      outcome: 'ok', durationMs: 1, summary: { kind: 'agent', tone: 'good', title: 'Finish queued' }, endsActivity: true
    }
  } as any);
  await appendEvent(prime.id, {
    time: finishAt + 2,
    source: 'app', kind: 'agent_message', messageId: 'branch-b-report', from: 'worker-3', to: 'prime',
    message: { text: '[worker-3 reported] branch B', truncated: false, chars: 28 }, delivery: 'delivered', finishReport: true
  });

  const unchangedA = (await listPlans()).live.find(plan => plan.id === planA.id)!;
  expect(unchangedA.worker).toEqual({ id: 'worker-3', reportedToPrime: false });
  expect(unchangedA.readyToArchive).toBe(true);
});
it('stops calling an idle source step Current after a newer proven completion boundary', async () => {
  const session = await createSession({ title: 'Expenses integration', conversationId: 'expenses-prime' });
  await syncSessionAgentPlan(session.id, 'expenses-prime', session.title, {
    plan: [
      { step: 'Integrate worker results', status: 'in_progress' },
      { step: 'Run final checks', status: 'pending' }
    ]
  });
  const active = (await listPlans()).live.find(plan => plan.provenance?.sessionId === session.id)!;
  expect(active.currentItemId).toBe(active.items[0]!.id);

  await appendEvent(session.id, {
    time: active.updatedAt + 10,
    source: 'browser',
    kind: 'assistant_message',
    message: { text: 'Finished integration.', truncated: false, chars: 21 },
    state: 'final',
    final: true
  } as any);
  const settled = (await listPlans()).live.find(plan => plan.id === active.id)!;
  expect(settled.items[0]!.status).toBe('in_progress');
  expect(settled.currentItemId).toBeNull();
  expect(settled.nextItemId).toBe(settled.items[0]!.id);

  await appendEvent(session.id, {
    time: active.updatedAt + 20,
    source: 'browser',
    kind: 'turn_start',
    turnId: 'resumed-work'
  } as any);
  const resumed = (await listPlans()).live.find(plan => plan.id === active.id)!;
  expect(resumed.currentItemId).toBe(resumed.items[0]!.id);
});

it('creates a Live projection when an archived checklist is later reopened', async () => {
  const first = await syncSessionAgentPlan('session-reopened', 'conversation-a', 'Reopenable work', {
    plan: [
      { step: 'First step', status: 'completed' },
      { step: 'Second step', status: 'completed' }
    ]
  });
  expect(first).not.toBeNull();
  expect(first!.readyToArchive).toBe(true);
  const archived = await archivePlan(first!.id);
  expect(archived.section).toBe('done');

  const replay = await syncSessionAgentPlan('session-reopened', 'conversation-b', 'Reopenable work', {
    plan: [
      { step: 'First step', status: 'completed' },
      { step: 'Second step', status: 'completed' }
    ]
  });
  expect(replay!.id).toBe(first!.id);
  expect(replay!.section).toBe('done');

  const reopened = await syncSessionAgentPlan('session-reopened', 'conversation-b', 'Reopenable work', {
    plan: [
      { step: 'First step', status: 'completed' },
      { step: 'Second step', status: 'in_progress' }
    ]
  });
  expect(reopened).not.toBeNull();
  expect(reopened!.id).not.toBe(first!.id);
  expect(reopened).toMatchObject({ section: 'live', readyToArchive: false });
  expect(reopened!.provenance?.conversationId).toBe('conversation-b');

  const library = await listPlans();
  expect(library.done.map(plan => plan.id)).toContain(first!.id);
  expect(library.live.map(plan => plan.id)).toContain(reopened!.id);
});

/** A catalog like the live one on 2026-09-27: 470 archived, 30 live (the old 500 cap). */
function catalog(size = 500, live = 30) {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  return Array.from({ length: size }, (_, index) => {
    const archived = index >= live;
    return {
      id: uuid(index + 1),
      title: archived ? `Finished ${index}` : `Live ${index}`,
      items: [{ id: uuid(100_000 + index), text: 'Step', status: archived ? 'done' : 'todo' }],
      createdAt: 1_000 + index,
      updatedAt: 2_000 + index,
      archivedAt: archived ? 3_000 + index : null
    };
  });
}

it('keeps every archived Plan and still accepts new Plans past the old 500 cap', async () => {
  const seeded = catalog();
  await writeDurableNow('plans', { version: 1, plans: seeded });

  const created = await createPlan({ title: 'New after 500', items: [{ text: 'Go', status: 'todo' }] });
  const library = await listPlans();
  const ids = new Set([...library.live, ...library.done].map(plan => plan.id));
  expect(ids.has(created.id)).toBe(true);
  expect(ids.size).toBe(501);
  for (const plan of seeded) expect(ids.has(plan.id)).toBe(true);
});

it('lets a chat update_plan create its Plan on a catalog that used to be full', async () => {
  await writeDurableNow('plans', { version: 1, plans: catalog() });
  const session = await createSession({ title: 'Eve after compaction', conversationId: 'conversation-full' });
  const projected = await syncSessionAgentPlan(session.id, 'conversation-full', 'Eve after compaction', {
    plan: [{ step: 'Keep working', status: 'in_progress' }]
  });
  expect(projected).toMatchObject({ title: 'Eve after compaction' });
});

it('refuses a new Plan only at the 5,000-Plan bound and removes nothing', async () => {
  const seeded = catalog(5_000);
  await writeDurableNow('plans', { version: 1, plans: seeded });
  await expect(createPlan({ title: 'No room', items: [{ text: 'Go', status: 'todo' }] })).rejects.toThrow('Plan catalog limit reached');
  const library = await listPlans();
  expect(library.live.length + library.done.length).toBe(5_000);
});

it('cancels a Live Plan into Done without ticking its items, and keeps it immutable', async () => {
  const plan = await createPlan({
    title: 'Superseded idea',
    items: [{ text: 'Started', status: 'done' }, { text: 'Never needed', status: 'todo' }]
  });

  const cancelled = await cancelPlan(plan.id);
  expect(cancelled).toMatchObject({ id: plan.id, section: 'done', readyToArchive: false });
  expect(cancelled.cancelledAt).toBe(cancelled.archivedAt);
  expect(cancelled.items.map(item => item.status)).toEqual(['done', 'todo']);

  const library = await listPlans();
  expect(library.live.some(row => row.id === plan.id)).toBe(false);
  expect(library.done.find(row => row.id === plan.id)).toMatchObject({ cancelledAt: cancelled.cancelledAt });
  // Repeating the cancel is the same answer; editing a cancelled Plan is refused like any archive.
  expect((await cancelPlan(plan.id)).cancelledAt).toBe(cancelled.cancelledAt);
  await expect(updatePlan(plan.id, { title: 'Revived' }, cancelled.updatedAt)).rejects.toThrow('Archived Plans cannot be edited');
  await expect(cancelPlan('00000000-0000-4000-8000-00000000ffff')).rejects.toThrow('Plan not found');
});

it('refuses to relabel a Plan archived as finished as cancelled', async () => {
  const plan = await createPlan({ title: 'Really done', items: [{ text: 'All of it', status: 'done' }] });
  await archivePlan(plan.id);
  await expect(cancelPlan(plan.id)).rejects.toThrow('already archived as finished');
});

it('accepts an incomplete archived Plan only when it was cancelled at its archive time', async () => {
  const record = (extra: Record<string, unknown>) => ({
    version: 1,
    plans: [{
      id: '00000000-0000-4000-8000-00000000aaaa',
      title: 'Half done',
      items: [{ id: '00000000-0000-4000-8000-00000000aaab', text: 'Todo', status: 'todo' }],
      createdAt: 1, updatedAt: 5, archivedAt: 5, ...extra
    }]
  });
  await writeDurableNow('plans', record({ cancelledAt: 5 }));
  expect((await listPlans()).done).toHaveLength(1);
  await writeDurableNow('plans', record({ cancelledAt: 4 }));
  await expect(listPlans()).rejects.toThrow('Plan catalog is invalid');
  await writeDurableNow('plans', record({}));
  await expect(listPlans()).rejects.toThrow('Plan catalog is invalid');
});
