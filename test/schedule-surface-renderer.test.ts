import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createScheduleSurface,
  type ScheduleDayView,
  type ScheduleViewData
} from '../src/renderer/schedule-surface.js';
import { setLanguage } from '../src/renderer/i18n.js';

const scheduleCss = readFileSync(new URL('../src/renderer/schedule-surface.css', import.meta.url), 'utf8');

let dom: JSDOM;

function day(overrides: Partial<ScheduleDayView> = {}): ScheduleDayView {
  return {
    dateKey: '2026-09-18',
    weekday: 5,
    isToday: true,
    visibleStartMinute: 8 * 60,
    visibleEndMinute: 21 * 60,
    entries: [
      { id: 'user-work', owner: 'user', title: 'Work', startMinute: 9 * 60, endMinute: 12 * 60 },
      {
        id: 'eve-review', owner: 'eve', title: 'Morning review', startMinute: 9 * 60, endMinute: 10 * 60,
        eveStatus: 'done', receipts: [{ id: 'review-done', kind: 'done', timeLabel: '09:18' }]
      },
      {
        id: 'eve-expenses', owner: 'eve', title: 'Expenses tidy-up', startMinute: 14 * 60, endMinute: 15 * 60,
        eveStatus: 'started', receipts: [{ id: 'expenses-start', kind: 'started', timeLabel: '14:03', action: { kind: 'chat', targetId: 'chat-a' } }]
      },
      { id: 'eve-backup', owner: 'eve', title: 'Backup check', startMinute: 16 * 60, endMinute: 16 * 60 + 30, eveStatus: 'scheduled' },
      { id: 'eve-question', owner: 'eve', title: 'Need your choice', startMinute: 17 * 60, endMinute: 17 * 60 + 30, eveStatus: 'blocked' }
    ],
    overlaps: [
      { id: 'lunch', startMinute: 12 * 60 + 30, endMinute: 13 * 60 },
      { id: 'evening', startMinute: 18 * 60 + 30, endMinute: 20 * 60 }
    ],
    ...overrides
  };
}

function view(overrides: Partial<ScheduleViewData> = {}): ScheduleViewData {
  const today = day();
  return {
    activeMode: 'today',
    detailDay: today,
    usualWeek: [
      { weekday: 1, entries: [], overlaps: [{ id: 'mon-free', startMinute: 18 * 60, endMinute: 19 * 60 }] },
      { weekday: 2, entries: [], overlaps: [] }
    ],
    next7Days: [today, day({ dateKey: '2026-09-19', weekday: 6, isToday: false, temporaryChangeCount: 1, backToUsualLabel: 'Sunday' })],
    nextOverlap: { dateKey: '2026-09-18', startMinute: 18 * 60 + 30, endMinute: 20 * 60, isToday: true },
    timeZoneLabel: 'Europe/Stockholm',
    ...overrides
  };
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://eve.local/' });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  setLanguage('en');
});

afterEach(() => dom.window.close());

it('renders the accepted two-lane Today view with first-class overlap and evidence-owned Eve states', () => {
  const host = document.getElementById('host')!;
  const onEditSchedule = vi.fn();
  const onChatAbout = vi.fn();
  createScheduleSurface({ host, view: view(), onEditSchedule, onChatAbout });

  expect(host.querySelector('.schedule-library-icon use')?.getAttribute('href')).toBe('#i-schedule-workspace');
  expect(host.querySelector('.schedule-overlap-hero')?.textContent).toContain('Next time you can both talk');
  expect(host.querySelector('.schedule-overlap-hero')?.textContent).toContain('Today 18:30–20:00');
  expect(host.querySelector('.schedule-lane-heading.is-user')?.textContent).toContain('Your Schedule');
  expect(host.querySelector('.schedule-lane-heading.is-eve')?.textContent).toContain('Eve’s Schedule');
  expect(host.textContent).not.toContain('%schedule');
  expect(host.textContent).not.toContain('%evecron');
  expect(host.querySelector('.schedule-title-block')?.textContent).not.toContain('#schedule');
  expect([...host.querySelectorAll<HTMLButtonElement>('.schedule-chat-pill')].map(button => button.textContent))
    .toEqual(['#schedules', '#myweek', '#routines']);
  const chatButtons = [...host.querySelectorAll<HTMLButtonElement>('.schedule-chat-pill')];
  chatButtons.forEach(button => button.click());
  expect(onChatAbout.mock.calls.map(call => call[0])).toEqual(['#schedules', '#myweek', '#routines']);
  const editAvailability = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit your availability')!;
  const editEve = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit Eve’s routines')!;
  editAvailability.click();
  editEve.click();
  expect(onEditSchedule.mock.calls.map(call => call[0])).toEqual(['user', 'eve']);
  expect(host.querySelectorAll('.schedule-desktop-day .schedule-overlap')).toHaveLength(2);
  expect(host.querySelector("[data-entry-id='eve-review'] .schedule-status")?.textContent).toContain('Done');
  expect(host.querySelector("[data-entry-id='eve-review']")?.getAttribute('aria-label')).toBe('Morning review');
  expect(host.querySelector("[data-entry-id='eve-review'] .schedule-status-icon")?.textContent).toBe('✓');
  expect(host.querySelector<HTMLElement>("[data-entry-id='eve-expenses']")?.dataset.status).toBe('started');
  expect(host.querySelector("[data-entry-id='eve-backup'] .schedule-status")?.textContent).toContain('Scheduled');
  expect(host.querySelector("[data-entry-id='eve-question'] .schedule-status")?.textContent).toContain('Needs you');
});

it('keeps the Schedule header clean and places ruler times inside the rounded timeline', () => {
  const host = document.getElementById('host')!;
  createScheduleSurface({ host, view: view() });

  const toolbarRule = scheduleCss.match(/\.schedule-toolbar\s*\{([^}]*)\}/)?.[1] ?? '';
  const tickLabelRule = scheduleCss.match(/\.schedule-time-tick span\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(toolbarRule).not.toContain('border-top');
  expect(tickLabelRule).toContain('top: 6px');
  expect([...host.querySelectorAll('.schedule-time-tick span')].map(node => node.textContent))
    .toEqual(['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00']);
});

it('never invents overlap or Started state from empty time or clock position', () => {
  const host = document.getElementById('host')!;
  const sparse = day({
    entries: [{ id: 'scheduled', owner: 'eve', title: 'Later task', startMinute: 12 * 60, endMinute: 13 * 60, eveStatus: 'scheduled' }],
    overlaps: []
  });
  createScheduleSurface({
    host,
    view: view({ detailDay: sparse, nextOverlap: null })
  });

  expect(host.querySelector('.schedule-desktop-day .schedule-overlap')).toBeNull();
  expect(host.querySelector<HTMLElement>("[data-entry-id='scheduled']")?.dataset.status).toBe('scheduled');
  expect(host.querySelector("[data-entry-id='scheduled']")?.textContent).not.toContain('In progress');
  expect(host.querySelector('.schedule-overlap-hero')?.textContent).toContain('No shared free time is scheduled yet.');
});

it('shows unresolved Eve duration as unavailable instead of fabricating BOTH FREE', () => {
  const host = document.getElementById('host')!;
  createScheduleSurface({
    host,
    view: view({
      overlapStatus: 'unresolved-eve-duration',
      nextOverlap: null,
      detailDay: day({ overlaps: [] }),
      usualWeek: [{ weekday: 1, userAvailability: 'known', entries: [], overlaps: [] }],
      next7Days: [day({ overlaps: [] })]
    })
  });

  expect(host.querySelector('.schedule-overlap-hero')?.textContent).toContain('Not available yet');
  expect(host.textContent).not.toContain('BOTH FREE');
  expect(host.querySelector('.schedule-overlap-hero')?.textContent)
    .toContain('not enough duration information to calculate shared free time yet');
});

it('keeps view changes controlled by the owner and renders weekly versus next-7-day projections distinctly', () => {
  const onModeChange = vi.fn();
  const onSelectDay = vi.fn();
  const host = document.getElementById('host')!;
  const controller = createScheduleSurface({ host, view: view(), onModeChange, onSelectDay });

  host.querySelector<HTMLButtonElement>("[data-mode='week']")!.click();
  expect(onModeChange).toHaveBeenCalledExactlyOnceWith('week');
  expect(host.querySelector("[data-mode='today']")?.getAttribute('aria-selected')).toBe('true');

  controller.update(view({ activeMode: 'week' }));
  expect(host.querySelector("[data-mode='week']")?.getAttribute('aria-selected')).toBe('true');
  expect(host.querySelector('.schedule-week-grid')?.textContent).toContain('Both free');

  controller.update(view({ activeMode: 'next7' }));
  expect(host.querySelector('.schedule-week-grid')?.textContent).toContain('1 change');
  const secondDay = host.querySelectorAll<HTMLButtonElement>('button.schedule-day-card')[1]!;
  secondDay.click();
  expect(onSelectDay).toHaveBeenCalledWith('2026-09-19');
});

it('renders compact/mobile rows chronologically and keeps overlap a full-width semantic row', () => {
  const host = document.getElementById('host')!;
  createScheduleSurface({ host, view: view() });
  const rows = [...host.querySelectorAll<HTMLElement>('.schedule-compact-day > *')];
  expect(rows.map(row => row.dataset.entryId ?? row.dataset.overlapId)).toEqual([
    'user-work', 'eve-review', 'lunch', 'eve-expenses', 'eve-backup', 'eve-question', 'evening'
  ]);
  expect(host.querySelector('.schedule-compact-day .schedule-overlap')?.textContent).toContain('BOTH FREE');
  expect(scheduleCss).toContain('@media (max-width: 720px)');
  expect(scheduleCss).toContain('.schedule-desktop-day { display: none; }');
  expect(scheduleCss).toContain('.schedule-compact-day { display: grid;');
});

it('shows friendly temporary-change copy and exposes receipt actions without internal ids', () => {
  const onReceiptAction = vi.fn();
  const host = document.getElementById('host')!;
  const changed = day({
    temporaryChangeCount: 1,
    backToUsualLabel: 'tomorrow',
    entries: [{
      id: 'eve-moved', owner: 'eve', title: 'Weekly cleanup', startMinute: 15 * 60 + 30, endMinute: 16 * 60 + 30,
      eveStatus: 'started',
      temporary: { scope: 'today', usualStartMinute: 14 * 60, usualEndMinute: 15 * 60, resumesLabel: 'tomorrow' },
      receipts: [{ id: 'receipt-secret-id', kind: 'started', timeLabel: '15:32', detail: 'Working through the saved list.', action: { kind: 'result', targetId: 'result-secret-id' } }]
    }]
  });
  createScheduleSurface({ host, view: view({ detailDay: changed }), onReceiptAction });

  expect(host.textContent).toContain('Today is a little different · 1 change');
  expect(host.textContent).toContain('Today only');
  expect(host.textContent).toContain('Usually 14:00–15:00 → 15:30–16:30');
  expect(host.textContent).toContain('Back to usual tomorrow');
  expect(host.textContent).not.toContain('receipt-secret-id');
  expect(host.textContent).not.toContain('result-secret-id');
  expect(host.querySelector('.schedule-updates summary')?.getAttribute('aria-label')).toBe('Weekly cleanup · 1 update');
  const resultAction = host.querySelector<HTMLButtonElement>('.schedule-text-action')!;
  expect(resultAction.getAttribute('aria-label')).toBe('See result · Weekly cleanup · Started 15:32');
  resultAction.click();
  expect(onReceiptAction).toHaveBeenCalledOnce();
  expect(onReceiptAction.mock.calls[0]![0]).toEqual({ kind: 'result', targetId: 'result-secret-id' });
});

it('uses square green Done, gold current rings, readable completion, and icon-plus-word status markers', () => {
  const doneRule = scheduleCss.match(/\.schedule-status\.is-done \.schedule-status-icon\s*\{([^}]*)\}/)?.[1] ?? '';
  const startedRule = scheduleCss.match(/\.schedule-status\.is-started \.schedule-status-icon\s*\{([^}]*)\}/)?.[1] ?? '';
  const doneTextRule = scheduleCss.match(/\.schedule-event\.is-done \.schedule-event-title\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(doneRule).toContain('border-color: var(--green)');
  expect(doneRule).toContain('background: var(--green)');
  expect(doneRule).toContain('border-radius: 4px');
  expect(startedRule).toContain('var(--schedule-gold)');
  expect(startedRule).toContain('border-radius: 50%');
  expect(doneTextRule).not.toContain('text-decoration');
  expect(doneTextRule).not.toContain('line-through');
  expect(scheduleCss).not.toContain('text-decoration: line-through');
});

it('localizes schedule chrome into natural Swedish while preserving authored schedule text', () => {
  const host = document.getElementById('host')!;
  createScheduleSurface({ host, view: view(), onEditSchedule: vi.fn() });
  const authoredTitle = host.querySelector("[data-entry-id='eve-review'] .schedule-event-title");
  expect(host.querySelector('.schedule-title-block h1')?.textContent).toBe('Schedule');
  setLanguage('sv-SE');
  expect(host.querySelector('.schedule-title-block h1')?.textContent).toBe('Schema');
  expect(host.querySelector("[data-mode='today']")?.textContent).toBe('I dag');
  expect(host.querySelector('.schedule-overlap-label')?.textContent).toBe('BÅDA LEDIGA');
  expect(host.querySelector("[data-entry-id='eve-expenses'] .schedule-status")?.textContent).toContain('Pågående');
  expect(host.querySelector("[data-entry-id='eve-review'] .schedule-event-title")).toBe(authoredTitle);
  expect(authoredTitle?.textContent).toBe('Morning review');
  expect(host.querySelector('.schedule-surface')?.getAttribute('aria-label')).toBe('Schema');
  expect(host.textContent).toContain('Ändra din tillgänglighet');
  expect(host.textContent).toContain('Ändra Eves rutiner');
});
