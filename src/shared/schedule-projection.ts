import type { EvecronExecutionStatus, EvecronReceiptKind } from './evecron-execution.js';
import type {
  IsoWeekday,
  ResolvedUserScheduleSnapshot
} from './user-schedule.js';

export type ScheduleProjectionEveStatus = EvecronExecutionStatus | 'scheduled';

export interface ScheduleProjectionReceipt {
  id: string;
  kind: EvecronReceiptKind;
  at: number;
  label: string;
  detail?: string;
  action?: { kind: 'result' | 'plan'; targetId: string };
}

/** Renderer-safe Eve row. No work payload, input id, authority hash or receipt capability crosses it. */
export interface ScheduleProjectionEveItem {
  occurrenceId: string;
  entryId: string;
  entryVersion: number;
  title: string;
  date: string;
  startMinute: number;
  /** Null is an explicit fail-closed legacy/unknown duration, never an estimate. */
  durationMinutes?: number | null;
  /** Local-day display bound when duration is known; 1440 means the busy window crosses midnight. */
  endMinute?: number | null;
  status: ScheduleProjectionEveStatus;
  temporary: boolean;
  receipts: ScheduleProjectionReceipt[];
}

export interface ScheduleProjectionDay {
  date: string;
  weekday: IsoWeekday;
  user: {
    source: 'weekly' | 'temporary' | 'unknown';
    temporaryChange: boolean;
    usual: ResolvedUserScheduleSnapshot;
    effective: ResolvedUserScheduleSnapshot;
  };
  eve: ScheduleProjectionEveItem[];
}

export interface ScheduleProjectionWeeklyEveItem {
  entryId: string;
  title: string;
  weekday: IsoWeekday;
  localTime: string;
  timeZone: string;
  durationMinutes?: number | null;
  state: 'enabled' | 'paused';
}

export interface ScheduleProjectionOverlapWindow {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  current: boolean;
}

export type ScheduleProjectionOverlap =
  | { status: 'resolved'; windows: ScheduleProjectionOverlapWindow[] }
  | { status: 'unresolved-eve-duration'; windows: [] };

export interface ScheduleProjectionWeeklyDay {
  weekday: IsoWeekday;
  user: ResolvedUserScheduleSnapshot;
  eve: ScheduleProjectionWeeklyEveItem[];
}

export interface ScheduleReadProjection {
  timeZone: string;
  startDate: string;
  userScheduleUpdatedAt: number | null;
  days: ScheduleProjectionDay[];
  usualWeek: ScheduleProjectionWeeklyDay[];
  /** Missing Eve duration anywhere relevant keeps this fail-closed; no prose/history inference. */
  overlap: ScheduleProjectionOverlap;
  nextOverlap: ScheduleProjectionOverlapWindow | null;
}
