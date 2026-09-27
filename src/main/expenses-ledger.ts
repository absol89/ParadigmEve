import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rawPromises as fs } from './rawfs.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { isContained, resolvePath } from './sandbox.js';
import {
  correctExpenseRequestSchema, deleteRetainedExpenseReceiptRequestSchema, emptyExpensesLedger, expenseLedgerSchema,
  expenseSourceKey, recordExpenseRequestSchema,
  type ExpenseLedger, type ExpenseRecord
} from '../shared/expenses.js';

export const EXPENSES_LEDGER_RELATIVE_PATH = 'data/ledger.json';
export const MAX_EXPENSES_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_RECEIPT_BYTES = 20 * 1024 * 1024;
type Authorize = () => void | Promise<void>;
type Rollback = () => Promise<void>;
const queues = new Map<string, Promise<unknown>>();
function check(mode: 'read' | 'create' | 'edit') {
  const caps = effectiveCapabilities(getConfig());
  if (!caps.read || (mode !== 'read' && !caps[mode])) throw new Error('Expenses permission denied');
}
function checkReceiptDelete() {
  const caps = effectiveCapabilities(getConfig());
  if (!caps.read || !caps.edit || !caps.deleteFile) throw new Error('Expenses retained receipt deletion permission denied');
}
async function target(folder: string, mode: 'read' | 'create' | 'edit') {
  check(mode);
  const project = await resolvePath(getConfig().roots, folder);
  if (!(await fs.stat(project.real)).isDirectory()) throw new Error('Expenses project must be a folder');
  const file = await resolvePath(getConfig().roots, project.virtual + '/' + EXPENSES_LEDGER_RELATIVE_PATH, { allowMissing: true });
  if (!isContained(project.real, file.real)) throw new Error('Expenses ledger escapes project');
  check(mode);
  return { project, file };
}
async function bytes(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_EXPENSES_LEDGER_BYTES) throw new Error('Expenses ledger is not a bounded file');
    const buffer = Buffer.alloc(MAX_EXPENSES_LEDGER_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_EXPENSES_LEDGER_BYTES) throw new Error('Expenses ledger is too large');
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}
function parse(raw: string | null): ExpenseLedger {
  if (raw === null) throw new Error('Expenses ledger is missing; initialize this project first');
  try { return expenseLedgerSchema.parse(JSON.parse(raw)); }
  catch { throw new Error('Expenses ledger is corrupt or unsupported; existing data was preserved'); }
}
async function serial<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const { file } = await target(folder, 'read');
  const key = process.platform === 'win32' ? file.real.toLowerCase() : file.real;
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(run);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
async function retainedReceiptTarget(folder: string, row: ExpenseRecord) {
  const expectedHash = row.source.sha256 ?? row.retention.sha256;
  if (row.source.kind !== 'image' || !expectedHash) throw new Error('Retained receipt needs an exact image source hash');
  if (row.source.sha256 && row.retention.sha256 && row.source.sha256 !== row.retention.sha256) throw new Error('Retained receipt hash conflicts with source');
  const { project } = await target(folder, 'read');
  const receipts = await resolvePath(getConfig().roots, project.virtual + '/receipts');
  const retained = await resolvePath(getConfig().roots, row.retention.localPath!, { base: project.virtual, allowMissing: true });
  if (!isContained(project.real, receipts.real) || !isContained(receipts.real, retained.real) || receipts.real === retained.real) throw new Error('Retained receipt must stay inside project receipts folder');
  return { expectedHash, retained };
}
async function readRetainedReceipt(real: string, expectedHash: string): Promise<{ outcome: 'present'; bytes: Buffer } | { outcome: 'missing-file' | 'changed-file' }> {
  let handle;
  try { handle = await fs.open(real, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'missing-file' };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RETAINED_RECEIPT_BYTES) return { outcome: 'changed-file' };
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > MAX_RETAINED_RECEIPT_BYTES) return { outcome: 'changed-file' };
      const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
      chunks.push(chunk);
      hash.update(chunk);
    }
    if (hash.digest('hex') !== expectedHash) return { outcome: 'changed-file' };
    return { outcome: 'present', bytes: Buffer.concat(chunks, total) };
  } finally { await handle.close(); }
}
async function validateRetention(folder: string, row: ExpenseRecord) {
  if (row.retention.status !== 'retained') return;
  const { expectedHash, retained } = await retainedReceiptTarget(folder, row);
  const receipt = await readRetainedReceipt(retained.real, expectedHash);
  if (receipt.outcome === 'missing-file') throw new Error('Retained receipt is missing');
  if (receipt.outcome === 'changed-file') throw new Error('Retained receipt does not match exact source hash');
  const current = await resolvePath(getConfig().roots, retained.virtual);
  if (current.real !== retained.real) throw new Error('Retained receipt path changed');
  check('read');
}
async function publish(folder: string, original: string | null, next: ExpenseLedger, authorize?: Authorize, beforeCommit?: () => Promise<Rollback | void>) {
  expenseLedgerSchema.parse(next);
  const raw = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(raw) > MAX_EXPENSES_LEDGER_BYTES) throw new Error('Expenses ledger capacity reached');
  const mode = original === null ? 'create' : 'edit';
  const { file } = await target(folder, mode);
  const temporary = file.real + '.' + randomUUID() + '.tmp';
  // Exclusive staging plus compare-before-publish preserves concurrent external edits.
  // This is an app-level atomic replacement, not a hostile-local-process filesystem lock.
  await fs.writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' });
  try {
    const current = await target(folder, mode);
    if (current.file.real !== file.real || await bytes(file.real) !== original) throw new Error('Expenses ledger changed; read the current revision');
    await authorize?.();
    check(mode);
    const final = await target(folder, mode);
    if (final.file.real !== file.real) throw new Error('Expenses project changed');
    for (const row of next.records) await validateRetention(folder, row);
    await authorize?.();
    check(mode);
    if (await bytes(file.real) !== original) throw new Error('Expenses ledger changed; read the current revision');
    check(mode);
    let rollback: Rollback | undefined;
    try {
      rollback = (await beforeCommit?.()) || undefined;
      if (rollback) {
        const finalAfterSideEffect = await target(folder, mode);
        if (finalAfterSideEffect.file.real !== file.real || await bytes(file.real) !== original) throw new Error('Expenses ledger changed; read the current revision');
        check(mode);
      }
      if (original === null) {
        // link refuses an existing destination; initialization never overwrites a ledger.
        await fs.link(temporary, file.real);
      } else await fs.rename(temporary, file.real);
    } catch (error) {
      if (rollback) {
        try { await rollback(); }
        catch { throw new Error('Expenses ledger was preserved, but the retained receipt could not be restored after publication failed'); }
      }
      throw error;
    }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
export async function readExpensesLedger(folder: string, authorize?: Authorize): Promise<ExpenseLedger> {
  const { file } = await target(folder, 'read');
  const result = parse(await bytes(file.real));
  const current = await target(folder, 'read');
  if (current.file.real !== file.real) throw new Error('Expenses project changed');
  await authorize?.();
  check('read');
  return result;
}
export async function initializeExpensesLedger(folder: string, authorize?: Authorize): Promise<ExpenseLedger> {
  return serial(folder, async () => {
    const { file } = await target(folder, 'create');
    if (await bytes(file.real) !== null) throw new Error('Expenses ledger already exists');
    await authorize?.();
    check('create');
    await fs.mkdir(path.dirname(file.real), { recursive: true });
    const ledger = emptyExpensesLedger();
    await publish(folder, null, ledger, authorize);
    return ledger;
  });
}
export async function recordExpense(folder: string, input: unknown, authorize?: Authorize) {
  const request = recordExpenseRequestSchema.parse(input);
  if ('origin' in request.draft.source) {
    if (request.draft.retention.userChoiceMessageId !== null) {
      throw new Error('Connector expense retention must not invent a local user message id');
    }
    if (request.draft.retention.userChoiceRequestId != null &&
        request.draft.retention.userChoiceRequestId !== request.draft.source.requestId) {
      throw new Error('Receipt retention choice must name the connector request');
    }
    if (request.draft.retention.status !== 'not-retained' && request.draft.retention.status !== 'retained' &&
        request.draft.retention.userChoiceRequestId !== request.draft.source.requestId) {
      throw new Error('Receipt retention choice must name the connector request');
    }
  } else {
    if (request.draft.retention.userChoiceRequestId != null) {
      throw new Error('Local expense retention must not invent a connector request id');
    }
    if (request.draft.retention.status !== 'not-retained' && request.draft.retention.status !== 'retained' &&
        request.draft.retention.userChoiceMessageId !== request.draft.source.messageId) {
      throw new Error('Receipt retention choice must name the source user message');
    }
    if (request.draft.retention.status === 'retained' && request.draft.retention.userChoiceMessageId !== null &&
        request.draft.retention.userChoiceMessageId !== request.draft.source.messageId) {
      throw new Error('Receipt retention choice must name the source user message');
    }
  }
  return serial(folder, async () => {
    const { file } = await target(folder, 'read');
    const original = await bytes(file.real);
    const ledger = parse(original);
    const key = expenseSourceKey(request.draft.source);
    const duplicate = ledger.records.find(row => expenseSourceKey(row.source) === key ||
      (request.draft.source.sha256 !== null && row.source.sha256 === request.draft.source.sha256));
    if (duplicate) {
      await authorize?.(); check('read');
      return { revision: ledger.revision, duplicate: true, record: duplicate, warnings: [] as string[] };
    }
    if (ledger.revision !== request.expectedRevision) throw new Error('Expenses revision conflict; read the current revision');
    const now = Date.now();
    const record: ExpenseRecord = { ...request.draft, id: randomUUID(), createdAt: now, updatedAt: now };
    const similar = ledger.records.filter(row => row.facts.purchasedOn !== null && row.facts.merchant !== null &&
      row.facts.total !== null && row.facts.currency !== null && row.facts.purchasedOn === record.facts.purchasedOn &&
      row.facts.merchant === record.facts.merchant && row.facts.total === record.facts.total && row.facts.currency === record.facts.currency);
    ledger.records.push(record);
    ledger.revision++;
    await publish(folder, original, ledger, authorize);
    return { revision: ledger.revision, duplicate: false, record,
      warnings: similar.map(row => 'Possible similar expense: ' + row.id + '; both records kept') };
  });
}
export async function correctExpense(folder: string, input: unknown, authorize?: Authorize) {
  const request = correctExpenseRequestSchema.parse(input);
  return serial(folder, async () => {
    const { file } = await target(folder, 'edit');
    const original = await bytes(file.real);
    const ledger = parse(original);
    if (ledger.revision !== request.expectedRevision) throw new Error('Expenses revision conflict; read the current revision');
    const record = ledger.records.find(row => row.id === request.recordId);
    if (!record) throw new Error('Expense record not found');
    const retentionChanged = JSON.stringify(record.retention) !== JSON.stringify(request.retention);
    if (record.retention.status === 'retained' && retentionChanged) {
      throw new Error('Retained receipt metadata cannot be changed through a generic correction; use the retained receipt deletion action');
    }
    if ('sourceRequestId' in request) {
      if (retentionChanged && request.retention.userChoiceMessageId !== null) {
        throw new Error('Connector expense corrections must not invent a local user message id');
      }
      if (retentionChanged && request.retention.status !== 'not-retained' &&
          !(request.retention.status === 'retained' && request.retention.userChoiceRequestId == null) &&
          request.retention.userChoiceRequestId !== request.sourceRequestId &&
          request.retention.userChoiceRequestId !== record.retention.userChoiceRequestId) {
        throw new Error('Receipt retention choice must name the current or previously recorded connector request');
      }
    } else if (retentionChanged && request.retention.status !== 'not-retained' &&
        !(request.retention.status === 'retained' && request.retention.userChoiceMessageId === null) &&
        request.retention.userChoiceMessageId !== request.sourceMessageId &&
        request.retention.userChoiceMessageId !== record.retention.userChoiceMessageId) {
      throw new Error('Receipt retention choice must name the current or previously recorded user choice');
    }
    const before = { facts: record.facts, retention: record.retention };
    const after = { facts: request.facts, retention: request.retention };
    const at = Math.max(Date.now(), record.updatedAt);
    ledger.revision++;
    ledger.corrections.push('sourceRequestId' in request
      ? { id: randomUUID(), recordId: record.id, revision: ledger.revision, at,
          sourceRequestId: request.sourceRequestId, actor: request.actor, reason: request.reason, before, after }
      : { id: randomUUID(), recordId: record.id, revision: ledger.revision, at,
          sourceMessageId: request.sourceMessageId, actor: request.actor, reason: request.reason, before, after });
    record.facts = after.facts;
    record.retention = after.retention;
    record.updatedAt = at;
    await publish(folder, original, ledger, authorize);
    return { revision: ledger.revision, record };
  });
}

class RetainedReceiptChanged extends Error {
  constructor(readonly outcome: 'missing-file' | 'changed-file') { super(outcome); }
}

export async function deleteRetainedExpenseReceipt(folder: string, input: unknown, authorize?: Authorize) {
  const request = deleteRetainedExpenseReceiptRequestSchema.parse(input);
  return serial(folder, async () => {
    checkReceiptDelete();
    const { file } = await target(folder, 'edit');
    const original = await bytes(file.real);
    const ledger = parse(original);
    if (ledger.revision !== request.expectedRevision) throw new Error('Expenses revision conflict; read the current revision');
    const record = ledger.records.find(row => row.id === request.recordId);
    if (!record) throw new Error('Expense record not found');
    if (record.retention.status !== 'retained') {
      return { revision: ledger.revision, recordId: record.id, deleted: false as const, outcome: 'not-retained' as const };
    }

    const targetReceipt = await retainedReceiptTarget(folder, record);
    const initial = await readRetainedReceipt(targetReceipt.retained.real, targetReceipt.expectedHash);
    if (initial.outcome !== 'present') {
      return { revision: ledger.revision, recordId: record.id, deleted: false as const, outcome: initial.outcome };
    }
    await authorize?.();
    checkReceiptDelete();

    const before = { facts: record.facts, retention: record.retention };
    const originalUpdatedAt = record.updatedAt;
    const after = { facts: record.facts, retention: 'sourceRequestId' in request ? {
      status: request.status, localPath: null, sha256: null, userChoiceMessageId: null, userChoiceRequestId: request.sourceRequestId
    } : {
      status: request.status, localPath: null, sha256: null, userChoiceMessageId: request.sourceMessageId
    } };
    const at = Math.max(Date.now(), record.updatedAt);
    ledger.revision++;
    ledger.corrections.push('sourceRequestId' in request
      ? { id: randomUUID(), recordId: record.id, revision: ledger.revision, at,
          sourceRequestId: request.sourceRequestId, actor: request.actor, reason: request.reason, before, after }
      : { id: randomUUID(), recordId: record.id, revision: ledger.revision, at,
          sourceMessageId: request.sourceMessageId, actor: request.actor, reason: request.reason, before, after });
    record.retention = after.retention;
    record.updatedAt = at;

    try {
      await publish(folder, original, ledger, authorize, async () => {
        const latest = await readRetainedReceipt(targetReceipt.retained.real, targetReceipt.expectedHash);
        if (latest.outcome !== 'present') throw new RetainedReceiptChanged(latest.outcome);
        checkReceiptDelete();
        try { await fs.unlink(targetReceipt.retained.real); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RetainedReceiptChanged('missing-file');
          throw error;
        }
        const restore = async () => {
          await fs.writeFile(targetReceipt.retained.real, latest.bytes, { flag: 'wx' });
          const restored = await readRetainedReceipt(targetReceipt.retained.real, targetReceipt.expectedHash);
          if (restored.outcome !== 'present') throw new Error('Retained receipt rollback verification failed');
        };
        try { await authorize?.(); checkReceiptDelete(); }
        catch (error) { await restore(); throw error; }
        return restore;
      });
    } catch (error) {
      if (error instanceof RetainedReceiptChanged) {
        record.retention = before.retention;
        record.updatedAt = originalUpdatedAt;
        return { revision: request.expectedRevision, recordId: record.id, deleted: false as const, outcome: error.outcome };
      }
      throw error;
    }
    return { revision: ledger.revision, recordId: record.id, deleted: true as const, outcome: 'deleted' as const };
  });
}
