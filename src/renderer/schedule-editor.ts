import type { AppApi } from '../preload/index.js';
import type {
  EveCronEditableEntry,
  EveCronUiCreateRequest,
  EveCronUiUpdateRequest,
  UserScheduleEditableInput,
  UserScheduleEditableRecord
} from '../shared/schedule-mutations.js';
import type {
  IsoWeekday,
  UserScheduleTemporaryChangeInput,
  UserScheduleWindowInput
} from '../shared/user-schedule.js';
import type { ScheduleOwner } from './schedule-surface.js';
import { el } from './dom.js';
import { t, ui } from './i18n.js';

type ApiReply<T> = { ok: true; data: T } | { ok: false; error: string };
type ScheduleMutationApi = Pick<AppApi,
  'listEveCronEntries' | 'createEveCronEntry' | 'updateEveCronEntry' | 'setEveCronEntryState' |
  'getUserSchedule' | 'replaceUserSchedule'>;

export interface ScheduleEditorOptions {
  owner: ScheduleOwner;
  api?: ScheduleMutationApi;
}

interface WindowRows {
  root: HTMLElement;
  read(): UserScheduleWindowInput[] | null;
  replace(windows: readonly UserScheduleWindowInput[]): void;
  setDisabled(disabled: boolean): void;
}

const WEEKDAYS: Array<{ value: IsoWeekday; label: string }> = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' }
];

function button(label: string | (() => string), onClick: () => void | Promise<void>, className = 'btn'): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  if (typeof label === 'function') ui(node, 'textContent', label); else node.textContent = label;
  node.addEventListener('click', () => void onClick());
  return node;
}

function labeledField(label: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'schedule-editor-field';
  wrap.append(el('span', 'schedule-editor-field-label', () => t(label)), input);
  if (hint) wrap.append(el('small', 'schedule-editor-hint', () => t(hint)));
  return wrap;
}

function textInput(value = ''): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.autocomplete = 'off';
  return input;
}

function selectInput(options: Array<{ value: string; label: string }>, value: string): HTMLSelectElement {
  const select = document.createElement('select');
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    ui(node, 'textContent', () => t(option.label));
    select.append(node);
  }
  select.value = value;
  return select;
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function errorText(error: string): string {
  if (/changed; refresh before editing/i.test(error)) return t('This schedule changed somewhere else. Refresh before saving again.');
  return error;
}

function setStatus(node: HTMLElement, message: string, error = false): void {
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.setAttribute('role', error ? 'alert' : 'status');
}

async function receive<T>(promise: Promise<ApiReply<T>>, status: HTMLElement): Promise<T | null> {
  const reply = await promise;
  if (!reply.ok) {
    setStatus(status, errorText(reply.error), true);
    return null;
  }
  return reply.data;
}

function triggerSummary(entry: EveCronEditableEntry): string {
  if (entry.trigger.kind === 'once') {
    return `${entry.trigger.localDate} · ${entry.trigger.localTime} · ${entry.trigger.timeZone}`;
  }
  const names = entry.trigger.weekdays.map(weekday => t(WEEKDAYS.find(day => day.value === weekday)?.label ?? String(weekday)));
  return `${names.join(', ')} · ${entry.trigger.localTime} · ${entry.trigger.timeZone}`;
}

function createWindowRows(initial: readonly UserScheduleWindowInput[] = []): WindowRows {
  const root = el('div', 'schedule-editor-windows');
  const list = el('div', 'schedule-editor-window-list');
  const add = button(() => t('Add free window'), () => appendRow(), 'btn btn-quiet');
  root.append(list, add);

  function appendRow(window: UserScheduleWindowInput = { start: '09:00', end: '17:00' }): void {
    const row = el('div', 'schedule-editor-window-row');
    const start = document.createElement('input');
    start.type = 'text';
    start.inputMode = 'numeric';
    start.pattern = '(?:[01]\\d|2[0-3]):[0-5]\\d';
    start.placeholder = 'HH:mm';
    start.dataset.scheduleWindowStart = 'true';
    start.value = window.start;
    start.setAttribute('aria-label', t('Free from'));
    const end = document.createElement('input');
    end.type = 'text';
    end.inputMode = 'numeric';
    end.pattern = '(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)';
    end.placeholder = 'HH:mm';
    end.dataset.scheduleWindowEnd = 'true';
    end.value = window.end;
    end.setAttribute('aria-label', t('Free until'));
    const remove = button(() => t('Remove'), () => row.remove(), 'btn btn-quiet schedule-editor-remove-window');
    row.append(start, el('span', 'schedule-editor-window-separator', '–'), end, remove);
    list.append(row);
  }

  function replace(windows: readonly UserScheduleWindowInput[]): void {
    list.replaceChildren();
    for (const window of windows) appendRow(window);
  }

  function read(): UserScheduleWindowInput[] | null {
    const windows: UserScheduleWindowInput[] = [];
    for (const row of list.querySelectorAll<HTMLElement>('.schedule-editor-window-row')) {
      const start = row.querySelector<HTMLInputElement>('[data-schedule-window-start]')?.value.trim() ?? '';
      const end = row.querySelector<HTMLInputElement>('[data-schedule-window-end]')?.value.trim() ?? '';
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start) || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u.test(end) || start >= end) return null;
      windows.push({ start, end });
    }
    return windows;
  }

  function setDisabled(disabled: boolean): void {
    for (const input of list.querySelectorAll<HTMLInputElement>('input')) input.disabled = disabled;
    for (const remove of list.querySelectorAll<HTMLButtonElement>('button')) remove.disabled = disabled;
    add.disabled = disabled;
  }

  replace(initial);
  return { root, read, replace, setDisabled };
}

function createDialogShell(title: string, description: string): { dialog: HTMLDialogElement; body: HTMLElement; status: HTMLElement } {
  document.querySelector('#scheduleEditorDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'scheduleEditorDialog';
  dialog.className = 'schedule-editor-dialog';
  const head = el('div', 'schedule-editor-head');
  const titleBlock = el('div', 'schedule-editor-title');
  const heading = el('h2', '', () => t(title));
  heading.id = 'scheduleEditorTitle';
  titleBlock.append(heading, el('span', 'schedule-editor-description', () => t(description)));
  head.append(titleBlock, button(() => t('Close'), () => dialog.close(), 'btn btn-quiet'));
  dialog.setAttribute('aria-labelledby', heading.id);
  const status = el('p', 'schedule-editor-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const body = el('div', 'schedule-editor-body');
  dialog.append(head, status, body);
  dialog.addEventListener('close', () => dialog.remove());
  return { dialog, body, status };
}

async function renderEveEditor(body: HTMLElement, status: HTMLElement, api: ScheduleMutationApi): Promise<void> {
  let entries = await receive(api.listEveCronEntries(), status);
  if (!entries) return;
  let editing: EveCronEditableEntry | null = null;

  const render = (): void => {
    body.replaceChildren();
    const form = el('section', 'schedule-editor-section');
    form.append(el('h3', '', () => t(editing ? 'Edit Eve schedule entry' : 'Add Eve schedule entry')));

    const title = textInput(editing?.title ?? '');
    title.maxLength = 160;
    const task = document.createElement('textarea');
    task.rows = 4;
    task.maxLength = 16_000;
    task.value = editing?.work.text ?? '';
    const cadence = selectInput([
      { value: 'weekly', label: 'Weekly' },
      { value: 'once', label: 'Once' }
    ], editing?.trigger.kind ?? 'weekly');
    const timeZone = textInput(editing?.trigger.timeZone ?? localTimeZone());
    const time = document.createElement('input');
    time.type = 'time';
    time.value = editing?.trigger.localTime ?? '09:00';
    const duration = document.createElement('input');
    duration.type = 'number';
    duration.min = '1';
    duration.max = '1440';
    duration.step = '1';
    duration.value = editing?.durationMinutes === undefined ? '' : String(editing.durationMinutes);
    const date = document.createElement('input');
    date.type = 'date';
    date.value = editing?.trigger.kind === 'once' ? editing.trigger.localDate : '';
    const startsOn = document.createElement('input');
    startsOn.type = 'date';
    startsOn.value = editing?.trigger.kind === 'weekly' ? (editing.trigger.startsOn ?? '') : '';
    const weekdays = el('fieldset', 'schedule-editor-weekdays');
    weekdays.append(el('legend', '', () => t('Days')));
    const selected = new Set(editing?.trigger.kind === 'weekly' ? editing.trigger.weekdays : [1]);
    for (const weekday of WEEKDAYS) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(weekday.value);
      checkbox.checked = selected.has(weekday.value);
      label.append(checkbox, el('span', '', () => t(weekday.label)));
      weekdays.append(label);
    }
    const automation = selectInput([
      { value: 'off', label: 'One task' },
      { value: 'goal', label: 'Goal' },
      { value: 'loop', label: 'Loop' }
    ], editing?.work.automation ?? 'off');
    const objective = document.createElement('textarea');
    objective.rows = 2;
    objective.maxLength = 16_000;
    objective.value = editing?.work.objective ?? '';
    const objectiveField = labeledField('Objective', objective, 'Optional for Goal and Loop.');

    const cadenceFields = el('div', 'schedule-editor-cadence-fields');
    const repaintCadence = (): void => {
      cadenceFields.replaceChildren();
      if (cadence.value === 'weekly') {
        cadenceFields.append(weekdays, labeledField('Starts on', startsOn, 'Optional. Leave blank to start with the current weekly pattern.'));
      } else {
        cadenceFields.append(labeledField('Date', date));
      }
    };
    cadence.addEventListener('change', repaintCadence);
    automation.addEventListener('change', () => { objectiveField.hidden = automation.value === 'off'; });
    objectiveField.hidden = automation.value === 'off';
    repaintCadence();

    form.append(
      labeledField('Title', title),
      labeledField('Task', task, 'This text is authorized only when you press Save.'),
      labeledField('Repeat', cadence),
      cadenceFields,
      labeledField('Time', time),
      labeledField('Duration in minutes', duration, 'Required so shared free time can be calculated without guessing.'),
      labeledField('Time zone', timeZone),
      labeledField('Run as', automation),
      objectiveField
    );

    const actions = el('div', 'schedule-editor-actions');
    const save = button(() => t(editing ? 'Save changes' : 'Add to Eve’s schedule'), async () => {
      setStatus(status, t('Saving…'));
      const pickedWeekdays = [...weekdays.querySelectorAll<HTMLInputElement>('input:checked')].map(input => Number(input.value) as IsoWeekday);
      const durationMinutes = Number(duration.value);
      if (!title.value.trim() || !task.value.trim() || !time.value || !timeZone.value.trim()
          || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
        setStatus(status, t('Fill in the title, task, time, duration, and time zone.'), true);
        return;
      }
      if (cadence.value === 'weekly' && pickedWeekdays.length === 0) {
        setStatus(status, t('Choose at least one weekday.'), true);
        return;
      }
      if (cadence.value === 'once' && !date.value) {
        setStatus(status, t('Choose a date.'), true);
        return;
      }
      const trigger = cadence.value === 'weekly'
        ? { kind: 'weekly' as const, weekdays: pickedWeekdays, localTime: time.value, timeZone: timeZone.value.trim(), ...(startsOn.value ? { startsOn: startsOn.value } : {}) }
        : { kind: 'once' as const, localDate: date.value, localTime: time.value, timeZone: timeZone.value.trim() };
      const work = {
        text: task.value.trim(),
        automation: automation.value as 'off' | 'goal' | 'loop',
        ...(automation.value !== 'off' && objective.value.trim() ? { objective: objective.value.trim() } : {}),
        ...(editing?.work.projectId ? { projectId: editing.work.projectId } : {})
      };
      const result = editing
        ? await receive(api.updateEveCronEntry({ id: editing.id, expectedUpdatedAt: editing.updatedAt, patch: { title: title.value.trim(), durationMinutes, trigger, work } } satisfies EveCronUiUpdateRequest), status)
        : await receive(api.createEveCronEntry({ title: title.value.trim(), durationMinutes, trigger, work } satisfies EveCronUiCreateRequest), status);
      if (!result) return;
      entries = editing ? entries!.map(entry => entry.id === result.id ? result : entry) : [...entries!, result];
      editing = null;
      setStatus(status, t('Schedule saved.'));
      render();
    }, 'btn btn-solid');
    actions.append(save);
    if (editing) actions.append(button(() => t('Cancel edit'), () => { editing = null; setStatus(status, ''); render(); }));
    form.append(actions);

    const list = el('section', 'schedule-editor-section');
    const listHead = el('div', 'schedule-editor-section-head');
    listHead.append(el('h3', '', () => t('Eve schedule entries')), button(() => t('Refresh'), async () => {
      const refreshed = await receive(api.listEveCronEntries(), status);
      if (!refreshed) return;
      entries = refreshed;
      editing = null;
      setStatus(status, t('Schedule refreshed.'));
      render();
    }, 'btn btn-quiet'));
    list.append(listHead);
    if (!entries!.length) list.append(el('p', 'schedule-editor-empty', () => t('No Eve schedule entries yet.')));
    for (const entry of entries!) {
      const row = el('article', `schedule-editor-entry${entry.state === 'paused' ? ' is-paused' : ''}`);
      row.setAttribute('aria-label', entry.title);
      const copy = el('div', 'schedule-editor-entry-copy');
      copy.append(el('strong', '', entry.title), el('span', '', triggerSummary(entry)), el('small', '', () => t(entry.state === 'paused' ? 'Paused' : 'Active')));
      const rowActions = el('div', 'schedule-editor-entry-actions');
      const edit = button(() => t('Edit'), () => { editing = entry; setStatus(status, ''); render(); });
      edit.setAttribute('aria-label', `${t('Edit')} · ${entry.title}`);
      const stateAction = entry.state === 'paused' ? 'Resume' : 'Pause';
      const toggleState = button(() => t(stateAction), async () => {
        setStatus(status, t('Saving…'));
        const nextState = entry.state === 'paused' ? 'enabled' : 'paused';
        const updated = await receive(api.setEveCronEntryState(entry.id, nextState, entry.updatedAt), status);
        if (!updated) return;
        entries = entries!.map(current => current.id === updated.id ? updated : current);
        if (editing?.id === updated.id) editing = updated;
        setStatus(status, t(nextState === 'paused' ? 'Eve schedule entry paused.' : 'Eve schedule entry resumed.'));
        render();
      });
      toggleState.setAttribute('aria-label', `${t(stateAction)} · ${entry.title}`);
      rowActions.append(edit, toggleState);
      row.append(copy, rowActions);
      list.append(row);
    }
    body.append(form, list);
  };

  render();
}

function cloneUserSchedule(record: UserScheduleEditableRecord | null): UserScheduleEditableInput {
  return record
    ? structuredClone({ baseline: record.baseline, changes: record.changes })
    : { baseline: { timeZone: localTimeZone(), days: {} }, changes: [] };
}

async function renderUserEditor(body: HTMLElement, status: HTMLElement, api: ScheduleMutationApi): Promise<void> {
  let record = await receive(api.getUserSchedule(), status);
  if (record === null && status.classList.contains('is-error')) return;
  let draft = cloneUserSchedule(record);

  const render = (): void => {
    body.replaceChildren();
    const timeZone = textInput(draft.baseline.timeZone);
    timeZone.className = 'schedule-editor-timezone-input';
    body.append(labeledField('Time zone', timeZone, 'Weekly times stay at the same local wall-clock time in this zone.'));

    const weekly = el('section', 'schedule-editor-section');
    weekly.append(el('h3', '', () => t('Usual week')));
    const weekday = selectInput(WEEKDAYS.map(day => ({ value: String(day.value), label: day.label })), '1');
    const availability = selectInput([
      { value: 'known', label: 'I know my availability' },
      { value: 'unknown', label: 'I’m not sure yet' }
    ], 'unknown');
    const weeklyWindows = createWindowRows();
    const weeklySummary = el('div', 'schedule-editor-week-summary');
    for (const day of WEEKDAYS) {
      const row = el('div', 'schedule-editor-week-summary-row');
      const value = draft.baseline.days[day.value];
      row.append(el('strong', '', () => t(day.label)), el('span', '', value?.availability === 'known'
        ? (value.windows?.length ? value.windows.map(window => `${window.start}–${window.end}`).join(', ') : t('No free time'))
        : t('Unknown')));
      weeklySummary.append(row);
    }
    const loadWeekday = (): void => {
      const value = draft.baseline.days[Number(weekday.value) as IsoWeekday];
      availability.value = value?.availability ?? 'unknown';
      weeklyWindows.replace(value?.availability === 'known' ? (value.windows ?? []) : []);
      weeklyWindows.setDisabled(availability.value === 'unknown');
    };
    weekday.addEventListener('change', loadWeekday);
    availability.addEventListener('change', () => weeklyWindows.setDisabled(availability.value === 'unknown'));
    loadWeekday();
    weekly.append(
      weeklySummary,
      labeledField('Weekday', weekday),
      labeledField('Availability', availability),
      weeklyWindows.root
    );
    weekly.append(button(() => t('Save weekday'), async () => {
      const windows = weeklyWindows.read();
      if (availability.value === 'known' && windows === null) {
        setStatus(status, t('Each free window needs an end time after its start time.'), true);
        return;
      }
      draft.baseline.timeZone = timeZone.value.trim();
      const chosen = Number(weekday.value) as IsoWeekday;
      draft.baseline.days[chosen] = availability.value === 'unknown'
        ? { availability: 'unknown' }
        : { availability: 'known', windows: windows ?? [] };
      const saved = await receive(api.replaceUserSchedule(draft, record?.updatedAt ?? null), status);
      if (!saved) return;
      record = saved;
      draft = cloneUserSchedule(saved);
      setStatus(status, t('Weekly availability saved.'));
      render();
    }, 'btn btn-solid'));

    const temporary = el('section', 'schedule-editor-section');
    temporary.append(el('h3', '', () => t('One-date change')));
    const date = document.createElement('input');
    date.type = 'date';
    const tempAvailability = selectInput([
      { value: 'known', label: 'I know my availability' },
      { value: 'unknown', label: 'I’m not sure yet' }
    ], 'unknown');
    const tempWindows = createWindowRows();
    const remove = button(() => t('Remove date change'), async () => {
      if (!date.value) return;
      draft.baseline.timeZone = timeZone.value.trim();
      draft.changes = (draft.changes ?? []).filter(change => change.date !== date.value);
      const saved = await receive(api.replaceUserSchedule(draft, record?.updatedAt ?? null), status);
      if (!saved) return;
      record = saved;
      draft = cloneUserSchedule(saved);
      setStatus(status, t('Date change removed.'));
      render();
    });
    const loadDate = (): void => {
      const change = (draft.changes ?? []).find(row => row.date === date.value);
      tempAvailability.value = change?.availability ?? 'unknown';
      tempWindows.replace(change?.availability === 'known' ? (change.windows ?? []) : []);
      tempWindows.setDisabled(tempAvailability.value === 'unknown');
      remove.disabled = !change;
    };
    date.addEventListener('change', loadDate);
    tempAvailability.addEventListener('change', () => tempWindows.setDisabled(tempAvailability.value === 'unknown'));
    loadDate();
    temporary.append(
      labeledField('Date', date, 'Temporary changes can be saved for the next 7 days.'),
      labeledField('Availability', tempAvailability),
      tempWindows.root
    );
    const tempActions = el('div', 'schedule-editor-actions');
    tempActions.append(button(() => t('Save date change'), async () => {
      if (!date.value) {
        setStatus(status, t('Choose a date.'), true);
        return;
      }
      const windows = tempWindows.read();
      if (tempAvailability.value === 'known' && windows === null) {
        setStatus(status, t('Each free window needs an end time after its start time.'), true);
        return;
      }
      draft.baseline.timeZone = timeZone.value.trim();
      const change: UserScheduleTemporaryChangeInput = tempAvailability.value === 'unknown'
        ? { date: date.value, availability: 'unknown' }
        : { date: date.value, availability: 'known', windows: windows ?? [] };
      draft.changes = [...(draft.changes ?? []).filter(row => row.date !== date.value), change];
      const saved = await receive(api.replaceUserSchedule(draft, record?.updatedAt ?? null), status);
      if (!saved) return;
      record = saved;
      draft = cloneUserSchedule(saved);
      setStatus(status, t('Date change saved.'));
      render();
    }, 'btn btn-solid'), remove);
    temporary.append(tempActions);

    const refresh = button(() => t('Refresh'), async () => {
      const refreshed = await receive(api.getUserSchedule(), status);
      if (refreshed === null && status.classList.contains('is-error')) return;
      record = refreshed;
      draft = cloneUserSchedule(refreshed);
      setStatus(status, t('Schedule refreshed.'));
      render();
    }, 'btn btn-quiet schedule-editor-refresh');
    body.append(weekly, temporary, refresh);
  };

  render();
}

/**
 * Opens the user-authorized schedule editor from #myweek. The workspace owns when this is
 * invoked; this module owns only explicit form mutations and never activates a Thread prompt or
 * derives work from chat prose.
 */
export async function showScheduleEditor(options: ScheduleEditorOptions): Promise<HTMLDialogElement> {
  const api = options.api ?? window.api;
  const shell = createDialogShell(
    options.owner === 'eve' ? 'Eve routines' : 'Your availability',
    options.owner === 'eve'
      ? 'Edit the recurring and one-time work Eve runs from this schedule.'
      : 'Edit the times you are usually available and any date-specific changes.'
  );
  document.body.append(shell.dialog);
  shell.dialog.showModal();
  setStatus(shell.status, t('Loading schedule…'));
  if (options.owner === 'eve') await renderEveEditor(shell.body, shell.status, api);
  else await renderUserEditor(shell.body, shell.status, api);
  if (!shell.status.classList.contains('is-error')) setStatus(shell.status, '');
  return shell.dialog;
}
