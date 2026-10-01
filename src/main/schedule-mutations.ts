import { randomUUID } from 'node:crypto';
import {
  createEveCronEntry,
  eveCronWorkPayloadHash,
  readScheduleState,
  updateEveCronEntry
} from './schedule.js';
import {
  eveCronUiCreateRequestSchema,
  eveCronUiStateRequestSchema,
  eveCronUiUpdateRequestSchema,
  type EveCronEditableEntry,
  type EveCronUiWorkInput
} from '../shared/schedule-mutations.js';
import type { FrozenScheduleWork } from '../shared/schedule.js';

function editableWork(work: FrozenScheduleWork): EveCronUiWorkInput {
  return {
    text: work.text,
    automation: work.automation ?? 'off',
    ...(work.objective ? { objective: work.objective } : {}),
    ...(work.projectId ? { projectId: work.projectId } : {}),
    ...(work.context ? { context: work.context } : {})
  };
}

function editableEntry(entry: Awaited<ReturnType<typeof createEveCronEntry>>): EveCronEditableEntry {
  return {
    id: entry.id,
    title: entry.title,
    state: entry.state,
    ...(entry.durationMinutes === undefined ? {} : { durationMinutes: entry.durationMinutes }),
    trigger: entry.trigger,
    work: editableWork(entry.work),
    updatedAt: entry.updatedAt
  };
}

function authorizedUiWork(input: EveCronUiWorkInput, now: number): FrozenScheduleWork {
  const executable = {
    target: { kind: 'installation-agent' } as const,
    text: input.text,
    automation: input.automation,
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.context ? { context: input.context } : {})
  };
  return {
    ...executable,
    authority: {
      kind: 'ui-user',
      changeId: randomUUID(),
      authorizedAt: now,
      payloadHash: eveCronWorkPayloadHash(executable)
    }
  };
}

export async function listEditableEveCronEntries(): Promise<EveCronEditableEntry[]> {
  const state = await readScheduleState();
  return state.entries.map(editableEntry);
}

export async function createEveCronFromUi(raw: unknown, now = Date.now()): Promise<EveCronEditableEntry> {
  const request = eveCronUiCreateRequestSchema.parse(raw);
  const entry = await createEveCronEntry({
    title: request.title,
    state: 'enabled',
    durationMinutes: request.durationMinutes,
    trigger: request.trigger,
    exceptions: [],
    work: authorizedUiWork(request.work, now)
  }, now);
  return editableEntry(entry);
}

export async function updateEveCronFromUi(raw: unknown, now = Date.now()): Promise<EveCronEditableEntry> {
  const request = eveCronUiUpdateRequestSchema.parse(raw);
  const entry = await updateEveCronEntry(request.id, {
    ...(request.patch.title !== undefined ? { title: request.patch.title } : {}),
    ...(request.patch.durationMinutes !== undefined ? { durationMinutes: request.patch.durationMinutes } : {}),
    ...(request.patch.trigger !== undefined ? { trigger: request.patch.trigger } : {}),
    ...(request.patch.work !== undefined ? { work: authorizedUiWork(request.patch.work, now) } : {})
  }, request.expectedUpdatedAt, now);
  return editableEntry(entry);
}

export async function setEveCronStateFromUi(raw: unknown, now = Date.now()): Promise<EveCronEditableEntry> {
  const request = eveCronUiStateRequestSchema.parse(raw);
  const entry = await updateEveCronEntry(request.id, { state: request.state }, request.expectedUpdatedAt, now);
  return editableEntry(entry);
}
