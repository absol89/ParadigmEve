import { describe, expect, it } from 'vitest';
import {
  intersectResolvedUserAvailability,
  resolveUserSchedule,
  type UserWeeklyScheduleInput
} from '../src/shared/user-schedule.js';

const weekly = (days: UserWeeklyScheduleInput['days']): UserWeeklyScheduleInput => ({
  timeZone: 'Europe/Stockholm',
  days
});

describe('user %schedule resolution', () => {
  it('resolves a recurring weekly baseline in local calendar order and normalizes its free windows', () => {
    const result = resolveUserSchedule({
      baseline: weekly({
        1: { availability: 'known', windows: [
          { start: '18:00', end: '20:00' },
          { start: '08:00', end: '10:00' },
          { start: '09:30', end: '11:00' },
          { start: '20:00', end: '21:00' }
        ] },
        2: { availability: 'known', windows: [] }
      }),
      startDate: '2026-09-21',
      days: 2
    });

    expect(result.days.map(day => [day.date, day.weekday, day.source])).toEqual([
      ['2026-09-21', 1, 'weekly'],
      ['2026-09-22', 2, 'weekly']
    ]);
    expect(result.days[0]!.effective).toEqual({
      availability: 'known',
      windows: [
        { key: '2026-09-21:480-660', startMinute: 480, endMinute: 660, startLocal: '08:00', endLocal: '11:00' },
        { key: '2026-09-21:1080-1260', startMinute: 1080, endMinute: 1260, startLocal: '18:00', endLocal: '21:00' }
      ]
    });
    expect(result.days[1]!.effective).toEqual({ availability: 'known', windows: [] });
  });

  it('uses an exact-date temporary replacement and returns to the recurring baseline on the next date', () => {
    const result = resolveUserSchedule({
      baseline: weekly({
        4: { availability: 'known', windows: [{ start: '17:00', end: '19:00' }] },
        5: { availability: 'known', windows: [{ start: '17:00', end: '19:00' }] }
      }),
      startDate: '2026-09-17',
      days: 2,
      changes: [{ date: '2026-09-17', availability: 'known', windows: [{ start: '18:30', end: '20:30' }] }]
    });

    expect(result.days[0]).toMatchObject({
      date: '2026-09-17',
      source: 'temporary',
      temporaryChange: true,
      usual: { availability: 'known', windows: [{ startLocal: '17:00', endLocal: '19:00' }] },
      effective: { availability: 'known', windows: [{ startLocal: '18:30', endLocal: '20:30' }] }
    });
    expect(result.days[1]).toMatchObject({
      date: '2026-09-18',
      source: 'weekly',
      temporaryChange: false,
      effective: { windows: [{ startLocal: '17:00', endLocal: '19:00' }] }
    });
  });

  it('never guesses a missing weekday or an explicit unknown change as free', () => {
    const missing = resolveUserSchedule({ baseline: weekly({}), startDate: '2026-09-18', days: 1 }).days[0]!;
    expect(missing).toMatchObject({ source: 'unknown', effective: { availability: 'unknown', windows: [] } });
    expect(intersectResolvedUserAvailability(missing, [{ startMinute: 0, endMinute: 1440 }])).toEqual([]);

    const changed = resolveUserSchedule({
      baseline: weekly({ 5: { availability: 'known', windows: [{ start: '09:00', end: '17:00' }] } }),
      startDate: '2026-09-18',
      days: 1,
      changes: [{ date: '2026-09-18', availability: 'unknown' }]
    }).days[0]!;
    expect(changed.usual.windows).toHaveLength(1);
    expect(changed.effective).toEqual({ availability: 'unknown', windows: [] });
    expect(intersectResolvedUserAvailability(changed, [{ startMinute: 600, endMinute: 720 }])).toEqual([]);
  });

  it('lets a date-specific change make an otherwise unknown date explicitly known', () => {
    const day = resolveUserSchedule({
      baseline: weekly({}),
      startDate: '2026-09-19',
      days: 1,
      changes: [{ date: '2026-09-19', availability: 'known', windows: [{ start: '12:00', end: '14:00' }] }]
    }).days[0]!;
    expect(day).toMatchObject({
      source: 'temporary',
      usual: { availability: 'unknown', windows: [] },
      effective: { availability: 'known', windows: [{ startLocal: '12:00', endLocal: '14:00' }] }
    });
  });

  it('supports a known full-day boundary without treating 24:00 as another date', () => {
    const day = resolveUserSchedule({
      baseline: weekly({ 5: { availability: 'known', windows: [{ start: '00:00', end: '24:00' }] } }),
      startDate: '2026-09-18',
      days: 1
    }).days[0]!;

    expect(day.effective.windows).toEqual([{
      key: '2026-09-18:0-1440',
      startMinute: 0,
      endMinute: 1440,
      startLocal: '00:00',
      endLocal: '24:00'
    }]);
  });

  it('returns deterministic overlap windows only inside known effective availability', () => {
    const day = resolveUserSchedule({
      baseline: weekly({ 5: { availability: 'known', windows: [
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '18:00' }
      ] } }),
      startDate: '2026-09-18',
      days: 1
    }).days[0]!;

    expect(intersectResolvedUserAvailability(day, [
      { startMinute: 11 * 60, endMinute: 14 * 60 },
      { startMinute: 17 * 60 + 30, endMinute: 19 * 60 }
    ])).toEqual([
      { key: '2026-09-18:overlap:660-720', startMinute: 660, endMinute: 720, startLocal: '11:00', endLocal: '12:00' },
      { key: '2026-09-18:overlap:780-840', startMinute: 780, endMinute: 840, startLocal: '13:00', endLocal: '14:00' },
      { key: '2026-09-18:overlap:1050-1080', startMinute: 1050, endMinute: 1080, startLocal: '17:30', endLocal: '18:00' }
    ]);
  });

  it('rejects ambiguous or malformed schedule input instead of silently resolving it', () => {
    expect(() => resolveUserSchedule({
      baseline: weekly({}), startDate: '2026-09-18', days: 8
    })).toThrow(/between 1 and 7 days/);

    expect(() => resolveUserSchedule({
      baseline: weekly({}), startDate: '2026-02-30', days: 1
    })).toThrow(/real yyyy-mm-dd calendar date/i);

    expect(() => resolveUserSchedule({
      baseline: { timeZone: 'Not/A_Timezone', days: {} }, startDate: '2026-09-18', days: 1
    })).toThrow(/valid iana time zone/i);

    expect(() => resolveUserSchedule({
      baseline: weekly({ 5: { availability: 'unknown', windows: [{ start: '09:00', end: '10:00' }] } }),
      startDate: '2026-09-18', days: 1
    })).toThrow(/unknown availability cannot carry free windows/i);

    expect(() => resolveUserSchedule({
      baseline: weekly({ 5: { availability: 'known', windows: [{ start: '22:00', end: '02:00' }] } }),
      startDate: '2026-09-18', days: 1
    })).toThrow(/within one local date/i);

    expect(() => resolveUserSchedule({
      baseline: weekly({}),
      startDate: '2026-09-18',
      days: 1,
      changes: [
        { date: '2026-09-18', availability: 'known', windows: [] },
        { date: '2026-09-18', availability: 'unknown' }
      ]
    })).toThrow(/duplicate temporary schedule change/i);

    expect(() => resolveUserSchedule({
      baseline: weekly({}),
      startDate: '2026-09-18',
      days: 1,
      changes: [{ date: '2026-09-25', availability: 'known', windows: [] }]
    })).toThrow(/next 7 local calendar days/i);
  });
});
