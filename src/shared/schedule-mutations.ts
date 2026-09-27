import { z } from 'zod';
import {
  scheduleDurationMinutesSchema,
  scheduleTriggerSchema,
  type ScheduleTrigger
} from './schedule.js';
import type {
  UserScheduleTemporaryChangeInput,
  UserWeeklyScheduleInput
} from './user-schedule.js';

const timestampSchema = z.number().int().nonnegative();
const uuidSchema = z.string().uuid();

export const eveCronUiWorkInputSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
  automation: z.enum(['off', 'goal', 'loop']).default('off'),
  objective: z.string().trim().min(1).max(16_000).nullable().optional(),
  projectId: uuidSchema.nullable().optional()
}).strict();

export const eveCronUiCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  durationMinutes: scheduleDurationMinutesSchema,
  trigger: scheduleTriggerSchema,
  work: eveCronUiWorkInputSchema
}).strict();

export const eveCronUiUpdateRequestSchema = z.object({
  id: uuidSchema,
  expectedUpdatedAt: timestampSchema,
  patch: z.object({
    title: z.string().trim().min(1).max(160).optional(),
    durationMinutes: scheduleDurationMinutesSchema.optional(),
    trigger: scheduleTriggerSchema.optional(),
    work: eveCronUiWorkInputSchema.optional()
  }).strict().refine(value => Object.keys(value).length > 0, 'Schedule update is empty')
}).strict();

export const eveCronUiStateRequestSchema = z.object({
  id: uuidSchema,
  state: z.enum(['enabled', 'paused']),
  expectedUpdatedAt: timestampSchema
}).strict();

export const userScheduleReplaceRequestSchema = z.object({
  schedule: z.unknown(),
  expectedUpdatedAt: timestampSchema.nullable()
}).strict();

export type EveCronUiWorkInput = z.infer<typeof eveCronUiWorkInputSchema>;
export type EveCronUiCreateRequest = z.infer<typeof eveCronUiCreateRequestSchema>;
export type EveCronUiUpdateRequest = z.infer<typeof eveCronUiUpdateRequestSchema>;
export type EveCronUiStateRequest = z.infer<typeof eveCronUiStateRequestSchema>;

export interface EveCronEditableEntry {
  id: string;
  title: string;
  state: 'enabled' | 'paused';
  durationMinutes?: number;
  trigger: ScheduleTrigger;
  work: EveCronUiWorkInput;
  updatedAt: number;
}

export interface UserScheduleEditableRecord {
  version: 1;
  baseline: UserWeeklyScheduleInput;
  changes: UserScheduleTemporaryChangeInput[];
  updatedAt: number;
}

export interface UserScheduleEditableInput {
  baseline: UserWeeklyScheduleInput;
  changes?: readonly UserScheduleTemporaryChangeInput[];
}
