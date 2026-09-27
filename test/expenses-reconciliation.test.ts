import { expect, it } from 'vitest';
import { emptyExpensesLedger, expenseDraftSchema, expenseLedgerSchema, type ExpenseRecord } from '../src/shared/expenses.js';
import {
  bankTransactionSchema, compareMonthlyEvidenceToReference, deriveExpenseReconciliationSummary,
  deriveMonthlyEvidenceSummary, emptyExpenseReconciliation, expenseReconciliationSchema,
  monthlyExpenseReferenceSchema, normalizeReconciliationMerchant, suggestExpenseMatches
} from '../src/shared/expenses-reconciliation.js';

const ids = {
  normal: '11111111-1111-4111-8111-111111111111',
  trappan: '22222222-2222-4222-8222-222222222222',
  lidl: '33333333-3333-4333-8333-333333333333',
  mio: '44444444-4444-4444-8444-444444444444'
};

function record(id: string, messageId: string, merchant: string, total: string, purchasedOn: string, extra: Record<string, unknown> = {}): ExpenseRecord {
  const draft = expenseDraftSchema.parse({
    source: { kind: 'text', sessionId: 'session', conversationId: 'chat', messageId, sourceIndex: 0, sha256: null },
    facts: {
      purchasedOn, merchant, location: 'Stockholm', currency: 'SEK', total, items: [], notes: null, ...extra
    }
  });
  return { ...draft, id, createdAt: 1, updatedAt: 1 };
}

const expenses = expenseLedgerSchema.parse({
  version: 1,
  revision: 4,
  records: [
    record(ids.normal, 'normal', 'Normal', '320', '2026-09-01'),
    record(ids.trappan, 'trappan', 'Trappan', '135', '2026-09-03'),
    record(ids.lidl, 'lidl', 'Lidl', '59.54', '2026-09-05'),
    record(ids.mio, 'mio', 'Mio', '821', '2026-09-07', {
      subtotal: '921', discount: '-100', paymentCardLast4: '4242', paymentReference: 'MIO-ORDER-7'
    })
  ],
  corrections: []
});

const bank = [
  bankTransactionSchema.parse({ id: 'bank-normal', source: { kind: 'statement', sourceId: 'sept.csv', externalId: 'tx-1' }, amount: '320', currency: 'SEK', bookingDate: '2026-09-03', transactionDate: '2026-09-01', rawMerchant: 'NORMAL SWEDEN AB' }),
  bankTransactionSchema.parse({ id: 'bank-trappan', source: { kind: 'statement', sourceId: 'sept.csv', externalId: 'tx-2' }, amount: '135', currency: 'SEK', bookingDate: '2026-09-05', rawMerchant: 'TRAPPAN STOCKHOLM' }),
  bankTransactionSchema.parse({ id: 'bank-lidl', source: { kind: 'statement', sourceId: 'sept.csv', externalId: 'tx-3' }, amount: '59.54', currency: 'SEK', bookingDate: '2026-09-06', rawMerchant: 'LIDL 018 HANINGE' }),
  bankTransactionSchema.parse({ id: 'bank-mio', source: { kind: 'statement', sourceId: 'sept.csv', externalId: 'tx-4' }, amount: '821', currency: 'SEK', bookingDate: '2026-09-09', rawMerchant: 'MIO AB HANINGE', cardLast4: '4242', reference: 'MIO-ORDER-7' })
];

it('keeps bank identity/provenance separate and makes omitted optional hints backward compatible', () => {
  expect(emptyExpenseReconciliation()).toEqual({ version: 1, bankTransactions: [], links: [] });
  expect(bank[0]).toMatchObject({ transactionDate: '2026-09-01', cardLast4: null, reference: null });
  expect(expenses.records[0]!.facts).toMatchObject({ paymentCardLast4: null, paymentReference: null });
  expect(normalizeReconciliationMerchant('Normal Sweden AB')).toBe('normal');
});

it('suggests probable matches across posting delays and merchant-string variation without auto-confirming', () => {
  const normal = suggestExpenseMatches(bank[0], expenses.records);
  const trappan = suggestExpenseMatches(bank[1], expenses.records);
  const lidl = suggestExpenseMatches(bank[2], expenses.records);
  const mio = suggestExpenseMatches(bank[3], expenses.records);
  expect(normal[0]).toMatchObject({ expenseRecordId: ids.normal, state: 'probable' });
  expect(trappan[0]).toMatchObject({ expenseRecordId: ids.trappan, state: 'probable' });
  expect(lidl[0]).toMatchObject({ expenseRecordId: ids.lidl, state: 'probable' });
  expect(mio[0]).toMatchObject({ expenseRecordId: ids.mio, state: 'probable', score: 100 });
  expect(mio[0]!.reasons).toEqual(expect.arrayContaining(['exact amount', 'date within 3 days', 'card last4 exact', 'payment reference exact']));
  expect(expenses.records.find(row => row.id === ids.mio)?.facts).toMatchObject({ total: '821', subtotal: '921', discount: '-100' });
});

it('does not use merchandise subtotal in place of the actual receipt/card total', () => {
  const wrongDebit = bankTransactionSchema.parse({ ...bank[3], id: 'bank-mio-subtotal', source: { kind: 'manual', sourceId: 'manual-mio' }, amount: '921' });
  expect(suggestExpenseMatches(wrongDebit, expenses.records).some(row => row.expenseRecordId === ids.mio)).toBe(false);
});

it('rejects heuristic auto-confirmation and allows explicit confirmed/rejected audit links', () => {
  const now = 100;
  expect(expenseReconciliationSchema.safeParse({
    version: 1, bankTransactions: bank, links: [{
      id: 'bad-auto-confirm', bankTransactionId: 'bank-normal', expenseRecordId: ids.normal, state: 'confirmed', score: 95,
      reasons: ['fuzzy match'], createdAt: now, updatedAt: now, decisionSource: 'heuristic'
    }]
  }).success).toBe(false);
  expect(expenseReconciliationSchema.safeParse({
    version: 1, bankTransactions: bank, links: [{
      id: 'explicit-confirm', bankTransactionId: 'bank-normal', expenseRecordId: ids.normal, state: 'confirmed', score: 95,
      reasons: ['user verified statement line'], createdAt: now, updatedAt: now, decisionSource: 'user'
    }, {
      id: 'explicit-reject', bankTransactionId: 'bank-trappan', expenseRecordId: ids.normal, state: 'rejected', score: 70,
      reasons: ['user rejected candidate'], createdAt: now, updatedAt: now, decisionSource: 'user'
    }]
  }).success).toBe(true);
});

it('suppresses only confirmed receipt duplicates in the derived view while preserving both evidence sets', () => {
  const now = 100;
  const reconciliation = expenseReconciliationSchema.parse({
    version: 1,
    bankTransactions: bank,
    links: [
      { id: 'normal-confirm', bankTransactionId: 'bank-normal', expenseRecordId: ids.normal, state: 'confirmed', score: 95, reasons: ['verified'], createdAt: now, updatedAt: now, decisionSource: 'user' },
      { id: 'trappan-probable', bankTransactionId: 'bank-trappan', expenseRecordId: ids.trappan, state: 'probable', score: 89, reasons: ['candidate'], createdAt: now, updatedAt: now, decisionSource: 'heuristic' },
      { id: 'lidl-reject', bankTransactionId: 'bank-lidl', expenseRecordId: ids.lidl, state: 'rejected', score: 80, reasons: ['not this receipt'], createdAt: now, updatedAt: now, decisionSource: 'user' },
      { id: 'mio-confirm', bankTransactionId: 'bank-mio', expenseRecordId: ids.mio, state: 'confirmed', score: 100, reasons: ['verified card/reference'], createdAt: now, updatedAt: now, decisionSource: 'user' }
    ]
  });
  const summary = deriveExpenseReconciliationSummary(expenses, reconciliation);
  expect(summary).toMatchObject({ confirmedMatchCount: 2, probableLinkCount: 1, rejectedLinkCount: 1 });
  expect(summary.bankTransactions.map(row => [row.id, row.state])).toEqual([
    ['bank-normal', 'confirmed'], ['bank-trappan', 'probable'], ['bank-lidl', 'rejected'], ['bank-mio', 'confirmed']
  ]);
  expect(summary.totals).toEqual([{ currency: 'SEK', bankTotal: '1335.54', receiptTotal: '1335.54', suppressedReceiptTotal: '1141', combinedTotal: '1530.08' }]);
  expect(reconciliation.bankTransactions).toHaveLength(4);
  expect(expenses.records).toHaveLength(4);
});

it('compares reconstructed 2025 activity with a human-curated monthly ledger reference', () => {
  const now = 100;
  const reconciliation = expenseReconciliationSchema.parse({
    version: 1,
    bankTransactions: bank,
    links: bank.map((transaction, index) => ({
      id: `confirmed-${index}`,
      bankTransactionId: transaction.id,
      expenseRecordId: expenses.records[index]!.id,
      state: 'confirmed', score: 100, reasons: ['human verified'], createdAt: now, updatedAt: now, decisionSource: 'user'
    }))
  });
  const reference = monthlyExpenseReferenceSchema.parse({
    month: '2026-09', currency: 'SEK', source: { kind: 'human-ledger', sourceId: 'physical-ledger-page-2026-09' },
    outflowTotal: '1340', incomeTotal: null, buckets: []
  });
  const comparison = compareMonthlyEvidenceToReference(expenses, reconciliation, [reference]);
  expect(comparison).toEqual([expect.objectContaining({
    month: '2026-09', currency: 'SEK', referenceOutflowTotal: '1340', reconstructedOutflowTotal: '1335.54',
    outflowDifference: '-4.46', missingEvidence: []
  })]);
});

it('uses receipts as primary 2026 evidence while bank-only subscriptions/income fill gaps without double counting probable matches', () => {
  const normalOnly = expenseLedgerSchema.parse({ version: 1, revision: 1, records: [expenses.records[0]], corrections: [] });
  const reconciliation = expenseReconciliationSchema.parse({
    version: 1,
    bankTransactions: [
      bankTransactionSchema.parse({ ...bank[0], id: 'normal-probable', source: { kind: 'statement', sourceId: 'bank-shot', externalId: 'normal' } }),
      bankTransactionSchema.parse({ id: 'subscription', source: { kind: 'statement', sourceId: 'bank-shot', externalId: 'sub' }, amount: '99', currency: 'SEK', flow: 'debit', kind: 'subscription', bookingDate: '2026-09-10', rawMerchant: 'STREAMING SERVICE', budgetBucket: 'subscriptions' }),
      bankTransactionSchema.parse({ id: 'salary', source: { kind: 'statement', sourceId: 'bank-shot', externalId: 'salary' }, amount: '25000', currency: 'SEK', flow: 'credit', kind: 'income', bookingDate: '2026-09-25', rawMerchant: 'SALARY' })
    ],
    links: [{
      id: 'normal-probable-link', bankTransactionId: 'normal-probable', expenseRecordId: ids.normal,
      state: 'probable', score: 95, reasons: ['exact amount and close date'], createdAt: 100, updatedAt: 100, decisionSource: 'heuristic'
    }]
  });
  const monthly = deriveMonthlyEvidenceSummary(normalOnly, reconciliation);
  expect(monthly).toEqual([{
    month: '2026-09', currency: 'SEK', outflowTotal: '419', incomeTotal: '25000', transferTotal: '0', unclassified: '320',
    evidence: { receiptOnly: 0, confirmed: 0, bankOnlyDebit: 1, bankOnlyCredit: 1, bankOnlyTransfer: 0, probable: 1 },
    buckets: [{ bucket: 'subscriptions', total: '99' }]
  }]);
  const comparison = compareMonthlyEvidenceToReference(normalOnly, reconciliation, []);
  expect(comparison[0]!.missingEvidence).toEqual(expect.arrayContaining([
    'reconstructed month has no human reference',
    '1 bank debit(s) lack receipt evidence',
    '1 probable bank/receipt match(es) need review'
  ]));
});

it('tracks a savings transfer without counting it as reconstructed spending', () => {
  const reconciliation = expenseReconciliationSchema.parse({
    version: 1,
    bankTransactions: [
      bankTransactionSchema.parse({
        id: 'savings-transfer', source: { kind: 'statement', sourceId: 'bank-shot', externalId: 'save-1' },
        amount: '5000', currency: 'SEK', flow: 'debit', kind: 'transfer', bookingDate: '2026-09-20',
        rawMerchant: 'OWN SAVINGS ACCOUNT'
      })
    ],
    links: []
  });
  expect(deriveMonthlyEvidenceSummary(emptyExpensesLedger(), reconciliation)).toEqual([{
    month: '2026-09', currency: 'SEK', outflowTotal: '0', incomeTotal: '0', transferTotal: '5000', unclassified: '0',
    evidence: { receiptOnly: 0, confirmed: 0, bankOnlyDebit: 0, bankOnlyCredit: 0, bankOnlyTransfer: 1, probable: 0 },
    buckets: []
  }]);
});
