import { z } from 'zod';
import {
  expenseBudgetBucketSchema, expenseDecimalSchema, expenseLedgerSchema,
  type ExpenseLedger, type ExpenseRecord
} from './expenses.js';

const evidenceId = z.string().min(1).max(240);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const nullableText = z.string().trim().min(1).max(500).nullable();

/**
 * Import boundary for future statement/manual ingestion. The reconciler owns no bank connector:
 * an importer supplies a stable source identity plus statement facts, then persists this shape.
 */
export const bankTransactionSchema = z.object({
  id: evidenceId,
  source: z.object({
    kind: z.enum(['manual', 'statement']),
    sourceId: evidenceId,
    externalId: evidenceId.nullable().default(null)
  }).strict(),
  amount: expenseDecimalSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  flow: z.enum(['debit', 'credit']).default('debit'),
  kind: z.enum(['purchase', 'subscription', 'income', 'transfer', 'other']).default('purchase'),
  bookingDate: date,
  transactionDate: date.nullable().default(null),
  rawMerchant: z.string().trim().min(1).max(500),
  cardLast4: z.string().regex(/^\d{4}$/).nullable().default(null),
  reference: nullableText.default(null),
  budgetBucket: expenseBudgetBucketSchema.default(null)
}).strict();

const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const referenceBucketSchema = z.object({
  bucket: z.string().trim().min(1).max(120),
  total: expenseDecimalSchema
}).strict();

/** Human-curated monthly baseline, such as the user's physical 2025 ledger. */
export const monthlyExpenseReferenceSchema = z.object({
  month,
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.object({ kind: z.literal('human-ledger'), sourceId: evidenceId }).strict(),
  outflowTotal: expenseDecimalSchema.nullable().default(null),
  incomeTotal: expenseDecimalSchema.nullable().default(null),
  buckets: z.array(referenceBucketSchema).max(100).default([])
    .refine(rows => new Set(rows.map(row => row.bucket)).size === rows.length, 'Reference bucket names must be unique')
}).strict();

export const expenseReconciliationLinkSchema = z.object({
  id: evidenceId,
  bankTransactionId: evidenceId,
  expenseRecordId: z.string().uuid(),
  state: z.enum(['probable', 'confirmed', 'rejected']),
  score: z.number().int().min(0).max(100).nullable().default(null),
  reasons: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  decisionSource: z.enum(['heuristic', 'user', 'import']).default('heuristic')
}).strict().refine(link => link.updatedAt >= link.createdAt, 'Reconciliation link update predates creation')
  .refine(link => link.state !== 'confirmed' || link.decisionSource !== 'heuristic',
    'Fuzzy reconciliation suggestions can never auto-confirm a match');

export const expenseReconciliationSchema = z.object({
  version: z.literal(1),
  bankTransactions: z.array(bankTransactionSchema).max(50000),
  links: z.array(expenseReconciliationLinkSchema).max(100000)
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const bankIds = new Set(value.bankTransactions.map(row => row.id));
  if (bankIds.size !== value.bankTransactions.length) reject('Duplicate bank transaction id');
  const sourceKeys = value.bankTransactions.map(bankTransactionSourceKey);
  if (new Set(sourceKeys).size !== sourceKeys.length) reject('Duplicate bank transaction source identity');
  const pairs = value.links.map(link => JSON.stringify([link.bankTransactionId, link.expenseRecordId]));
  if (new Set(pairs).size !== pairs.length) reject('Duplicate reconciliation link');
  if (new Set(value.links.map(link => link.id)).size !== value.links.length) reject('Duplicate reconciliation link id');
  for (const link of value.links) if (!bankIds.has(link.bankTransactionId)) reject('Reconciliation link references unknown bank transaction');
  for (const bankId of bankIds) {
    if (value.links.filter(link => link.bankTransactionId === bankId && link.state === 'confirmed').length > 1) {
      reject('A bank transaction cannot confirm multiple expense records');
    }
  }
});

export type BankTransaction = z.infer<typeof bankTransactionSchema>;
export type ExpenseReconciliation = z.infer<typeof expenseReconciliationSchema>;
export type ExpenseReconciliationLink = z.infer<typeof expenseReconciliationLinkSchema>;
export type ReconciliationState = 'unmatched' | 'probable' | 'confirmed' | 'rejected';
export type MonthlyExpenseReference = z.infer<typeof monthlyExpenseReferenceSchema>;

export function bankTransactionSourceKey(row: BankTransaction): string {
  return JSON.stringify([row.source.kind, row.source.sourceId, row.source.externalId ?? row.id]);
}

export function emptyExpenseReconciliation(): ExpenseReconciliation {
  return expenseReconciliationSchema.parse({ version: 1, bankTransactions: [], links: [] });
}

function decimalScaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(negative ? -1 : 1) * (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0')));
}

function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return (value < 0n ? '-' : '') + (absolute / 10000n).toString() + (fraction ? '.' + fraction : '');
}

function dayNumber(value: string): number {
  return Math.floor(new Date(value + 'T00:00:00Z').getTime() / 86_400_000);
}

export function normalizeReconciliationMerchant(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:ab|aktiebolag|sweden|sverige|store|butik)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function merchantSimilarity(left: string, right: string): number {
  const a = normalizeReconciliationMerchant(left);
  const b = normalizeReconciliationMerchant(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const leftTokens = new Set(a.split(' '));
  const rightTokens = new Set(b.split(' '));
  const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

export type ExpenseMatchSuggestion = {
  expenseRecordId: string;
  state: 'probable';
  score: number;
  reasons: string[];
};

/**
 * Returns review candidates only. Even a score of 100 is `probable`; confirmation must come
 * from an explicit user/import decision and is represented as a persisted reconciliation link.
 */
export function suggestExpenseMatches(transactionInput: unknown, recordsInput: ExpenseRecord[]): ExpenseMatchSuggestion[] {
  const transaction = bankTransactionSchema.parse(transactionInput);
  const records = recordsInput.map(row => expenseLedgerSchema.shape.records.element.parse(row));
  if (transaction.kind === 'transfer' || transaction.kind === 'income') return [];
  const transactionDate = transaction.transactionDate ?? transaction.bookingDate;
  const candidates: ExpenseMatchSuggestion[] = [];
  for (const record of records) {
    if (record.facts.financialKind === 'transfer' || record.facts.financialKind === 'income') continue;
    const facts = record.facts;
    if (facts.currency !== transaction.currency || facts.total === null || facts.purchasedOn === null) continue;
    const reasons: string[] = [];
    let score = 0;
    if (decimalScaled(facts.total) === decimalScaled(transaction.amount)) {
      score += 55;
      reasons.push('exact amount');
    } else continue;

    const days = Math.abs(dayNumber(facts.purchasedOn) - dayNumber(transactionDate));
    if (days === 0) { score += 20; reasons.push('same transaction date'); }
    else if (days <= 1) { score += 18; reasons.push('date within 1 day'); }
    else if (days <= 3) { score += 14; reasons.push('date within 3 days'); }
    else if (days <= 7) { score += 6; reasons.push('date within 7 days'); }
    else continue;

    if (facts.merchant !== null) {
      const merchant = merchantSimilarity(facts.merchant, transaction.rawMerchant);
      if (merchant >= 1) { score += 20; reasons.push('normalized merchant exact'); }
      else if (merchant >= 0.8) { score += 16; reasons.push('normalized merchant strong'); }
      else if (merchant >= 0.5) { score += 8; reasons.push('normalized merchant partial'); }
    }
    if (facts.paymentCardLast4 !== null && transaction.cardLast4 !== null && facts.paymentCardLast4 === transaction.cardLast4) {
      score += 5; reasons.push('card last4 exact');
    }
    if (facts.paymentReference !== null && transaction.reference !== null && facts.paymentReference === transaction.reference) {
      score += 10; reasons.push('payment reference exact');
    }
    if (score >= 69) candidates.push({ expenseRecordId: record.id, state: 'probable', score: Math.min(score, 100), reasons });
  }
  return candidates.sort((a, b) => b.score - a.score || a.expenseRecordId.localeCompare(b.expenseRecordId));
}

function transactionState(transactionId: string, links: ExpenseReconciliationLink[]): ReconciliationState {
  const own = links.filter(link => link.bankTransactionId === transactionId);
  if (own.some(link => link.state === 'confirmed')) return 'confirmed';
  if (own.some(link => link.state === 'probable')) return 'probable';
  if (own.length && own.every(link => link.state === 'rejected')) return 'rejected';
  return 'unmatched';
}

/**
 * Reconciliation view keeps both evidence sets intact. A confirmed link suppresses only the
 * receipt side from `combinedTotal`; probable/fuzzy matches remain unresolved and count twice.
 */
export function deriveExpenseReconciliationSummary(expensesInput: ExpenseLedger, reconciliationInput: ExpenseReconciliation) {
  const expenses = expenseLedgerSchema.parse(expensesInput);
  const reconciliation = expenseReconciliationSchema.parse(reconciliationInput);
  const recordIds = new Set(expenses.records.map(row => row.id));
  for (const link of reconciliation.links) {
    if (!recordIds.has(link.expenseRecordId)) throw new Error('Reconciliation link references unknown expense record');
  }
  const confirmed = reconciliation.links.filter(link => link.state === 'confirmed');
  const confirmedExpenseIds = new Set<string>();
  for (const link of confirmed) {
    if (confirmedExpenseIds.has(link.expenseRecordId)) throw new Error('An expense record cannot be confirmed against multiple bank transactions');
    confirmedExpenseIds.add(link.expenseRecordId);
  }

  const currencies = new Map<string, { bank: bigint; receipts: bigint; suppressedReceipts: bigint }>();
  const bucket = (currency: string) => currencies.get(currency) ?? { bank: 0n, receipts: 0n, suppressedReceipts: 0n };
  for (const bank of reconciliation.bankTransactions) {
    const row = bucket(bank.currency); row.bank += decimalScaled(bank.amount); currencies.set(bank.currency, row);
  }
  for (const record of expenses.records) {
    if (record.facts.currency === null || record.facts.total === null) continue;
    const row = bucket(record.facts.currency);
    const total = decimalScaled(record.facts.total);
    row.receipts += total;
    if (confirmedExpenseIds.has(record.id)) row.suppressedReceipts += total;
    currencies.set(record.facts.currency, row);
  }

  return {
    expenseRecordCount: expenses.records.length,
    bankTransactionCount: reconciliation.bankTransactions.length,
    confirmedMatchCount: confirmed.length,
    probableLinkCount: reconciliation.links.filter(link => link.state === 'probable').length,
    rejectedLinkCount: reconciliation.links.filter(link => link.state === 'rejected').length,
    bankTransactions: reconciliation.bankTransactions.map(transaction => ({
      id: transaction.id,
      state: transactionState(transaction.id, reconciliation.links),
      linkedExpenseRecordIds: reconciliation.links.filter(link => link.bankTransactionId === transaction.id && link.state !== 'rejected').map(link => link.expenseRecordId)
    })),
    totals: [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, row]) => ({
      currency,
      bankTotal: decimal(row.bank),
      receiptTotal: decimal(row.receipts),
      suppressedReceiptTotal: decimal(row.suppressedReceipts),
      combinedTotal: decimal(row.bank + row.receipts - row.suppressedReceipts)
    }))
  };
}

type MonthlyEvidence = {
  month: string;
  currency: string;
  outflow: bigint;
  income: bigint;
  receiptOnly: number;
  confirmed: number;
  bankOnlyDebit: number;
  bankOnlyCredit: number;
  bankOnlyTransfer: number;
  probable: number;
  buckets: Map<string, bigint>;
  unclassified: bigint;
  transfers: bigint;
};

function monthlyEvidenceKey(monthValue: string, currency: string): string {
  return JSON.stringify([monthValue, currency]);
}

function monthlyEvidenceBucket(rows: Map<string, MonthlyEvidence>, monthValue: string, currency: string): MonthlyEvidence {
  const key = monthlyEvidenceKey(monthValue, currency);
  const existing = rows.get(key);
  if (existing) return existing;
  const created: MonthlyEvidence = {
    month: monthValue, currency, outflow: 0n, income: 0n, receiptOnly: 0, confirmed: 0,
    bankOnlyDebit: 0, bankOnlyCredit: 0, bankOnlyTransfer: 0, probable: 0,
    buckets: new Map(), unclassified: 0n, transfers: 0n
  };
  rows.set(key, created);
  return created;
}

function addMonthlyBucket(row: MonthlyEvidence, bucket: string | null, amount: bigint): void {
  if (bucket === null) row.unclassified += amount;
  else row.buckets.set(bucket, (row.buckets.get(bucket) ?? 0n) + amount);
}

/**
 * Builds a month-level reconstruction for validation/dogfooding. Receipt evidence is primary:
 * every receipt is counted once. Confirmed bank links corroborate that receipt and are not added
 * again. Probable links stay unresolved and also are not added again. Only bank rows with no
 * confirmed/probable receipt link fill cashflow gaps. This keeps uncertainty visible without
 * double counting a likely duplicate.
 */
export function deriveMonthlyEvidenceSummary(expensesInput: ExpenseLedger, reconciliationInput: ExpenseReconciliation) {
  const expenses = expenseLedgerSchema.parse(expensesInput);
  const reconciliation = expenseReconciliationSchema.parse(reconciliationInput);
  const expenseIds = new Set(expenses.records.map(record => record.id));
  for (const link of reconciliation.links) {
    if (!expenseIds.has(link.expenseRecordId)) throw new Error('Reconciliation link references unknown expense record');
  }

  const confirmedExpenseIds = new Set(reconciliation.links.filter(link => link.state === 'confirmed').map(link => link.expenseRecordId));
  const probableExpenseIds = new Set(reconciliation.links.filter(link => link.state === 'probable').map(link => link.expenseRecordId));
  const rows = new Map<string, MonthlyEvidence>();

  for (const record of expenses.records) {
    if (record.facts.purchasedOn === null || record.facts.currency === null || record.facts.total === null) continue;
    const row = monthlyEvidenceBucket(rows, record.facts.purchasedOn.slice(0, 7), record.facts.currency);
    const total = decimalScaled(record.facts.total);
    if (record.facts.financialKind === 'transfer') {
      row.transfers += total;
      continue;
    }
    if (record.facts.financialKind === 'income') {
      row.income += total;
      continue;
    }
    row.outflow += total;
    if (confirmedExpenseIds.has(record.id)) row.confirmed++;
    else if (!probableExpenseIds.has(record.id)) row.receiptOnly++;

    const overrides = record.facts.items.filter(item => item.budgetBucket !== null && item.amount !== null);
    let overridden = 0n;
    for (const item of overrides) {
      const amount = decimalScaled(item.amount!);
      overridden += amount;
      addMonthlyBucket(row, item.budgetBucket, amount);
    }
    addMonthlyBucket(row, record.facts.defaultBudgetBucket, total - overridden);
  }

  for (const bank of reconciliation.bankTransactions) {
    const ownLinks = reconciliation.links.filter(link => link.bankTransactionId === bank.id);
    if (ownLinks.some(link => link.state === 'confirmed')) continue;
    const bankMonth = (bank.transactionDate ?? bank.bookingDate).slice(0, 7);
    const row = monthlyEvidenceBucket(rows, bankMonth, bank.currency);
    if (ownLinks.some(link => link.state === 'probable')) {
      row.probable++;
      continue;
    }
    const amount = decimalScaled(bank.amount);
    if (bank.kind === 'transfer') {
      row.transfers += amount;
      row.bankOnlyTransfer++;
    } else if (bank.flow === 'credit') {
      row.income += amount;
      row.bankOnlyCredit++;
    } else {
      row.outflow += amount;
      row.bankOnlyDebit++;
      addMonthlyBucket(row, bank.budgetBucket, amount);
    }
  }

  return [...rows.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency))
    .map(row => ({
      month: row.month,
      currency: row.currency,
      outflowTotal: decimal(row.outflow),
      incomeTotal: decimal(row.income),
      transferTotal: decimal(row.transfers),
      evidence: {
        receiptOnly: row.receiptOnly,
        confirmed: row.confirmed,
        bankOnlyDebit: row.bankOnlyDebit,
        bankOnlyCredit: row.bankOnlyCredit,
        bankOnlyTransfer: row.bankOnlyTransfer,
        probable: row.probable
      },
      unclassified: decimal(row.unclassified),
      buckets: [...row.buckets].sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, total]) => ({ bucket, total: decimal(total) }))
    }));
}

/** Compare reconstructed evidence with human-curated monthly reference totals/classifications. */
export function compareMonthlyEvidenceToReference(
  expensesInput: ExpenseLedger,
  reconciliationInput: ExpenseReconciliation,
  referencesInput: MonthlyExpenseReference[]
) {
  const reconstructed = deriveMonthlyEvidenceSummary(expensesInput, reconciliationInput);
  const references = referencesInput.map(value => monthlyExpenseReferenceSchema.parse(value));
  const reconstructedByKey = new Map(reconstructed.map(row => [monthlyEvidenceKey(row.month, row.currency), row]));
  const referenceByKey = new Map(references.map(row => [monthlyEvidenceKey(row.month, row.currency), row]));
  const keys = new Set([...reconstructedByKey.keys(), ...referenceByKey.keys()]);

  return [...keys].map(key => {
    const reconstructedRow = reconstructedByKey.get(key) ?? null;
    const reference = referenceByKey.get(key) ?? null;
    const bucketNames = new Set([
      ...(reconstructedRow?.buckets.map(row => row.bucket) ?? []),
      ...(reference?.buckets.map(row => row.bucket) ?? [])
    ]);
    const bucketDiscrepancies = [...bucketNames].sort().map(bucket => {
      const reconstructedTotal = reconstructedRow?.buckets.find(row => row.bucket === bucket)?.total ?? '0';
      const referenceTotal = reference?.buckets.find(row => row.bucket === bucket)?.total ?? '0';
      return { bucket, referenceTotal, reconstructedTotal, difference: decimal(decimalScaled(reconstructedTotal) - decimalScaled(referenceTotal)) };
    });
    const missingEvidence: string[] = [];
    if (reference && !reconstructedRow) missingEvidence.push('reference month has no reconstructed evidence');
    if (!reference && reconstructedRow) missingEvidence.push('reconstructed month has no human reference');
    if (reconstructedRow?.evidence.receiptOnly) missingEvidence.push(`${reconstructedRow.evidence.receiptOnly} receipt-only transaction(s) lack confirmed bank evidence`);
    if (reconstructedRow?.evidence.bankOnlyDebit) missingEvidence.push(`${reconstructedRow.evidence.bankOnlyDebit} bank debit(s) lack receipt evidence`);
    if (reconstructedRow?.evidence.probable) missingEvidence.push(`${reconstructedRow.evidence.probable} probable bank/receipt match(es) need review`);

    return {
      month: reconstructedRow?.month ?? reference!.month,
      currency: reconstructedRow?.currency ?? reference!.currency,
      referenceSource: reference?.source ?? null,
      referenceOutflowTotal: reference?.outflowTotal ?? null,
      reconstructedOutflowTotal: reconstructedRow?.outflowTotal ?? null,
      outflowDifference: reference?.outflowTotal !== null && reference?.outflowTotal !== undefined && reconstructedRow
        ? decimal(decimalScaled(reconstructedRow.outflowTotal) - decimalScaled(reference.outflowTotal)) : null,
      referenceIncomeTotal: reference?.incomeTotal ?? null,
      reconstructedIncomeTotal: reconstructedRow?.incomeTotal ?? null,
      incomeDifference: reference?.incomeTotal !== null && reference?.incomeTotal !== undefined && reconstructedRow
        ? decimal(decimalScaled(reconstructedRow.incomeTotal) - decimalScaled(reference.incomeTotal)) : null,
      bucketDiscrepancies,
      missingEvidence
    };
  }).sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
}
