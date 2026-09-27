import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { ensureRequestTrailForAcceptedPlan } from '../src/main/request-trail-admission.js';
import { listRequestTrail, resetRequestTrailForTests } from '../src/main/request-trail.js';
import { resetPlansForTests, syncSessionAgentPlan } from '../src/main/plans.js';
import { createQuilt, resetPinsForTests } from '../src/main/pins.js';
import { enqueueInput, resetInputForTests } from '../src/main/session/input.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  upsertMessageEvent,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';

beforeEach(async () => {
  directory = await makeTempDir('paradigmeve-request-admission-');
  resetDurableForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetPlansForTests();
  resetRequestTrailForTests();
  resetPinsForTests();
  resetInputForTests();
  initDurableStore(directory);
  initSessionStore(directory);
});

afterEach(async () => {
  resetRequestTrailForTests();
  resetPlansForTests();
  resetPinsForTests();
  resetInputForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('Request Trail production admission', () => {
  it('promotes a fresh Thread opening into Request Trail from the exact originating input id', async () => {
    const thread = await createQuilt({ title: 'requests', collectionIds: [] });
    const inputId = randomUUID();
    await enqueueInput({
      id: inputId,
      sessionId: null,
      contextQuiltId: thread.id,
      text: 'Implement the bounded request from this Thread.',
      mode: 'auto',
      dueAt: 0,
      model: null,
      reasoningEffort: null
    });

    const conversationId = 'thread-admission-conversation-0001';
    const session = await createSession({ title: 'Thread admission', conversationId });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'app',
      kind: 'user_message',
      inputId,
      messageId: 'thread-admission-user-message-1',
      turnId: 'thread-admission-turn-1',
      message: { text: 'Implement the bounded request from this Thread.', chars: 47, truncated: false }
    });
    await appendEvent(session.id, { time: 1_001, source: 'extension', kind: 'turn_start', turnId: 'thread-admission-turn-1' });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'Thread admission', {
      plan: [{ step: 'Implement the bounded request', status: 'in_progress' }]
    });

    const trail = await ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! });
    expect(trail).toMatchObject({
      planId: plan!.id,
      threadId: thread.id,
      origin: { sessionId: session.id, conversationId, eventSeq: request.seq }
    });
  });

  it('admits one exact active-turn user request when an accepted human update_plan becomes a first-class Plan', async () => {
    const conversationId = 'admission-conversation-0001';
    const session = await createSession({ title: 'Admission test', conversationId });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'admission-user-message-1',
      turnId: 'admission-turn-1',
      message: {
        text: 'Trace the production admission bug, implement the fix, and run focused tests.',
        chars: 75,
        truncated: false
      }
    });
    await appendEvent(session.id, {
      time: 1_001,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'admission-turn-1'
    });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'Admission test', {
      plan: [
        { step: 'Trace admission', status: 'completed' },
        { step: 'Wire Request Trail', status: 'in_progress' },
        { step: 'Verify runtime', status: 'pending' }
      ]
    });
    expect(plan?.audience).toBe('human');

    const trail = await ensureRequestTrailForAcceptedPlan({
      sessionId: session.id,
      conversationId,
      plan: plan!
    });
    expect(trail).toMatchObject({
      planId: plan!.id,
      state: 'running',
      origin: {
        sessionId: session.id,
        conversationId,
        eventSeq: request.seq,
        messageId: 'admission-user-message-1',
        turnId: 'admission-turn-1'
      }
    });
    expect(trail?.summary).toBe('Trace the production admission bug, implement the fix, and run focused tests.');
    expect(await listRequestTrail()).toHaveLength(1);

    // A later accepted update of the same Plan reuses its exact Request Trail link instead of
    // reinterpreting the newest chat prose as another request.
    await appendEvent(session.id, {
      time: 2_000,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'admission-turn-1',
      outcome: 'completed'
    });
    await appendEvent(session.id, {
      time: 3_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'admission-user-message-2',
      turnId: 'admission-turn-2',
      message: { text: 'Also make the status copy concise.', chars: 34, truncated: false }
    });
    await appendEvent(session.id, {
      time: 3_001,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'admission-turn-2'
    });
    const repeated = await ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! });
    expect(repeated?.id).toBe(trail?.id);
    expect(repeated?.origin.eventSeq).toBe(request.seq);
    expect(await listRequestTrail()).toHaveLength(1);
  });

  it('admits a confirmed fresh-chat app opening recorded just before its exact turn_start', async () => {
    const thread = await createQuilt({ title: 'plans', collectionIds: [] });
    const conversationId = 'fresh-opening-conversation-0001';
    const session = await createSession({ title: 'Fresh Plans opening', conversationId });
    const inputId = randomUUID();
    await enqueueInput({
      id: inputId,
      sessionId: null,
      contextQuiltId: thread.id,
      text: 'Make me a 3 step plan to get started with %plans.',
      mode: 'auto',
      dueAt: 0,
      model: null,
      reasoningEffort: null
    });
    const written = await upsertMessageEvent(session.id, {
      time: 1_000,
      source: 'app',
      kind: 'user_message',
      messageId: 'fresh-opening-user-message',
      inputId,
      inputDelivery: 'confirmed',
      authoredText: 'Make me a 3 step plan to get started with %plans.',
      message: {
        text: '[[PARADIGMEVE_CONTEXT]]\n...\n[[/PARADIGMEVE_CONTEXT]]\n\n--- Current request ---\nMake me a 3 step plan to get started with %plans.',
        chars: 132,
        truncated: false
      }
    });
    expect(written.event.turnId).toBeUndefined();
    await appendEvent(session.id, {
      time: 1_001,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'fresh-opening-turn-1'
    });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'Fresh Plans opening', {
      plan: [
        { step: 'Pick one small outcome', status: 'in_progress' },
        { step: 'Work the Plan with Eve', status: 'pending' },
        { step: 'Review and archive', status: 'pending' }
      ]
    });

    const trail = await ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! });
    expect(trail).toMatchObject({
      planId: plan!.id,
      threadId: thread.id,
      summary: 'Make me a 3 step plan to get started with %plans.',
      origin: {
        sessionId: session.id,
        conversationId,
        eventSeq: written.event.origin ?? written.event.seq,
        messageId: 'fresh-opening-user-message'
      }
    });
  });

  it('does not infer a pre-start request when the opening segment is ambiguous', async () => {
    const conversationId = 'fresh-opening-ambiguous-0001';
    const session = await createSession({ title: 'Ambiguous fresh opening', conversationId });
    for (const [index, text] of ['First possible opening.', 'Second possible opening.'].entries()) {
      await upsertMessageEvent(session.id, {
        time: 1_000 + index,
        source: 'app',
        kind: 'user_message',
        messageId: `ambiguous-opening-${index}`,
        inputId: randomUUID(),
        inputDelivery: 'confirmed',
        authoredText: text,
        message: { text, chars: text.length, truncated: false }
      });
    }
    await appendEvent(session.id, {
      time: 1_010,
      source: 'extension',
      kind: 'turn_start',
      turnId: 'fresh-opening-ambiguous-turn'
    });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'Ambiguous fresh opening', {
      plan: [{ step: 'Do not guess', status: 'in_progress' }]
    });

    await expect(ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! }))
      .rejects.toThrow(/one exact canonical user request message/i);
    expect(await listRequestTrail()).toEqual([]);
  });

  it('fails closed when a human Plan has no exact active-turn user request identity', async () => {
    const conversationId = 'admission-conversation-0002';
    const session = await createSession({ title: 'No exact request', conversationId });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'No exact request', {
      plan: [{ step: 'Do not guess', status: 'in_progress' }]
    });
    await expect(ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! }))
      .rejects.toThrow(/no exact active request turn/i);
    expect(await listRequestTrail()).toEqual([]);
  });

  it('fails closed when more than one canonical user message claims the active turn', async () => {
    const conversationId = 'admission-conversation-0003';
    const session = await createSession({ title: 'Ambiguous request', conversationId });
    for (const [messageId, text] of [
      ['ambiguous-user-message-1', 'First possible request.'],
      ['ambiguous-user-message-2', 'Second possible request.']
    ] as const) {
      await appendEvent(session.id, {
        time: 1_000,
        source: 'extension',
        kind: 'user_message',
        messageId,
        turnId: 'ambiguous-turn-1',
        message: { text, chars: text.length, truncated: false }
      });
    }
    await appendEvent(session.id, { time: 1_001, source: 'extension', kind: 'turn_start', turnId: 'ambiguous-turn-1' });
    const plan = await syncSessionAgentPlan(session.id, conversationId, 'Ambiguous request', {
      plan: [{ step: 'Do not guess between requests', status: 'in_progress' }]
    });
    await expect(ensureRequestTrailForAcceptedPlan({ sessionId: session.id, conversationId, plan: plan! }))
      .rejects.toThrow(/one exact canonical user request message/i);
    expect(await listRequestTrail()).toEqual([]);
  });

  it('does not admit worker/helper Eve Activity as a user Request Trail', async () => {
    const prime = await createSession({ title: 'Prime', conversationId: 'admission-prime-0001' });
    const worker = await createSession({
      title: 'Worker',
      conversationId: 'admission-worker-0001',
      origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Implement the bounded fix' }
    });
    await appendEvent(worker.id, {
      time: 1_000,
      source: 'app',
      kind: 'user_message',
      messageId: 'worker-bootstrap-message',
      turnId: 'worker-turn-1',
      message: { text: 'Implement the bounded fix.', chars: 26, truncated: false }
    });
    await appendEvent(worker.id, { time: 1_001, source: 'extension', kind: 'turn_start', turnId: 'worker-turn-1' });
    const plan = await syncSessionAgentPlan(worker.id, 'admission-worker-0001', 'Worker', {
      plan: [{ step: 'Implement', status: 'in_progress' }]
    });
    // The immediate sync projection historically defaults to `human`; admission must not trust
    // that presentation shortcut. Durable worker ancestry is the authority fence here.
    expect(plan?.audience).toBe('human');
    expect(await ensureRequestTrailForAcceptedPlan({
      sessionId: worker.id,
      conversationId: 'admission-worker-0001',
      plan: plan!
    })).toBeNull();
    expect(await listRequestTrail()).toEqual([]);
  });
});
