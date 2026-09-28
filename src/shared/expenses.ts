import { z } from 'zod';

const id = z.string().min(1).max(240);
const nullableText = z.string().trim().min(1).max(500).nullable();
export const expenseBudgetBucketSchema = z.string().trim().min(1).max(120).nullable().describe(
  'Monthly budget allocation, separate from item category and receipt merchant/location provenance. Use the user\'s established bucket names (for example Fun); durability or non-essentiality may be a hint, never an automatic assignment.'
);
export const expenseFinancialKindSchema = z.enum(['purchase', 'bill', 'transfer', 'income']).describe(
  'Financial meaning of the evidence. Purchase and bill count as spending. Transfer is a movement between the user\'s own accounts and never spending. Income is tracked separately from spending.'
);
// Decimal strings retain exact source precision. No binary floating point enters totals.
export const expenseDecimalSchema = z.string().regex(/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/,
  'Use a decimal string such as "208.18" (at most 4 decimals, no currency symbol or thousands separator)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use an ISO date YYYY-MM-DD', abort: true }).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date YYYY-MM-DD');
const expenseLocalSourceSchema = z.object({
  kind: z.enum(['text', 'image']),
  sessionId: id,
  conversationId: id,
  messageId: id,
  sourceIndex: z.number().int().min(0).max(99),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict().refine(source => source.kind === 'image' || source.sha256 === null,
  'Text expense sources cannot carry image hashes');
const expenseConnectorSourceSchema = z.object({
  origin: z.literal('connector'),
  kind: z.enum(['text', 'image']),
  requestId: id,
  sourceIndex: z.number().int().min(0).max(99),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable()
}).strict().refine(source => source.kind === 'image' || source.sha256 === null,
  'Text expense sources cannot carry image hashes');
export const expenseSourceSchema = z.union([expenseLocalSourceSchema, expenseConnectorSourceSchema]);
export const expenseItemSchema = z.object({
  id,
  rawName: z.string().min(1).max(500),
  normalizedName: nullableText.default(null),
  category: nullableText.default(null),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown'),
  quantity: expenseDecimalSchema.nullable().default(null),
  unit: nullableText.default(null),
  brand: nullableText.default(null),
  unitPrice: expenseDecimalSchema.nullable().default(null),
  amount: expenseDecimalSchema.nullable().default(null),
  budgetBucket: expenseBudgetBucketSchema.default(null).describe('Optional monthly budget allocation, separate from category and receipt merchant/location provenance. Use an established user bucket such as fun only when supported by the user\'s allocation rules; durability is a hint, never an automatic assignment.'),
  warranty: z.object({ candidate: z.boolean(), reason: nullableText.default(null) }).strict()
    .default(() => ({ candidate: false, reason: null }))
}).strict();
// An omitted item id is the item's 1-based receipt line position; ids only need to be unique per record.
const expenseItemsSchema = z.preprocess(items => items === undefined ? [] : Array.isArray(items)
  ? items.map((item, index) => item && typeof item === 'object' && !Array.isArray(item) && (item as { id?: unknown }).id === undefined
    ? { ...item, id: String(index + 1) } : item)
  : items,
z.array(expenseItemSchema).max(500).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Item ids must be unique'));
export const expenseFactsSchema = z.object({
  financialKind: expenseFinancialKindSchema.default('purchase'),
  purchasedOn: date.nullable(),
  rawDateText: nullableText.default(null),
  merchant: nullableText,
  rawMerchant: nullableText.default(null),
  location: nullableText.default(null),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use an uppercase ISO 4217 code such as "SEK"').nullable(),
  total: expenseDecimalSchema.nullable(),
  subtotal: expenseDecimalSchema.nullable().default(null),
  discount: expenseDecimalSchema.nullable().default(null),
  tax: expenseDecimalSchema.nullable().default(null),
  paymentCardLast4: z.string().regex(/^\d{4}$/).nullable().default(null),
  paymentReference: nullableText.default(null),
  transferAccount: nullableText.default(null).describe('For own-account transfers, the supported destination/source account label when visible. Never infer an account name.'),
  // The record bucket is only the fallback classification. Merchant/location remain evidence,
  // and an item's budgetBucket can override this fallback for its exact amount.
  defaultBudgetBucket: expenseBudgetBucketSchema.default(null),
  items: expenseItemsSchema,
  notes: z.string().max(2000).nullable().default(null)
  ,confidence: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown')
  ,uncertainties: z.array(z.string().min(1).max(500)).max(50).default([])
}).strict();
// Model callers naturally send receipt amounts as JSON numbers. Below 1e11 a value with at most
// four decimals has at most 15 significant digits, so its shortest round-trip text is exactly the
// digits the caller wrote. Only this caller boundary converts; stored ledger facts stay strings.
const callerDecimal = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e11 ? String(value) : value;
const DECIMAL_FACTS = ['total', 'subtotal', 'discount', 'tax'] as const;
const DECIMAL_ITEM_FACTS = ['quantity', 'unitPrice', 'amount'] as const;
const withCallerDecimals = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = { ...value } as Record<string, unknown>;
  for (const key of keys) if (key in row) row[key] = callerDecimal(row[key]);
  return row;
};
export const expenseFactsInputSchema = z.preprocess(value => {
  const facts = withCallerDecimals(value, DECIMAL_FACTS) as Record<string, unknown>;
  return facts !== value && Array.isArray(facts.items)
    ? { ...facts, items: facts.items.map(item => withCallerDecimals(item, DECIMAL_ITEM_FACTS)) } : facts;
}, expenseFactsSchema);
export const expenseRetentionSchema = z.object({
  status: z.enum(['not-retained', 'requested', 'declined', 'retained']),
  localPath: z.string().min(1).max(1000).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  userChoiceMessageId: id.nullable(),
  userChoiceRequestId: id.nullable().optional()
}).strict().refine(value =>
  (value.status === 'retained' ? value.localPath !== null : value.localPath === null && value.sha256 === null) &&
  (value.status === 'not-retained' || value.status === 'retained' || value.userChoiceMessageId !== null || value.userChoiceRequestId !== null),
'Retained copies need a local path; requested/declined states need an explicit user choice; other statuses have no local path');
export const defaultExpenseRetention = () => ({ status: 'not-retained' as const, localPath: null, sha256: null, userChoiceMessageId: null });
export const expenseDraftSchema = z.object({
  source: expenseSourceSchema,
  facts: expenseFactsSchema,
  retention: expenseRetentionSchema.default(defaultExpenseRetention)
}).strict();
export const expenseRecordSchema = expenseDraftSchema.extend({
  id: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
}).strict().refine(row => row.updatedAt >= row.createdAt);
const expenseCorrectionBase = {
  id: z.string().uuid(),
  recordId: z.string().uuid(),
  revision: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000),
  before: z.object({ facts: expenseFactsSchema, retention: expenseRetentionSchema }).strict(),
  after: z.object({ facts: expenseFactsSchema, retention: expenseRetentionSchema }).strict()
};
const expenseLocalActorSchema = z.object({ sessionId: id, conversationId: id }).strict();
const expenseConnectorActorSchema = z.object({ kind: z.literal('connector'), requestId: id }).strict();
export const expenseCorrectionSchema = z.union([
  z.object({ ...expenseCorrectionBase, sourceMessageId: id, actor: expenseLocalActorSchema }).strict(),
  z.object({ ...expenseCorrectionBase, sourceRequestId: id, actor: expenseConnectorActorSchema }).strict()
]);
export const expenseLedgerSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  records: z.array(expenseRecordSchema).max(10000),
  corrections: z.array(expenseCorrectionSchema).max(20000)
}).strict().superRefine((ledger, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(ledger.records.map(row => row.id)).size !== ledger.records.length) reject('Duplicate record id');
  if (new Set(ledger.records.map(row => expenseSourceKey(row.source))).size !== ledger.records.length) reject('Duplicate source identity');
  const hashes = ledger.records.flatMap(row => row.source.sha256 ? [row.source.sha256] : []);
  if (new Set(hashes).size !== hashes.length) reject('Duplicate exact source hash');
  if (new Set(ledger.corrections.map(row => row.id)).size !== ledger.corrections.length) reject('Duplicate correction id');
  if (ledger.revision !== ledger.records.length + ledger.corrections.length) reject('Invalid ledger revision');
  let previousRevision = 0;
  for (const correction of ledger.corrections) {
    if (!ledger.records.some(row => row.id === correction.recordId) || correction.revision > ledger.revision || correction.revision <= previousRevision) reject('Invalid correction reference');
    previousRevision = correction.revision;
  }
  for (const row of ledger.records) {
    const changes = ledger.corrections.filter(change => change.recordId === row.id);
    for (let index = 1; index < changes.length; index++) {
      if (JSON.stringify(changes[index - 1]!.after) !== JSON.stringify(changes[index]!.before)) reject('Broken correction history');
    }
    const last = changes.at(-1);
    if (last && (JSON.stringify(last.after) !== JSON.stringify({ facts: row.facts, retention: row.retention }) || last.at !== row.updatedAt)) reject('Correction does not match current record');
  }
});
export const recordExpenseRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  draft: expenseDraftSchema
}).strict();
const correctionRequestBase = {
  expectedRevision: z.number().int().nonnegative(),
  recordId: z.string().uuid(),
  facts: expenseFactsSchema,
  retention: expenseRetentionSchema,
  reason: z.string().trim().min(1).max(1000)
};
export const correctExpenseRequestSchema = z.union([
  z.object({ ...correctionRequestBase, sourceMessageId: id, actor: expenseLocalActorSchema }).strict(),
  z.object({ ...correctionRequestBase, sourceRequestId: id, actor: expenseConnectorActorSchema }).strict()
]);
const deleteReceiptRequestBase = {
  expectedRevision: z.number().int().nonnegative(),
  recordId: z.string().uuid(),
  status: z.enum(['not-retained', 'declined']),
  reason: z.string().trim().min(1).max(1000)
};
export const deleteRetainedExpenseReceiptRequestSchema = z.union([
  z.object({ ...deleteReceiptRequestBase, sourceMessageId: id, actor: expenseLocalActorSchema }).strict(),
  z.object({ ...deleteReceiptRequestBase, sourceRequestId: id, actor: expenseConnectorActorSchema }).strict()
]);

export type ExpenseSource = z.infer<typeof expenseSourceSchema>;
export type ExpenseDraft = z.infer<typeof expenseDraftSchema>;
export type ExpenseLedger = z.infer<typeof expenseLedgerSchema>;
export type ExpenseRecord = z.infer<typeof expenseRecordSchema>;
export function expenseSourceKey(source: ExpenseSource): string {
  return 'origin' in source
    ? JSON.stringify(['connector', source.requestId, source.sourceIndex])
    : JSON.stringify(['local', source.sessionId, source.conversationId, source.messageId, source.sourceIndex]);
}
export function emptyExpensesLedger(): ExpenseLedger {
  return expenseLedgerSchema.parse({ version: 1, revision: 0, records: [], corrections: [] });
}
function scaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(negative ? -1 : 1) * (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0')));
}
function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return (value < 0n ? '-' : '') + (absolute / 10000n).toString() + (fraction ? '.' + fraction : '');
}
type MonthlyBudget = {
  month: string;
  currency: string;
  total: bigint;
  unclassified: bigint;
  incompleteRecords: number;
  buckets: Map<string, bigint>;
};
type MonthlyActivity = {
  month: string;
  currency: string;
  spending: bigint;
  income: bigint;
  transfers: bigint;
};
function monthlyBudgetKey(month: string, currency: string): string {
  return JSON.stringify([month, currency]);
}
function addBudgetAmount(summary: MonthlyBudget, bucket: string | null, amount: bigint): void {
  if (bucket === null) {
    summary.unclassified += amount;
    return;
  }
  summary.buckets.set(bucket, (summary.buckets.get(bucket) ?? 0n) + amount);
}
export function deriveExpenseSummary(input: ExpenseLedger) {
  const ledger = expenseLedgerSchema.parse(input);
  const totals = new Map<string, bigint>();
  const monthly = new Map<string, MonthlyBudget>();
  const activity = new Map<string, MonthlyActivity>();
  let incompleteRecords = 0;
  for (const row of ledger.records) {
    if (row.facts.currency === null || row.facts.total === null) { incompleteRecords++; continue; }
    const total = scaled(row.facts.total);
    if (row.facts.purchasedOn !== null) {
      const month = row.facts.purchasedOn.slice(0, 7);
      const activityKey = monthlyBudgetKey(month, row.facts.currency);
      const activityRow = activity.get(activityKey) ?? {
        month, currency: row.facts.currency, spending: 0n, income: 0n, transfers: 0n
      };
      activity.set(activityKey, activityRow);
      if (row.facts.financialKind === 'income') activityRow.income += total;
      else if (row.facts.financialKind === 'transfer') activityRow.transfers += total;
      else activityRow.spending += total;
    }
    if (row.facts.financialKind === 'transfer' || row.facts.financialKind === 'income') continue;
    totals.set(row.facts.currency, (totals.get(row.facts.currency) ?? 0n) + total);
    if (row.facts.purchasedOn === null) continue;
    const month = row.facts.purchasedOn.slice(0, 7);
    const key = monthlyBudgetKey(month, row.facts.currency);
    const budget = monthly.get(key) ?? {
      month, currency: row.facts.currency, total: 0n, unclassified: 0n, incompleteRecords: 0, buckets: new Map<string, bigint>()
    };
    monthly.set(key, budget);
    budget.total += total;
    const overrides = row.facts.items.filter(item => item.budgetBucket !== null);
    if (!overrides.length) {
      addBudgetAmount(budget, row.facts.defaultBudgetBucket, total);
      continue;
    }
    let overridden = 0n;
    let missingOverrideAmount = false;
    for (const item of overrides) {
      if (item.amount === null) {
        missingOverrideAmount = true;
        continue;
      }
      const amount = scaled(item.amount);
      overridden += amount;
      addBudgetAmount(budget, item.budgetBucket, amount);
    }
    const remainder = total - overridden;
    if (missingOverrideAmount) {
      budget.incompleteRecords++;
      budget.unclassified += remainder;
    } else addBudgetAmount(budget, row.facts.defaultBudgetBucket, remainder);
  }
  return { revision: ledger.revision, recordCount: ledger.records.length, incompleteRecords,
    warnings: ledger.records.flatMap(row => {
      const facts = row.facts;
      if (facts.financialKind === 'transfer' || facts.financialKind === 'income') return [];
      if (facts.total === null || !facts.items.length || facts.items.some(item => item.amount === null)) return [];
      const sum = facts.items.reduce((total, item) => total + scaled(item.amount!), 0n);
      return sum === scaled(facts.total) ? [] : [{ recordId: row.id, message: 'Item amounts differ from receipt total; review discounts, tax and incomplete lines' }];
    }),
    totals: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, total: decimal(total) })),
    monthlyActivity: [...activity.values()]
      .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency))
      .map(row => ({ month: row.month, currency: row.currency, spending: decimal(row.spending), income: decimal(row.income), transfers: decimal(row.transfers) })),
    monthlyBudget: [...monthly.values()]
      .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency))
      .map(row => ({
        month: row.month,
        currency: row.currency,
        total: decimal(row.total),
        unclassified: decimal(row.unclassified),
        incompleteRecords: row.incompleteRecords,
        buckets: [...row.buckets].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, total]) => ({ bucket, total: decimal(total) }))
      })),
    warrantyCandidates: ledger.records.flatMap(row =>
      row.facts.financialKind === 'purchase' || row.facts.financialKind === 'bill'
        ? row.facts.items.filter(item => item.warranty.candidate).map(item => ({ recordId: row.id, itemId: item.id, name: item.normalizedName ?? item.rawName, retention: row.retention.status }))
        : [])
  };
}
