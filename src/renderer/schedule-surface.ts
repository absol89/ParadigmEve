import { el, icon } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

export type ScheduleViewMode = 'today' | 'week' | 'next7';
export type ScheduleOwner = 'user' | 'eve';
export type EveScheduleStatus =
  | 'scheduled'
  | 'started'
  | 'blocked'
  | 'retrying'
  | 'stopping'
  | 'skipped'
  | 'stopped'
  | 'failed'
  | 'paused'
  | 'done';
export type ScheduleReceiptKind =
  | 'queued'
  | 'started'
  | 'progress'
  | 'needs_user'
  | 'retrying'
  | 'stopping'
  | 'skipped'
  | 'stopped'
  | 'failed'
  | 'done';
export type ScheduleReceiptActionKind = 'chat' | 'result' | 'plan';
export type ScheduleOverlapStatus = 'resolved' | 'unresolved-eve-duration' | 'not-projected';

export interface ScheduleReceiptActionView {
  kind: ScheduleReceiptActionKind;
  targetId?: string;
}

export interface ScheduleReceiptView {
  id: string;
  kind: ScheduleReceiptKind;
  /** Human clock text supplied by the schedule owner, for example 09:02. */
  timeLabel: string;
  /** Task-authored/result text. Never translated by the renderer. */
  detail?: string;
  action?: ScheduleReceiptActionView;
}

export interface ScheduleTemporaryChangeView {
  scope: 'today' | 'date' | 'until';
  /** Required only for `until`, already formatted as a short human date/day label. */
  untilLabel?: string;
  /** Optional recurring-baseline time used only for friendly comparison copy. */
  usualStartMinute?: number;
  usualEndMinute?: number;
  /** For example "tomorrow" or "Friday". Kept verbatim because it is view data. */
  resumesLabel?: string;
}

export interface ScheduleEntryView {
  id: string;
  owner: ScheduleOwner;
  /** User/Eve-authored title. Never passed through translation. */
  title: string;
  /** App-owned titles such as Available opt into localization. Eve-authored task names never do. */
  appAuthoredTitle?: boolean;
  startMinute: number;
  /** Omitted for Eve rows whose durable schedule proves a start time but no semantic duration. */
  endMinute?: number;
  /** Eve status is projection-only evidence from the schedule owner. The renderer never infers it. */
  eveStatus?: EveScheduleStatus;
  receipts?: readonly ScheduleReceiptView[];
  temporary?: ScheduleTemporaryChangeView;
}

export interface ScheduleOverlapView {
  id: string;
  startMinute: number;
  endMinute: number;
  /** True only when the schedule owner has resolved this overlap as current. */
  current?: boolean;
}

export interface ScheduleDayView {
  /** YYYY-MM-DD for resolved calendar days; omitted for the recurring weekly baseline. */
  dateKey?: string;
  /** 0=Sunday … 6=Saturday. Required for baseline days without dateKey. */
  weekday?: number;
  isToday?: boolean;
  visibleStartMinute?: number;
  visibleEndMinute?: number;
  userAvailability?: 'known' | 'unknown';
  overlapStatus?: ScheduleOverlapStatus;
  entries: readonly ScheduleEntryView[];
  overlaps: readonly ScheduleOverlapView[];
  temporaryChangeCount?: number;
  /** Friendly owner-provided date/day label, for example "tomorrow". */
  backToUsualLabel?: string;
}

export interface ScheduleNextOverlapView {
  dateKey: string;
  startMinute: number;
  endMinute: number;
  current?: boolean;
  isToday?: boolean;
  isTomorrow?: boolean;
}

/**
 * Read-only renderer projection. Recurrence, exceptions, availability, overlap calculation,
 * occurrence state and receipts all belong to the schedule owner outside this component.
 */
export interface ScheduleViewData {
  activeMode: ScheduleViewMode;
  detailDay: ScheduleDayView;
  usualWeek: readonly ScheduleDayView[];
  next7Days: readonly ScheduleDayView[];
  nextOverlap: ScheduleNextOverlapView | null;
  overlapStatus?: ScheduleOverlapStatus;
  timeZoneLabel?: string;
}

export interface ScheduleSurfaceCallbacks {
  onModeChange?: (mode: ScheduleViewMode) => void;
  onSelectDay?: (dateKey: string) => void;
  onEditSchedule?: (owner: ScheduleOwner) => void;
  onChatAbout?: (reference: '#schedules' | '#myweek' | '#routines') => void;
  onOpenChat?: () => void;
  onReceiptAction?: (action: ScheduleReceiptActionView, receipt: ScheduleReceiptView, entry: ScheduleEntryView) => void;
}

export interface ScheduleSurfaceOptions extends ScheduleSurfaceCallbacks {
  host: HTMLElement;
  view: ScheduleViewData;
}

export interface ScheduleSurfaceController {
  update(view: ScheduleViewData): void;
  destroy(): void;
}

const MODE_LABEL: Record<ScheduleViewMode, string> = {
  today: 'Today',
  week: 'Usual week',
  next7: 'Next 7 days'
};

const STATUS_LABEL: Record<EveScheduleStatus, string> = {
  scheduled: 'Scheduled',
  started: 'In progress',
  blocked: 'Needs you',
  retrying: 'Trying again',
  stopping: 'Stopping',
  skipped: 'Skipped',
  stopped: 'Stopped',
  failed: 'Failed',
  paused: 'Paused',
  done: 'Done'
};

function minuteLabel(minute: number): string {
  const safe = Math.max(0, Math.min(24 * 60, Math.round(minute)));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function spanLabel(startMinute: number, endMinute: number): string {
  return `${minuteLabel(startMinute)}–${minuteLabel(endMinute)}`;
}

function entryTimeLabel(entry: Pick<ScheduleEntryView, 'startMinute' | 'endMinute'>): string {
  return entry.endMinute === undefined ? minuteLabel(entry.startMinute) : spanLabel(entry.startMinute, entry.endMinute);
}

function durationLabel(startMinute: number, endMinute: number): string {
  const minutes = Math.max(0, endMinute - startMinute);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return t('{0}h {1}m', [hours, rest]);
  if (hours) return t('{0}h', [hours]);
  return t('{0} min', [rest]);
}

function dateAtNoon(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00`);
}

function locale(): string {
  return currentLanguage();
}

function weekdayLabel(day: ScheduleDayView, style: 'long' | 'short' = 'long'): string {
  if (day.dateKey) return new Intl.DateTimeFormat(locale(), { weekday: style }).format(dateAtNoon(day.dateKey));
  const weekday = day.weekday ?? 1;
  const anchor = new Date(2026, 0, 4 + weekday, 12, 0, 0);
  return new Intl.DateTimeFormat(locale(), { weekday: style }).format(anchor);
}

function dayHeading(day: ScheduleDayView): string {
  if (day.isToday) return t('Today');
  if (!day.dateKey) return weekdayLabel(day);
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', month: 'short', day: 'numeric' }).format(dateAtNoon(day.dateKey));
}

function nextOverlapWhen(overlap: ScheduleNextOverlapView): string {
  const time = spanLabel(overlap.startMinute, overlap.endMinute);
  if (overlap.current) return t('Now · until {0}', [minuteLabel(overlap.endMinute)]);
  if (overlap.isToday) return t('Today {0}', [time]);
  if (overlap.isTomorrow) return t('Tomorrow {0}', [time]);
  const day = new Intl.DateTimeFormat(locale(), { weekday: 'short', month: 'short', day: 'numeric' }).format(dateAtNoon(overlap.dateKey));
  return `${day} · ${time}`;
}

function appButton(className: string, label: () => string, onClick?: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  ui(button, 'textContent', label);
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function ownerHeading(owner: ScheduleOwner): HTMLElement {
  const shell = el('div', `schedule-lane-heading is-${owner}`);
  const label = owner === 'user' ? 'Your Schedule' : 'Eve’s Schedule';
  shell.append(el('strong', '', () => t(label)));
  return shell;
}

function statusMarker(status: EveScheduleStatus): HTMLElement {
  const row = el('span', `schedule-status is-${status}`);
  const icon = el('span', 'schedule-status-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (status === 'done') icon.textContent = '✓';
  else if (status === 'blocked' || status === 'failed') icon.textContent = '!';
  row.append(icon, el('span', 'schedule-status-text', () => t(STATUS_LABEL[status])));
  row.setAttribute('data-status', status);
  return row;
}

function receiptActionLabel(kind: ScheduleReceiptActionKind): string {
  if (kind === 'chat') return t('Open chat');
  if (kind === 'result') return t('See result');
  return t('Open Plan');
}

function receiptLabel(receipt: ScheduleReceiptView): string {
  if (receipt.kind === 'queued') return t('Scheduled {0}', [receipt.timeLabel]);
  if (receipt.kind === 'started') return t('Started {0}', [receipt.timeLabel]);
  if (receipt.kind === 'done') return t('Done {0}', [receipt.timeLabel]);
  if (receipt.kind === 'needs_user') return t('Needs you {0}', [receipt.timeLabel]);
  if (receipt.kind === 'retrying') return t('Trying again {0}', [receipt.timeLabel]);
  if (receipt.kind === 'stopping') return t('Stopping {0}', [receipt.timeLabel]);
  if (receipt.kind === 'skipped') return t('Skipped {0}', [receipt.timeLabel]);
  if (receipt.kind === 'stopped') return t('Stopped {0}', [receipt.timeLabel]);
  if (receipt.kind === 'failed') return t('Failed {0}', [receipt.timeLabel]);
  return t('Update {0}', [receipt.timeLabel]);
}

function updates(entry: ScheduleEntryView, callbacks: ScheduleSurfaceCallbacks): HTMLElement | null {
  const receipts = entry.receipts ?? [];
  if (!receipts.length) return null;
  const details = document.createElement('details');
  details.className = 'schedule-updates';
  const summary = document.createElement('summary');
  ui(summary, 'textContent', () => receipts.length === 1 ? t('1 update') : t('{0} updates', [receipts.length]));
  summary.setAttribute('aria-label', `${entry.title} · ${receipts.length === 1 ? t('1 update') : t('{0} updates', [receipts.length])}`);
  details.append(summary);
  const body = el('div', 'schedule-updates-body');
  for (const receipt of receipts) {
    const row = el('div', `schedule-receipt is-${receipt.kind}`);
    const copy = el('div', 'schedule-receipt-copy');
    copy.append(el('strong', '', () => receiptLabel(receipt)));
    if (receipt.detail) copy.append(el('span', '', receipt.detail));
    row.append(copy);
    if (receipt.action && callbacks.onReceiptAction) {
      const action = appButton('schedule-text-action', () => receiptActionLabel(receipt.action!.kind), () => {
        callbacks.onReceiptAction?.(receipt.action!, receipt, entry);
      });
      action.setAttribute('aria-label', `${receiptActionLabel(receipt.action.kind)} · ${entry.title} · ${receiptLabel(receipt)}`);
      row.append(action);
    }
    body.append(row);
  }
  details.append(body);
  return details;
}

function temporaryBadge(change: ScheduleTemporaryChangeView, day: ScheduleDayView): HTMLElement {
  let text: () => string;
  if (change.scope === 'today') text = () => t('Today only');
  else if (change.scope === 'until') text = () => t('Until {0}', [change.untilLabel ?? '']);
  else text = () => t('{0} only', [weekdayLabel(day, 'short')]);
  return el('span', 'schedule-temporary-badge', text);
}

function temporaryDetail(change: ScheduleTemporaryChangeView, entry: ScheduleEntryView): HTMLElement | null {
  if (change.usualStartMinute === undefined || change.usualEndMinute === undefined || entry.endMinute === undefined) return null;
  const current = spanLabel(entry.startMinute, entry.endMinute);
  const usual = spanLabel(change.usualStartMinute, change.usualEndMinute);
  const detail = el('span', 'schedule-temporary-detail', () => t('Usually {0} → {1}', [usual, current]));
  if (change.resumesLabel) detail.append(document.createTextNode(' · '), el('span', '', () => t('Back to usual {0}', [change.resumesLabel!])))
  return detail;
}

function eventCard(entry: ScheduleEntryView, day: ScheduleDayView, callbacks: ScheduleSurfaceCallbacks, compact = false): HTMLElement {
  const card = el('article', `schedule-event is-${entry.owner}${entry.endMinute === undefined ? ' is-point' : ''}${entry.eveStatus ? ` is-${entry.eveStatus}` : ''}`);
  card.setAttribute('aria-label', entry.title);
  card.dataset.entryId = entry.id;
  card.dataset.owner = entry.owner;
  if (entry.eveStatus) card.dataset.status = entry.eveStatus;

  const top = el('div', 'schedule-event-top');
  if (compact) top.append(el('span', 'schedule-owner-kicker', () => t(entry.owner === 'user' ? 'You' : 'Eve')));
  top.append(el('span', 'schedule-event-time', entryTimeLabel(entry)));
  if (entry.temporary) top.append(temporaryBadge(entry.temporary, day));
  card.append(top, el('strong', 'schedule-event-title', entry.appAuthoredTitle ? () => t(entry.title) : entry.title));
  if (entry.owner === 'eve' && entry.eveStatus) card.append(statusMarker(entry.eveStatus));
  if (entry.temporary) {
    const detail = temporaryDetail(entry.temporary, entry);
    if (detail) card.append(detail);
  }
  const receiptView = updates(entry, callbacks);
  if (receiptView) card.append(receiptView);
  return card;
}

function overlapCard(overlap: ScheduleOverlapView, compact = false): HTMLElement {
  const row = el('div', `schedule-overlap${compact ? ' is-compact' : ''}${overlap.current ? ' is-current' : ''}`);
  row.dataset.overlapId = overlap.id;
  row.dataset.current = String(!!overlap.current);
  row.append(
    el('strong', 'schedule-overlap-label', () => t('BOTH FREE')),
    el('span', 'schedule-overlap-time', spanLabel(overlap.startMinute, overlap.endMinute)),
    el('span', 'schedule-overlap-duration', () => durationLabel(overlap.startMinute, overlap.endMinute))
  );
  if (overlap.current) row.append(el('span', 'schedule-now', () => t('Now')));
  return row;
}

function rangeFor(day: ScheduleDayView): { start: number; end: number } {
  if (day.visibleStartMinute !== undefined && day.visibleEndMinute !== undefined && day.visibleEndMinute > day.visibleStartMinute) {
    return { start: day.visibleStartMinute, end: day.visibleEndMinute };
  }
  const starts = [...day.entries.map(entry => entry.startMinute), ...day.overlaps.map(overlap => overlap.startMinute)];
  const ends = [...day.entries.map(entry => entry.endMinute ?? entry.startMinute), ...day.overlaps.map(overlap => overlap.endMinute)];
  if (!starts.length || !ends.length) return { start: 8 * 60, end: 20 * 60 };
  const start = Math.max(0, Math.floor(Math.min(...starts) / 60) * 60 - 60);
  const end = Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60 + 60);
  return end > start ? { start, end } : { start: 8 * 60, end: 20 * 60 };
}

function place(node: HTMLElement, startMinute: number, endMinute: number, range: { start: number; end: number }): void {
  const span = range.end - range.start;
  const top = ((Math.max(range.start, startMinute) - range.start) / span) * 100;
  const height = ((Math.min(range.end, endMinute) - Math.max(range.start, startMinute)) / span) * 100;
  node.style.setProperty('--schedule-top', `${Math.max(0, top).toFixed(3)}%`);
  node.style.setProperty('--schedule-height', `${Math.max(2.5, height).toFixed(3)}%`);
}

function temporarySummary(day: ScheduleDayView): HTMLElement | null {
  const count = day.temporaryChangeCount ?? day.entries.filter(entry => entry.temporary).length;
  if (!count) return null;
  const note = el('aside', 'schedule-change-note');
  const heading = day.isToday ? 'Today is a little different · {0}' : 'A little different · {0}';
  note.append(el('strong', '', () => t(heading, [count === 1 ? t('1 change') : t('{0} changes', [count])])));
  if (day.backToUsualLabel) note.append(el('span', '', () => t('Back to usual {0}.', [day.backToUsualLabel!])))
  return note;
}

function desktopTimeline(day: ScheduleDayView, callbacks: ScheduleSurfaceCallbacks): HTMLElement {
  const wrap = el('section', 'schedule-desktop-day');
  const headings = el('div', 'schedule-lane-headings');
  headings.append(el('span', 'schedule-ruler-heading', () => t('Time')), ownerHeading('user'), ownerHeading('eve'));
  wrap.append(headings);

  const range = rangeFor(day);
  const stage = el('div', 'schedule-timeline-stage');
  ui(stage, 'aria-label', () => t('Daily schedule'));
  const backgrounds = el('div', 'schedule-lane-backgrounds');
  backgrounds.append(el('div', 'schedule-lane-bg is-user'), el('div', 'schedule-lane-bg is-eve'));
  stage.append(backgrounds);
  const userEntries = day.entries.filter(entry => entry.owner === 'user');
  if (day.userAvailability === 'unknown' || (day.userAvailability === 'known' && userEntries.length === 0)) {
    const note = el('div', 'schedule-user-availability-note', () => t(day.userAvailability === 'unknown' ? 'Availability not known' : 'Not available'));
    stage.append(note);
  }
  const tickStart = Math.ceil(range.start / 120) * 120;
  for (let minute = tickStart; minute < range.end; minute += 120) {
    const tick = el('div', 'schedule-time-tick');
    place(tick, minute, minute + 1, range);
    tick.append(el('span', '', minuteLabel(minute)));
    stage.append(tick);
  }
  for (const overlap of day.overlaps) {
    const band = overlapCard(overlap);
    place(band, overlap.startMinute, overlap.endMinute, range);
    stage.append(band);
  }
  for (const entry of day.entries) {
    const card = eventCard(entry, day, callbacks);
    card.classList.add('schedule-lane-event');
    place(card, entry.startMinute, entry.endMinute ?? Math.min(range.end, entry.startMinute + 30), range);
    stage.append(card);
  }
  wrap.append(stage);
  return wrap;
}

function compactTimeline(day: ScheduleDayView, callbacks: ScheduleSurfaceCallbacks): HTMLElement {
  const list = el('section', 'schedule-compact-day');
  ui(list, 'aria-label', () => t('Daily schedule'));
  if (day.userAvailability === 'unknown' || (day.userAvailability === 'known' && !day.entries.some(entry => entry.owner === 'user'))) {
    const note = el('div', 'schedule-compact-availability');
    note.append(el('span', 'schedule-owner-kicker', () => t('You')), el('strong', '', () => t(day.userAvailability === 'unknown' ? 'Availability not known' : 'Not available')));
    list.append(note);
  }
  const rows: Array<{ start: number; order: number; node: HTMLElement }> = [];
  for (const entry of day.entries) rows.push({ start: entry.startMinute, order: entry.owner === 'user' ? 1 : 2, node: eventCard(entry, day, callbacks, true) });
  for (const overlap of day.overlaps) rows.push({ start: overlap.startMinute, order: 0, node: overlapCard(overlap, true) });
  rows.sort((left, right) => left.start - right.start || left.order - right.order);
  for (const row of rows) list.append(row.node);
  if (!rows.length) list.append(el('p', 'schedule-empty', () => t('Nothing planned for this day.')));
  return list;
}

function overlapHero(view: ScheduleViewData, callbacks: ScheduleSurfaceCallbacks): HTMLElement {
  const hero = el('section', `schedule-overlap-hero${view.nextOverlap?.current ? ' is-current' : ''}`);
  if (view.overlapStatus && view.overlapStatus !== 'resolved') {
    hero.classList.add('is-unavailable');
    hero.append(
      el('span', 'schedule-eyebrow', () => t('Overlap time')),
      el('strong', '', () => t('Not available yet')),
      el('span', 'schedule-overlap-hero-duration', () => t('Eve’s schedule has start times, but not enough duration information to calculate shared free time yet.'))
    );
    return hero;
  }
  if (!view.nextOverlap) {
    hero.append(
      el('span', 'schedule-eyebrow', () => t('Next time you can both talk')),
      el('strong', '', () => t('No shared free time is scheduled yet.'))
    );
    return hero;
  }
  const overlap = view.nextOverlap;
  hero.append(
    el('span', 'schedule-eyebrow', () => t(overlap.current ? 'You’re both free now' : 'Next time you can both talk')),
    el('strong', 'schedule-overlap-hero-time', () => nextOverlapWhen(overlap)),
    el('span', 'schedule-overlap-hero-duration', () => t('Both free for {0}', [durationLabel(overlap.startMinute, overlap.endMinute)]))
  );
  if (callbacks.onOpenChat) hero.append(appButton('schedule-open-chat', () => t('Open Eve chat'), callbacks.onOpenChat));
  return hero;
}

function summaryTimes(day: ScheduleDayView, owner: ScheduleOwner): string {
  const entries = day.entries.filter(entry => entry.owner === owner).sort((a, b) => a.startMinute - b.startMinute);
  if (!entries.length) {
    if (owner === 'user') return t(day.userAvailability === 'unknown' ? 'Availability not known' : 'Not available');
    return t('Nothing scheduled');
  }
  const first = entries.slice(0, 2).map(entry => entryTimeLabel(entry)).join(' · ');
  return entries.length > 2 ? t('{0} · +{1} more', [first, entries.length - 2]) : first;
}

function overlapSummary(day: ScheduleDayView, status: ScheduleOverlapStatus | undefined): string {
  if (status && status !== 'resolved') return t('Not available yet');
  if (!day.overlaps.length) return t('No shared free time');
  return day.overlaps.slice(0, 2).map(overlap => spanLabel(overlap.startMinute, overlap.endMinute)).join(' · ');
}

function weekView(days: readonly ScheduleDayView[], mode: ScheduleViewMode, callbacks: ScheduleSurfaceCallbacks, overlapStatus?: ScheduleOverlapStatus): HTMLElement {
  const grid = el('section', 'schedule-week-grid');
  ui(grid, 'aria-label', () => t(mode === 'week' ? 'Usual week' : 'Next 7 days'));
  for (const day of days) {
    const card = document.createElement(day.dateKey && callbacks.onSelectDay ? 'button' : 'article');
    card.className = `schedule-day-card${day.isToday ? ' is-today' : ''}`;
    if (card instanceof HTMLButtonElement) {
      card.type = 'button';
      card.addEventListener('click', () => callbacks.onSelectDay?.(day.dateKey!));
      ui(card, 'aria-label', () => t('Open {0}', [dayHeading(day)]));
    }
    const head = el('div', 'schedule-day-card-head');
    head.append(el('strong', '', () => dayHeading(day)));
    const count = day.temporaryChangeCount ?? day.entries.filter(entry => entry.temporary).length;
    if (mode === 'next7' && count) head.append(el('span', 'schedule-change-count', () => count === 1 ? t('1 change') : t('{0} changes', [count])));
    card.append(head);
    const user = el('div', 'schedule-day-summary');
    user.append(el('span', 'schedule-day-owner', () => t('You')), el('span', '', () => summaryTimes(day, 'user')));
    const eve = el('div', 'schedule-day-summary');
    eve.append(el('span', 'schedule-day-owner', () => t('Eve')), el('span', '', () => summaryTimes(day, 'eve')));
    const both = el('div', 'schedule-day-summary is-overlap');
    const dayOverlapStatus = day.overlapStatus ?? overlapStatus ?? 'resolved';
    both.append(
      el('span', 'schedule-day-owner', () => t(dayOverlapStatus === 'resolved' ? 'Both free' : 'Overlap time')),
      el('span', '', () => overlapSummary(day, dayOverlapStatus))
    );
    card.append(user, eve, both);
    if (day.backToUsualLabel && mode === 'next7') card.append(el('span', 'schedule-day-resume', () => t('Back to usual {0}.', [day.backToUsualLabel!])))
    grid.append(card);
  }
  if (!days.length) grid.append(el('p', 'schedule-empty', () => t('No schedule days to show yet.')));
  return grid;
}

function paint(root: HTMLElement, view: ScheduleViewData, callbacks: ScheduleSurfaceCallbacks): void {
  const head = el('header', 'schedule-head');
  const identityWrap = el('div', 'schedule-identity');
  const identity = el('div', 'schedule-title-block');
  identity.append(el('h1', '', () => t('Schedule')),
    el('p', '', () => t('Your availability and Eve’s routines in one place, so you can see when you’re both free.')));
  identityWrap.append(icon('i-schedule-workspace', 'schedule-library-icon'), identity);
  head.append(identityWrap);
  const tools = el('div', 'schedule-head-tools');
  if (view.timeZoneLabel) tools.append(el('span', 'schedule-timezone', view.timeZoneLabel));
  if (callbacks.onEditSchedule) {
    const actions = el('div', 'schedule-edit-actions');
    actions.append(
      appButton('schedule-edit-action', () => t('Edit your availability'), () => callbacks.onEditSchedule?.('user')),
      appButton('schedule-edit-action', () => t('Edit Eve’s routines'), () => callbacks.onEditSchedule?.('eve'))
    );
    tools.append(actions);
  }
  if (tools.childElementCount) head.append(tools);

  const toolbar = el('div', 'schedule-toolbar');
  const modes = el('div', 'schedule-mode-tabs');
  modes.setAttribute('role', 'tablist');
  ui(modes, 'aria-label', () => t('Schedule view'));
  for (const mode of ['today', 'week', 'next7'] as const) {
    const button = appButton('schedule-mode-tab', () => t(MODE_LABEL[mode]), () => callbacks.onModeChange?.(mode));
    button.setAttribute('role', 'tab');
    button.dataset.mode = mode;
    const selected = view.activeMode === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
    modes.append(button);
  }
  toolbar.append(modes);
  if (callbacks.onChatAbout) {
    const chat = el('div', 'schedule-chat-about');
    chat.append(el('span', 'schedule-chat-about-label', () => t('Chat about')));
    for (const reference of ['#schedules', '#myweek', '#routines'] as const) {
      chat.append(appButton('schedule-chat-pill', () => t(reference), () => callbacks.onChatAbout?.(reference)));
    }
    toolbar.append(chat);
  }

  const body = el('div', 'schedule-body');
  body.append(overlapHero(view, callbacks));
  if (view.activeMode === 'today') {
    const dayHead = el('div', 'schedule-day-heading');
    dayHead.append(el('h2', '', () => dayHeading(view.detailDay)));
    const note = temporarySummary(view.detailDay);
    body.append(dayHead);
    if (note) body.append(note);
    body.append(desktopTimeline(view.detailDay, callbacks), compactTimeline(view.detailDay, callbacks));
  } else {
    body.append(weekView(view.activeMode === 'week' ? view.usualWeek : view.next7Days, view.activeMode, callbacks, view.overlapStatus));
  }
  root.replaceChildren(head, toolbar, body);
}

export function createScheduleSurface(options: ScheduleSurfaceOptions): ScheduleSurfaceController {
  const root = el('section', 'schedule-surface');
  ui(root, 'aria-label', () => t('Schedule'));
  options.host.replaceChildren(root);
  let current = options.view;
  const callbacks: ScheduleSurfaceCallbacks = {
    onModeChange: options.onModeChange,
    onSelectDay: options.onSelectDay,
    onEditSchedule: options.onEditSchedule,
    onChatAbout: options.onChatAbout,
    onOpenChat: options.onOpenChat,
    onReceiptAction: options.onReceiptAction
  };
  paint(root, current, callbacks);
  return {
    update(view): void {
      current = view;
      paint(root, current, callbacks);
    },
    destroy(): void {
      if (root.parentElement === options.host) root.remove();
    }
  };
}
