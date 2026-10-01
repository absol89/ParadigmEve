import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { eveCronWorkPayloadHash, readScheduleState, resetScheduleForTests } from '../src/main/schedule.js';
import type { SurfaceRegistrar, ToolResult } from '../src/main/mcp/kernel.js';

const fixture = vi.hoisted(() => ({
  caller: {
    requestId: 'wfr_schedule_create_1',
    sessionId: '2026-10-01-source-a',
    conversationId: 'conversation-source-a'
  } as { requestId: string | null; sessionId: string | null; conversationId: string | null },
  startedAt: Date.parse('2026-10-01T18:00:00.000Z'),
  events: [{ kind: 'user_message', messageId: 'message-source-a' }] as any[],
  completed: [] as any[]
}));

const NOW = Date.parse('2026-10-01T18:00:00.000Z');

vi.mock('../src/main/mcp/call-context.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/mcp/call-context.js')>()),
  currentCaller: () => fixture.caller,
  currentCall: () => ({ startedAt: fixture.startedAt }) as any
}));

vi.mock('../src/main/session/store.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/session/store.js')>()),
  readEvents: async () => [...fixture.events]
}));

vi.mock('../src/main/evecron-runner.js', () => ({
  completeEvecronRunFromSessionVerification: async (input: any) => {
    fixture.completed.push(input);
    return { occurrence: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, execution: { status: 'completed' } };
  }
}));

const { registerScheduleTool, scheduleToolSchema } = await import('../src/main/mcp/schedule-tool.js');

let directory = '';
let run: (args: unknown) => Promise<ToolResult>;

const text = (result: ToolResult) => result.content.map(part => part.type === 'text' ? part.text : '').join('');

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-schedule-tool-'));
  resetDurableForTests();
  resetScheduleForTests();
  initDurableStore(directory);
  fixture.caller = { requestId: 'wfr_schedule_create_1', sessionId: '2026-10-01-source-a', conversationId: 'conversation-source-a' };
  fixture.startedAt = NOW;
  fixture.events = [{ kind: 'user_message', messageId: 'message-source-a' }];
  fixture.completed = [];
  registerScheduleTool({
    sessionToolsExposed: true,
    sessionToolsLive: true,
    register: (_name: string, config: { inputSchema: z.ZodType }, handler: (args: any) => Promise<ToolResult>) => {
      run = args => handler(config.inputSchema.parse(args));
    },
    featureDisabled: () => ({ isError: true, content: [{ type: 'text', text: 'disabled' }] })
  } as unknown as SurfaceRegistrar);
});

afterEach(async () => {
  resetScheduleForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('model-facing schedule tool', () => {
  it('binds creation to the exact source conversation and preserves that context across later amendments', async () => {
    const createdResult = await run({
      action: 'create',
      payload: {
        title: 'ICA morning brief',
        duration_minutes: 20,
        trigger: { kind: 'once', localDate: '2026-10-02', localTime: '08:00', timeZone: 'Europe/Stockholm' },
        task: 'Prepare the already-agreed shopping brief.',
        context: {
          purpose: 'Compare the stores using the prices discussed in this conversation.',
          desiredOutcome: 'A short today-only brief that notices if the shopping already happened.',
          constraints: ['Do not file an expense merely because #expenses is present.'],
          requestedFormat: 'Wedding-invitation visual card.',
          instructionRefs: ['%morningbrief'],
          contextRefs: ['#expenses']
        }
      }
    });
    expect(createdResult.isError).not.toBe(true);
    const created = JSON.parse(text(createdResult)).created;
    const stored = (await readScheduleState()).entries[0]!;
    expect(stored.work.context?.sources).toEqual([{
      sessionId: '2026-10-01-source-a',
      conversationId: 'conversation-source-a',
      messageIds: ['message-source-a']
    }]);
    expect(stored.work.authority).toMatchObject({
      kind: 'chat-user', requestId: 'wfr_schedule_create_1', sessionId: '2026-10-01-source-a', conversationId: 'conversation-source-a'
    });
    expect(stored.work.authority.payloadHash).toBe(eveCronWorkPayloadHash(stored.work));

    fixture.caller = { requestId: 'wfr_schedule_update_2', sessionId: '2026-10-01-source-b', conversationId: 'conversation-source-b' };
    fixture.startedAt = NOW + 1_000;
    fixture.events = [{ kind: 'user_message', messageId: 'message-source-b' }];
    const updatedResult = await run({
      action: 'update',
      payload: {
        id: created.id,
        expected_updated_at: created.updatedAt,
        trigger: { kind: 'once', localDate: '2026-10-03', localTime: '08:00', timeZone: 'Europe/Stockholm' }
      }
    });
    expect(updatedResult.isError).not.toBe(true);
    const updated = (await readScheduleState()).entries[0]!;
    expect(updated.work.context?.purpose).toContain('Compare the stores');
    expect(updated.work.context?.sources).toEqual([
      { sessionId: '2026-10-01-source-a', conversationId: 'conversation-source-a', messageIds: ['message-source-a'] },
      { sessionId: '2026-10-01-source-b', conversationId: 'conversation-source-b', messageIds: ['message-source-b'] }
    ]);
    expect(updated.work.authority).toMatchObject({ kind: 'chat-user', requestId: 'wfr_schedule_update_2' });
    expect(updated.work.authority.payloadHash).toBe(eveCronWorkPayloadHash(updated.work));
  });

  it('fails closed when the mutation call lacks exact request/session/conversation identity', async () => {
    fixture.caller = { requestId: null, sessionId: null, conversationId: null };
    const result = await run({
      action: 'create',
      payload: {
        title: 'Unsafe reminder',
        duration_minutes: 10,
        trigger: { kind: 'once', localDate: '2026-10-02', localTime: '09:00', timeZone: 'Europe/Stockholm' },
        task: 'Do something later.',
        context: { purpose: 'Remember why.', desiredOutcome: 'Do it.', instructionRefs: [], contextRefs: [] }
      }
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/exact current chat identity/i);
    expect((await readScheduleState()).entries).toHaveLength(0);
  });

  it('keeps conversational pause/resume source provenance with the schedule context', async () => {
    const createdResult = await run({
      action: 'create',
      payload: {
        title: 'Recurring brief',
        duration_minutes: 15,
        trigger: { kind: 'weekly', weekdays: [1], localTime: '08:00', timeZone: 'Europe/Stockholm' },
        task: 'Prepare the recurring brief.',
        context: { purpose: 'Keep the Monday brief useful.', desiredOutcome: 'One brief each Monday.' }
      }
    });
    const created = JSON.parse(text(createdResult)).created;
    fixture.caller = { requestId: 'wfr_schedule_pause_2', sessionId: '2026-10-01-pause', conversationId: 'conversation-pause' };
    fixture.startedAt = NOW + 2_000;
    fixture.events = [{ kind: 'user_message', messageId: 'message-pause' }];
    const pausedResult = await run({ action: 'set_state', payload: { id: created.id, expected_updated_at: created.updatedAt, state: 'paused' } });
    expect(pausedResult.isError).not.toBe(true);
    const paused = (await readScheduleState()).entries[0]!;
    expect(paused.state).toBe('paused');
    expect(paused.work.context?.sources).toContainEqual({
      sessionId: '2026-10-01-pause', conversationId: 'conversation-pause', messageIds: ['message-pause']
    });
    expect(paused.work.authority).toMatchObject({ kind: 'chat-user', requestId: 'wfr_schedule_pause_2' });
    expect(paused.work.authority.payloadHash).toBe(eveCronWorkPayloadHash(paused.work));
  });

  it('compacts repeated amendments from one conversation into message history instead of source-row growth', async () => {
    const createdResult = await run({
      action: 'create', payload: {
        title: 'Long-lived routine', duration_minutes: 10,
        trigger: { kind: 'weekly', weekdays: [2], localTime: '08:00', timeZone: 'Europe/Stockholm' },
        task: 'Prepare the routine.', context: { purpose: 'Keep this routine current.', desiredOutcome: 'Useful recurring output.' }
      }
    });
    const created = JSON.parse(text(createdResult)).created;
    fixture.caller = { requestId: 'wfr_schedule_same_chat_2', sessionId: '2026-10-01-source-a', conversationId: 'conversation-source-a' };
    fixture.startedAt = NOW + 3_000;
    fixture.events = [{ kind: 'user_message', messageId: 'message-source-a-2' }];
    await run({ action: 'update', payload: { id: created.id, expected_updated_at: created.updatedAt, title: 'Long-lived routine revised' } });
    const updated = (await readScheduleState()).entries[0]!;
    expect(updated.work.context?.sources).toEqual([{
      sessionId: '2026-10-01-source-a',
      conversationId: 'conversation-source-a',
      messageIds: ['message-source-a', 'message-source-a-2']
    }]);
  });

  it('keeps the model schema strict and never accepts model-supplied source identity', () => {
    expect(scheduleToolSchema.safeParse({
      action: 'create', title: 'x', duration_minutes: 10,
      trigger: { kind: 'once', localDate: '2026-10-02', localTime: '09:00', timeZone: 'Europe/Stockholm' },
      task: 'x', context: { purpose: 'p', desiredOutcome: 'o', sources: [{ sessionId: 'fake', conversationId: 'fake' }] }
    }).success).toBe(false);
  });

  it('completes the exact scheduled chat through the unified lifecycle action', async () => {
    const result = await run({
      action: 'complete',
      payload: { verification_tool_call: 'T2F', result_tool_call: 'T2E' }
    });
    expect(result.isError).not.toBe(true);
    expect(fixture.completed).toEqual([{
      sessionId: '2026-10-01-source-a',
      conversationId: 'conversation-source-a',
      verificationToolRef: 'T2F',
      resultToolRef: 'T2E'
    }]);
    expect(JSON.parse(text(result))).toEqual({ occurrenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completed' });
  });
});
