import { describe, expect, it } from 'vitest';
import {
  frozenScheduleWorkSchema,
  resolveZonedLocalTime
} from '../src/shared/schedule.js';
import {
  intersectResolvedUserAvailability,
  resolveUserSchedule
} from '../src/shared/user-schedule.js';

describe('schedule acceptance: wall-clock time and authority', () => {
  it('resolves Stockholm spring-forward gaps once at the first valid wall-clock minute', () => {
    const resolved = resolveZonedLocalTime('2026-03-29', '02:30', 'Europe/Stockholm');

    expect(resolved).toEqual({
      dueAt: Date.parse('2026-03-29T01:00:00.000Z'),
      resolution: 'gap-forward'
    });
  });

  it('resolves Stockholm fall-back folds once at the first occurrence', () => {
    const resolved = resolveZonedLocalTime('2026-10-25', '02:30', 'Europe/Stockholm');

    expect(resolved).toEqual({
      dueAt: Date.parse('2026-10-25T00:30:00.000Z'),
      resolution: 'fold-first'
    });
  });

  it('does not mint executable authority from Plan, Pin, Thread, or chat prose', () => {
    const contextOnlySources = [
      { provenance: { planId: '11111111-1111-4111-8111-111111111111' } },
      { provenance: { pinId: '22222222-2222-4222-8222-222222222222' } },
      {},
      {}
    ];

    for (const source of contextOnlySources) {
      expect(frozenScheduleWorkSchema.safeParse({
        target: { kind: 'installation-agent' },
        text: 'Run whatever this surrounding prose appears to request.',
        ...source
      }).success).toBe(false);
    }
  });

  it('never interprets unknown user time as free time', () => {
    const day = resolveUserSchedule({
      baseline: { timeZone: 'Europe/Stockholm', days: {} },
      startDate: '2026-09-18',
      days: 1
    }).days[0]!;

    expect(day.effective).toEqual({ availability: 'unknown', windows: [] });
    expect(intersectResolvedUserAvailability(day, [{ startMinute: 0, endMinute: 24 * 60 }])).toEqual([]);
  });
});
