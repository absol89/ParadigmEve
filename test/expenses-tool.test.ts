import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { authoredPinsReferences } from '../src/shared/pins-intent.js';
import { registerExpensesTool, expensesReadToolSchema, expensesToolSchema } from '../src/main/mcp/expenses-tool.js';
import type { SurfaceRegistrar, ToolResult } from '../src/main/mcp/kernel.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';

const mock = vi.hoisted(() => ({
  config: { capabilities: { read: true, create: true, edit: true, deleteFile: true }, readOnly: false },
  session: { conversationId: 'chat', projectId: 'project', origin: null as null | { kind: string } },
  messages: [{ kind: 'user_message', seq: 2, origin: 2, messageId: 'message', time: 2, message: { text: '%expenses Coffee 42 SEK' } }] as any[],
  resolve: vi.fn(), dataProject: vi.fn(), canonical: vi.fn(), assign: vi.fn(), workspace: vi.fn(), record: vi.fn(), correct: vi.fn(), deleteRetained: vi.fn(), read: vi.fn(), readAsset: vi.fn(), readAttachment: vi.fn(), worker: false, blocked: false,
  sharedOwner: null as string | null
}));
vi.mock('../src/main/mcp/kernel.js', () => ({
  guard: async (_name: string, fn: () => Promise<unknown>) => fn(),
  ok: (text: string) => ({ content: [{ type: 'text', text }] }),
  fail: (text: string) => ({ content: [{ type: 'text', text }], isError: true })
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => mock.config, effectiveCapabilities: (config: typeof mock.config) => ({ ...config.capabilities, edit: config.capabilities.edit && !config.readOnly, create: config.capabilities.create && !config.readOnly }) }));
vi.mock('../src/main/bridge.js', () => ({ goalWorkerChat: () => mock.worker }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: () => mock.blocked }));
vi.mock('../src/main/session/continuation.js', () => ({ compactingConversation: () => null }));
vi.mock('../src/main/session/store.js', () => ({
  getSession: async () => ({ ...mock.session }),
  readEvents: async () => [...mock.messages],
  readAsset: (...args: unknown[]) => mock.readAsset(...args)
}));
vi.mock('../src/main/session/input-attachments.js', () => ({
  ATTACHMENT_CHUNK_BYTES: 512 * 1024,
  readInputAttachmentChunk: (...args: unknown[]) => mock.readAttachment(...args)
}));
vi.mock('../src/main/projects.js', () => ({
  assignSessionProject: (...args: unknown[]) => mock.assign(...args),
  getProject: async (id: string) => id === 'project' ? { id, template: { id: 'expenses' } } : { id },
  projectWorkspace: (...args: unknown[]) => mock.workspace(...args)
}));
vi.mock('../src/main/expenses-project.js', () => ({
  resolveExpensesProject: (...args: unknown[]) => mock.resolve(...args),
  hasExpensesDataReference: (text: string) => authoredPinsReferences(text).some(row => row.reference.toLowerCase() === '#expenses'),
  resolveExpensesDataProject: (...args: unknown[]) => mock.dataProject(...args),
  resolveCanonicalExpensesProject: (...args: unknown[]) => mock.canonical(...args)
}));
vi.mock('../src/main/eve-access.js', () => ({ sharedEveOwnerForCurrentCall: () => mock.sharedOwner }));
vi.mock('../src/main/expenses-ledger.js', () => ({
  readExpensesLedger: (...args: unknown[]) => mock.read(...args),
  recordExpense: (...args: unknown[]) => mock.record(...args),
  correctExpense: (...args: unknown[]) => mock.correct(...args),
  deleteRetainedExpenseReceipt: (...args: unknown[]) => mock.deleteRetained(...args)
}));

const facts = { purchasedOn: null, merchant: 'Cafe', location: null, currency: 'SEK', total: '42', items: [], notes: null };
const retention = { status: 'not-retained', localPath: null, userChoiceMessageId: null };
const recordId = '11111111-1111-4111-8111-111111111111';
const context = (): CallContext => ({ startedAt: 100, transportKey: null, agent: null, caller: { transportKey: null, requestId: 'request', sessionId: 'session', conversationId: 'chat' }, outcome: null, evidence: emptyEvidence() });
let run: (args: unknown, ctx?: CallContext) => Promise<ToolResult>;
beforeEach(() => {
  vi.clearAllMocks();
  mock.config = { capabilities: { read: true, create: true, edit: true, deleteFile: true }, readOnly: false };
  mock.session = { conversationId: 'chat', projectId: 'project', origin: null };
  mock.messages = [{ kind: 'user_message', seq: 2, origin: 2, messageId: 'message', time: 2, message: { text: '%expenses Coffee 42 SEK' } }];
  mock.worker = false; mock.blocked = false;
  mock.sharedOwner = null;
  mock.dataProject.mockResolvedValue({ id: 'project' });
  mock.resolve.mockResolvedValue({ id: 'project' });
  mock.canonical.mockResolvedValue({ id: 'project' });
  mock.assign.mockImplementation(async (_sessionId: string, projectId: string) => { mock.session.projectId = projectId; });
  mock.workspace.mockResolvedValue({ real: '/approved/Expenses', virtual: '/projects/Expenses' });
  mock.readAsset.mockResolvedValue(null);
  mock.readAttachment.mockRejectedValue(new Error('No staged bytes'));
  mock.record.mockImplementation(async (_folder, _input, authorize) => { await authorize(); return { revision: 1, duplicate: false, record: { id: recordId }, warnings: [] }; });
  mock.correct.mockImplementation(async (_folder, _input, authorize) => { await authorize(); return { revision: 2, record: { id: recordId } }; });
  mock.deleteRetained.mockImplementation(async (_folder, _input, authorize) => { await authorize(); return { revision: 2, recordId, deleted: true, outcome: 'deleted' }; });
  mock.read.mockResolvedValue({ version: 1, revision: 0, records: [], corrections: [] });
  const handlers = new Map<string, (args: unknown, ctx?: CallContext) => Promise<ToolResult>>();
  registerExpensesTool({ caps: mock.config.capabilities, exposedCaps: mock.config.capabilities,
    register: (name: string, config: { inputSchema: z.ZodType }, handler: (args: any) => Promise<ToolResult>) => {
      handlers.set(name, (args, ctx = context()) => runInCallContext(ctx, () => handler(config.inputSchema.parse(args))));
    }
  } as unknown as SurfaceRegistrar);
  run = (args: any, ctx) => handlers.get(args.action === 'read' || args.action === 'summary' ? 'expenses_read' : 'expenses')!(args, ctx);
});
const record = () => run({ action: 'record', expectedRevision: 0, facts });
const message = (result: ToolResult) => result.content.map(part => part.type === 'text' ? part.text : '').join('');
const remoteContext = (): CallContext => {
  const ctx = context();
  ctx.caller.sessionId = null;
  ctx.caller.conversationId = null;
  return ctx;
};

it('derives expense source and native Thread selection from exact canonical caller history', async () => {
  mock.session.projectId = undefined as any;
  mock.messages.push({ ...mock.messages[0], seq: 9, origin: 1, messageId: 'older-revised', message: { text: '%other' } });
  expect((await record()).isError).not.toBe(true);
  expect(mock.resolve).toHaveBeenCalledWith('%expenses Coffee 42 SEK', null);
  expect(mock.assign).toHaveBeenCalledWith('session', 'project');
  expect(mock.record.mock.calls[0]![1].draft.source).toEqual({ sessionId: 'session', conversationId: 'chat', messageId: 'message', sourceIndex: 0, kind: 'text', sha256: null });
});

it('keeps an explicitly resolved %expenses project bound for later messages without a selector', async () => {
  mock.session.projectId = undefined as any;
  expect((await record()).isError).not.toBe(true);
  expect(mock.assign).toHaveBeenCalledWith('session', 'project');

  mock.resolve.mockClear();
  mock.messages = [{ kind: 'user_message', seq: 3, origin: 3, messageId: 'receipt', time: 3, message: { text: 'Here is the receipt photo.' } }];
  expect((await run({ action: 'read' })).isError).not.toBe(true);
  expect(mock.resolve).toHaveBeenCalledWith('Here is the receipt photo.', 'project');
  expect(mock.assign).toHaveBeenCalledTimes(1);
});

it('resolves a read-only %expenses query without binding the session even with writes disabled', async () => {
  mock.session.projectId = undefined as any;
  mock.config.readOnly = true;
  expect((await run({ action: 'read' })).isError).not.toBe(true);
  expect(mock.assign).not.toHaveBeenCalled();
  expect(mock.record).not.toHaveBeenCalled();
});

it('does not borrow shared authority when a real Quilt shadows #expenses', async () => {
  mock.session.projectId = undefined as any;
  mock.messages[0].message.text = '#expenses summarize this month';
  mock.resolve.mockResolvedValue(null);
  mock.dataProject.mockResolvedValue(null);
  mock.sharedOwner = 'prime-chat';
  expect((await run({ action: 'read' })).isError).toBe(true);
  expect((await record()).isError).toBe(true);
  expect(mock.canonical).not.toHaveBeenCalled();
  expect(mock.assign).not.toHaveBeenCalled();
});

it('uses the canonical Expenses project from a normal local chat without replacing its other project binding', async () => {
  mock.session.projectId = 'other';
  mock.messages = [{ kind: 'user_message', seq: 3, origin: 3, messageId: 'receipt', time: 3, message: { text: 'Here is a receipt.' } }];
  mock.resolve.mockResolvedValue(null);
  mock.sharedOwner = 'prime-chat';

  expect((await record()).isError).not.toBe(true);
  expect(mock.canonical).toHaveBeenCalled();
  expect(mock.assign).not.toHaveBeenCalled();
  expect(mock.record.mock.calls[0]![1].draft.source).toMatchObject({
    sessionId: 'session', conversationId: 'chat', messageId: 'receipt'
  });
});

it('reads and records from a cross-device connector call with honest request provenance', async () => {
  mock.sharedOwner = 'prime-chat';
  const remote = remoteContext();
  expect((await run({ action: 'read' }, remote)).isError).not.toBe(true);
  expect(mock.canonical).toHaveBeenCalled();

  expect((await run({ action: 'record', expectedRevision: 0, sourceKind: 'image', sourceIndex: 1, facts }, remote)).isError).not.toBe(true);
  expect(mock.record.mock.calls[0]![1].draft.source).toEqual({
    origin: 'connector', kind: 'image', requestId: 'request', sourceIndex: 1, sha256: null
  });
  expect(JSON.parse(message(await run({ action: 'read' }, remote))).project).toBe('/projects/Expenses');
});

it('keeps cross-device correction provenance separate from local session ids', async () => {
  mock.sharedOwner = 'prime-chat';
  const remote = remoteContext();
  expect((await run({ action: 'correct', expectedRevision: 1, recordId, facts, retention, reason: 'Phone correction' }, remote)).isError).not.toBe(true);
  expect(mock.correct.mock.calls[0]![1]).toMatchObject({
    sourceRequestId: 'request',
    actor: { kind: 'connector', requestId: 'request' }
  });
});

it('restores strict local-only Expenses behavior when cross-chat Eve access is disabled', async () => {
  const result = await run({ action: 'read' }, remoteContext());
  expect(result.isError).toBe(true);
  expect(message(result)).toMatch(/other ChatGPT chats and devices/i);
  expect(mock.canonical).not.toHaveBeenCalled();
});

it('derives and validates two-image source identity from the canonical user message', async () => {
  const first = { id: '11111111-1111-4111-8111-111111111111', name: 'first.png', size: 5, mimeType: 'image/png' };
  const second = { id: '22222222-2222-4222-8222-222222222222', name: 'second.png', size: 6, mimeType: 'image/png' };
  mock.messages = [{ ...mock.messages[0], inputId: 'app-input', attachments: [first, second] }];
  mock.readAttachment.mockImplementation(async (attachment: typeof first) => Buffer.from(attachment === first ? 'first' : 'second').toString('base64'));
  expect((await run({ action: 'record', expectedRevision: 0, sourceIndex: 1, facts })).isError).not.toBe(true);
  expect(mock.record.mock.calls[0]![1].draft.source).toEqual({
    sessionId: 'session', conversationId: 'chat', messageId: 'message', sourceIndex: 1, kind: 'image',
    sha256: createHash('sha256').update('second').digest('hex')
  });
  expect((await run({ action: 'record', expectedRevision: 0, sourceIndex: 2, facts })).isError).toBe(true);
  expect(mock.record).toHaveBeenCalledTimes(1);
});

it('leaves a native ChatGPT image hash null when Eve does not own its bytes', async () => {
  const native = { id: 'provider-image', name: 'receipt.png', size: 123, mimeType: 'image/png' };
  mock.messages = [{ ...mock.messages[0], attachments: [native] }];
  expect((await record()).isError).not.toBe(true);
  expect(mock.record.mock.calls[0]![1].draft.source).toMatchObject({ kind: 'image', sourceIndex: 0, sha256: null });
  expect(mock.readAttachment).not.toHaveBeenCalled();
});

it('falls back to a null hash when previously staged image bytes are unavailable', async () => {
  const staged = { id: '33333333-3333-4333-8333-333333333333', name: 'receipt.png', size: 123, mimeType: 'image/png' };
  mock.messages = [{ ...mock.messages[0], inputId: 'app-input', attachments: [staged] }];
  expect((await record()).isError).not.toBe(true);
  expect(mock.readAttachment).toHaveBeenCalledTimes(1);
  expect(mock.record.mock.calls[0]![1].draft.source).toMatchObject({ kind: 'image', sourceIndex: 0, sha256: null });
});

it('derives the same exact digest from app-owned canonical image bytes across messages', async () => {
  const raw = Buffer.from('trusted-image-bytes');
  mock.readAsset.mockResolvedValue(raw);
  const asset = { id: 'abcdef0123456789abcdef0123456789.bin', mimeType: 'image/webp', bytes: raw.length };
  mock.messages = [{ ...mock.messages[0], assets: [asset] }];
  expect((await record()).isError).not.toBe(true);
  const first = mock.record.mock.calls[0]![1].draft.source;
  mock.messages = [{ ...mock.messages[0], seq: 3, origin: 3, messageId: 'second-message', assets: [asset] }];
  expect((await record()).isError).not.toBe(true);
  const second = mock.record.mock.calls[1]![1].draft.source;
  const expected = createHash('sha256').update(raw).digest('hex');
  expect(first).toMatchObject({ messageId: 'message', kind: 'image', sha256: expected });
  expect(second).toMatchObject({ messageId: 'second-message', kind: 'image', sha256: expected });
});

it('refuses unknown identity, workers, helpers and replaced callers before persistence', async () => {
  const unproven = context(); unproven.caller.requestId = null;
  expect((await run({ action: 'read' }, unproven)).isError).toBe(true);
  mock.worker = true; expect((await record()).isError).toBe(true);
  mock.worker = false; mock.session.origin = { kind: 'helper' }; expect((await record()).isError).toBe(true);
  mock.session.origin = null; mock.session.conversationId = 'replacement'; expect((await record()).isError).toBe(true);
  expect(mock.record).not.toHaveBeenCalled();
});

it('refuses a missing project instead of selecting a folder', async () => {
  mock.resolve.mockResolvedValue(null);
  expect((await record()).isError).toBe(true);
  expect(mock.workspace).not.toHaveBeenCalled();
});

it.each(['permission', 'project', 'message', 'conversation', 'blocked'])('revalidates %s after asynchronous ledger work', async change => {
  mock.record.mockImplementation(async (_folder, _input, authorize) => {
    if (change === 'permission') mock.config.readOnly = true;
    if (change === 'project') mock.session.projectId = 'other';
    if (change === 'message') mock.messages.push({ ...mock.messages[0], seq: 3, origin: 3, messageId: 'newer' });
    if (change === 'conversation') mock.session.conversationId = 'replacement';
    if (change === 'blocked') mock.blocked = true;
    await authorize();
    throw new Error('publication should be unreachable');
  });
  expect((await record()).isError).toBe(true);
});

it('records structured correction provenance without model-owned caller ids', async () => {
  expect((await run({ action: 'correct', expectedRevision: 1, recordId, facts, retention, reason: 'User corrected total' })).isError).not.toBe(true);
  expect(mock.correct.mock.calls[0]![1]).toMatchObject({ actor: { sessionId: 'session', conversationId: 'chat' }, sourceMessageId: 'message', expectedRevision: 1 });
  expect(expensesToolSchema.safeParse({ action: 'read', sessionId: 'foreign' }).success).toBe(false);
  expect(expensesReadToolSchema.safeParse({ action: 'read' }).success).toBe(true);
  expect(expensesToolSchema.safeParse({ action: 'record', expectedRevision: 0, kind: 'image', facts }).success).toBe(false);
  expect(expensesToolSchema.safeParse({ action: 'record', expectedRevision: 0, image: 'data:image/png;base64,AA', facts }).success).toBe(false);
  expect(expensesToolSchema.safeParse({ action: 'record', expectedRevision: 0, sha256: 'a'.repeat(64), facts }).success).toBe(false);
  expect(expensesToolSchema.safeParse({ action: 'record', expectedRevision: 0, facts: {
    ...facts, defaultBudgetBucket: 'groceries', items: [{ id: 'snack', rawName: 'Snack', normalizedName: null, category: null,
      quantity: null, amount: '42', budgetBucket: 'fun', warranty: { candidate: false, reason: null } }]
  } }).success).toBe(true);
});

it('lets a #expenses chat read without binding and bind on its first write, without the Thread prompt', async () => {
  mock.session.projectId = undefined as any;
  mock.messages = [{ kind: 'user_message', seq: 2, origin: 2, messageId: 'message', time: 2, message: { text: '#expenses summarize this month' } }];
  mock.resolve.mockResolvedValue(null);
  mock.canonical.mockResolvedValue({ id: 'project' });
  const data = await run({ action: 'read' });
  expect(data.isError).not.toBe(true);
  expect(JSON.parse(message(data)).instructions).toContain('Ledger data only');
  expect(mock.assign).not.toHaveBeenCalled();
  expect(mock.record).not.toHaveBeenCalled();

  // Discussion turned into a write request: the same chat records without restarting as %expenses.
  mock.messages = [{ kind: 'user_message', seq: 3, origin: 3, messageId: 'write', time: 3, message: { text: '#expenses add the coffee, 42 SEK' } }];
  mock.resolve.mockImplementation(async (_text: string, bound?: string | null) => bound === 'project' ? { id: 'project' } : null);
  const written = await run({ action: 'record', expectedRevision: 0, facts });
  expect(written.isError).not.toBe(true);
  expect(mock.assign).toHaveBeenCalledWith('session', 'project');
  expect(mock.record).toHaveBeenCalledTimes(1);
});

it('never rebinds a chat already bound to another project when #expenses writes', async () => {
  mock.session.projectId = 'other-project';
  mock.messages = [{ kind: 'user_message', seq: 2, origin: 2, messageId: 'message', time: 2, message: { text: '#expenses add the coffee, 42 SEK' } }];
  mock.resolve.mockResolvedValue(null);
  expect((await record()).isError).not.toBe(true);
  expect(mock.assign).not.toHaveBeenCalled();
});

it('routes retained receipt deletion through the audited mutation with canonical caller provenance', async () => {
  const result = JSON.parse(message(await run({ action: 'delete_retained_receipt', expectedRevision: 1, recordId, status: 'declined', reason: 'User said delete it' })));
  expect(result.result).toEqual({ revision: 2, recordId, deleted: true, outcome: 'deleted' });
  expect(mock.deleteRetained.mock.calls[0]![1]).toMatchObject({
    expectedRevision: 1, recordId, status: 'declined', reason: 'User said delete it',
    sourceMessageId: 'message', actor: { sessionId: 'session', conversationId: 'chat' }
  });
});

it('requires live delete-file permission before retained receipt deletion', async () => {
  mock.config.capabilities.deleteFile = false;
  const result = await run({ action: 'delete_retained_receipt', expectedRevision: 1, recordId, reason: 'Delete it' });
  expect(result.isError).toBe(true);
  expect(mock.deleteRetained).not.toHaveBeenCalled();
});

it('bounds detail reads and preserves explicit pagination for long receipts', async () => {
  const items = Array.from({ length: 70 }, (_, index) => ({ id: String(index), rawName: 'Item' }));
  mock.read.mockResolvedValue({ revision: 1, records: [{ id: recordId, facts: { ...facts, items } }] });
  const result = JSON.parse(message(await run({ action: 'read', recordId, offset: 25, limit: 25 })));
  expect(result.result.record.facts.items).toHaveLength(25);
  expect(result.result.itemCount).toBe(70);
  expect(result.result.nextOffset).toBe(50);
});

it('refuses truncated or excessive selector history', async () => {
  mock.messages[0].message.truncated = true;
  expect((await record()).isError).toBe(true);
  mock.messages = Array.from({ length: 5001 }, (_, seq) => ({ kind: 'user_message', seq, messageId: String(seq), time: seq, message: { text: '%expenses' } }));
  expect((await record()).isError).toBe(true);
  expect(mock.record).not.toHaveBeenCalled();
});
