import type {
  ScheduleProjectionDay,
  ScheduleProjectionEveItem,
  ScheduleProjectionReceipt,
  ScheduleProjectionWeeklyDay,
  ScheduleReadProjection
} from '../shared/schedule-projection.js';
import type { ResolvedUserScheduleSnapshot } from '../shared/user-schedule.js';
import { el, run } from './dom.js';
import { currentLanguage, t } from './i18n.js';
import {
  createScheduleSurface,
  type EveScheduleStatus,
  type ScheduleDayView,
  type ScheduleEntryView,
  type ScheduleReceiptView,
  type ScheduleSurfaceController,
  type ScheduleViewData,
  type ScheduleViewMode
} from './schedule-surface.js';
import { showScheduleEditor } from './schedule-editor.js';
import { currentWorkspaceNavigation, navigateWorkspace, onWorkspaceNavigation } from './workspace-navigation.js';

let initialized = false;
let controller: ScheduleSurfaceController | null = null;
let projection: ScheduleReadProjection | null = null;
let activeMode: ScheduleViewMode = 'today';
let selectedDate: string | null = null;
let refreshGeneration = 0;

function isoWeekdayToJs(weekday: number): number {
  return weekday % 7;
}

function minuteFromLocalTime(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function clockAt(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat(currentLanguage(), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(at));
}

export function rendererStatusFromProjection(status: ScheduleProjectionEveItem['status']): EveScheduleStatus {
  switch (status) {
    case 'scheduled':
    case 'queued':
      return 'scheduled';
    case 'running':
      return 'started';
    case 'needs_user':
      return 'blocked';
    case 'retrying':
    case 'stopping':
    case 'skipped':
    case 'stopped':
    case 'failed':
    case 'done':
      return status;
  }
}

function receiptView(receipt: ScheduleProjectionReceipt, timeZone: string): ScheduleReceiptView {
  return {
    id: receipt.id,
    kind: receipt.kind,
    timeLabel: clockAt(receipt.at, timeZone),
    ...(receipt.detail ? { detail: receipt.detail } : {}),
    ...(receipt.action ? { action: receipt.action } : {})
  };
}

function userEntries(
  snapshot: ResolvedUserScheduleSnapshot,
  idPrefix: string,
  options: { temporary?: boolean; usual?: ResolvedUserScheduleSnapshot; today?: boolean } = {}
): ScheduleEntryView[] {
  if (snapshot.availability !== 'known') return [];
  const comparableUsual = options.usual?.availability === 'known' && options.usual.windows.length === snapshot.windows.length
    ? options.usual.windows
    : [];
  return snapshot.windows.map((window, index) => {
    const usual = comparableUsual[index];
    return {
      id: `${idPrefix}:${window.key}`,
      owner: 'user' as const,
      title: 'Available',
      appAuthoredTitle: true,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      ...(options.temporary ? {
        temporary: {
          scope: options.today ? 'today' as const : 'date' as const,
          ...(usual ? { usualStartMinute: usual.startMinute, usualEndMinute: usual.endMinute } : {})
        }
      } : {})
    };
  });
}

function eveEntry(row: ScheduleProjectionEveItem, timeZone: string, today: boolean): ScheduleEntryView {
  return {
    id: row.occurrenceId,
    owner: 'eve',
    title: row.title,
    startMinute: row.startMinute,
    ...(row.endMinute !== null && row.endMinute !== undefined ? { endMinute: row.endMinute } : {}),
    eveStatus: rendererStatusFromProjection(row.status),
    receipts: row.receipts.map(receipt => receiptView(receipt, timeZone)),
    ...(row.temporary ? { temporary: { scope: today ? 'today' as const : 'date' as const } } : {})
  };
}

function resolvedDay(row: ScheduleProjectionDay, projection: ScheduleReadProjection): ScheduleDayView {
  const isToday = row.date === projection.startDate;
  const overlaps = projection.overlap.status === 'resolved'
    ? projection.overlap.windows
      .filter(window => window.date === row.date)
      .map(window => ({
        id: window.id,
        startMinute: window.startMinute,
        endMinute: window.endMinute,
        current: window.current
      }))
    : [];
  return {
    dateKey: row.date,
    weekday: isoWeekdayToJs(row.weekday),
    isToday,
    userAvailability: row.user.effective.availability,
    entries: [
      ...userEntries(row.user.effective, `${row.date}:user`, {
        temporary: row.user.temporaryChange,
        usual: row.user.usual,
        today: isToday
      }),
      ...row.eve.map(item => eveEntry(item, projection.timeZone, isToday))
    ],
    // Overlap is backend authority. An empty unresolved projection stays empty here rather than
    // treating gaps between start-only Eve rows as free time.
    overlaps,
    overlapStatus: projection.overlap.status,
    temporaryChangeCount: Number(row.user.temporaryChange) + row.eve.filter(item => item.temporary).length
  };
}

function weeklyDay(row: ScheduleProjectionWeeklyDay): ScheduleDayView {
  return {
    weekday: isoWeekdayToJs(row.weekday),
    userAvailability: row.user.availability,
    entries: [
      ...userEntries(row.user, `weekly-${row.weekday}:user`),
      ...row.eve.map(item => ({
        id: `weekly:${item.entryId}:${row.weekday}`,
        owner: 'eve' as const,
        title: item.title,
        startMinute: minuteFromLocalTime(item.localTime),
        ...(item.durationMinutes !== null && item.durationMinutes !== undefined
          ? { endMinute: Math.min(24 * 60, minuteFromLocalTime(item.localTime) + item.durationMinutes) }
          : {}),
        eveStatus: item.state === 'paused' ? 'paused' as const : 'scheduled' as const
      }))
    ],
    overlaps: [],
    // The current backend projects resolved overlap for dated occurrences only. Do not derive the
    // recurring weekly overlap again in the renderer from entry starts/durations.
    overlapStatus: 'not-projected'
  };
}

/**
 * Pure adapter from the backend's authority-safe read model into the renderer's visual model.
 * It never derives Eve durations, execution transitions or overlap.
 */
export function scheduleViewFromProjection(
  source: ScheduleReadProjection,
  mode: ScheduleViewMode = 'today',
  detailDate: string | null = null
): ScheduleViewData {
  const next7Days = source.days.map(day => resolvedDay(day, source));
  const detailDay = next7Days.find(day => day.dateKey === detailDate) ?? next7Days[0] ?? {
    dateKey: source.startDate,
    isToday: true,
    userAvailability: 'unknown' as const,
    entries: [],
    overlaps: []
  };
  return {
    activeMode: mode,
    detailDay,
    usualWeek: source.usualWeek.map(weeklyDay),
    next7Days,
    nextOverlap: source.nextOverlap ? {
      dateKey: source.nextOverlap.date,
      startMinute: source.nextOverlap.startMinute,
      endMinute: source.nextOverlap.endMinute,
      current: source.nextOverlap.current,
      isToday: source.nextOverlap.date === source.startDate,
      isTomorrow: source.days[1]?.date === source.nextOverlap.date
    } : null,
    overlapStatus: source.overlap.status,
    timeZoneLabel: source.timeZone
  };
}

function paint(): void {
  if (!projection) return;
  const host = document.getElementById('scheduleLibraryHost');
  if (!host) return;
  const view = scheduleViewFromProjection(projection, activeMode, selectedDate);
  const callbacks = {
    onModeChange(mode: ScheduleViewMode) {
      activeMode = mode;
      paint();
    },
    onSelectDay(dateKey: string) {
      selectedDate = dateKey;
      activeMode = 'today' as const;
      paint();
    },
    onEditSchedule(owner: 'user' | 'eve') { void showScheduleEditor({ owner }); },
    onChatAbout(reference: '#schedules' | '#myweek' | '#routines') {
      navigateWorkspace({ screen: 'chat' });
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
      if (!input) return;
      input.value = t('Chat about {0}', [t(reference)]);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.focus();
    }
  };
  if (controller) controller.update(view);
  else controller = createScheduleSurface({ host, view, ...callbacks });
}

export async function refreshScheduleSurface(): Promise<void> {
  const generation = ++refreshGeneration;
  const host = document.getElementById('scheduleLibraryHost');
  if (!host) return;
  if (!projection && !controller) host.replaceChildren(el('p', 'schedule-empty', () => t('Loading schedule…')));
  const next = await run(window.api.readScheduleProjection());
  if (!next || generation !== refreshGeneration) return;
  projection = next;
  if (selectedDate && !next.days.some(day => day.date === selectedDate)) selectedDate = null;
  paint();
}

export function initScheduleWorkspace(): void {
  if (initialized) return;
  initialized = true;
  onWorkspaceNavigation(state => {
    if (state.screen === 'schedule') void refreshScheduleSurface();
  });
  // Running/Done/Needs-you receipts are usually accompanied by session activity. Re-read the
  // backend projection while Schedule is visible; the read itself remains side-effect free.
  window.api.onSessionChanged(() => {
    if (currentWorkspaceNavigation()?.screen === 'schedule') void refreshScheduleSurface();
  });
  window.api.onScheduleChanged(() => {
    if (currentWorkspaceNavigation()?.screen === 'schedule') void refreshScheduleSurface();
  });
}
