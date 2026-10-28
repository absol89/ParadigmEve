import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';

// Pass-through by default; one test holds or fails a single ledger write.
vi.mock('../src/main/durable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/durable.js')>();
  return { ...actual, writeDurableNow: vi.fn(actual.writeDurableNow) };
});
import {
  closeNativeDelegation,
  listNativeDelegations,
  nativeDelegationBlocksEffectful,
  nativeDelegationBlocksTool,
  nativeDelegationHasActiveLocks,
  nativeDelegationReady,
  prepareNativeDelegation,
  reportNativeDelegation,
  requestNativeDelegationCancellation,
  restoreNativeDelegations,
  settleNativeDelegationHolds,
  type NativeDelegationOwner
} from '../src/main/native-delegation.js';

const owner: NativeDelegationOwner = {
  conversationId: 'prime-conversation-a', sessionId: 'session-a', primeRunId: 'run-a'
};
const other: NativeDelegationOwner = {
  conversationId: 'prime-conversation-b', sessionId: 'session-b', primeRunId: 'run-b'
};
const assignments = [
  { label: 'One', task: 'Read the code and summarize its current behavior' },
  { label: 'Two', task: 'Inspect the existing tests and report gaps' },
  { label: 'Three', task: 'Compare documented APIs without making requests' },
  { label: 'Four', task: 'Propose a read-only negative-test matrix' }
];
let temp: string;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-native-delegation-'));
  initDurableStore(temp);
  await restoreNativeDelegations();
});
afterEach(async () => {
  resetDurableForTests();
  await fs.rm(temp, { recursive: true, force: true });
});

describe('Prime-mediated native delegation ledger', () => {
  it('starts off, permits at most four tasks and locks only the exact proven parent', async () => {
    expect(nativeDelegationReady()).toBe(true);
    expect(nativeDelegationHasActiveLocks()).toBe(false);
    await expect(prepareNativeDelegation({
      owner, assignments: [...assignments, { label: 'Five', task: 'extra' }],
      acknowledgement: 'User-enabled experimental mode'
    })).rejects.toThrow(/ASSIGNMENTS_REQUIRED/);
    const request = await prepareNativeDelegation({
      owner, assignments, acknowledgement: 'User-enabled experimental mode'
    });
    expect(request.assignments).toHaveLength(4);
    expect(request.assignments.every((a) => a.status === 'prepared' && a.report === null)).toBe(true);
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksEffectful(owner.conversationId, 'different-session')).toBe(true);
    expect(nativeDelegationBlocksEffectful(owner.conversationId, null)).toBe(true);
    expect(nativeDelegationBlocksEffectful(other.conversationId, other.sessionId)).toBe(false);
    expect(nativeDelegationBlocksEffectful(null, null)).toBe(true);
    expect(nativeDelegationBlocksTool('exec_command', { cmd: 'git status' }, true, owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksTool('exec_command', { cmd: 'git status' }, true, owner.conversationId, 'different-session')).toBe(true);
    expect(nativeDelegationBlocksTool('exec', { code: 'tools.apply_patch(...)' }, true, owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksTool('update_plan', {}, true, owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksTool('native_delegation', { action: 'prepare' }, true, owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksTool('native_delegation', { action: 'report' }, true, owner.conversationId, owner.sessionId)).toBe(false);
    expect(nativeDelegationBlocksTool('native_delegation', { action: 'close' }, true, owner.conversationId, owner.sessionId)).toBe(false);
    expect(nativeDelegationBlocksTool('agents', { action: 'status' }, true, owner.conversationId, owner.sessionId)).toBe(false);
    expect(nativeDelegationBlocksTool('read', { paths: ['AGENTS.md'] }, false, owner.conversationId, owner.sessionId)).toBe(false);
    expect(nativeDelegationBlocksTool('exec_command', {}, true, other.conversationId, other.sessionId)).toBe(false);
    expect(nativeDelegationBlocksTool('exec_command', {}, true, null, null)).toBe(true);
    await expect(prepareNativeDelegation({
      owner, assignments: assignments.slice(0, 1), acknowledgement: 'duplicate'
    })).rejects.toThrow(/ALREADY_ACTIVE/);
    const unrelated = await prepareNativeDelegation({
      owner: other, assignments: assignments.slice(0, 1), acknowledgement: 'separate user opt-in'
    });
    expect(unrelated.owner.conversationId).toBe(other.conversationId);
  });

  it('preserves distinct parent-reported findings without fabricating child identities or overwriting', async () => {
    const request = await prepareNativeDelegation({ owner, assignments, acknowledgement: 'opted in' });
    const assignmentId = request.assignments[0]!.id;
    await expect(reportNativeDelegation({
      owner: other, requestId: request.id, assignmentId, report: 'spoofed'
    })).rejects.toThrow(/NOT_FOUND_OR_OWNER_CHANGED/);
    const reported = await reportNativeDelegation({
      owner, requestId: request.id, assignmentId, report: 'Finding A', sourceReferences: ['src/main/agents.ts']
    });
    expect(reported.status).toBe('reported_by_prime');
    expect(reported.assignments[0]).toMatchObject({
      report: 'Finding A', status: 'reported_by_prime', sourceReferences: ['src/main/agents.ts']
    });
    expect(reported.assignments[1]!.report).toBeNull();
    const same = await reportNativeDelegation({
      owner, requestId: request.id, assignmentId, report: 'Finding A', sourceReferences: ['src/main/agents.ts']
    });
    expect(same.assignments[0]!.reportedAt).toBe(reported.assignments[0]!.reportedAt);
    await expect(reportNativeDelegation({
      owner, requestId: request.id, assignmentId, report: 'Changed, possibly duplicated'
    })).rejects.toThrow(/ALREADY_RECORDED/);
    expect(listNativeDelegations(owner)[0]!.assignments).toHaveLength(4);
  });

  it('retains lock on cancellation/unknown and restores reports without retrying hosted actions', async () => {
    const request = await prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    await reportNativeDelegation({ owner, requestId: request.id, assignmentId: request.assignments[0]!.id, report: 'partial' });
    const cancelled = await requestNativeDelegationCancellation({ owner, requestId: request.id });
    expect(cancelled.status).toBe('cancellation_requested');
    const unknown = await closeNativeDelegation({ owner, requestId: request.id, disposition: 'unknown', reason: 'host status not observable' });
    expect(unknown.status).toBe('unknown');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    await restoreNativeDelegations(); // simulate process registry rehydration from durable bytes
    expect(listNativeDelegations(owner)[0]!.assignments[0]!.report).toBe('partial');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    const closed = await closeNativeDelegation({ owner, requestId: request.id, disposition: 'closed', reason: 'local request settled' });
    expect(closed.status).toBe('closed');
    expect(nativeDelegationHasActiveLocks()).toBe(false);
    expect((await readDurable<{ records: unknown[] }>('native-delegations'))?.records).toHaveLength(1);
  });

  it('recovers only the exact recorded parent session when its Prime run ID changes', async () => {
    const request = await prepareNativeDelegation({
      owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in'
    });
    const restoredRunOwner = { ...owner, primeRunId: 'new-run-after-restart' };
    const absentRunOwner = { ...owner, primeRunId: null };
    const wrongSession = { ...owner, sessionId: 'session-from-a-different-chat' };
    await restoreNativeDelegations();
    expect(listNativeDelegations(absentRunOwner)[0]!.owner.primeRunId).toBe('run-a');
    expect(listNativeDelegations(restoredRunOwner)).toHaveLength(1);
    expect(listNativeDelegations(wrongSession)).toHaveLength(0);
    await expect(closeNativeDelegation({
      owner: wrongSession, requestId: request.id, disposition: 'closed'
    })).rejects.toThrow(/NOT_FOUND_OR_OWNER_CHANGED/);
    await expect(closeNativeDelegation({
      owner: other, requestId: request.id, disposition: 'closed'
    })).rejects.toThrow(/NOT_FOUND_OR_OWNER_CHANGED/);
    const closed = await closeNativeDelegation({
      owner: restoredRunOwner, requestId: request.id, disposition: 'closed',
      reason: 'The exact parent reconciled the host outcome after restart'
    });
    expect(closed.owner.primeRunId).toBe('run-a');
    expect(nativeDelegationHasActiveLocks()).toBe(false);
  });

  it('keeps the parent lock until a close is durable, and keeps it when the close fails to save', async () => {
    const request = await prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    let finishWrite!: () => void;
    let failWrite!: (error: Error) => void;
    vi.mocked(writeDurableNow).mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishWrite = resolve; failWrite = reject;
    }));
    const pending = closeNativeDelegation({ owner, requestId: request.id, disposition: 'closed' });
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    // Not yet durable: a crash now would restore the lock, so effects must still be refused.
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationHasActiveLocks()).toBe(true);
    failWrite(new Error('disk full'));
    await expect(pending).rejects.toThrow('disk full');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    expect(listNativeDelegations(owner)[0]!.status).toBe('prepared');

    vi.mocked(writeDurableNow).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const retried = closeNativeDelegation({ owner, requestId: request.id, disposition: 'closed' });
    await vi.waitFor(() => expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true));
    finishWrite();
    expect((await retried).status).toBe('closed');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(false);
  });

  it('makes room past 1,000 lifetime records by retiring the oldest settled ones, never an open one', async () => {
    const record = (index: number, status: string) => ({
      id: `record-${index}`, owner: { conversationId: `chat-${index}`, sessionId: `session-${index}`, primeRunId: null },
      acknowledgement: 'opted in', status, createdAt: index, updatedAt: index, reason: null,
      assignments: [{ id: `assignment-${index}`, label: 'One', task: 'Read only', status: 'prepared', report: null, sourceReferences: [], reportedAt: null }]
    });
    const source = path.join(temp, 'state', 'native-delegations.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    // The oldest record is still open; the next oldest settled one is what gives way.
    const full = Array.from({ length: 1_000 }, (_, index) => record(index, index === 0 ? 'unknown' : 'closed'));
    await fs.writeFile(source, JSON.stringify({ version: 1, records: full }));
    await restoreNativeDelegations();
    expect(nativeDelegationReady()).toBe(true);

    const request = await prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    const saved = (await readDurable<{ records: Array<{ id: string }> }>('native-delegations'))!.records.map((row) => row.id);
    expect(saved).toHaveLength(1_000);
    expect(saved).toContain('record-0');
    expect(saved).not.toContain('record-1');
    expect(saved.at(-1)).toBe(request.id);
    expect(nativeDelegationBlocksEffectful('chat-0', 'session-0')).toBe(true);

    // Every record still open: nothing may be dropped, so the ledger refuses instead.
    await fs.writeFile(source, JSON.stringify({ version: 1, records: Array.from({ length: 1_000 }, (_, index) => record(index, 'unknown')) }));
    await restoreNativeDelegations();
    await expect(prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' }))
      .rejects.toThrow(/LEDGER_FULL/);
  });

  it('does not let a close made inside the delegating turn unlock effects until that turn ends', async () => {
    const request = await prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    // A hosted child carries the parent's exact proof, so this close is indistinguishable from it.
    const closed = await closeNativeDelegation({ owner, requestId: request.id, disposition: 'closed', turnId: 'turn-delegating' });
    expect(closed).toMatchObject({ status: 'closed', closedInTurn: 'turn-delegating' });
    expect(nativeDelegationBlocksTool('exec_command', {}, true, owner.conversationId, owner.sessionId)).toBe(true);
    expect(nativeDelegationBlocksEffectful(other.conversationId, other.sessionId)).toBe(false);

    await settleNativeDelegationHolds(async () => 'turn-delegating');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    await settleNativeDelegationHolds(async () => { throw new Error('session store busy'); });
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    // The hold survives a restart and is learned again from the session.
    await restoreNativeDelegations();
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);

    const read = vi.fn(async () => null);
    await settleNativeDelegationHolds(read);
    expect(read).toHaveBeenCalledExactlyOnceWith(owner.sessionId);
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(false);
    expect(nativeDelegationHasActiveLocks()).toBe(false);
    // Nothing is held any more, so the next settle reads nothing.
    await settleNativeDelegationHolds(read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('holds unsupported the same way, keeps unknown locked, and holds nothing for a close outside a turn', async () => {
    const unsupported = await prepareNativeDelegation({ owner, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    await closeNativeDelegation({ owner, requestId: unsupported.id, disposition: 'unsupported', turnId: 'turn-1' });
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(true);
    await settleNativeDelegationHolds(async () => 'turn-2');
    expect(nativeDelegationBlocksEffectful(owner.conversationId, owner.sessionId)).toBe(false);

    const unknown = await prepareNativeDelegation({ owner: other, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    const unresolved = await closeNativeDelegation({ owner: other, requestId: unknown.id, disposition: 'unknown', turnId: 'turn-1' });
    expect(unresolved.closedInTurn).toBeUndefined();
    await settleNativeDelegationHolds(async () => null);
    expect(nativeDelegationBlocksEffectful(other.conversationId, other.sessionId)).toBe(true);

    const third = { conversationId: 'prime-conversation-c', sessionId: 'session-c', primeRunId: null };
    const outside = await prepareNativeDelegation({ owner: third, assignments: assignments.slice(0, 1), acknowledgement: 'opted in' });
    expect((await closeNativeDelegation({ owner: third, requestId: outside.id, disposition: 'closed', turnId: null })).closedInTurn).toBeUndefined();
    expect(nativeDelegationBlocksEffectful(third.conversationId, third.sessionId)).toBe(false);
  });

  it('fails closed on unreadable or invalid recovery instead of overwriting state', async () => {
    const source = path.join(temp, 'state', 'native-delegations.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '{damaged private ledger');
    await restoreNativeDelegations();
    expect(nativeDelegationReady()).toBe(false);
    expect(nativeDelegationHasActiveLocks()).toBe(true);
    expect(nativeDelegationBlocksEffectful(other.conversationId, other.sessionId)).toBe(true);
    await expect(prepareNativeDelegation({
      owner, assignments: assignments.slice(0, 1), acknowledgement: 'should fail'
    })).rejects.toThrow(/LEDGER_UNREADABLE/);
    expect(await fs.readFile(source, 'utf8')).toBe('{damaged private ledger');
  });
});
