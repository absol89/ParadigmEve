import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  createEveCronEntry,
  eveCronWorkPayloadHash,
  materializeEveCronOccurrences,
  readScheduleState,
  resetScheduleForTests
} from '../src/main/schedule.js';
import { readScheduleProjection } from '../src/main/schedule-projection.js';
import {
  readUserSchedule,
  replaceUserSchedule,
  resetUserScheduleStoreForTests,
  resolveStoredUserSchedule
} from '../src/main/user-schedule-store.js';
import { resetEvecronExecutionForTests } from '../src/main/evecron-execution.js';
import type { FrozenScheduleWork } from '../src/shared/schedule.js';

let directory = '';
const NOW = Date.parse('2026-09-18T06:00:00.000Z');

function work(): FrozenScheduleWork {
  const executable = { target: { kind: 'installation-agent' as const }, text: 'Run the bounded scheduled check.' };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorizedAt: NOW,
      payloadHash: eveCronWorkPayloadHash(executable)
    }
  };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-projection-'));
  resetEvecronExecutionForTests();
  resetUserScheduleStoreForTests();
  resetScheduleForTests();
  resetDurableForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetEvecronExecutionForTests();
  resetUserScheduleStoreForTests();
  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('persists the complete user availability document behind optimistic CAS and survives restart', async () => {
  const created = await replaceUserSchedule({
    baseline: {
      timeZone: 'Europe/Stockholm',
      days: {
        5: { availability: 'known', windows: [{ start: '18:00', end: '21:00' }] },
        6: { availability: 'unknown' }
      }
    },
    changes: [{ date: '2026-09-18', availability: 'known', windows: [{ start: '19:00', end: '20:00' }] }]
  }, null, NOW);
  expect(created.updatedAt).toBe(NOW);
  await expect(replaceUserSchedule({ baseline: created.baseline, changes: created.changes }, null, NOW + 1))
    .rejects.toThrow(/changed; refresh/i);

  const updated = await replaceUserSchedule({
    baseline: created.baseline,
    changes: [{ date: '2026-09-19', availability: 'known', windows: [] }]
  }, created.updatedAt, NOW + 1);
  expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);

  resetUserScheduleStoreForTests();
  expect(await readUserSchedule()).toEqual(updated);
});

it('keeps unknown availability unknown and filters historical temporary rows out of a later projection', async () => {
  await replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: { 6: { availability: 'unknown' } } },
    changes: [{ date: '2026-09-18', availability: 'known', windows: [{ start: '10:00', end: '12:00' }] }]
  }, null, NOW);

  const later = await resolveStoredUserSchedule('2026-09-19', 1);
  expect(later?.days[0]).toMatchObject({
    date: '2026-09-19',
    source: 'weekly',
    effective: { availability: 'unknown', windows: [] }
  });
});

it('rejects malformed or out-of-window user changes rather than persisting ambiguous schedule state', async () => {
  await expect(replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: { 5: { availability: 'known', windows: [{ start: '22:00', end: '02:00' }] } } },
    changes: []
  }, null, NOW)).rejects.toThrow(/within one local date/i);

  await expect(replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: {} },
    changes: [{ date: '2026-09-25', availability: 'known', windows: [] }]
  }, null, NOW)).rejects.toThrow(/next 7 local calendar days/i);
});

it('projects future Eve recurrence read-only without materializing an executable occurrence', async () => {
  await createEveCronEntry({
    title: 'Friday review',
    state: 'enabled',
    trigger: { kind: 'weekly', weekdays: [5], localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, NOW);
  await replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '12:00' }] } } },
    changes: []
  }, null, NOW);

  expect((await readScheduleState()).occurrences).toEqual([]);
  const projected = await readScheduleProjection({ now: NOW, days: 1 });
  expect(projected.days[0]).toMatchObject({
    date: '2026-09-18',
    user: { effective: { availability: 'known', windows: [{ startLocal: '08:00', endLocal: '12:00' }] } },
    eve: [{ title: 'Friday review', startMinute: 10 * 60, durationMinutes: null, endMinute: null, status: 'scheduled' }]
  });
  expect(projected.overlap).toEqual({ status: 'unresolved-eve-duration', windows: [] });
  expect(projected.nextOverlap).toBeNull();
  expect((await readScheduleState()).occurrences).toEqual([]);

  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain('Run the bounded scheduled check.');
  expect(serialized).not.toContain('payloadHash');
  expect(serialized).not.toContain('receiptKey');
  expect(serialized).not.toContain('inputId');
});

it('subtracts only explicit Eve busy duration from known user availability and exposes a truthful next overlap', async () => {
  await createEveCronEntry({
    title: 'Friday review',
    state: 'enabled',
    durationMinutes: 60,
    trigger: { kind: 'weekly', weekdays: [5], localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, NOW);
  await replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '12:00' }] } } },
    changes: []
  }, null, NOW);

  const projected = await readScheduleProjection({ now: NOW, days: 1 });
  expect(projected.days[0]!.eve[0]).toMatchObject({
    title: 'Friday review',
    startMinute: 10 * 60,
    durationMinutes: 60,
    endMinute: 11 * 60
  });
  expect(projected.overlap).toEqual({
    status: 'resolved',
    windows: [
      { id: '2026-09-18:overlap:480-600', date: '2026-09-18', startMinute: 480, endMinute: 600, current: true },
      { id: '2026-09-18:overlap:660-720', date: '2026-09-18', startMinute: 660, endMinute: 720, current: false }
    ]
  });
  expect(projected.nextOverlap).toEqual({
    id: '2026-09-18:overlap:480-600',
    date: '2026-09-18',
    startMinute: 480,
    endMinute: 600,
    current: true
  });
});

it('never turns unknown user availability into overlap even when every Eve duration is known', async () => {
  await createEveCronEntry({
    title: 'Friday review',
    state: 'enabled',
    durationMinutes: 30,
    trigger: { kind: 'weekly', weekdays: [5], localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, NOW);
  await replaceUserSchedule({
    baseline: { timeZone: 'Europe/Stockholm', days: { 5: { availability: 'unknown' } } },
    changes: []
  }, null, NOW);

  const projected = await readScheduleProjection({ now: NOW, days: 1 });
  expect(projected.overlap).toEqual({ status: 'resolved', windows: [] });
  expect(projected.nextOverlap).toBeNull();
});

it('carries an explicit Eve busy window across midnight without guessing the next day free', async () => {
  await createEveCronEntry({
    title: 'Late maintenance',
    state: 'enabled',
    durationMinutes: 60,
    trigger: { kind: 'once', localDate: '2026-09-18', localTime: '23:30', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, NOW);
  await replaceUserSchedule({
    baseline: {
      timeZone: 'Europe/Stockholm',
      days: {
        5: { availability: 'known', windows: [] },
        6: { availability: 'known', windows: [{ start: '00:00', end: '02:00' }] }
      }
    },
    changes: []
  }, null, NOW);

  const projected = await readScheduleProjection({ now: NOW, days: 2 });
  expect(projected.overlap).toEqual({
    status: 'resolved',
    windows: [{
      id: '2026-09-19:overlap:30-120',
      date: '2026-09-19',
      startMinute: 30,
      endMinute: 120,
      current: false
    }]
  });
});

it('fails overlap closed when a busy duration crosses the repeated wall-clock portion of a DST fold', async () => {
  const foldNow = Date.parse('2026-10-25T00:00:00.000Z');
  await createEveCronEntry({
    title: 'Fold maintenance',
    state: 'enabled',
    durationMinutes: 60,
    trigger: { kind: 'once', localDate: '2026-10-25', localTime: '02:45', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, foldNow);
  await replaceUserSchedule({
    baseline: {
      timeZone: 'Europe/Stockholm',
      days: { 7: { availability: 'known', windows: [{ start: '02:00', end: '04:00' }] } }
    },
    changes: []
  }, null, foldNow);

  const projected = await readScheduleProjection({ now: foldNow, days: 1 });
  expect(projected.days[0]!.eve[0]).toMatchObject({
    startMinute: 2 * 60 + 45,
    durationMinutes: 60,
    endMinute: null
  });
  expect(projected.overlap).toEqual({ status: 'unresolved-eve-duration', windows: [] });
  expect(projected.nextOverlap).toBeNull();
});

it('prefers persisted occurrence state over a recurrence preview while keeping the renderer projection authority-free', async () => {
  // Without a user schedule the projection days follow the machine's zone. NOW is Friday morning
  // in Stockholm but still Thursday on a US Pacific runner (the arm64 release runner), so give the
  // projection its zone the way the product does: from the user's schedule.
  await replaceUserSchedule({ baseline: { timeZone: 'Europe/Stockholm', days: {} }, changes: [] }, null, NOW);
  await createEveCronEntry({
    title: 'Friday review',
    state: 'enabled',
    trigger: { kind: 'weekly', weekdays: [5], localTime: '10:00', timeZone: 'Europe/Stockholm' },
    exceptions: [],
    work: work()
  }, NOW);
  const [occurrence] = await materializeEveCronOccurrences(NOW, NOW + 8 * 60 * 60_000, NOW + 1);
  expect(occurrence).toBeDefined();

  const projected = await readScheduleProjection({ now: NOW, days: 1 });
  const row = projected.days[0]!.eve[0]!;
  expect(row).toMatchObject({ occurrenceId: occurrence!.id, entryId: occurrence!.entryId, status: 'scheduled' });
  expect(row).not.toHaveProperty('work');
  expect(row).not.toHaveProperty('inputId');
});
