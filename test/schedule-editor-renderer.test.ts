import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { showScheduleEditor } from '../src/renderer/schedule-editor.js';
import { setLanguage } from '../src/renderer/i18n.js';

let dom: JSDOM;
const scheduleEditorCss = readFileSync(new URL('../src/renderer/schedule-editor.css', import.meta.url), 'utf8');

function ok<T>(data: T) { return Promise.resolve({ ok: true as const, data }); }

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const wrap = [...document.querySelectorAll<HTMLLabelElement>('.schedule-editor-field')]
    .find(node => node.querySelector('.schedule-editor-field-label')?.textContent?.trim() === label);
  const found = wrap?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select');
  if (!found) throw new Error(`Field not found: ${label}`);
  return found;
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://eve.local/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLDialogElement: w.HTMLDialogElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLSelectElement: w.HTMLSelectElement
  });
  if (!(w.HTMLDialogElement.prototype as any).showModal) {
    (w.HTMLDialogElement.prototype as any).showModal = function showModal() { this.open = true; };
  }
  if (!(w.HTMLDialogElement.prototype as any).close) {
    (w.HTMLDialogElement.prototype as any).close = function close() { this.open = false; this.dispatchEvent(new w.Event('close')); };
  }
  setLanguage('en');
});

afterEach(() => dom.window.close());

it('uses the app theme surfaces so both schedule editors have an opaque readable backplate', () => {
  const dialogRule = scheduleEditorCss.match(/\.schedule-editor-dialog\s*\{([^}]*)\}/u)?.[1] ?? '';
  const backdropRule = scheduleEditorCss.match(/\.schedule-editor-dialog::backdrop\s*\{([^}]*)\}/u)?.[1] ?? '';
  expect(dialogRule).toContain('background: var(--card);');
  expect(dialogRule).toContain('color: var(--ink);');
  expect(dialogRule).not.toContain('transparent');
  expect(backdropRule).toMatch(/background:\s*(?!transparent)[^;]+;/u);
  expect(scheduleEditorCss).toContain('background: var(--sunk);');
  expect(scheduleEditorCss).toContain('color: var(--soft);');
  expect(scheduleEditorCss).not.toMatch(/var\(--(?:panel|text|muted|input)\b/u);
});

it('uses the Eve entry revision for pause and surfaces a stale conflict instead of overwriting', async () => {
  const entry = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Morning review',
    state: 'enabled' as const,
    durationMinutes: 45,
    trigger: { kind: 'weekly' as const, weekdays: [5], localTime: '09:00', timeZone: 'Europe/Stockholm' },
    work: {
      text: 'Review the queue', automation: 'off' as const,
      context: {
        purpose: 'Prepare the short morning comparison before shopping.',
        desiredOutcome: 'A today-only decision brief.',
        sources: [{ sessionId: '2026-10-01-source', conversationId: 'conversation-source' }]
      }
    },
    updatedAt: 42
  };
  const setState = vi.fn(async () => ({ ok: false as const, error: 'Schedule changed; refresh before editing it again' }));
  const api: any = {
    listEveCronEntries: () => ok([entry]),
    createEveCronEntry: vi.fn(), updateEveCronEntry: vi.fn(), setEveCronEntryState: setState,
    getUserSchedule: vi.fn(), replaceUserSchedule: vi.fn()
  };

  await showScheduleEditor({ owner: 'eve', api });
  expect(document.querySelector('#scheduleEditorDialog')?.getAttribute('aria-labelledby')).toBe('scheduleEditorTitle');
  expect(document.getElementById('scheduleEditorTitle')?.textContent).toBe('Eve routines');
  expect(document.body.textContent).not.toContain('%evecron');
  expect(document.body.textContent).toContain('Edit the recurring and one-time work Eve runs from this schedule.');
  expect(document.body.textContent).toContain('Duration in minutes');
  expect(document.querySelector('.schedule-editor-entry')?.getAttribute('aria-label')).toBe('Morning review');
  expect(document.body.textContent).toContain('Purpose: Prepare the short morning comparison before shopping.');
  expect(button('Edit').getAttribute('aria-label')).toBe('Edit · Morning review');
  expect(button('Pause').getAttribute('aria-label')).toBe('Pause · Morning review');
  button('Pause').click();
  await vi.waitFor(() => expect(setState).toHaveBeenCalledWith(entry.id, 'paused', 42));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('changed somewhere else'));
  expect(document.body.textContent).toContain('Active');
});

it('requires the user to choose a duration before creating an Eve entry', async () => {
  const create = vi.fn(async (input: any) => ok({
    id: '22222222-2222-4222-8222-222222222222',
    title: input.title,
    state: 'enabled' as const,
    durationMinutes: input.durationMinutes,
    trigger: input.trigger,
    work: input.work,
    updatedAt: 100
  }));
  const api: any = {
    listEveCronEntries: () => ok([]), createEveCronEntry: create,
    updateEveCronEntry: vi.fn(), setEveCronEntryState: vi.fn(),
    getUserSchedule: vi.fn(), replaceUserSchedule: vi.fn()
  };

  await showScheduleEditor({ owner: 'eve', api });
  (field('Title') as HTMLInputElement).value = 'Morning review';
  (field('Task') as HTMLTextAreaElement).value = 'Review the queue';
  const duration = field('Duration in minutes') as HTMLInputElement;
  expect(duration.value).toBe('');
  button('Add to Eve’s schedule').click();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('duration'));
  expect(create).not.toHaveBeenCalled();

  duration.value = '30';
  button('Add to Eve’s schedule').click();
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    title: 'Morning review',
    durationMinutes: 30,
    trigger: { kind: 'weekly', weekdays: [1], localTime: '09:00' },
    work: { text: 'Review the queue', automation: 'off' }
  });
});

it('preserves a 24:00 weekly boundary through the user editor and uses record CAS', async () => {
  const record = {
    version: 1 as const,
    baseline: {
      timeZone: 'Europe/Stockholm',
      days: { 1: { availability: 'known' as const, windows: [{ start: '00:00', end: '24:00' }] } }
    },
    changes: [],
    updatedAt: 77
  };
  const replace = vi.fn(async (schedule: any, _expectedUpdatedAt: number | null) => ({
    ok: true as const,
    data: { version: 1 as const, ...schedule, updatedAt: 78 }
  }));
  const api: any = {
    getUserSchedule: () => ok(record), replaceUserSchedule: replace,
    listEveCronEntries: vi.fn(), createEveCronEntry: vi.fn(), updateEveCronEntry: vi.fn(), setEveCronEntryState: vi.fn()
  };

  await showScheduleEditor({ owner: 'user', api });
  expect(document.getElementById('scheduleEditorTitle')?.textContent).toBe('Your availability');
  expect(document.body.textContent).not.toContain('%schedule');
  const end = document.querySelector<HTMLInputElement>('[data-schedule-window-end]');
  expect(end?.value).toBe('24:00');
  button('Save weekday').click();
  await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('Weekly availability saved.'));
  expect(replace.mock.calls[0]?.[0].baseline.days[1].windows).toEqual([{ start: '00:00', end: '24:00' }]);
  expect(replace.mock.calls[0]?.[1]).toBe(77);

  const date = field('Date') as HTMLInputElement;
  date.value = '2026-09-19';
  date.dispatchEvent(new window.Event('change', { bubbles: true }));
  button('Save date change').click();
  await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  expect(replace.mock.calls[1]?.[0].changes).toContainEqual({ date: '2026-09-19', availability: 'unknown' });
  expect(replace.mock.calls[1]?.[1]).toBe(78);
});

it('localizes the mutation sheet into Swedish', async () => {
  setLanguage('sv-SE');
  const api: any = {
    listEveCronEntries: () => ok([]),
    createEveCronEntry: vi.fn(), updateEveCronEntry: vi.fn(), setEveCronEntryState: vi.fn(),
    getUserSchedule: vi.fn(), replaceUserSchedule: vi.fn()
  };
  await showScheduleEditor({ owner: 'eve', api });
  expect(document.getElementById('scheduleEditorTitle')?.textContent).toBe('Eves rutiner');
  expect(field('Varaktighet i minuter')).toHaveProperty('value', '');
  expect(document.body.textContent).toContain('Lägg till i Eves schema');
});
