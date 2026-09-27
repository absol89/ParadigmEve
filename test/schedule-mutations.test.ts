import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  createEveCronFromUi,
  listEditableEveCronEntries,
  setEveCronStateFromUi,
  updateEveCronFromUi
} from '../src/main/schedule-mutations.js';
import { eveCronWorkPayloadHash, readScheduleState, resetScheduleForTests } from '../src/main/schedule.js';
import {
  readUserSchedule,
  replaceUserSchedule,
  resetUserScheduleStoreForTests
} from '../src/main/user-schedule-store.js';

let directory = '';
const NOW = Date.parse('2026-09-18T10:00:00.000Z');

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-mutations-'));
  resetDurableForTests();
  resetScheduleForTests();
  resetUserScheduleStoreForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetScheduleForTests();
  resetUserScheduleStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('user-facing Eve schedule mutations', () => {
  it('mints authority only for explicit UI work and keeps CAS on edit/pause', async () => {
    const created = await createEveCronFromUi({
      title: 'Morning review',
      durationMinutes: 45,
      trigger: { kind: 'weekly', weekdays: [1, 5], localTime: '09:15', timeZone: 'Europe/Stockholm' },
      work: { text: 'Review the saved morning queue.', automation: 'off' }
    }, NOW);

    expect(created).toMatchObject({ title: 'Morning review', durationMinutes: 45, state: 'enabled' });
    expect(created.work).toEqual({ text: 'Review the saved morning queue.', automation: 'off' });
    expect(created.work).not.toHaveProperty('authority');
    const stored = (await readScheduleState()).entries[0]!;
    expect(stored.work.target).toEqual({ kind: 'installation-agent' });
    expect(stored.work.authority).toMatchObject({ kind: 'ui-user', authorizedAt: NOW });
    expect(stored.work.authority.payloadHash).toBe(eveCronWorkPayloadHash(stored.work));

    const paused = await setEveCronStateFromUi({
      id: created.id, state: 'paused', expectedUpdatedAt: created.updatedAt
    }, NOW + 1);
    expect(paused.state).toBe('paused');
    await expect(updateEveCronFromUi({
      id: created.id,
      expectedUpdatedAt: created.updatedAt,
      patch: { title: 'Stale title' }
    }, NOW + 2)).rejects.toThrow(/changed; refresh/i);

    const changed = await updateEveCronFromUi({
      id: created.id,
      expectedUpdatedAt: paused.updatedAt,
      patch: { work: { text: 'Review the updated queue.', automation: 'off' }, durationMinutes: 60 }
    }, NOW + 3);
    const changedStored = (await readScheduleState()).entries[0]!;
    expect(changed.durationMinutes).toBe(60);
    expect(changedStored.work.authority).toMatchObject({ kind: 'ui-user', authorizedAt: NOW + 3 });
    expect(changedStored.work.authority).not.toEqual(stored.work.authority);
  });

  it('rejects renderer attempts to inject target, authority, or provenance', async () => {
    await expect(createEveCronFromUi({
      title: 'Injected task',
      durationMinutes: 30,
      trigger: { kind: 'once', localDate: '2026-09-19', localTime: '10:00', timeZone: 'Europe/Stockholm' },
      work: {
        text: 'Explicit task',
        automation: 'off',
        target: { kind: 'session', sessionId: 'attacker-session' },
        authority: { kind: 'chat-user' },
        provenance: { pinId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
      }
    }, NOW)).rejects.toThrow();
    expect(await listEditableEveCronEntries()).toEqual([]);
  });
});

describe('user availability mutation persistence', () => {
  it('preserves an unchanged historical date row during weekly edits but refuses rewriting it', async () => {
    const initial = await replaceUserSchedule({
      baseline: {
        timeZone: 'Europe/Stockholm',
        days: { 5: { availability: 'known', windows: [{ start: '08:00', end: '17:00' }] } }
      },
      changes: [{ date: '2026-09-18', availability: 'known', windows: [{ start: '10:00', end: '12:00' }] }]
    }, null, NOW);

    const later = Date.parse('2026-09-20T10:00:00.000Z');
    const edited = await replaceUserSchedule({
      baseline: {
        timeZone: 'Europe/Stockholm',
        days: {
          1: { availability: 'known', windows: [{ start: '09:00', end: '17:00' }] },
          5: { availability: 'known', windows: [{ start: '08:00', end: '17:00' }] }
        }
      },
      changes: initial.changes
    }, initial.updatedAt, later);
    expect(edited.changes).toEqual(initial.changes);
    expect((await readUserSchedule())?.baseline.days[1]).toEqual({
      availability: 'known', windows: [{ start: '09:00', end: '17:00' }]
    });

    await expect(replaceUserSchedule({
      baseline: edited.baseline,
      changes: [{ date: '2026-09-18', availability: 'known', windows: [{ start: '11:00', end: '12:00' }] }]
    }, edited.updatedAt, later + 1)).rejects.toThrow(/next 7 local calendar days/i);
  });
});
