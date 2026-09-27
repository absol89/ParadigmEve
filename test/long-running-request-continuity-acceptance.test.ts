import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  initDurableStore,
  readDurableStrict,
  resetDurableForTests,
  writeDurableNow
} from '../src/main/durable.js';
import {
  createRequestCheckInOwner,
  type DurableRequestCheckInSnapshot,
  type DurableRequestCheckInSource,
  type RequestCheckInClaim,
  type RequestCheckInNotification
} from '../src/main/request-checkins.js';
import {
  ensureRequestTrail,
  requestTrailById,
  resetRequestTrailForTests,
  updateRequestTrail
} from '../src/main/request-trail.js';
import { createRequestTrailCheckInSource, requestTrailSourceTarget } from '../src/main/request-trail-checkins.js';
import {
  createCollection,
  createPin,
  createQuilt,
  pinsLibrary,
  resetPinsForTests
} from '../src/main/pins.js';
import { archivePlan, createPlan, listPlans, resetPlansForTests, updatePlan } from '../src/main/plans.js';
import { inputArgs } from '../src/main/session/input.js';
import {
  appendEvent,
  createSession,
  endSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import { workspaceReferenceNavigation, createExactSourceLink } from '../src/renderer/workspace-reference-links.js';
import type { PinsLibrarySnapshot } from '../src/shared/pins.js';

let directory: string;

const CHECK_IN_CLAIMS = 'acceptance-long-request-checkin-claims';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type ClaimState = { keys: string[] };

class DurableAcceptanceCheckInSource implements DurableRequestCheckInSource {
  private listener: ((requestRef: string) => void) | null = null;

  constructor(public snapshots: DurableRequestCheckInSnapshot[]) {}

  async listCheckInRequests(): Promise<readonly DurableRequestCheckInSnapshot[]> {
    return this.snapshots;
  }

  onCheckInRequestChange(listener: (requestRef: string) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = null; };
  }

  async claimCheckInNotification(claim: RequestCheckInClaim): Promise<boolean> {
    const snapshot = this.snapshots.find(row => row.requestRef === claim.requestRef);
    if (!snapshot || snapshot.revision !== claim.expectedRevision) return false;
    const current = await readDurableStrict<ClaimState>(CHECK_IN_CLAIMS) ?? { keys: [] };
    const key = `${claim.requestRef}:${claim.dedupeKey}`;
    if (current.keys.includes(key)) return false;
    await writeDurableNow(CHECK_IN_CLAIMS, { keys: [...current.keys, key] });
    snapshot.lastCheckInAt = claim.claimedAt;
    return true;
  }

  changed(requestRef = this.snapshots[0]?.requestRef ?? ''): void {
    this.listener?.(requestRef);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-long-request-acceptance-'));
  resetRequestTrailForTests();
  resetPinsForTests();
  resetPlansForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  initDurableStore(directory);
  initSessionStore(directory);
});

afterEach(async () => {
  resetRequestTrailForTests();
  resetPinsForTests();
  resetPlansForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('long-running request continuity acceptance', () => {
  it('keeps native request notification source navigation pinned to the exact recorded event', () => {
    expect(requestTrailSourceTarget('source:session-source-0001:42')).toEqual({
      sessionId: 'session-source-0001',
      eventSeq: 42
    });
    expect(requestTrailSourceTarget('source:session-source-0001:0')).toBeNull();
    expect(requestTrailSourceTarget('source:session-source-0001:10000001')).toBeNull();
    expect(requestTrailSourceTarget(`thread:${randomUUID()}`)).toBeNull();
  });

  it('keeps exact request → Thread evidence → Plan/user story → worker → result → Needs-review provenance through restart', async () => {
    const conversationId = 'continuity-conversation-0001';
    const session = await createSession({ title: 'Long request continuity', conversationId });
    const requestText = 'Trace the recovery bug, implement the bounded fix, run tests, and bring it back for my review.';
    const requestEvent = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'continuity-request-message-1',
      turnId: 'continuity-turn-1',
      message: { text: requestText, chars: requestText.length, truncated: false }
    });

    const widerQuilt = await createCollection({ name: 'Recovery' });
    const evidenceThread = await createQuilt({ title: 'Recovery evidence', collectionIds: [widerQuilt.id] });
    const plan = await createPlan({
      title: 'User story · recovery continuity',
      items: [
        { text: 'As the user, I can return to the exact originating request.', status: 'in_progress' },
        { text: 'Verify the bounded implementation and focused tests.', status: 'todo' },
        { text: 'Present the result for explicit review/signoff.', status: 'todo' }
      ],
      provenance: {
        kind: 'message',
        sessionId: session.id,
        conversationId,
        messageId: 'continuity-request-message-1',
        label: 'Originating long-running request'
      }
    });

    const accepted = await ensureRequestTrail({
      origin: {
        sessionId: session.id,
        conversationId,
        eventSeq: requestEvent.seq,
        messageId: 'continuity-request-message-1',
        turnId: 'continuity-turn-1'
      },
      summary: 'Repair recovery continuity and return the verified result for review',
      state: 'planned',
      planId: plan.id,
      workers: [{ runId: RUN_ID, workerId: 'worker-continuity', conversationId: 'worker-conversation-continuity' }],
      threadId: evidenceThread.id,
      quiltIds: [widerQuilt.id]
    });

    // The Thread/Quilt discussion is evidence/context metadata only. Merely linking it does not
    // create a Pin, rewrite the user request, or grant a second execution authority.
    expect((await pinsLibrary()).pins).toEqual([]);
    expect(accepted).toMatchObject({
      origin: {
        sessionId: session.id,
        conversationId,
        eventSeq: requestEvent.seq,
        messageId: 'continuity-request-message-1',
        turnId: 'continuity-turn-1'
      },
      planId: plan.id,
      workers: [{ runId: RUN_ID, workerId: 'worker-continuity', conversationId: 'worker-conversation-continuity' }],
      threadId: evidenceThread.id,
      quiltIds: [widerQuilt.id]
    });

    const resultText = 'PR-like result: recovery now reuses the exact source request; focused tests are green.';
    const resultEvent = await appendEvent(session.id, {
      time: 2_000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'continuity-result-message-1',
      turnId: 'continuity-turn-1',
      message: { text: resultText, chars: resultText.length, truncated: false },
      state: 'final',
      final: true
    });
    const advancedPlan = await updatePlan(plan.id, {
      items: plan.items.map((item, index) => ({
        ...item,
        status: index < 2 ? 'done' as const : 'in_progress' as const
      }))
    }, plan.updatedAt);
    expect(advancedPlan.items.map(item => item.status)).toEqual(['done', 'done', 'in_progress']);

    const reviewText = 'Implementation and tests are ready. Please review the result and sign off before this request is considered accepted.';
    const reviewEvent = await appendEvent(session.id, {
      time: 2_100,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'continuity-review-message-1',
      turnId: 'continuity-turn-1',
      message: { text: reviewText, chars: reviewText.length, truncated: false },
      state: 'final',
      final: true
    });
    const resultRef = {
      sessionId: session.id,
      conversationId,
      eventSeq: resultEvent.seq,
      kind: 'assistant_message' as const,
      messageId: 'continuity-result-message-1',
      turnId: 'continuity-turn-1'
    };
    const reviewRef = {
      sessionId: session.id,
      conversationId,
      eventSeq: reviewEvent.seq,
      kind: 'assistant_message' as const,
      messageId: 'continuity-review-message-1',
      turnId: 'continuity-turn-1'
    };
    const readyForSignoff = await updateRequestTrail(accepted.id, {
      state: 'needs_user',
      resultRef,
      needsUserRef: reviewRef
    });
    expect(readyForSignoff).toMatchObject({
      state: 'needs_user',
      planId: plan.id,
      resultRef,
      needsUserRef: reviewRef,
      threadId: evidenceThread.id,
      quiltIds: [widerQuilt.id],
      terminalAt: null
    });

    // Process restart: reset serializers/caches but keep durable bytes. Every exact link must survive.
    resetRequestTrailForTests();
    resetPinsForTests();
    resetPlansForTests();
    resetSessionStoreForTests();
    unsetSessionRootForTests();
    resetDurableForTests();
    initDurableStore(directory);
    initSessionStore(directory);

    expect(await requestTrailById(accepted.id)).toEqual(readyForSignoff);
    expect((await listPlans()).live.find(row => row.id === plan.id)).toMatchObject({
      id: plan.id,
      provenance: {
        kind: 'message',
        sessionId: session.id,
        conversationId,
        messageId: 'continuity-request-message-1'
      }
    });
    const restoredPins = await pinsLibrary();
    expect(restoredPins.pins).toEqual([]);
    expect(restoredPins.quilts.find(row => row.id === evidenceThread.id)?.collectionIds).toContain(widerQuilt.id);
  });

  it('recovers a missed meaningful progress ping and dedupes progress + terminal pings across process restart', async () => {
    const requestRef = `request:${randomUUID()}`;
    const planRef = `plan:${randomUUID()}`;
    const resultRef = `result:${randomUUID()}`;
    const progressSnapshot: DurableRequestCheckInSnapshot = {
      requestRef,
      revision: 'revision:progress-1',
      summary: 'Repair long-running request continuity',
      threadRef: `thread:${randomUUID()}`,
      evidenceRefs: ['evidence:repro-1'],
      activityRef: 'activity:continuity-1',
      activityState: 'open',
      planRef,
      planState: 'live',
      planSignoffRequired: true,
      userStoryRef: 'story:continuity-1',
      resultRef,
      testRefs: ['tests:focused-green'],
      startedAt: 1_000,
      lastCheckInAt: null,
      state: 'active',
      activeEvidenceRef: 'activity:worker-1',
      lastMeaningfulAt: 1_500,
      progress: {
        eventRef: 'progress:focused-tests-green',
        at: 2_000,
        text: 'The implementation is in place and focused tests are green.',
        meaningful: true
      }
    };

    // The progress event existed before the presentation owner started: startup recovery must still
    // surface it once rather than treating the missed notification as lost work.
    const sourceA = new DurableAcceptanceCheckInSource([progressSnapshot]);
    const firstProgress = vi.fn<(notification: RequestCheckInNotification) => void>();
    const ownerA = createRequestCheckInOwner({ source: sourceA, notify: firstProgress });
    ownerA.start();
    await ownerA.refresh();
    await flush();
    ownerA.stop();
    expect(firstProgress).toHaveBeenCalledTimes(1);
    expect(firstProgress.mock.calls[0]![0]).toMatchObject({
      kind: 'progress',
      requestSummary: 'Repair long-running request continuity',
      links: {
        originalRequest: requestRef,
        requestThread: progressSnapshot.threadRef,
        evidence: ['evidence:repro-1'],
        eveActivity: 'activity:continuity-1',
        plan: planRef,
        userStory: 'story:continuity-1',
        implementationResult: resultRef,
        tests: ['tests:focused-green'],
        decision: null,
        currentState: 'progress:focused-tests-green'
      }
    });

    // New process, same durable claim bytes: no second progress side effect.
    resetDurableForTests();
    initDurableStore(directory);
    const sourceB = new DurableAcceptanceCheckInSource([{ ...progressSnapshot }]);
    const replayedProgress = vi.fn();
    const ownerB = createRequestCheckInOwner({ source: sourceB, notify: replayedProgress });
    ownerB.start();
    await ownerB.refresh();
    await flush();
    ownerB.stop();
    expect(replayedProgress).not.toHaveBeenCalled();

    const terminalSnapshot: DurableRequestCheckInSnapshot = {
      requestRef,
      revision: 'revision:terminal-2',
      summary: 'Repair long-running request continuity',
      threadRef: progressSnapshot.threadRef,
      evidenceRefs: ['evidence:repro-1'],
      activityRef: 'activity:continuity-1',
      activityState: 'complete',
      planRef,
      planState: 'ready_to_archive',
      planSignoffRequired: true,
      userStoryRef: 'story:continuity-1',
      resultRef,
      testRefs: ['tests:focused-green'],
      startedAt: 1_000,
      lastCheckInAt: progressSnapshot.lastCheckInAt,
      state: 'ready_for_review',
      stateRef: 'review:ready-77',
      decisionRef: 'decision:signoff-77',
      outcome: 'The implementation result and focused continuity tests are ready for your review.',
      feedbackPrompt: 'Sign off if this matches the request, or tell Eve what still needs changing.'
    };
    const sourceTerminalA = new DurableAcceptanceCheckInSource([terminalSnapshot]);
    const terminal = vi.fn<(notification: RequestCheckInNotification) => void>();
    const ownerTerminalA = createRequestCheckInOwner({ source: sourceTerminalA, notify: terminal });
    ownerTerminalA.start();
    await ownerTerminalA.refresh();
    await flush();
    ownerTerminalA.stop();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0]).toMatchObject({
      kind: 'terminal',
      requestSummary: 'Repair long-running request continuity',
      links: {
        originalRequest: requestRef,
        requestThread: progressSnapshot.threadRef,
        evidence: ['evidence:repro-1'],
        eveActivity: 'activity:continuity-1',
        plan: planRef,
        userStory: 'story:continuity-1',
        implementationResult: resultRef,
        tests: ['tests:focused-green'],
        decision: 'decision:signoff-77',
        currentState: 'review:ready-77'
      }
    });
    expect(terminal.mock.calls[0]![0].title).toContain('Ready for review');
    expect(terminal.mock.calls[0]![0].body).toContain('The implementation result and focused continuity tests are ready');
    expect(terminal.mock.calls[0]![0].body).toContain('Decision needed:');

    resetDurableForTests();
    initDurableStore(directory);
    const sourceTerminalB = new DurableAcceptanceCheckInSource([{ ...terminalSnapshot }]);
    const replayedTerminal = vi.fn();
    const ownerTerminalB = createRequestCheckInOwner({ source: sourceTerminalB, notify: replayedTerminal });
    ownerTerminalB.start();
    await ownerTerminalB.refresh();
    await flush();
    ownerTerminalB.stop();
    expect(replayedTerminal).not.toHaveBeenCalled();
  });

  it('keeps an optional Pin-to-%Thread prompt inert until the explicit Pin owner is invoked', async () => {
    const quilt = await createCollection({ name: 'Continuity' });
    const thread = await createQuilt({ title: 'Recovery-evidence', collectionIds: [quilt.id] });
    const source = new DurableAcceptanceCheckInSource([{
      requestRef: `request:${randomUUID()}`,
      revision: 'revision:needs-review',
      summary: 'Review the long-running result',
      threadRef: `thread:${thread.id}`,
      evidenceRefs: ['evidence:request-discussion'],
      activityRef: 'activity:review-1',
      activityState: 'complete',
      planRef: null,
      planState: 'none',
      planSignoffRequired: true,
      userStoryRef: null,
      resultRef: 'result:exact-1',
      testRefs: ['tests:exact-1'],
      startedAt: 1_000,
      lastCheckInAt: null,
      state: 'needs_user',
      stateRef: 'needs-review:exact-1',
      needsUser: 'Review the result. If it is useful later, you can Pin it to %Recovery-evidence.',
      decisionRef: 'decision:review-1'
    }]);
    const notices: RequestCheckInNotification[] = [];
    const owner = createRequestCheckInOwner({ source, notify: notice => { notices.push(notice); } });
    owner.start();
    await owner.refresh();
    await flush();
    owner.stop();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'needs_user',
      requestSummary: 'Review the long-running result',
      links: {
        originalRequest: source.snapshots[0]!.requestRef,
        requestThread: `thread:${thread.id}`,
        evidence: ['evidence:request-discussion'],
        eveActivity: 'activity:review-1',
        plan: null,
        userStory: null,
        implementationResult: 'result:exact-1',
        tests: ['tests:exact-1'],
        decision: 'decision:review-1',
        currentState: 'needs-review:exact-1'
      }
    });
    expect(notices[0]!.body).toContain('%Recovery-evidence');
    expect((await pinsLibrary()).pins).toEqual([]);

    const explicit = await createPin({
      kind: 'result',
      target: { mode: 'existing', quiltId: thread.id },
      title: 'Reviewed continuity result',
      excerpt: 'Explicitly saved after the review prompt.',
      provenance: {
        sessionId: 'session-explicit-pin',
        conversationId: null,
        eventSeq: 1,
        callId: 'explicit-pin-action'
      }
    });
    expect(explicit.pin.quiltId).toBe(thread.id);
    expect((await pinsLibrary()).pins).toEqual([expect.objectContaining({ id: explicit.pin.id, quiltId: thread.id })]);
  });

  it('navigates %Thread/#Quilt and request/result sources by durable ids and fails closed on ambiguity', async () => {
    const widerQuilt = await createCollection({ name: 'Release' });
    const thread = await createQuilt({ title: 'Recovery', collectionIds: [widerQuilt.id] });
    const snapshot = await pinsLibrary();

    expect(workspaceReferenceNavigation(snapshot, '%Recovery')).toEqual({ screen: 'pins', quiltId: thread.id });
    expect(workspaceReferenceNavigation(snapshot, '#Release')).toEqual({ screen: 'pins', collectionId: widerQuilt.id });

    // Old/corrupt libraries can predate today's duplicate-name fence. Navigation must abstain, not
    // choose whichever similarly named durable object happens to be first.
    const ambiguousThread: PinsLibrarySnapshot = {
      ...snapshot,
      quilts: [...snapshot.quilts, { ...thread, id: randomUUID(), title: '%recovery' }]
    };
    const ambiguousQuilt: PinsLibrarySnapshot = {
      ...snapshot,
      collections: [...snapshot.collections, { ...widerQuilt, id: randomUUID(), name: '#release' }]
    };
    expect(workspaceReferenceNavigation(ambiguousThread, '%Recovery')).toBeNull();
    expect(workspaceReferenceNavigation(ambiguousQuilt, '#Release')).toBeNull();
    expect(workspaceReferenceNavigation(snapshot, '%Missing')).toBeNull();

    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://eve.local/' });
    const visited: unknown[] = [];
    const requestLink = createExactSourceLink(dom.window.document, 'Open original request', 'session-source-request', 41, state => visited.push(state));
    const resultLink = createExactSourceLink(dom.window.document, 'Open current result', 'session-source-result', 77, state => visited.push(state));
    requestLink?.click();
    resultLink?.click();
    expect(visited).toEqual([
      { screen: 'chat', sessionId: 'session-source-request', eventSeq: 41 },
      { screen: 'chat', sessionId: 'session-source-result', eventSeq: 77 }
    ]);
    expect(createExactSourceLink(dom.window.document, 'Ambiguous source', 'x', 41)).toBeNull();
    dom.window.close();
  });

  it('keeps an owning Thread stable through chat migration and admits Thread context only into a fresh chat', async () => {
    const sourceConversation = 'continuity-source-chat-0001';
    const resumedConversation = 'continuity-resumed-chat-0002';
    const session = await createSession({ title: 'Historical request chat', conversationId: sourceConversation });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'thread-source-request',
      turnId: 'thread-source-turn',
      message: { text: 'Keep this request continuous through a later chat.', chars: 51, truncated: false }
    });
    const thread = await createQuilt({ title: 'Stable request thread', collectionIds: [] });
    const trail = await ensureRequestTrail({
      origin: {
        sessionId: session.id,
        conversationId: sourceConversation,
        eventSeq: request.seq,
        messageId: 'thread-source-request',
        turnId: 'thread-source-turn'
      },
      summary: 'Keep one stable discussion Thread after the source chat moves',
      threadId: thread.id
    });

    expect(await rebindSession(session.id, sourceConversation, resumedConversation)).toBe(true);
    expect((await requestTrailById(trail.id))?.threadId).toBe(thread.id);
    expect((await requestTrailById(trail.id))?.origin).toMatchObject({
      sessionId: session.id,
      conversationId: sourceConversation,
      eventSeq: request.seq
    });

    const fresh = inputArgs.safeParse({
      id: randomUUID(),
      sessionId: null,
      contextQuiltId: thread.id,
      text: 'Continue from this Thread in a fresh chat.',
      mode: 'auto',
      dueAt: 0,
      model: null,
      reasoningEffort: null
    });
    expect(fresh.success).toBe(true);
    expect(fresh.success && fresh.data).toMatchObject({ sessionId: null, contextQuiltId: thread.id });

    const resurrectHistoricalChat = inputArgs.safeParse({
      id: randomUUID(),
      sessionId: session.id,
      contextQuiltId: thread.id,
      text: 'Do not reuse the historical creation chat for Thread opening context.',
      mode: 'auto',
      dueAt: 0,
      model: null,
      reasoningEffort: null
    });
    expect(resurrectHistoricalChat.success).toBe(false);
  });

  it('uses structural human Plan archive as the only high-level signoff fence', async () => {
    const conversationId = 'signoff-source-chat-0001';
    const session = await createSession({ title: 'Signoff source', conversationId });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'signoff-request-message',
      turnId: 'signoff-turn',
      message: { text: 'Implement this, then let me sign off the Plan.', chars: 45, truncated: false }
    });
    const review = await appendEvent(session.id, {
      time: 2_000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'signoff-review-message',
      turnId: 'signoff-turn',
      message: { text: 'Implementation is ready for your review.', chars: 40, truncated: false },
      state: 'final',
      final: true
    });
    const thread = await createQuilt({ title: 'Signoff request', collectionIds: [] });
    const plan = await createPlan({
      title: 'High-level signoff Plan',
      provenance: { kind: 'message', sessionId: session.id, conversationId, messageId: 'signoff-request-message' },
      items: [{ text: 'Implement and verify the request', status: 'done' }]
    });
    const trail = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId, eventSeq: request.seq, messageId: 'signoff-request-message', turnId: 'signoff-turn' },
      summary: 'Implement and sign off the high-level Plan',
      state: 'needs_user',
      planId: plan.id,
      threadId: thread.id,
      resultRef: { sessionId: session.id, conversationId, eventSeq: review.seq, kind: 'assistant_message', messageId: 'signoff-review-message', turnId: 'signoff-turn' },
      needsUserRef: { sessionId: session.id, conversationId, eventSeq: review.seq, kind: 'assistant_message', messageId: 'signoff-review-message', turnId: 'signoff-turn' }
    });

    const source = createRequestTrailCheckInSource();
    const before = (await source.listCheckInRequests()).find(row => row.requestRef === `request:${trail.id}`)!;
    expect(before.state).toBe('needs_user');
    expect(before.planState).toBe('ready_to_archive');
    expect(before.planSourceRef).toBe(`thread:${thread.id}`);
    expect((await requestTrailById(trail.id))?.userPlanArchivedAt).toBeNull();

    // Result prose and Ready-to-archive are not signoff. Only the user's structural archive is.
    await archivePlan(plan.id);
    const signed = (await source.listCheckInRequests()).find(row => row.requestRef === `request:${trail.id}`)!;
    expect(signed.state).toBe('signed_off');
    expect(signed.planState).toBe('signed_off');
    expect((await requestTrailById(trail.id))?.userPlanArchivedAt).not.toBeNull();
  });

  it('adapts Request Trail to check-ins with a persistent revision and notification-claim ledger', async () => {
    const conversationId = 'adapter-source-chat-0001';
    const session = await createSession({ title: 'Adapter source', conversationId });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'adapter-request-message',
      turnId: 'adapter-turn',
      message: { text: 'Track this request through notification restart.', chars: 47, truncated: false }
    });
    const needs = await appendEvent(session.id, {
      time: 2_000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'adapter-needs-message',
      turnId: 'adapter-turn',
      message: { text: 'I need your review.', chars: 19, truncated: false },
      state: 'final',
      final: true
    });
    const trail = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId, eventSeq: request.seq, messageId: 'adapter-request-message', turnId: 'adapter-turn' },
      summary: 'Prove persistent request check-in claims',
      state: 'needs_user',
      needsUserRef: { sessionId: session.id, conversationId, eventSeq: needs.seq, kind: 'assistant_message', messageId: 'adapter-needs-message', turnId: 'adapter-turn' }
    });

    const firstSource = createRequestTrailCheckInSource();
    const firstNotifications: RequestCheckInNotification[] = [];
    const firstOwner = createRequestCheckInOwner({
      source: firstSource,
      notify: notification => { firstNotifications.push(notification); },
      silenceMs: 60_000
    });
    firstOwner.start();
    await firstOwner.refresh();
    await flush();
    firstOwner.stop();
    expect(firstNotifications).toHaveLength(1);
    expect(firstNotifications[0]!.links.originalRequest).toBe(`source:${session.id}:${request.seq}`);

    const claimed = await requestTrailById(trail.id);
    expect(claimed?.notificationClaims).toHaveLength(1);
    expect(claimed?.lastCheckInAt).not.toBeNull();
    const claimedRevision = claimed?.revision;

    // New process, same durable bytes: the same exact Needs-you event cannot be claimed twice.
    resetRequestTrailForTests();
    resetDurableForTests();
    initDurableStore(directory);
    const secondSource = createRequestTrailCheckInSource();
    const replayed: RequestCheckInNotification[] = [];
    const secondOwner = createRequestCheckInOwner({ source: secondSource, notify: notification => { replayed.push(notification); } });
    secondOwner.start();
    await secondOwner.refresh();
    await flush();
    secondOwner.stop();
    expect(replayed).toEqual([]);
    expect((await requestTrailById(trail.id))?.revision).toBe(claimedRevision);
  });

  it('recovers missed meaningful progress, falls back after bounded silence, and dedupes both through restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const conversationId = 'progress-source-chat-0001';
    const session = await createSession({ title: 'Progress source', conversationId });
    // The work is genuinely live: its turn is open. That, not the admission state, earns "Still working".
    await appendEvent(session.id, { time: 1_000, source: 'extension', kind: 'turn_start', turnId: 'progress-turn' });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'progress-request-message',
      turnId: 'progress-turn',
      message: { text: 'Run the implementation and focused tests.', chars: 41, truncated: false }
    });
    const tests = await appendEvent(session.id, {
      time: 2_000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'progress-tests-message',
      turnId: 'progress-turn',
      message: { text: 'Focused continuity tests are green.', chars: 35, truncated: false },
      state: 'final',
      final: true
    });
    const trail = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId, eventSeq: request.seq, messageId: 'progress-request-message', turnId: 'progress-turn' },
      summary: 'Run implementation and focused tests',
      state: 'running',
      testRefs: [{ sessionId: session.id, conversationId, eventSeq: tests.seq, kind: 'assistant_message', messageId: 'progress-tests-message', turnId: 'progress-turn' }]
    });

    // The meaningful test event existed before the presentation owner started. Startup recovery
    // must still surface it once, and exact links must retain the original message as evidence.
    const firstSource = createRequestTrailCheckInSource();
    const firstNotifications: RequestCheckInNotification[] = [];
    const firstOwner = createRequestCheckInOwner({
      source: firstSource,
      notify: notification => { firstNotifications.push(notification); },
      silenceMs: 60_000
    });
    firstOwner.start();
    await firstOwner.refresh();
    await flush();
    expect(firstNotifications.map(row => row.kind)).toEqual(['progress']);
    expect(firstNotifications[0]!.links).toMatchObject({
      originalRequest: `source:${session.id}:${request.seq}`,
      evidence: [`source:${session.id}:${request.seq}`],
      tests: [`source:${session.id}:${tests.seq}`],
      planSource: `source:${session.id}:${request.seq}`
    });

    // No newer milestone exists and the request's turn is still open. The bounded silence timer
    // may therefore issue one truthful "Still working" check-in.
    await vi.advanceTimersByTimeAsync(60_000);
    await firstOwner.refresh();
    await flush();
    expect((await requestTrailById(trail.id))?.notificationClaims.map(row => row.kind)).toEqual(['progress', 'silence']);
    expect(firstNotifications.map(row => row.kind)).toEqual(['progress', 'silence']);
    firstOwner.stop();

    const claimed = await requestTrailById(trail.id);
    expect(claimed?.notificationClaims.map(row => row.kind)).toEqual(['progress', 'silence']);
    expect(claimed?.lastCheckInAt).toBe(70_000);

    // New process, same Request Trail bytes: neither the missed milestone nor the silence bucket
    // can replay. The adapter has no side ledger to reconstruct or synchronize.
    resetRequestTrailForTests();
    resetDurableForTests();
    initDurableStore(directory);
    const secondSource = createRequestTrailCheckInSource();
    const replayed: RequestCheckInNotification[] = [];
    const secondOwner = createRequestCheckInOwner({ source: secondSource, notify: notification => { replayed.push(notification); } });
    secondOwner.start();
    await secondOwner.refresh();
    await flush();
    secondOwner.stop();
    expect(replayed).toEqual([]);
  });

  it('never says Still working about a running request whose origin turn is not live', async () => {
    // Dogfood 2026-09-26: two "Make me a 3 step plan" requests from 2026-09-23 were admitted as
    // running (the new Plan's first item was in progress), their chats finished minutes later, and
    // they went on toasting "Still working" every quiet quarter hour for three days.
    vi.useFakeTimers();
    // An hour after the chats' turns started: past ChatGPT's per-turn ceiling for an abandoned open turn.
    vi.setSystemTime(60 * 60_000);
    const scenarios: Array<{ name: string; events: Array<Record<string, unknown>>; end?: boolean }> = [
      { name: 'finished', events: [
        { time: 1_000, kind: 'turn_start', turnId: 'plan-turn' },
        { time: 3_000, kind: 'turn_end', turnId: 'plan-turn', outcome: 'completed' }] },
      { name: 'ended', events: [{ time: 1_000, kind: 'turn_start', turnId: 'plan-turn' }], end: true },
      { name: 'abandoned', events: [{ time: 1_000, kind: 'turn_start', turnId: 'plan-turn' }] }
    ];
    const notifications: RequestCheckInNotification[] = [];
    const trails: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
      const conversationId = `plan-create-chat-000${index}`;
      const session = await createSession({ title: `Create plan ${scenario.name}`, conversationId });
      for (const event of scenario.events) await appendEvent(session.id, { source: 'extension', ...event } as never);
      const request = await appendEvent(session.id, {
        time: 1_500, source: 'extension', kind: 'user_message', messageId: `plan-request-${index}`, turnId: 'plan-turn',
        message: { text: 'Make me a 3 step plan to get started with %plans', chars: 48, truncated: false }
      });
      if (scenario.end) await endSession(session.id);
      const plan = await createPlan({ title: `Coding agent setup ${index}`,
        items: [{ text: 'One', status: 'in_progress' }, { text: 'Two', status: 'todo' }, { text: 'Three', status: 'todo' }],
        provenance: { kind: 'message', sessionId: session.id, conversationId, messageId: `plan-request-${index}` } });
      const trail = await ensureRequestTrail({
        origin: { sessionId: session.id, conversationId, eventSeq: request.seq, messageId: `plan-request-${index}`, turnId: 'plan-turn' },
        summary: 'Make me a 3 step plan to get started with %plans', state: 'running', planId: plan.id
      });
      trails.push(trail.id);
    }
    const owner = createRequestCheckInOwner({
      source: createRequestTrailCheckInSource(), notify: notification => { notifications.push(notification); }, silenceMs: 60_000
    });
    owner.start();
    await owner.refresh();
    // "Abandoned" leaves an open turn past ChatGPT's per-turn ceiling; that is not live work either.
    for (let quarter = 0; quarter < 4; quarter++) {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await owner.refresh();
      await flush();
    }
    owner.stop();
    expect(notifications.filter(row => row.kind === 'silence')).toEqual([]);
    for (const id of trails) {
      expect((await requestTrailById(id))?.notificationClaims.filter(row => row.kind === 'silence')).toEqual([]);
    }
  });

  it('keeps Still working to the newest request of a live chat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const conversationId = 'plan-exec-chat-0001';
    const session = await createSession({ title: 'Execute plan', conversationId });
    const first = await appendEvent(session.id, {
      time: 1_000, source: 'extension', kind: 'user_message', messageId: 'older-request', turnId: 'older-turn',
      message: { text: 'Make me a plan', chars: 14, truncated: false }
    });
    await appendEvent(session.id, { time: 2_000, source: 'extension', kind: 'turn_start', turnId: 'newer-turn' } as never);
    const second = await appendEvent(session.id, {
      time: 2_000, source: 'extension', kind: 'user_message', messageId: 'newer-request', turnId: 'newer-turn',
      message: { text: 'Now execute it', chars: 14, truncated: false }
    });
    const older = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId, eventSeq: first.seq, messageId: 'older-request', turnId: 'older-turn' },
      summary: 'Make me a plan', state: 'running'
    });
    vi.setSystemTime(11_000);
    const newer = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId, eventSeq: second.seq, messageId: 'newer-request', turnId: 'newer-turn' },
      summary: 'Now execute it', state: 'running'
    });
    const notifications: RequestCheckInNotification[] = [];
    const owner = createRequestCheckInOwner({
      source: createRequestTrailCheckInSource(), notify: notification => { notifications.push(notification); }, silenceMs: 60_000
    });
    owner.start();
    await owner.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.refresh();
    await flush();
    owner.stop();
    const silence = notifications.filter(row => row.kind === 'silence');
    expect(silence.map(row => row.requestSummary)).toEqual(['Now execute it']);
    expect(silence[0]!.links.currentState).toBe(`request:${newer.id}:turn:${session.id}:newer-turn`);
    expect((await requestTrailById(older.id))?.notificationClaims.filter(row => row.kind === 'silence')).toEqual([]);
  });

  it('uses the owning request Thread as Plan primary Source across chat migration and keeps history as fallback evidence', async () => {
    const sourceConversation = 'thread-plan-source-chat-0001';
    const resumedConversation = 'thread-plan-resumed-chat-0002';
    const session = await createSession({ title: 'Historical Plan source', conversationId: sourceConversation });
    const request = await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'thread-plan-request-message',
      turnId: 'thread-plan-turn',
      message: { text: 'Keep the Thread as the Plan source when this chat moves.', chars: 54, truncated: false }
    });
    const thread = await createQuilt({ title: 'Primary Plan source', collectionIds: [] });
    const plan = await createPlan({
      title: 'Thread-anchored Plan',
      provenance: {
        kind: 'message',
        sessionId: session.id,
        conversationId: sourceConversation,
        messageId: 'thread-plan-request-message',
        label: 'Historical request chat'
      },
      items: [{ text: 'Keep source identity durable', status: 'in_progress' }]
    });
    const trail = await ensureRequestTrail({
      origin: { sessionId: session.id, conversationId: sourceConversation, eventSeq: request.seq, messageId: 'thread-plan-request-message', turnId: 'thread-plan-turn' },
      summary: 'Keep the Thread as the Plan primary source',
      planId: plan.id,
      threadId: thread.id
    });

    const source = createRequestTrailCheckInSource();
    const projected = (await source.listCheckInRequests()).find(row => row.requestRef === `request:${trail.id}`)!;
    expect(projected.planSourceRef).toBe(`thread:${thread.id}`);
    const anchored = [...(await listPlans()).live, ...(await listPlans()).done].find(row => row.id === plan.id)!;
    expect(anchored.provenance).toMatchObject({
      threadId: thread.id,
      sessionId: session.id,
      conversationId: sourceConversation,
      messageId: 'thread-plan-request-message'
    });

    expect(await rebindSession(session.id, sourceConversation, resumedConversation)).toBe(true);
    const afterMigration = (await source.listCheckInRequests()).find(row => row.requestRef === `request:${trail.id}`)!;
    expect(afterMigration.planSourceRef).toBe(`thread:${thread.id}`);
    expect(afterMigration.evidenceRefs).toContain(`source:${session.id}:${request.seq}`);
    const afterPlan = [...(await listPlans()).live, ...(await listPlans()).done].find(row => row.id === plan.id)!;
    expect(afterPlan.provenance?.threadId).toBe(thread.id);
    expect(afterPlan.provenance?.sessionId).toBe(session.id);
  });
});
