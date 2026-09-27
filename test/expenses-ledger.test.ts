import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { correctExpense, deleteRetainedExpenseReceipt, initializeExpensesLedger, readExpensesLedger, recordExpense } from '../src/main/expenses-ledger.js';
import { deriveExpenseSummary, emptyExpensesLedger, expenseDraftSchema } from '../src/shared/expenses.js';

let directory: string, approved: string;
const folder = '/work/project';
function draft(messageId = 'message-1', total = '0.1') {
  return expenseDraftSchema.parse({
    source: { kind: 'text', sessionId: 'session', conversationId: 'conversation', messageId, sourceIndex: 0, sha256: null },
    facts: { purchasedOn: '2026-09-14', merchant: 'Shop', location: null, currency: 'SEK', total,
      items: [{ id: 'one', rawName: 'KETTLE', normalizedName: 'Kettle', category: 'Appliances', quantity: '1', amount: total,
        warranty: { candidate: true, reason: 'Durable appliance' } }], notes: null }
  });
}
async function retained(messageId = 'keep-receipt', contents = 'receipt-bytes') {
  const receipt = path.join(approved, 'project', 'receipts', `${messageId}.png`);
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  await fs.writeFile(receipt, contents);
  const image = draft(messageId, '499');
  image.source.kind = 'image';
  image.source.sha256 = createHash('sha256').update(contents).digest('hex');
  image.retention = { status: 'retained', localPath: `receipts/${messageId}.png`, sha256: image.source.sha256, userChoiceMessageId: messageId };
  const saved = await recordExpense(folder, { expectedRevision: 0, draft: image });
  return { receipt, image, saved };
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-expenses-'));
  approved = await validateNewRoot(directory, []);
  await fs.mkdir(path.join(approved, 'project'));
  initConfigPath(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  await initializeExpensesLedger(folder);
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('persists exact decimals, separates currencies and leaves unknown facts unknown', async () => {
  await recordExpense(folder, { expectedRevision: 0, draft: draft() });
  await recordExpense(folder, { expectedRevision: 1, draft: draft('second', '0.2') });
  const usd = draft('third', '8.9999'); usd.facts.currency = 'USD';
  await recordExpense(folder, { expectedRevision: 2, draft: usd });
  const unknown = draft('fourth'); unknown.facts.currency = null; unknown.facts.total = null;
  await recordExpense(folder, { expectedRevision: 3, draft: unknown });
  const ledger = await readExpensesLedger(folder);
  expect(deriveExpenseSummary(ledger)).toMatchObject({ incompleteRecords: 1, totals: [{ currency: 'SEK', total: '0.3' }, { currency: 'USD', total: '8.9999' }] });
  expect(ledger.records[0]!.facts.defaultBudgetBucket).toBeNull();
  expect(ledger.records[0]!.facts.items[0]!.budgetBucket).toBeNull();
  expect(ledger.records[0]!.retention.status).toBe('not-retained');
  expect(await fs.readdir(path.join(approved, 'project'))).toEqual(['data']);
});
it('serializes stale writers and deduplicates exact sources without merging similar purchases', async () => {
  const firstDraft = draft();
  const otherDraft = draft('other');
  const results = await Promise.allSettled([
    recordExpense(folder, { expectedRevision: 0, draft: firstDraft }),
    recordExpense(folder, { expectedRevision: 0, draft: otherDraft })
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const winner = results[0]!.status === 'fulfilled' ? firstDraft : otherDraft;
  const lostResponseRetry = await recordExpense(folder, { expectedRevision: 0, draft: winner });
  expect(lostResponseRetry).toMatchObject({ revision: 1, duplicate: true });
  expect((await readExpensesLedger(folder)).records).toHaveLength(1);
  const similar = await recordExpense(folder, { expectedRevision: 1, draft: draft('similar') });
  expect(similar.duplicate).toBe(false); expect(similar.warnings).toHaveLength(1);
  const textWithHash = draft('text-hash'); textWithHash.source.sha256 = 'a'.repeat(64);
  await expect(recordExpense(folder, { expectedRevision: 2, draft: textWithHash })).rejects.toThrow(/Text expense sources/);
  const hashed = draft('hash-one'); hashed.source.kind = 'image'; hashed.source.sha256 = 'a'.repeat(64);
  await recordExpense(folder, { expectedRevision: 2, draft: hashed });
  if ('messageId' in hashed.source) hashed.source.messageId = 'hash-two';
  expect(await recordExpense(folder, { expectedRevision: 2, draft: hashed })).toMatchObject({ revision: 3, duplicate: true });
  expect((await readExpensesLedger(folder)).records).toHaveLength(3);
});

it('deduplicates a retried connector source by request id and source index', async () => {
  const remote = draft('unused');
  remote.source = { origin: 'connector', kind: 'image', requestId: 'wfr_phone_receipt', sourceIndex: 1, sha256: null };
  const first = await recordExpense(folder, { expectedRevision: 0, draft: remote });
  expect(first.duplicate).toBe(false);
  const retry = await recordExpense(folder, { expectedRevision: 0, draft: remote });
  expect(retry).toMatchObject({ duplicate: true, revision: 1, record: { id: first.record.id } });
  expect((await readExpensesLedger(folder)).records).toHaveLength(1);
});
it('audits corrections and rejects source rewrites, invalid dates, decimal numbers and corrupt storage', async () => {
  const first = await recordExpense(folder, { expectedRevision: 0, draft: draft() });
  const facts = { ...first.record.facts, total: '12.99' };
  const correction = { expectedRevision: 1, recordId: first.record.id, facts, retention: first.record.retention,
    sourceMessageId: 'correction-message', actor: { sessionId: 'session', conversationId: 'conversation' }, reason: 'User clarified total' };
  await expect(correctExpense(folder, { ...correction, source: draft().source })).rejects.toThrow();
  await correctExpense(folder, correction);
  const ledger = await readExpensesLedger(folder);
  expect(ledger.records[0]!.source).toEqual(first.record.source);
  expect(ledger.corrections[0]!.before.facts.total).toBe('0.1');
  expect(ledger.corrections[0]!.after.facts.total).toBe('12.99');
  await expect(recordExpense(folder, { expectedRevision: 2, draft: { ...draft('invalid'), facts: { ...facts, purchasedOn: '2026-02-30' } } })).rejects.toThrow();
  await expect(recordExpense(folder, { expectedRevision: 2, draft: { ...draft('invalid'), facts: { ...facts, total: 1.1 } } })).rejects.toThrow();
  const file = path.join(approved, 'project', 'data', 'ledger.json');
  await fs.writeFile(file, '{broken');
  await expect(recordExpense(folder, { expectedRevision: 2, draft: draft('invalid') })).rejects.toThrow(/corrupt/);
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  await expect(initializeExpensesLedger(folder)).rejects.toThrow(/exists/);
});
it('keeps budget allocation separate from receipt provenance and audits item-level moves', async () => {
  const grocery = draft('mixed-grocery', '620');
  grocery.facts.merchant = 'Grocery Store';
  grocery.facts.location = 'Haninge';
  grocery.facts.items = [
    { ...grocery.facts.items[0]!, id: 'food', rawName: 'MILK', normalizedName: 'Milk', category: 'Groceries', amount: '20', warranty: { candidate: false, reason: null } },
    { ...grocery.facts.items[0]!, id: 'tool', rawName: 'HAMMER', normalizedName: 'Hammer', category: 'Tools', amount: '600', warranty: { candidate: true, reason: 'Durable tool' } }
  ];
  const first = await recordExpense(folder, { expectedRevision: 0, draft: grocery });
  expect(first.record.facts.items.map(item => item.budgetBucket)).toEqual([null, null]);

  const facts = {
    ...first.record.facts,
    items: first.record.facts.items.map(item => item.id === 'tool' ? { ...item, budgetBucket: 'fun' } : item)
  };
  await correctExpense(folder, { expectedRevision: 1, recordId: first.record.id, facts, retention: first.record.retention,
    sourceMessageId: 'move-tool-to-fun', actor: { sessionId: 'session', conversationId: 'conversation' }, reason: 'User allocated the non-essential tool to the monthly Fun budget' });
  const ledger = await readExpensesLedger(folder);
  expect(ledger.records[0]!.facts).toMatchObject({ merchant: 'Grocery Store', location: 'Haninge' });
  expect(ledger.records[0]!.facts.items.map(item => [item.id, item.category, item.budgetBucket])).toEqual([
    ['food', 'Groceries', null], ['tool', 'Tools', 'fun']
  ]);
  expect(ledger.corrections[0]!.before.facts.items.find(item => item.id === 'tool')?.budgetBucket).toBeNull();
  expect(ledger.corrections[0]!.after.facts.items.find(item => item.id === 'tool')?.budgetBucket).toBe('fun');
});
it('enforces read-only, root revocation and actor revocation at publication without losing newer bytes', async () => {
  await saveConfig({ ...getConfig(), readOnly: true });
  await expect(recordExpense(folder, { expectedRevision: 0, draft: draft() })).rejects.toThrow(/permission/);
  await saveConfig({ ...getConfig(), readOnly: false });
  await expect(recordExpense(folder, { expectedRevision: 0, draft: draft() }, () => { throw new Error('Actor revoked'); })).rejects.toThrow(/Actor revoked/);
  expect((await readExpensesLedger(folder)).revision).toBe(0);
  const file = path.join(approved, 'project', 'data', 'ledger.json');
  let changed = false;
  await expect(recordExpense(folder, { expectedRevision: 0, draft: draft() }, async () => {
    if (!changed) { changed = true; await fs.writeFile(file, 'external edit'); }
  })).rejects.toThrow(/changed/);
  expect(await fs.readFile(file, 'utf8')).toBe('external edit');
  await saveConfig({ ...getConfig(), roots: [] });
  await expect(readExpensesLedger(folder)).rejects.toThrow();
});
it('retains exact image copies inside project receipts for either a per-receipt choice or durable-item policy', async () => {
  const image = draft('keep-it');
  image.source.kind = 'image';
  image.source.sha256 = createHash('sha256').update('raw-source').digest('hex');
  image.retention = { status: 'retained', localPath: 'receipts/raw.png', sha256: null, userChoiceMessageId: 'keep-it' };
  await fs.mkdir(path.join(approved, 'project', 'receipts'));
  await fs.writeFile(path.join(approved, 'project', 'receipts', 'raw.png'), 'wrong');
  await expect(recordExpense(folder, { expectedRevision: 0, draft: image })).rejects.toThrow(/hash/);
  await fs.writeFile(path.join(approved, 'project', 'receipts', 'raw.png'), 'raw-source');
  expect(await recordExpense(folder, { expectedRevision: 0, draft: { ...image, retention: { ...image.retention, userChoiceMessageId: null } } }))
    .toMatchObject({ revision: 1, record: { retention: { status: 'retained', userChoiceMessageId: null } } });
  await initializeExpensesLedger(folder).catch(() => {});
  const ledgerFile = path.join(approved, 'project', 'data', 'ledger.json');
  await fs.writeFile(ledgerFile, JSON.stringify(emptyExpensesLedger(), null, 2) + '\n');
  await fs.writeFile(path.join(approved, 'outside.png'), 'raw-source');
  await expect(recordExpense(folder, { expectedRevision: 0, draft: { ...image, retention: { ...image.retention, localPath: '/work/outside.png' } } })).rejects.toThrow(/receipts/);
  await expect(recordExpense(folder, { expectedRevision: 0, draft: { ...image, retention: { ...image.retention, userChoiceMessageId: 'invented-choice' } } })).rejects.toThrow(/choice/);
  expect(await recordExpense(folder, { expectedRevision: 0, draft: image })).toMatchObject({ revision: 1 });
});

it('keeps savings transfers and income out of spending totals while retaining monthly activity', async () => {
  const purchase = draft('purchase', '100');
  purchase.facts.financialKind = 'purchase';
  purchase.facts.rawDateText = '26-09-04';
  purchase.facts.purchasedOn = '2026-09-04';
  purchase.facts.defaultBudgetBucket = 'groceries';
  await recordExpense(folder, { expectedRevision: 0, draft: purchase });

  const savings = draft('savings', '5000');
  savings.facts.financialKind = 'transfer';
  savings.facts.transferAccount = 'Savings account';
  savings.facts.items = [];
  savings.facts.defaultBudgetBucket = null;
  await recordExpense(folder, { expectedRevision: 1, draft: savings });

  const salary = draft('salary', '25000');
  salary.facts.financialKind = 'income';
  salary.facts.items = [];
  salary.facts.defaultBudgetBucket = null;
  await recordExpense(folder, { expectedRevision: 2, draft: salary });

  const summary = deriveExpenseSummary(await readExpensesLedger(folder));
  expect(summary.totals).toEqual([{ currency: 'SEK', total: '100' }]);
  expect(summary.monthlyBudget).toEqual([{
    month: '2026-09', currency: 'SEK', total: '100', unclassified: '0', incompleteRecords: 0,
    buckets: [{ bucket: 'groceries', total: '100' }]
  }]);
  expect(summary.monthlyActivity).toEqual([{
    month: '2026-09', currency: 'SEK', spending: '100', income: '25000', transfers: '5000'
  }]);
});
it.each(['declined', 'not-retained'] as const)('deletes a retained receipt and audits the user choice as %s', async status => {
  const { receipt, saved } = await retained(`delete-${status}`);
  const result = await deleteRetainedExpenseReceipt(folder, {
    expectedRevision: 1, recordId: saved.record.id, status, reason: 'User asked to stop keeping the raw receipt',
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' }
  });
  expect(result).toMatchObject({ revision: 2, recordId: saved.record.id, deleted: true, outcome: 'deleted' });
  await expect(fs.access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  const ledger = await readExpensesLedger(folder);
  expect(ledger.records[0]!.retention).toEqual({ status, localPath: null, sha256: null, userChoiceMessageId: 'delete-choice' });
  expect(ledger.corrections[0]!).toMatchObject({
    recordId: saved.record.id, revision: 2, sourceMessageId: 'delete-choice',
    before: { retention: { status: 'retained', userChoiceMessageId: `delete-${status}` } },
    after: { retention: { status, localPath: null, sha256: null, userChoiceMessageId: 'delete-choice' } }
  });
});
it('rejects generic retained-receipt downgrades and leaves the exact file and ledger unchanged', async () => {
  const { receipt, saved } = await retained('generic-downgrade');
  await expect(correctExpense(folder, {
    expectedRevision: 1, recordId: saved.record.id, facts: saved.record.facts,
    retention: { status: 'declined', localPath: null, sha256: null, userChoiceMessageId: 'delete-choice' },
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' }, reason: 'Stop keeping it'
  })).rejects.toThrow(/deletion action/);
  expect(await fs.readFile(receipt, 'utf8')).toBe('receipt-bytes');
  const ledger = await readExpensesLedger(folder);
  expect(ledger.revision).toBe(1);
  expect(ledger.records[0]!.retention.status).toBe('retained');
  expect(ledger.corrections).toEqual([]);
});
it('still allows ordinary fact corrections while retained receipt metadata stays identical', async () => {
  const { receipt, saved } = await retained('retained-fact-fix');
  await correctExpense(folder, {
    expectedRevision: 1, recordId: saved.record.id, facts: { ...saved.record.facts, location: 'Corrected location' },
    retention: saved.record.retention, sourceMessageId: 'fact-fix', actor: { sessionId: 'session', conversationId: 'conversation' },
    reason: 'User corrected the store location'
  });
  expect(await fs.readFile(receipt, 'utf8')).toBe('receipt-bytes');
  const ledger = await readExpensesLedger(folder);
  expect(ledger.records[0]!.facts.location).toBe('Corrected location');
  expect(ledger.records[0]!.retention).toEqual(saved.record.retention);
  expect(ledger.corrections[0]!.before.retention).toEqual(ledger.corrections[0]!.after.retention);
});
it.each([
  ['missing-file', 'missing'] as const,
  ['changed-file', 'changed'] as const
])('returns %s without changing retained metadata when the local receipt is %s', async (outcome, condition) => {
  const { receipt, saved } = await retained(`safe-${condition}`);
  if (condition === 'missing') await fs.unlink(receipt);
  else await fs.writeFile(receipt, 'different-bytes');
  const result = await deleteRetainedExpenseReceipt(folder, {
    expectedRevision: 1, recordId: saved.record.id, status: 'declined', reason: 'Stop keeping it',
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' }
  });
  expect(result).toMatchObject({ revision: 1, recordId: saved.record.id, deleted: false, outcome });
  const ledger = await readExpensesLedger(folder);
  expect(ledger.revision).toBe(1);
  expect(ledger.records[0]!.retention.status).toBe('retained');
  expect(ledger.corrections).toEqual([]);
  if (condition === 'changed') expect(await fs.readFile(receipt, 'utf8')).toBe('different-bytes');
});
it('never deletes a retained path outside receipts', async () => {
  const { saved } = await retained('unsafe-path');
  const outside = path.join(approved, 'outside.png');
  await fs.writeFile(outside, 'receipt-bytes');
  const ledgerFile = path.join(approved, 'project', 'data', 'ledger.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  ledger.records[0].retention.localPath = '/work/outside.png';
  await fs.writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
  await expect(deleteRetainedExpenseReceipt(folder, {
    expectedRevision: 1, recordId: saved.record.id, status: 'declined', reason: 'Stop keeping it',
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' }
  })).rejects.toThrow(/receipts folder/);
  expect(await fs.readFile(outside, 'utf8')).toBe('receipt-bytes');
  expect((await readExpensesLedger(folder)).records[0]!.retention.status).toBe('retained');
});
it('checks stale revisions and live write permission before deleting retained bytes', async () => {
  const { receipt, saved } = await retained('stale-delete');
  await recordExpense(folder, { expectedRevision: 1, draft: draft('later-expense', '2') });
  const request = { expectedRevision: 1, recordId: saved.record.id, status: 'declined' as const, reason: 'Stop keeping it',
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' } };
  await expect(deleteRetainedExpenseReceipt(folder, request)).rejects.toThrow(/revision conflict/);
  expect(await fs.readFile(receipt, 'utf8')).toBe('receipt-bytes');
  await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, deleteFile: false } });
  await expect(deleteRetainedExpenseReceipt(folder, { ...request, expectedRevision: 2 })).rejects.toThrow(/permission/);
  expect(await fs.readFile(receipt, 'utf8')).toBe('receipt-bytes');
  await saveConfig({ ...getConfig(), capabilities: { ...getConfig().capabilities, deleteFile: true } });
  expect((await readExpensesLedger(folder)).records.find(row => row.id === saved.record.id)!.retention.status).toBe('retained');
});
it('restores the exact retained bytes if authorization fails after deletion but before ledger publication', async () => {
  const { receipt, saved } = await retained('rollback-delete');
  let checks = 0;
  await expect(deleteRetainedExpenseReceipt(folder, {
    expectedRevision: 1, recordId: saved.record.id, status: 'declined', reason: 'Stop keeping it',
    sourceMessageId: 'delete-choice', actor: { sessionId: 'session', conversationId: 'conversation' }
  }, async () => {
    checks++;
    if (checks === 4) {
      await expect(fs.access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
      throw new Error('authorization revoked after delete');
    }
  })).rejects.toThrow(/authorization revoked/);
  expect(checks).toBe(4);
  expect(await fs.readFile(receipt, 'utf8')).toBe('receipt-bytes');
  const ledger = await readExpensesLedger(folder);
  expect(ledger.revision).toBe(1);
  expect(ledger.records[0]!.retention.status).toBe('retained');
  expect(ledger.corrections).toEqual([]);
});
it('summarizes monthly budget buckets independently of merchant and location with item overrides', async () => {
  const groceries = draft('groceries', '290');
  groceries.facts.merchant = 'ICA Maxi';
  groceries.facts.location = 'Haninge';
  groceries.facts.subtotal = '300';
  groceries.facts.discount = '-10';
  groceries.facts.defaultBudgetBucket = 'groceries';
  groceries.facts.items = [
    { ...groceries.facts.items[0]!, id: 'food', rawName: 'Groceries', normalizedName: 'Groceries', category: 'Food', amount: '240', budgetBucket: null },
    { ...groceries.facts.items[0]!, id: 'toy', rawName: 'Toy', normalizedName: 'Toy', category: 'Toys', amount: '60', budgetBucket: 'fun' }
  ];
  await recordExpense(folder, { expectedRevision: 0, draft: groceries });

  const order = draft('food-order', '180');
  order.facts.merchant = 'Wolt';
  order.facts.location = 'Home';
  order.facts.defaultBudgetBucket = 'food orders';
  await recordExpense(folder, { expectedRevision: 1, draft: order });

  const fun = draft('same-merchant-different-budget', '120');
  fun.facts.merchant = 'ICA Maxi';
  fun.facts.location = 'Haninge';
  fun.facts.defaultBudgetBucket = 'fun';
  await recordExpense(folder, { expectedRevision: 2, draft: fun });

  const nextMonth = draft('next-month', '50');
  nextMonth.facts.purchasedOn = '2026-10-01';
  nextMonth.facts.defaultBudgetBucket = 'groceries';
  await recordExpense(folder, { expectedRevision: 3, draft: nextMonth });

  expect(deriveExpenseSummary(await readExpensesLedger(folder)).monthlyBudget).toEqual([
    {
      month: '2026-09', currency: 'SEK', total: '590', unclassified: '0', incompleteRecords: 0,
      buckets: [
        { bucket: 'food orders', total: '180' },
        { bucket: 'fun', total: '180' },
        { bucket: 'groceries', total: '230' }
      ]
    },
    {
      month: '2026-10', currency: 'SEK', total: '50', unclassified: '0', incompleteRecords: 0,
      buckets: [{ bucket: 'groceries', total: '50' }]
    }
  ]);
});
it('keeps unresolved item overrides unclassified instead of guessing the record default', async () => {
  const mixed = draft('mixed', '100');
  mixed.facts.defaultBudgetBucket = 'groceries';
  mixed.facts.items = [
    { ...mixed.facts.items[0]!, amount: null, budgetBucket: 'fun' }
  ];
  await recordExpense(folder, { expectedRevision: 0, draft: mixed });
  expect(deriveExpenseSummary(await readExpensesLedger(folder)).monthlyBudget).toEqual([
    { month: '2026-09', currency: 'SEK', total: '100', unclassified: '100', incompleteRecords: 1, buckets: [] }
  ]);
});
it('keeps warranty retention as an audited user choice after the original expense is recorded', async () => {
  const image = draft('warranty-receipt', '499');
  image.source.kind = 'image';
  image.source.sha256 = createHash('sha256').update('receipt-bytes').digest('hex');
  const first = await recordExpense(folder, { expectedRevision: 0, draft: image });
  expect(first.record.retention).toEqual({ status: 'not-retained', localPath: null, sha256: null, userChoiceMessageId: null });
  expect(deriveExpenseSummary(await readExpensesLedger(folder)).warrantyCandidates).toEqual([
    expect.objectContaining({ recordId: first.record.id, itemId: 'one', name: 'Kettle', retention: 'not-retained' })
  ]);

  await fs.mkdir(path.join(approved, 'project', 'receipts'));
  await fs.writeFile(path.join(approved, 'project', 'receipts', 'warranty.png'), 'receipt-bytes');
  const kept = { status: 'retained' as const, localPath: 'receipts/warranty.png', sha256: image.source.sha256, userChoiceMessageId: 'user-said-keep' };
  await expect(correctExpense(folder, { expectedRevision: 1, recordId: first.record.id, facts: first.record.facts,
    retention: { ...kept, userChoiceMessageId: 'invented-choice' }, sourceMessageId: 'user-said-keep',
    actor: { sessionId: 'session', conversationId: 'conversation' }, reason: 'User chose to keep warranty proof' })).rejects.toThrow(/choice/);
  await correctExpense(folder, { expectedRevision: 1, recordId: first.record.id, facts: first.record.facts, retention: kept,
    sourceMessageId: 'user-said-keep', actor: { sessionId: 'session', conversationId: 'conversation' }, reason: 'User chose to keep warranty proof' });
  const ledger = await readExpensesLedger(folder);
  expect(ledger.records[0]!.retention).toEqual(kept);
  expect(ledger.corrections[0]!.before.retention.status).toBe('not-retained');
  expect(ledger.corrections[0]!.after.retention).toEqual(kept);
  expect(deriveExpenseSummary(ledger).warrantyCandidates[0]).toMatchObject({ recordId: first.record.id, itemId: 'one', retention: 'retained' });
});
