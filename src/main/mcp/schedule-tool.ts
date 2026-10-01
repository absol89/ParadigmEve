import { z } from 'zod';
import {
  createEveCronEntry,
  eveCronWorkPayloadHash,
  readScheduleState,
  updateEveCronEntry
} from '../schedule.js';
import { completeEvecronRunFromSessionVerification } from '../evecron-runner.js';
import { readEvents } from '../session/store.js';
import {
  scheduleDurationMinutesSchema,
  scheduleTaskContextSchema,
  scheduleTriggerSchema,
  type FrozenScheduleWork,
  type ScheduleTaskContext
} from '../../shared/schedule.js';
import { currentCall, currentCaller } from './call-context.js';
import type { SessionEvent } from '../../shared/session.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const uuid = z.string().uuid();
const contextWithoutSourcesSchema = scheduleTaskContextSchema.omit({ sources: true });

export const scheduleToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    action: z.literal('create'),
    title: z.string().trim().min(1).max(160),
    duration_minutes: scheduleDurationMinutesSchema,
    trigger: scheduleTriggerSchema,
    task: z.string().trim().min(1).max(16_000),
    automation: z.enum(['off', 'goal', 'loop']).default('off'),
    objective: z.string().trim().min(1).max(16_000).optional(),
    project_id: uuid.optional(),
    context: contextWithoutSourcesSchema
  }).strict(),
  z.object({
    action: z.literal('update'),
    id: uuid,
    expected_updated_at: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(160).optional(),
    duration_minutes: scheduleDurationMinutesSchema.optional(),
    trigger: scheduleTriggerSchema.optional(),
    task: z.string().trim().min(1).max(16_000).optional(),
    automation: z.enum(['off', 'goal', 'loop']).optional(),
    objective: z.string().trim().min(1).max(16_000).nullable().optional(),
    project_id: uuid.nullable().optional(),
    context: contextWithoutSourcesSchema.optional()
  }).strict().refine(value => Object.keys(value).some(key => !['action', 'id', 'expected_updated_at'].includes(key)), 'Schedule update is empty'),
  z.object({
    action: z.literal('set_state'),
    id: uuid,
    expected_updated_at: z.number().int().nonnegative(),
    state: z.enum(['enabled', 'paused'])
  }).strict()
]);

const scheduleCompletePayloadSchema = z.object({
  verification_tool_call: z.string().regex(/^T[0-9A-Z]+$/i),
  result_tool_call: z.string().regex(/^T[0-9A-Z]+$/i).optional()
}).strict();

/** Small published envelope; detailed action payloads are validated again inside the handler. */
const schedulePublishedSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'set_state', 'complete']),
  payload: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((value, ctx) => {
  if (value.action === 'list' && value.payload !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['payload'], message: 'list takes no payload' });
  }
  if (value.action !== 'list' && value.payload === undefined) {
    ctx.addIssue({ code: 'custom', path: ['payload'], message: `${value.action} requires payload` });
  }
});

type CallerSource = ScheduleTaskContext['sources'][number];

async function callerSource(): Promise<{ requestId: string; source: CallerSource; authorizedAt: number } | null> {
  const caller = currentCaller();
  const call = currentCall();
  if (!caller.requestId || !caller.sessionId || !caller.conversationId || !call) return null;
  const events = await readEvents(caller.sessionId, { kinds: ['user_message'] }).catch(() => []);
  const latest = [...events].reverse()
    .filter((event): event is Extract<SessionEvent, { kind: 'user_message' }> => event.kind === 'user_message')
    .find(event => !!event.messageId);
  return {
    requestId: caller.requestId,
    authorizedAt: call.startedAt,
    source: {
      sessionId: caller.sessionId,
      conversationId: caller.conversationId,
      ...(latest?.messageId ? { messageIds: [latest.messageId] } : {})
    }
  };
}

function mergedSources(prior: readonly CallerSource[] | undefined, source: CallerSource): CallerSource[] {
  const rows = [...(prior ?? [])].map(row => ({ ...row, ...(row.messageIds ? { messageIds: [...row.messageIds] } : {}) }));
  const held = rows.find(row => row.sessionId === source.sessionId && row.conversationId === source.conversationId);
  if (held) {
    const messageIds = [...new Set([...(held.messageIds ?? []), ...(source.messageIds ?? [])])].slice(-32);
    if (messageIds.length) held.messageIds = messageIds;
  } else {
    rows.push(source);
  }
  // Keep the original source and the most recent distinct conversations inside the durable bound.
  return rows.length <= 16 ? rows : [rows[0]!, ...rows.slice(-15)];
}

function contextWithSource(
  raw: z.infer<typeof contextWithoutSourcesSchema>,
  source: CallerSource,
  prior: readonly CallerSource[] = []
): ScheduleTaskContext {
  return scheduleTaskContextSchema.parse({ ...raw, sources: mergedSources(prior, source) });
}

function executableWork(
  input: { task: string; automation: 'off' | 'goal' | 'loop'; objective?: string; projectId?: string; context: ScheduleTaskContext },
  authority: { requestId: string; source: CallerSource; authorizedAt: number }
): FrozenScheduleWork {
  const executable = {
    target: { kind: 'installation-agent' } as const,
    text: input.task,
    automation: input.automation,
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    context: input.context
  };
  return {
    ...executable,
    authority: {
      kind: 'chat-user',
      sessionId: authority.source.sessionId,
      conversationId: authority.source.conversationId,
      requestId: authority.requestId,
      authorizedAt: authority.authorizedAt,
      payloadHash: eveCronWorkPayloadHash(executable)
    }
  };
}

function view(entry: Awaited<ReturnType<typeof createEveCronEntry>>) {
  return {
    id: entry.id,
    title: entry.title,
    state: entry.state,
    durationMinutes: entry.durationMinutes ?? null,
    trigger: entry.trigger,
    task: entry.work.text,
    automation: entry.work.automation ?? 'off',
    objective: entry.work.objective ?? null,
    projectId: entry.work.projectId ?? null,
    context: entry.work.context ?? null,
    updatedAt: entry.updatedAt
  };
}

export function registerScheduleTool(reg: SurfaceRegistrar): void {
  if (!reg.sessionToolsExposed) return;
  reg.register('schedule', toolDeclaration('schedule', () => ({
    title: 'Eve schedules and routines',
    description:
      'Eve schedule lifecycle. list has no payload. create payload: title,duration_minutes,trigger,task,context. update: id,expected_updated_at plus changes. set_state: id,expected_updated_at,state. complete: verification_tool_call,result_tool_call?. Context keeps purpose/outcome/decisions/observations/constraints/format and optional instructionRefs/contextRefs; source chat ids are app-bound. % activates instructions; # is data-only.',
    inputSchema: schedulePublishedSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  })), input => guard('schedule', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings -> Chat');
    if (input.action === 'complete') {
      const parsed = scheduleCompletePayloadSchema.safeParse(input.payload);
      if (!parsed.success) return fail(`INVALID_SCHEDULE_COMPLETE: ${parsed.error.issues[0]?.message ?? 'invalid completion payload'}`);
      const caller = currentCaller();
      if (!caller.sessionId || !caller.conversationId) return fail('Exact scheduled session identity is required');
      const completed = await completeEvecronRunFromSessionVerification({
        sessionId: caller.sessionId,
        conversationId: caller.conversationId,
        verificationToolRef: parsed.data.verification_tool_call,
        ...(parsed.data.result_tool_call ? { resultToolRef: parsed.data.result_tool_call } : {})
      });
      return ok(JSON.stringify({ occurrenceId: completed.occurrence.id, status: completed.execution.status }));
    }
    const parsed = scheduleToolSchema.safeParse({ action: input.action, ...(input.payload ?? {}) });
    if (!parsed.success) return fail(`INVALID_SCHEDULE: ${parsed.error.issues[0]?.message ?? 'invalid schedule payload'}`);
    const args = parsed.data;
    if (args.action === 'list') {
      const state = await readScheduleState();
      return ok(JSON.stringify({ entries: state.entries.map(view) }));
    }
    const caller = await callerSource();
    if (!caller) return fail('Exact current chat identity is required to change schedules. Nothing was changed; retry after the Companion reconnects.');
    const now = caller.authorizedAt;

    if (args.action === 'create') {
      const context = contextWithSource(args.context, caller.source);
      const entry = await createEveCronEntry({
        title: args.title,
        state: 'enabled',
        durationMinutes: args.duration_minutes,
        trigger: args.trigger,
        exceptions: [],
        work: executableWork({
          task: args.task,
          automation: args.automation,
          ...(args.objective ? { objective: args.objective } : {}),
          ...(args.project_id ? { projectId: args.project_id } : {}),
          context
        }, caller)
      }, now);
      return ok(JSON.stringify({ created: view(entry) }));
    }

    const state = await readScheduleState();
    const current = state.entries.find(entry => entry.id === args.id);
    if (!current) return fail(`Schedule ${args.id} was not found. Nothing was changed.`);

    if (args.action === 'set_state') {
      const priorContext = current.work.context;
      const context = priorContext
        ? scheduleTaskContextSchema.parse({ ...priorContext, sources: mergedSources(priorContext.sources, caller.source) })
        : scheduleTaskContextSchema.parse({
          purpose: current.work.text,
          desiredOutcome: current.work.objective ?? current.work.text,
          sources: [caller.source]
        });
      const work = executableWork({
        task: current.work.text,
        automation: current.work.automation ?? 'off',
        ...(current.work.objective ? { objective: current.work.objective } : {}),
        ...(current.work.projectId ? { projectId: current.work.projectId } : {}),
        context
      }, caller);
      const updated = await updateEveCronEntry(args.id, { state: args.state, work }, args.expected_updated_at, now);
      return ok(JSON.stringify({ updated: view(updated) }));
    }

    const priorContext = current.work.context;
    const context = args.context
      ? contextWithSource(args.context, caller.source, priorContext?.sources)
      : priorContext
        ? scheduleTaskContextSchema.parse({ ...priorContext, sources: mergedSources(priorContext.sources, caller.source) })
        : scheduleTaskContextSchema.parse({
          purpose: current.work.text,
          desiredOutcome: current.work.objective ?? current.work.text,
          sources: [caller.source]
        });
    // Every conversational amendment is itself relevant provenance. Re-authorize the same work
    // even for a title/time-only edit so the context capsule gains this exact source conversation.
    const work = executableWork({
      task: args.task ?? current.work.text,
      automation: args.automation ?? current.work.automation ?? 'off',
      ...((args.objective === null ? undefined : args.objective ?? current.work.objective) ? { objective: args.objective ?? current.work.objective! } : {}),
      ...((args.project_id === null ? undefined : args.project_id ?? current.work.projectId) ? { projectId: args.project_id ?? current.work.projectId! } : {}),
      context
    }, caller);
    const updated = await updateEveCronEntry(args.id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.duration_minutes !== undefined ? { durationMinutes: args.duration_minutes } : {}),
      ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
      work
    }, args.expected_updated_at, now);
    return ok(JSON.stringify({ updated: view(updated) }));
  }));
}
