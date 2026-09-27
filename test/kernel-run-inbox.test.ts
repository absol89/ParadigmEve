import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const broker = vi.hoisted(() => ({
  offer: vi.fn(), ack: vi.fn(), bareOffer: vi.fn(), bareAck: vi.fn(), release: vi.fn(), alive: vi.fn(), record: vi.fn(), archive: vi.fn(),
  awaitOrigin: vi.fn(), archiveAuthority: false
}));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  agentForCaller: () => 'worker-1', agentForFinishCaller: () => 'worker-1',
  offerMessagesForConversation: broker.offer, acknowledgeOffersForConversation: broker.ack,
  offerMessages: broker.bareOffer, acknowledgeOffers: broker.bareAck,
  currentRunId: (conversationId?: string) => conversationId ? `run-${conversationId}` : null,
  releaseQuiescentRun: broker.release,
  noteAgentAlive: broker.alive
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  awaitFreshCallOrigin: broker.awaitOrigin,
  recordToolCall: async () => null, recordAgentMessage: broker.record
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({ offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => undefined, TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n' }));
vi.mock('../src/main/plans.js', () => ({ archiveWorkerPlansForDeliveredReport: broker.archive }));
vi.mock('../src/main/config.js', async (original) => {
  const actual = await original<typeof import('../src/main/config.js')>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.defaultConfig(),
      eveAuthority: { ...actual.defaultConfig().eveAuthority, archiveCompletedWork: broker.archiveAuthority }
    })
  };
});
import { createRegistrar, dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';
beforeEach(() => {
  vi.clearAllMocks();
  broker.alive.mockReturnValue(null);
  broker.awaitOrigin.mockImplementation(async (_tool: string, _at: number, _waitMs: number, options?: { requestId?: string | null }) =>
    options?.requestId?.startsWith('late-') ? options.requestId.slice(5) : null);
  broker.offer.mockImplementation((conversationId) => conversationId ? { agentId: 'worker-1', messages: [{ id: `m-${conversationId}`, from: 'prime', text: `private-${conversationId}`, offers: 1 }] } : null);
  broker.ack.mockReturnValue(null);
  broker.bareOffer.mockReturnValue([{ id: 'foreign', from: 'prime', text: 'foreign-private', offers: 1 }]);
  broker.archiveAuthority = false;
});
it('records same-named worker liveness reports under the exact author conversation', async () => {
  broker.alive.mockImplementation((conversationId) => ({ report: { id: `report-${conversationId}`, from: 'worker-1', to: 'prime', text: 'active again' } }));
  const call = handler();
  await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-a' }), 'sent', 'chat-a');
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-b' }), 'sent', 'chat-b');
});
function handler() {
  let call!: (args: object) => Promise<{ content: Array<{ text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'test real dispatch', inputSchema: z.object({}) }, async () => ok('result'));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
it('routes identical friendly workers through their exact conversation inbox and run cleanup', async () => {
  const call = handler();
  const [a, b] = await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(JSON.stringify(a)).toContain('private-chat-a'); expect(JSON.stringify(a)).not.toContain('private-chat-b');
  expect(JSON.stringify(b)).toContain('private-chat-b'); expect(JSON.stringify(b)).not.toContain('private-chat-a');
  expect(JSON.stringify(a)).toContain('• prime: private-chat-a');
  expect(JSON.stringify(a)).not.toContain('m-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-b');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
});
it('does not fall back to a friendly-id inbox when exact conversation ownership abstains', async () => {
  const result = await handler()(null);
  expect(JSON.stringify(result)).not.toContain('foreign-private');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('waits for exact request-id proof before a Pins mutation but keeps Pins listing non-blocking', async () => {
  let mutationCaller: string | null | undefined;
  const mutated = await dispatch('pins', { action: 'pin' }, null, 'late-chat-pins', 'core', async () => {
    mutationCaller = currentCall()?.caller.conversationId;
    return ok('mutated');
  });
  expect(mutated.isError).not.toBe(true);
  expect(mutationCaller).toBe('chat-pins');
  expect(broker.awaitOrigin).toHaveBeenCalledTimes(1);

  broker.awaitOrigin.mockClear();
  let listCaller: string | null | undefined;
  const listed = await dispatch('pins', { action: 'list', reference: '%architecture' }, null, 'late-chat-list', 'core', async () => {
    listCaller = currentCall()?.caller.conversationId;
    return ok('listed');
  });
  expect(listed.isError).not.toBe(true);
  expect(listCaller).toBeNull();
  expect(broker.awaitOrigin).not.toHaveBeenCalled();
});

it('offers and acknowledges the worker inbox only on the outer call, outside nested filtering', async () => {
  const registrar = createRegistrar(null, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok('private tool value'));
  const result = await dispatch('exec', {}, null, 'req-chat-a', 'core', async () => {
    const parent = currentCall()!;
    const children = await Promise.all([registrar.invokeNested('read', {}, parent), registrar.invokeNested('read', {}, parent)]);
    expect(children).toEqual([ok('private tool value'), ok('private tool value')]);
    expect(broker.offer).not.toHaveBeenCalled();
    expect(broker.ack).not.toHaveBeenCalled();
    return ok('filtered');
  });
  expect(broker.offer).toHaveBeenCalledTimes(1);
  expect(broker.ack).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).toContain('private-chat-a');
  expect(JSON.stringify(result)).not.toContain('private tool value');
});

it('auto-archives only after a finish report is acknowledged as delivered to Prime', async () => {
  broker.archiveAuthority = true;
  const finishReport = {
    id: 'finish-report-1', from: 'worker-1', to: 'prime', time: 10, text: '[worker-1 reported] done',
    offeredAt: 11, offers: 1, offeredOnFinish: false, offeredViaRevival: false, ackedAt: 12, finishReport: true
  };
  broker.ack.mockReturnValueOnce({ agentId: 'prime', messages: [finishReport] });
  await handler()('req-chat-a');
  expect(broker.record).toHaveBeenCalledWith(finishReport, 'delivered', 'chat-a');
  expect(broker.archive).toHaveBeenCalledExactlyOnceWith('finish-report-1');

  broker.archive.mockClear();
  broker.ack.mockReturnValueOnce({ agentId: 'prime', messages: [{ ...finishReport, id: 'ordinary-1', finishReport: false }] });
  await handler()('req-chat-a');
  expect(broker.archive).not.toHaveBeenCalled();
});
