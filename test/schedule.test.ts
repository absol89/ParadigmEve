import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  claimEveCronOccurrence,
  completeEveCronOccurrence,
  createEveCronEntry,
  eveCronWorkPayloadHash,
  markEveCronOccurrenceRunning,
  materializeEveCronOccurrences,
  readScheduleState,
  resetScheduleForTests,
  updateEveCronEntry
} from '../src/main/schedule.js';
import { resolveZonedLocalTime, type FrozenScheduleWork } from '../src/shared/schedule.js';

const STOCKHOLM = 'Europe/Stockholm';
const NOW = Date.UTC(2026, 8, 18, 10, 0, 0);
const HORIZON_END = Date.UTC(2026, 8, 25, 0, 0, 0);
let directory = '';

function work(text: string, authorizedAt = NOW): FrozenScheduleWork {
  const executable = {
    target: { kind: 'installation-agent' as const },
    text,
    automation: 'off' as const
  };
  return {
    ...executable,
    authority: {
      kind: 'chat-user',
      sessionId: 'session-schedule',
      conversationId: 'conversation-schedule',
      requestId: `request-${text}`,
      authorizedAt,
      payloadHash: eveCronWorkPayloadHash(executable)
    }
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-'));
  initDurableStore(directory);
  resetScheduleForTests();
});

afterEach(async () => {
  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('schedule wall-clock resolution', () => {
  it('moves a spring DST gap to the first real local minute after the gap', () => {
    const resolved = resolveZonedLocalTime('2026-03-29', '02:30', STOCKHOLM);
    expect(resolved).toEqual({ dueAt: Date.UTC(2026, 2, 29, 1, 0, 0), resolution: 'gap-forward' });
  });

  it('uses only the first real instant in an autumn DST fold', () => {
    const resolved = resolveZonedLocalTime('2026-10-25', '02:30', STOCKHOLM);
    expect(resolved).toEqual({ dueAt: Date.UTC(2026, 9, 25, 0, 30, 0), resolution: 'fold-first' });
  });
});

describe('durable Eve schedule core', () => {
  it('materializes weekly next-7-day skip/move exceptions with stable occurrence and input ids across restart', async () => {
    const entry = await createEveCronEntry({
      title: 'Weekly upkeep',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1, 2], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [
        { nominalDate: '2026-09-21', action: 'skip', reason: 'Holiday' },
        { nominalDate: '2026-09-22', action: 'move', moveTo: { localDate: '2026-09-23', localTime: '11:00' }, reason: 'Busy morning' }
      ],
      work: work('Review weekly housekeeping')
    }, NOW);

    const first = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    expect(first).toHaveLength(2);
    expect(first.find(row => row.nominal.localDate === '2026-09-21')).toMatchObject({
      entryId: entry.id,
      state: 'skipped',
      skipReason: 'exception',
      skipNote: 'Holiday',
      dueAt: Date.UTC(2026, 8, 21, 7, 0, 0)
    });
    expect(first.find(row => row.nominal.localDate === '2026-09-22')).toMatchObject({
      state: 'scheduled',
      scheduled: { localDate: '2026-09-23', localTime: '11:00', timeZone: STOCKHOLM },
      dueAt: Date.UTC(2026, 8, 23, 9, 0, 0)
    });
    const identities = first.map(row => ({ id: row.id, inputId: row.inputId, receiptKey: row.receiptKey }));

    resetScheduleForTests();
    const second = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 1);
    expect(second).toEqual(first);
    expect(second.map(row => ({ id: row.id, inputId: row.inputId, receiptKey: row.receiptKey }))).toEqual(identities);
  });

  it('uses optimistic revision fencing and rejects exceptions outside the next seven local dates', async () => {
    const entry = await createEveCronEntry({
      title: 'Monday task',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Original task')
    }, NOW);
    const updated = await updateEveCronEntry(entry.id, { title: 'Monday review' }, entry.updatedAt, NOW);
    expect(updated.updatedAt).toBeGreaterThan(entry.updatedAt);
    await expect(updateEveCronEntry(entry.id, { title: 'Stale edit' }, entry.updatedAt, NOW + 1))
      .rejects.toThrow(/changed/i);
    await expect(updateEveCronEntry(entry.id, {
      exceptions: [{ nominalDate: '2026-09-28', action: 'skip' }]
    }, updated.updatedAt, NOW + 1)).rejects.toThrow(/next 7/i);
  });

  it('freezes an explicit busy duration onto occurrences and keeps claimed duration history across edits', async () => {
    const entry = await createEveCronEntry({
      title: 'Bounded Monday task',
      state: 'enabled',
      durationMinutes: 45,
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Duration-bounded task')
    }, NOW);
    const [first] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    expect(first).toMatchObject({ durationMinutes: 45, entryVersion: entry.updatedAt });

    const longer = await updateEveCronEntry(entry.id, { durationMinutes: 90 }, entry.updatedAt, NOW + 1);
    const [reconciled] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 2);
    expect(reconciled).toMatchObject({
      id: first!.id,
      inputId: first!.inputId,
      durationMinutes: 90,
      entryVersion: longer.updatedAt
    });

    const claimed = await claimEveCronOccurrence(reconciled!.id, reconciled!.inputId, NOW + 3);
    await updateEveCronEntry(entry.id, { durationMinutes: 120 }, longer.updatedAt, NOW + 4);
    const [afterClaim] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 5);
    expect(afterClaim).toMatchObject({
      id: claimed.id,
      durationMinutes: 90,
      entryVersion: longer.updatedAt,
      claimedAt: claimed.claimedAt
    });
  });

  it('accepts legacy unknown duration but rejects invalid explicit busy-window bounds', async () => {
    const legacy = await createEveCronEntry({
      title: 'Legacy-style durationless task',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('No duration yet')
    }, NOW);
    expect(legacy.durationMinutes).toBeUndefined();

    await expect(createEveCronEntry({
      title: 'Zero duration', state: 'enabled', durationMinutes: 0,
      trigger: { kind: 'weekly', weekdays: [1], localTime: '10:00', timeZone: STOCKHOLM },
      exceptions: [], work: work('Zero')
    }, NOW)).rejects.toThrow();
    await expect(createEveCronEntry({
      title: 'Too long', state: 'enabled', durationMinutes: 1441,
      trigger: { kind: 'weekly', weekdays: [1], localTime: '11:00', timeZone: STOCKHOLM },
      exceptions: [], work: work('Too long')
    }, NOW)).rejects.toThrow();
  });

  it('lets future unclaimed rows adopt an authorized work edit without changing their stable delivery identity', async () => {
    const entry = await createEveCronEntry({
      title: 'Monday task',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Version one')
    }, NOW);
    const [before] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    const nextWork = work('Version two', NOW + 1);
    const changed = await updateEveCronEntry(entry.id, { work: nextWork }, entry.updatedAt, NOW + 1);
    const [after] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 2);
    expect(after).toMatchObject({
      id: before!.id,
      inputId: before!.inputId,
      receiptKey: before!.receiptKey,
      entryVersion: changed.updatedAt,
      work: nextWork
    });
  });

  it('freezes claimed work history across later schedule edits', async () => {
    const originalWork = work('Do the authorized original');
    const entry = await createEveCronEntry({
      title: 'Monday task',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: originalWork
    }, NOW);
    const [materialized] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    const claimed = await claimEveCronOccurrence(materialized!.id, materialized!.inputId, NOW + 1);
    expect(claimed.claimedAt).toBe(NOW + 1);

    await updateEveCronEntry(entry.id, { work: work('Different future work', NOW + 2) }, entry.updatedAt, NOW + 2);
    const [after] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 3);
    expect(after).toMatchObject({
      id: claimed.id,
      inputId: claimed.inputId,
      entryVersion: entry.updatedAt,
      work: originalWork,
      claimedAt: NOW + 1
    });
  });

  it('retires an unclaimed future slot when timing changes and materializes the replacement separately', async () => {
    const entry = await createEveCronEntry({
      title: 'Weekly timing',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Same authorized work')
    }, NOW);
    const [original] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    const changed = await updateEveCronEntry(entry.id, {
      trigger: { kind: 'weekly', weekdays: [2], localTime: '10:00', timeZone: STOCKHOLM }
    }, entry.updatedAt, NOW + 1);
    const rows = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 2);
    expect(rows.find(row => row.id === original!.id)).toMatchObject({
      state: 'skipped',
      skipReason: 'schedule-edited',
      entryVersion: entry.updatedAt
    });
    const replacement = rows.find(row => row.entryVersion === changed.updatedAt)!;
    expect(replacement).toMatchObject({ state: 'scheduled', nominal: { localDate: '2026-09-22', localTime: '10:00' } });
    expect(replacement.inputId).not.toBe(original!.inputId);
  });

  it('projects pause as a skipped future occurrence and restores it when resumed before its due time', async () => {
    const entry = await createEveCronEntry({
      title: 'Monday task',
      state: 'enabled',
      trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Pause-safe task')
    }, NOW);
    const enabled = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    expect(enabled[0]?.state).toBe('scheduled');

    const paused = await updateEveCronEntry(entry.id, { state: 'paused' }, entry.updatedAt, NOW + 1);
    expect((await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 2))[0]).toMatchObject({
      state: 'skipped', skipReason: 'paused'
    });
    await updateEveCronEntry(entry.id, { state: 'enabled' }, paused.updatedAt, NOW + 3);
    const resumed = (await materializeEveCronOccurrences(NOW, HORIZON_END, NOW + 4))[0]!;
    expect(resumed.state).toBe('scheduled');
    expect(resumed).not.toHaveProperty('skipReason');
  });

  it('requires the authorization hash to match executable work and never treats provenance as authority', async () => {
    const valid = work('Bound payload');
    await expect(createEveCronEntry({
      title: 'Tampered task',
      state: 'enabled',
      trigger: { kind: 'once', localDate: '2026-09-19', localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: { ...valid, text: 'Different executable prose', provenance: { planId: '11111111-1111-4111-8111-111111111111' } }
    }, NOW)).rejects.toThrow(/authority/i);
  });

  it('requires exact accepted-delivery lineage and an opaque occurrence key for semantic completion', async () => {
    await createEveCronEntry({
      title: 'One-time task',
      state: 'enabled',
      trigger: { kind: 'once', localDate: '2026-09-19', localTime: '09:00', timeZone: STOCKHOLM },
      exceptions: [],
      work: work('Do one bounded task')
    }, NOW);
    const [row] = await materializeEveCronOccurrences(NOW, HORIZON_END, NOW);
    await claimEveCronOccurrence(row!.id, row!.inputId, NOW + 1);
    const running = await markEveCronOccurrenceRunning(row!.id, row!.inputId, {
      sessionId: 'session-schedule',
      conversationId: 'conversation-schedule',
      messageId: 'message-scheduled-run',
      acceptedAt: NOW + 2
    });
    expect(running.state).toBe('running');

    await expect(completeEveCronOccurrence(row!.id, {
      key: 'wrong-receipt-key-that-is-long-enough',
      sessionId: 'session-schedule',
      conversationId: 'conversation-schedule',
      requestId: 'completion-request',
      completedAt: NOW + 3,
      result: 'done'
    })).rejects.toThrow(/key/i);

    const receipt = {
      key: row!.receiptKey,
      sessionId: 'session-schedule',
      conversationId: 'conversation-schedule',
      requestId: 'completion-request',
      completedAt: NOW + 3,
      result: 'done' as const
    };
    const done = await completeEveCronOccurrence(row!.id, receipt);
    expect(done).toMatchObject({ state: 'done', completion: receipt });
    expect(await completeEveCronOccurrence(row!.id, receipt)).toEqual(done);
    expect((await readScheduleState()).occurrences[0]).toEqual(done);
  });
});
