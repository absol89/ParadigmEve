import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestCheckInOwner,
  type DurableRequestCheckInSnapshot,
  type DurableRequestCheckInSource,
  type RequestCheckInClaim,
  type RequestCheckInNotification
} from '../src/main/request-checkins.js';

const START = 1_000_000;
const SILENCE = 60_000;

class Source implements DurableRequestCheckInSource {
  snapshots: DurableRequestCheckInSnapshot[] = [];
  claims: RequestCheckInClaim[] = [];
  claimed = new Set<string>();
  listener: ((requestRef: string) => void) | null = null;
  async listCheckInRequests(): Promise<readonly DurableRequestCheckInSnapshot[]> { return this.snapshots; }
  onCheckInRequestChange(listener: (requestRef: string) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = null; };
  }
  async claimCheckInNotification(claim: RequestCheckInClaim): Promise<boolean> {
    this.claims.push(claim);
    const current = this.snapshots.find(row => row.requestRef === claim.requestRef);
    if (!current || current.revision !== claim.expectedRevision) return false;
    const key = `${claim.requestRef}:${claim.dedupeKey}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    current.lastCheckInAt = claim.claimedAt;
    return true;
  }
  changed(requestRef = this.snapshots[0]?.requestRef ?? ''): void { this.listener?.(requestRef); }
}

function active(overrides: Partial<Extract<DurableRequestCheckInSnapshot, { state: 'active' }>> = {}): Extract<DurableRequestCheckInSnapshot, { state: 'active' }> {
  return {
    requestRef: 'req:opaque-1', revision: 'rev:1', summary: 'Compare the installer logs and repair the failing recovery path',
    threadRef: 'thread:opaque-1', evidenceRefs: ['evidence:log-1'], activityRef: 'activity:item-1', activityState: 'open',
    planRef: 'plan:opaque-2', planState: 'live', planSignoffRequired: true, userStoryRef: 'story:opaque-2',
    resultRef: 'result:opaque-3', testRefs: ['tests:opaque-3'], startedAt: START, lastCheckInAt: null, state: 'active',
    activeEvidenceRef: 'activity:opaque-4', lastMeaningfulAt: START, progress: null, ...overrides
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); });

describe('long-running request check-ins', () => {
  it('publishes authority-marked progress immediately with exact opaque links', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + 10_000);
    const source = new Source();
    source.snapshots = [active({ progress: { eventRef: 'event:milestone-1', at: START + 9_000, text: 'The recovery owner is isolated; focused validation is running.', meaningful: true } })];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'progress',
      requestSummary: 'Compare the installer logs and repair the failing recovery path',
      links: {
        originalRequest: 'req:opaque-1', requestThread: 'thread:opaque-1', evidence: ['evidence:log-1'],
        eveActivity: 'activity:item-1', plan: 'plan:opaque-2', userStory: 'story:opaque-2', implementationResult: 'result:opaque-3',
        tests: ['tests:opaque-3'], decision: null, currentState: 'event:milestone-1'
      }
    });
    expect(source.claims[0]).toMatchObject({ requestRef: 'req:opaque-1', expectedRevision: 'rev:1', dedupeKey: 'progress:event:milestone-1', kind: 'progress' });
    owner.stop();
  });

  it('does not turn routine activity or elapsed time without active evidence into a working claim', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + SILENCE * 2);
    const source = new Source();
    source.snapshots = [active({
      activeEvidenceRef: null,
      progress: { eventRef: 'event:routine-1', at: START + 1_000, text: 'Read another file.', meaningful: false }
    })];
    const notify = vi.fn();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).not.toHaveBeenCalled();
    expect(source.claims).toHaveLength(0);
    owner.stop();
  });

  it('uses a bounded silence fallback only while durable state positively says active', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const source = new Source(); source.snapshots = [active()];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SILENCE);
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'silence', title: expect.stringContaining('Still working'),
      links: { currentState: 'activity:opaque-4' }
    });
    owner.stop();
  });

  it('dedupes the same silence bucket across restart through the durable source claim', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + SILENCE);
    const source = new Source(); source.snapshots = [active()];
    const first = vi.fn();
    const ownerA = createRequestCheckInOwner({ source, notify: first, silenceMs: SILENCE });
    ownerA.start(); await ownerA.refresh(); ownerA.stop();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const ownerB = createRequestCheckInOwner({ source, notify: second, silenceMs: SILENCE });
    ownerB.start(); await ownerB.refresh();
    expect(second).not.toHaveBeenCalled();
    expect(source.claims.filter(row => row.kind === 'silence')).toHaveLength(1);
    ownerB.stop();
  });

  it('does not stack a silence check-in on top of a newly delivered milestone', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + SILENCE * 2);
    const source = new Source();
    source.snapshots = [active({
      lastMeaningfulAt: START,
      progress: { eventRef: 'event:late-milestone', at: START + 5_000, text: 'A real milestone is ready.', meaningful: true }
    })];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify.mock.calls.map(call => call[0].kind)).toEqual(['progress']);
    owner.stop();
  });

  it('surfaces Needs-you state immediately and preserves its exact state/result references', async () => {
    const source = new Source();
    source.snapshots = [{
      requestRef: 'req:needs', revision: 'rev:needs', summary: 'Prepare the release candidate',
      threadRef: 'thread:needs', evidenceRefs: ['evidence:needs'], activityRef: 'activity:needs', activityState: 'open',
      planRef: 'plan:needs', planState: 'live', planSignoffRequired: true, userStoryRef: 'story:needs',
      resultRef: 'result:draft', testRefs: ['tests:draft'], startedAt: START, lastCheckInAt: null, state: 'needs_user',
      stateRef: 'needs:approval-1', needsUser: 'Choose whether to publish the candidate or keep it private.', decisionRef: 'decision:publish'
    }];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'needs_user', title: expect.stringContaining('Needs you'),
      links: {
        originalRequest: 'req:needs', requestThread: 'thread:needs', eveActivity: 'activity:needs', plan: 'plan:needs', implementationResult: 'result:draft',
        tests: ['tests:draft'], decision: 'decision:publish', currentState: 'needs:approval-1'
      }
    });
    owner.stop();
  });

  it('review-ready terminal links the whole request-to-signoff chain and states the decision Eve wants', async () => {
    const source = new Source();
    source.snapshots = [{
      requestRef: 'req:review', revision: 'rev:review', summary: 'Repair browser recovery',
      threadRef: 'thread:recovery', evidenceRefs: ['evidence:logs', 'evidence:repro'], activityRef: 'activity:recovery', activityState: 'complete',
      planRef: 'plan:recovery', planState: 'ready_to_archive', planSignoffRequired: true, userStoryRef: 'story:recovery',
      resultRef: 'result:recovery', testRefs: ['tests:unit', 'tests:smoke'], startedAt: START, lastCheckInAt: null,
      state: 'ready_for_review', stateRef: 'terminal:review-1', decisionRef: 'decision:signoff-1',
      outcome: 'Recovery now reuses the exact restored conversation and focused tests pass.',
      feedbackPrompt: 'Approve this recovery behavior for signoff, or tell Eve what still needs changing.'
    }];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    const message = notify.mock.calls[0]![0];
    expect(message.kind).toBe('terminal');
    expect(message.title).toContain('Implementation complete · Ready for review');
    expect(message.body).toContain('Eve activity complete.');
    expect(message.body).toContain('Plan is ready to archive and is still awaiting your signoff.');
    expect(message.body).toContain('Recovery now reuses the exact restored conversation');
    expect(message.body).toContain('Decision needed: Approve this recovery behavior for signoff');
    expect(message.links).toEqual({
      originalRequest: 'req:review', requestThread: 'thread:recovery', evidence: ['evidence:logs', 'evidence:repro'],
      eveActivity: 'activity:recovery', plan: 'plan:recovery', planSource: 'thread:recovery', userStory: 'story:recovery', implementationResult: 'result:recovery', tests: ['tests:unit', 'tests:smoke'],
      decision: 'decision:signoff-1', currentState: 'terminal:review-1'
    });
    owner.stop();
  });

  it('distinguishes explicit signoff from review readiness', async () => {
    const source = new Source();
    source.snapshots = [{
      requestRef: 'req:signed', revision: 'rev:signed', summary: 'Repair browser recovery',
      threadRef: 'thread:recovery', evidenceRefs: [], activityRef: 'activity:recovery', activityState: 'complete',
      planRef: 'plan:recovery', planState: 'signed_off', planSignoffRequired: true, userStoryRef: null, resultRef: 'result:recovery',
      testRefs: ['tests:unit'], startedAt: START, lastCheckInAt: null, state: 'signed_off', stateRef: 'terminal:signed-1', decisionRef: null,
      outcome: 'The reviewed change is accepted and the request lifecycle is closed.', feedbackPrompt: 'No further action is required unless you want another change.'
    }];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify.mock.calls[0]![0].title).toContain('Signed off');
    expect(notify.mock.calls[0]![0].body).toContain('Feedback wanted: No further action is required');
    owner.stop();
  });

  it('never treats checked Plan items, passing tests, or archive readiness as user signoff', async () => {
    const source = new Source();
    source.snapshots = [{
      requestRef: 'req:not-signed', revision: 'rev:not-signed', summary: 'Ship the new recovery flow',
      threadRef: 'thread:not-signed', evidenceRefs: ['evidence:implementation'], activityRef: 'activity:not-signed', activityState: 'complete',
      planRef: 'plan:not-signed', planState: 'ready_to_archive', planSignoffRequired: true, userStoryRef: 'story:not-signed',
      resultRef: 'result:not-signed', testRefs: ['tests:passing'], startedAt: START, lastCheckInAt: null,
      state: 'ready_for_review', stateRef: 'terminal:not-signed', decisionRef: 'decision:not-signed',
      outcome: 'Implementation and tests are complete.', feedbackPrompt: 'Review the result and sign off or request changes.'
    }];
    const notify = vi.fn<(notification: RequestCheckInNotification) => void>();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    const message = notify.mock.calls[0]![0];
    expect(message.title).not.toContain('Signed off');
    expect(message.body).toContain('Plan is ready to archive and is still awaiting your signoff.');
    expect(message.links.decision).toBe('decision:not-signed');
    owner.stop();
  });

  it('fails closed instead of claiming signoff when the durable Plan is not signed off', async () => {
    const source = new Source();
    source.snapshots = [{
      requestRef: 'req:false-signoff', revision: 'rev:false-signoff', summary: 'Review a high-level Plan',
      threadRef: 'thread:false-signoff', evidenceRefs: [], activityRef: 'activity:false-signoff', activityState: 'complete',
      planRef: 'plan:false-signoff', planState: 'ready_to_archive', planSignoffRequired: true, userStoryRef: null,
      resultRef: 'result:false-signoff', testRefs: ['tests:passing'], startedAt: START, lastCheckInAt: null,
      state: 'signed_off', stateRef: 'terminal:false-signoff', decisionRef: 'decision:false-signoff',
      outcome: 'Implementation is complete.', feedbackPrompt: 'Review it.'
    }];
    const notify = vi.fn();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).not.toHaveBeenCalled();
    expect(source.claims).toHaveLength(0);
    owner.stop();
  });

  it('rejects a stale revision before any notification side effect', async () => {
    const source = new Source();
    source.snapshots = [active({ revision: 'rev:new', progress: { eventRef: 'event:new', at: START, text: 'New state', meaningful: true } })];
    const originalClaim = source.claimCheckInNotification.bind(source);
    source.claimCheckInNotification = async claim => originalClaim({ ...claim, expectedRevision: 'rev:old' });
    const notify = vi.fn();
    const owner = createRequestCheckInOwner({ source, notify, silenceMs: SILENCE });
    owner.start(); await owner.refresh();
    expect(notify).not.toHaveBeenCalled();
    owner.stop();
  });
});
