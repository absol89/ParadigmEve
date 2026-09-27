import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScheduleReadProjection } from '../src/shared/schedule-projection.js';

let dom: JSDOM;

function projection(status: ScheduleReadProjection['days'][number]['eve'][number]['status'] = 'scheduled'): ScheduleReadProjection {
  const user = {
    availability: 'known' as const,
    windows: [{ key: '2026-09-18:1080-1260', startLocal: '18:00', endLocal: '21:00', startMinute: 1080, endMinute: 1260 }]
  };
  return {
    timeZone: 'Europe/Stockholm',
    startDate: '2026-09-18',
    userScheduleUpdatedAt: 1,
    days: [{
      date: '2026-09-18',
      weekday: 5,
      user: { source: 'weekly', temporaryChange: false, usual: user, effective: user },
      eve: [{
        occurrenceId: '11111111-1111-4111-8111-111111111111',
        entryId: '22222222-2222-4222-8222-222222222222',
        entryVersion: 1,
        title: 'Friday review',
        date: '2026-09-18',
        startMinute: 10 * 60,
        status,
        temporary: false,
        receipts: status === 'running' ? [{
          id: 'start-receipt', kind: 'started', at: Date.parse('2026-09-18T08:02:00Z'), label: 'Started'
        }] : []
      }]
    }],
    usualWeek: [{
      weekday: 5,
      user,
      eve: [{
        entryId: '22222222-2222-4222-8222-222222222222',
        title: 'Friday review', weekday: 5, localTime: '10:00', timeZone: 'Europe/Stockholm', state: 'enabled'
      }]
    }],
    overlap: { status: 'unresolved-eve-duration', windows: [] },
    nextOverlap: null
  };
}

beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<!doctype html><html><head><title>Eve</title></head><body><div id="scheduleLibraryHost"></div><textarea id="chatInput"></textarea></body></html>', {
    url: 'https://eve.local/'
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement
  });
});

afterEach(() => dom.window.close());

it('adapts the backend projection without inventing Eve duration, overlap, or execution state', async () => {
  const { rendererStatusFromProjection, scheduleViewFromProjection } = await import('../src/renderer/schedule-workspace.js');
  const view = scheduleViewFromProjection(projection('queued'));

  const user = view.detailDay.entries.find(row => row.owner === 'user')!;
  const eve = view.detailDay.entries.find(row => row.owner === 'eve')!;
  expect(user).toMatchObject({ title: 'Available', startMinute: 1080, endMinute: 1260 });
  expect(eve).toMatchObject({ title: 'Friday review', startMinute: 600, eveStatus: 'scheduled' });
  expect(eve.endMinute).toBeUndefined();
  expect(view.detailDay.overlaps).toEqual([]);
  expect(view.nextOverlap).toBeNull();
  expect(view.overlapStatus).toBe('unresolved-eve-duration');
  expect(rendererStatusFromProjection('running')).toBe('started');
  expect(rendererStatusFromProjection('done')).toBe('done');
  expect(rendererStatusFromProjection('needs_user')).toBe('blocked');
  expect(rendererStatusFromProjection('failed')).toBe('failed');
});

it('renders only backend-resolved Eve duration and overlap when that evidence exists', async () => {
  const source = projection('scheduled');
  const eve = source.days[0]!.eve[0]!;
  eve.durationMinutes = 60;
  eve.endMinute = 11 * 60;
  source.overlap = {
    status: 'resolved',
    windows: [{
      id: '2026-09-18:overlap:1080-1200',
      date: '2026-09-18',
      startMinute: 1080,
      endMinute: 1200,
      current: false
    }]
  };
  source.nextOverlap = source.overlap.windows[0]!;
  const { scheduleViewFromProjection } = await import('../src/renderer/schedule-workspace.js');
  const view = scheduleViewFromProjection(source);

  expect(view.detailDay.entries.find(row => row.owner === 'eve')?.endMinute).toBe(660);
  expect(view.detailDay.overlaps).toEqual([{ id: '2026-09-18:overlap:1080-1200', startMinute: 1080, endMinute: 1200, current: false }]);
  expect(view.nextOverlap).toMatchObject({ dateKey: '2026-09-18', startMinute: 1080, endMinute: 1200, isToday: true });
  expect(view.overlapStatus).toBe('resolved');
});

it('mounts live #myweek from readScheduleProjection and refreshes evidence while the surface is open', async () => {
  let current = projection('scheduled');
  const listeners: { session?: () => void; schedule?: () => void } = {};
  const readScheduleProjection = vi.fn(async () => ({ ok: true as const, data: current }));
  Object.assign(window, {
    api: {
      readScheduleProjection,
      onSessionChanged(listener: () => void) { listeners.session = listener; return () => { delete listeners.session; }; },
      onScheduleChanged(listener: () => void) { listeners.schedule = listener; return () => { delete listeners.schedule; }; },
      getPinsLibrary: vi.fn(async () => ({ ok: true as const, data: { quilts: [], collections: [], pins: [] } }))
    }
  });

  const navigation = await import('../src/renderer/workspace-navigation.js');
  const schedule = await import('../src/renderer/schedule-workspace.js');
  navigation.initWorkspaceNavigation({ screen: 'chat' });
  schedule.initScheduleWorkspace();
  navigation.navigateWorkspace({ screen: 'schedule' });

  await vi.waitFor(() => expect(readScheduleProjection).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.querySelector('.schedule-surface')).not.toBeNull());
  const host = document.getElementById('scheduleLibraryHost')!;
  expect(host.textContent).toContain('Not available yet');
  expect(host.textContent).not.toContain('BOTH FREE');
  expect(host.querySelector("[data-entry-id='11111111-1111-4111-8111-111111111111']")?.textContent).toContain('10:00');
  expect(host.querySelector("[data-entry-id='11111111-1111-4111-8111-111111111111']")?.textContent).not.toContain('10:00–');
  expect(host.textContent).toContain('Scheduled');

  current = projection('running');
  listeners.schedule?.();
  await vi.waitFor(() => expect(readScheduleProjection).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(host.textContent).toContain('In progress'));
  expect(host.textContent).toContain('Started 10:02');
  expect(host.textContent).not.toContain('BOTH FREE');

  current = projection('done');
  listeners.session?.();
  await vi.waitFor(() => expect(readScheduleProjection).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(host.textContent).toContain('Done'));
  expect(host.querySelector("[data-entry-id='11111111-1111-4111-8111-111111111111'] .schedule-status-icon")?.textContent).toBe('✓');

  const myWeek = [...host.querySelectorAll<HTMLButtonElement>('.schedule-chat-pill')]
    .find(button => button.textContent === '#myweek')!;
  myWeek.click();
  expect(navigation.currentWorkspaceNavigation()).toMatchObject({ screen: 'chat' });
  expect((document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Chat about #myweek');
});
