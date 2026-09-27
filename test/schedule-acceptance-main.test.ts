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
import type { EveCronEntryCreate, FrozenScheduleWork } from '../src/shared/schedule.js';

let directory: string;

const DAY = 24 * 60 * 60_000;
const baseNow = Date.parse('2026-09-18T00:00:00.000Z');

function approvedWork(text = 'Run the already-authorized scheduled check.'): FrozenScheduleWork {
  const executable = { target: { kind: 'installation-agent' as const }, text };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorizedAt: baseNow,
      payloadHash: eveCronWorkPayloadHash(executable)
    }
  };
}

function weeklyEntry(overrides: Partial<EveCronEntryCreate> = {}): EveCronEntryCreate {
  return {
    title: 'Acceptance schedule',
    state: 'enabled',
    trigger: {
      kind: 'weekly',
      weekdays: [5],
      localTime: '10:00',
      timeZone: 'Europe/Stockholm'
    },
    exceptions: [],
    work: approvedWork(),
    ...overrides
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-acceptance-'));
  resetScheduleForTests();
  resetDurableForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('schedule acceptance: durable core', () => {
  it('keeps weekly wall-clock recurrence deterministic through Stockholm DST gap and fold', async () => {
    const springNow = Date.parse('2026-03-28T00:00:00.000Z');
    await createEveCronEntry(weeklyEntry({
      trigger: {
        kind: 'weekly',
        weekdays: [7],
        localTime: '02:30',
        timeZone: 'Europe/Stockholm'
      }
    }), springNow);
    const spring = await materializeEveCronOccurrences(
      Date.parse('2026-03-29T00:00:00.000Z'),
      Date.parse('2026-03-29T23:59:59.999Z'),
      springNow + 1
    );
    expect(spring).toHaveLength(1);
    expect(spring[0]).toMatchObject({
      nominal: { localDate: '2026-03-29', localTime: '02:30' },
      dueAt: Date.parse('2026-03-29T01:00:00.000Z'),
      dstResolution: 'gap-forward'
    });

    resetScheduleForTests();
    resetDurableForTests();
    await fs.rm(directory, { recursive: true, force: true });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-acceptance-'));
    initDurableStore(directory);

    const fallNow = Date.parse('2026-10-24T00:00:00.000Z');
    await createEveCronEntry(weeklyEntry({
      trigger: {
        kind: 'weekly',
        weekdays: [7],
        localTime: '02:30',
        timeZone: 'Europe/Stockholm'
      }
    }), fallNow);
    const fall = await materializeEveCronOccurrences(
      Date.parse('2026-10-25T00:00:00.000Z'),
      Date.parse('2026-10-25T23:59:59.999Z'),
      fallNow + 1
    );
    expect(fall).toHaveLength(1);
    expect(fall[0]).toMatchObject({
      nominal: { localDate: '2026-10-25', localTime: '02:30' },
      dueAt: Date.parse('2026-10-25T00:30:00.000Z'),
      dstResolution: 'fold-first'
    });
  });

  it('applies next-7-day move exceptions and rejects exceptions outside that local window', async () => {
    const moved = await createEveCronEntry(weeklyEntry({
      exceptions: [{
        nominalDate: '2026-09-18',
        action: 'move',
        moveTo: { localDate: '2026-09-19', localTime: '11:30' }
      }]
    }), baseNow);

    const occurrences = await materializeEveCronOccurrences(baseNow, baseNow + 2 * DAY, baseNow + 1);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      entryId: moved.id,
      nominal: { localDate: '2026-09-18', localTime: '10:00', timeZone: 'Europe/Stockholm' },
      scheduled: { localDate: '2026-09-19', localTime: '11:30', timeZone: 'Europe/Stockholm' },
      state: 'scheduled'
    });

    await expect(createEveCronEntry(weeklyEntry({
      exceptions: [{ nominalDate: '2026-09-25', action: 'skip' }]
    }), baseNow)).rejects.toThrow(/next 7 local calendar days/i);
  });

  it('uses optimistic CAS for edits and rejects a stale revision', async () => {
    const entry = await createEveCronEntry(weeklyEntry(), baseNow);
    const updated = await updateEveCronEntry(entry.id, { title: 'Accepted edit' }, entry.updatedAt, baseNow + 10);

    expect(updated.updatedAt).toBeGreaterThan(entry.updatedAt);
    await expect(updateEveCronEntry(entry.id, { title: 'Stale edit' }, entry.updatedAt, baseNow + 20))
      .rejects.toThrow(/changed; refresh/i);
    expect((await readScheduleState()).entries[0]?.title).toBe('Accepted edit');
  });

  it('pauses only future unclaimed work and preserves a claimed occurrence snapshot', async () => {
    const entry = await createEveCronEntry(weeklyEntry({
      trigger: {
        kind: 'weekly',
        weekdays: [5, 6],
        localTime: '10:00',
        timeZone: 'Europe/Stockholm'
      }
    }), baseNow);
    const initial = await materializeEveCronOccurrences(baseNow, baseNow + 2 * DAY, baseNow + 1);
    expect(initial).toHaveLength(2);
    const friday = initial.find(row => row.nominal.localDate === '2026-09-18')!;
    const saturday = initial.find(row => row.nominal.localDate === '2026-09-19')!;
    const claimed = await claimEveCronOccurrence(friday.id, friday.inputId, baseNow + 2);

    const paused = await updateEveCronEntry(entry.id, { state: 'paused' }, entry.updatedAt, baseNow + 3);
    expect(paused.state).toBe('paused');
    const reconciled = await materializeEveCronOccurrences(baseNow, baseNow + 2 * DAY, baseNow + 4);
    const kept = reconciled.find(row => row.id === friday.id)!;
    const future = reconciled.find(row => row.id === saturday.id)!;

    expect(kept).toMatchObject({
      id: claimed.id,
      state: 'scheduled',
      claimedAt: claimed.claimedAt,
      entryVersion: entry.updatedAt,
      work: entry.work
    });
    expect(future).toMatchObject({ state: 'skipped', skipReason: 'paused', entryVersion: paused.updatedAt });
  });

  it('keeps stable occurrence/input IDs and suppresses duplicate Start and Done transitions across restart', async () => {
    await createEveCronEntry(weeklyEntry(), baseNow);
    const [occurrence] = await materializeEveCronOccurrences(baseNow, baseNow + DAY, baseNow + 1);
    expect(occurrence).toBeDefined();
    const firstId = occurrence!.id;
    const firstInputId = occurrence!.inputId;
    const delivery = {
      sessionId: 'schedule-session-0001',
      conversationId: 'schedule-conversation-0001',
      messageId: 'accepted-message-1',
      acceptedAt: baseNow + 5
    };
    const running = await markEveCronOccurrenceRunning(firstId, firstInputId, delivery);
    expect(running.state).toBe('running');

    resetScheduleForTests();
    resetDurableForTests();
    initDurableStore(directory);
    const rematerialized = await materializeEveCronOccurrences(baseNow, baseNow + DAY, baseNow + 6);
    const afterRestart = rematerialized.find(row => row.id === firstId)!;
    expect(afterRestart).toMatchObject({ id: firstId, inputId: firstInputId, state: 'running', delivery });
    expect(await markEveCronOccurrenceRunning(firstId, firstInputId, delivery)).toEqual(afterRestart);

    const completion = {
      key: afterRestart.receiptKey,
      sessionId: delivery.sessionId,
      conversationId: delivery.conversationId,
      requestId: 'completion-request-1',
      completedAt: baseNow + 7,
      result: 'done' as const
    };
    const done = await completeEveCronOccurrence(firstId, completion);
    expect(done.state).toBe('done');

    resetScheduleForTests();
    resetDurableForTests();
    initDurableStore(directory);
    expect(await completeEveCronOccurrence(firstId, completion)).toEqual(done);
  });

  it('keeps queued/claimed work out of Started and requires delivery-bound semantic evidence for Done', async () => {
    await createEveCronEntry(weeklyEntry(), baseNow);
    const [occurrence] = await materializeEveCronOccurrences(baseNow, baseNow + DAY, baseNow + 1);
    const claimed = await claimEveCronOccurrence(occurrence!.id, occurrence!.inputId, baseNow + 2);
    expect(claimed.state).toBe('scheduled');
    expect(claimed.delivery).toBeUndefined();

    await expect(completeEveCronOccurrence(claimed.id, {
      key: claimed.receiptKey,
      sessionId: 'schedule-session-0001',
      conversationId: 'schedule-conversation-0001',
      requestId: 'prose-is-not-proof',
      completedAt: baseNow + 3,
      result: 'done'
    })).rejects.toThrow(/accepted delivery/i);

    const delivery = {
      sessionId: 'schedule-session-0001',
      conversationId: 'schedule-conversation-0001',
      messageId: 'accepted-message-1',
      acceptedAt: baseNow + 4
    };
    const running = await markEveCronOccurrenceRunning(claimed.id, claimed.inputId, delivery);

    await expect(completeEveCronOccurrence(running.id, {
      key: running.receiptKey,
      sessionId: 'wrong-session-0000001',
      conversationId: delivery.conversationId,
      requestId: 'wrong-owner',
      completedAt: baseNow + 5,
      result: 'done'
    })).rejects.toThrow(/does not belong/i);

    const done = await completeEveCronOccurrence(running.id, {
      key: running.receiptKey,
      sessionId: delivery.sessionId,
      conversationId: delivery.conversationId,
      requestId: 'verified-completion',
      completedAt: baseNow + 6,
      result: 'done'
    });
    expect(done).toMatchObject({ state: 'done', completion: { requestId: 'verified-completion', result: 'done' } });
  });

  it('rejects executable schedule creation when context prose/provenance has no user authority', async () => {
    await expect(createEveCronEntry(weeklyEntry({
      work: {
        target: { kind: 'installation-agent' },
        text: 'A Plan, Pin, Thread prompt, or old chat sentence said to do this.',
        provenance: { planId: '11111111-1111-4111-8111-111111111111', pinId: '22222222-2222-4222-8222-222222222222' }
      } as any
    }), baseNow)).rejects.toThrow();
  });
});
