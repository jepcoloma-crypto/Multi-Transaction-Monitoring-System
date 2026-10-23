// R1 — Outgoings by purpose: the two manual forms that hand money out of a
// branch, side by side.
//
// `operating_expense` (Record expense) counts in the expense reports;
// `cash_payment` (Payments) deliberately does not — migration 045 kept it out of
// EXPENSE_BUCKETS because "cash that left and never was a cost of the business"
// is not spending. The two forms offer the SAME categories (rent, salary,
// utilities, supplier payment…), so "what did we pay out in March" is only
// answerable by reading both halves together — which is what this report does,
// without ever folding one into the other.
//
// Everything here is pure: the route reads ledger rows and this decides what
// they mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutgoingsReport, OUTGOINGS_HALVES, OUTGOINGS_CODES, type OutgoingsSourceRow } from '../services/outgoingsReport';
import { bucketFor } from '../services/cashManagement';

const row = (overrides: Partial<OutgoingsSourceRow> = {}): OutgoingsSourceRow => ({
  branch_id: 'b1',
  branch_name: 'Main Branch',
  entry_type: 'debit',
  amount: '1000.00',
  source_type: 'transaction',
  txn_code: 'operating_expense',
  transaction_id: 't1',
  transaction_number: '100',
  category_name: 'Rent',
  payee: 'Landlord',
  reference_number: null,
  description: 'October rent',
  entry_date: '2026-10-14T08:00:00Z',
  ...overrides,
});

test('the two halves stay separate and add back to the total', () => {
  const report = buildOutgoingsReport([
    row({ id: 'e1', txn_code: 'operating_expense', category_name: 'Rent', amount: '5000.00' }),
    row({ id: 'p1', txn_code: 'cash_payment', category_name: 'Rent', amount: '1500.00' }),
  ]);

  const rent = report.rows.find((r) => r.category === 'Rent');
  assert.ok(rent, 'the shared category appears once');
  assert.equal(rent!.expense, 5000, 'the expense half');
  assert.equal(rent!.payment, 1500, 'the payment half');
  assert.equal(rent!.total, 6500, 'the purpose total across both forms');
  assert.equal(rent!.expenseCount, 1);
  assert.equal(rent!.paymentCount, 1);

  assert.equal(report.summary.expenseTotal, 5000);
  assert.equal(report.summary.paymentTotal, 1500);
  assert.equal(report.summary.totalOutgoings, 6500);
  assert.equal(report.summary.expenseTotal + report.summary.paymentTotal, report.summary.totalOutgoings,
    'the halves add back to the total');
});

test('a category is never folded into the other half, even at one peso', () => {
  const report = buildOutgoingsReport([
    row({ txn_code: 'cash_payment', category_name: 'Salary', amount: '1.00' }),
  ]);
  const salary = report.rows[0];
  assert.equal(salary.expense, 0, 'a payment is not an expense however small');
  assert.equal(salary.payment, 1);
  assert.equal(salary.expenseCount, 0);
  assert.equal(salary.count, 1);
});

// A debit leaves the drawer and a credit is money that came back — the same
// reading `buildCashStatement` applies to a bucket, so this report and the
// statement's Uses line can never disagree about the sign of a peso.
test('a debit reads as outgoings and a credit nets them down', () => {
  const report = buildOutgoingsReport([
    row({ id: 'e1', amount: '95000.00', entry_type: 'debit' }),
    row({ id: 'e2', amount: '5000.00', entry_type: 'credit' }),
  ]);
  assert.equal(report.summary.totalOutgoings, 90000, 'the returned money reduces what was paid out');
  assert.equal(report.rows[0].total, 90000);
});

// Centavos, not floats: 0.10 + 0.05 is 0.15000000000000002, and a printed
// total that disagrees with its own rows by a fraction is a total nobody trusts.
test('the totals are summed in whole centavos', () => {
  const report = buildOutgoingsReport([
    row({ id: 'e1', amount: '0.10', category_name: 'Bank Fee' }),
    row({ id: 'e2', amount: '0.05', category_name: 'Bank Fee' }),
  ]);
  assert.equal(report.summary.totalOutgoings, 0.15);
  assert.equal(report.rows[0].total, 0.15);
});

test('a row with no category is named rather than dropped', () => {
  const report = buildOutgoingsReport([row({ category_name: null })]);
  assert.equal(report.rows.length, 1, 'nothing vanishes');
  assert.equal(report.rows[0].category, 'Uncategorised');
  assert.equal(report.rows[0].categoryId, null);
});

test('rows are ordered by what was paid out, largest first', () => {
  const report = buildOutgoingsReport([
    row({ id: 'a', category_name: 'Rent', amount: '100.00' }),
    row({ id: 'b', category_name: 'Salary', amount: '9000.00' }),
    row({ id: 'c', category_name: 'Utilities', amount: '500.00' }),
  ]);
  assert.deepEqual(report.rows.map((r) => r.category), ['Salary', 'Utilities', 'Rent']);
});

test('the branch rows add back to the summary, as Consolidated does', () => {
  const report = buildOutgoingsReport([
    row({ branch_id: 'b1', branch_name: 'Main Branch', category_name: 'Rent', amount: '1000.00' }),
    row({ branch_id: 'b2', branch_name: 'Satellite', category_name: 'Rent', amount: '2500.00' }),
    row({ branch_id: 'b2', branch_name: 'Satellite', category_name: 'Salary', amount: '500.00', txn_code: 'cash_payment' }),
  ]);
  assert.equal(report.branches.length, 2);
  const summed = report.branches.reduce((total, b) => total + b.total, 0);
  assert.equal(summed, report.summary.totalOutgoings, 'no branch row is orphaned or double counted');
  assert.equal(report.summary.branchCount, 2);
});

test('no rows still produces a report with zeros, never undefined', () => {
  const report = buildOutgoingsReport([]);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.branches, []);
  assert.equal(report.summary.totalOutgoings, 0);
  assert.equal(report.summary.expenseTotal, 0);
  assert.equal(report.summary.paymentTotal, 0);
  assert.equal(report.summary.count, 0);
  assert.equal(report.summary.branchCount, 0);
});

test('a string amount and a numeric amount are read the same way', () => {
  const report = buildOutgoingsReport([
    row({ id: 'a', amount: '100.00' }),
    row({ id: 'b', amount: 200 as unknown as string }),
  ]);
  assert.equal(report.summary.totalOutgoings, 300);
});

test('the two halves are named for what they are, not merely left and right', () => {
  assert.equal(OUTGOINGS_HALVES.expense.code, 'operating_expense');
  assert.equal(OUTGOINGS_HALVES.payment.code, 'cash_payment');
  assert.match(OUTGOINGS_HALVES.payment.label, /outside/i, 'the payment half must say it is not an expense');
});

// The one claim that cannot be tested by running the report: the route selects
// its rows with a hand-written `WHERE tt.code IN (...)` built from
// OUTGOINGS_CODES, while every other reader of this ledger asks `bucketFor`
// which bucket a row belongs to. The two are separate pieces of knowledge, and
// they have to agree — if a code ever buckets into operating_expenses or
// cash_payments without being in OUTGOINGS_CODES, Sources and Uses would count
// a peso this report never shows, and neither would notice.
test('the route’s WHERE clause and the classifier agree, code for code', () => {
  // Each code the route asks for is filed under its own bucket by the same
  // classifier the statement uses.
  assert.equal(bucketFor('transaction', OUTGOINGS_HALVES.expense.code), 'operating_expenses');
  assert.equal(bucketFor('transaction', OUTGOINGS_HALVES.payment.code), 'cash_payments');
  for (const code of OUTGOINGS_CODES) {
    const bucket = bucketFor('transaction', code);
    assert.ok(
      bucket === 'operating_expenses' || bucket === 'cash_payments',
      `${code} files under ${bucket}, so the route's IN clause would miss it`,
    );
  }

  // And nothing else reaches either bucket. The list is the classifier's own
  // reachable set (see cashManagement.test.ts); a new code that began filing
  // there would have to be added to OUTGOINGS_CODES in the same change, and
  // this is what fails when it is not.
  const everyOtherCode = [
    'owner_funding', 'owner_return', 'transfer_in', 'transfer_out',
    'cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal',
    'load_purchase', 'expense', 'service_fee', 'bill_payment', 'refund',
    'other_income', 'refund_received', 'adjustment_in', 'adjustment_out',
    'loan_received', 'loan_repayment',
    'something_unrecognised',
  ];
  for (const code of everyOtherCode) {
    const bucket = bucketFor('transaction', code);
    assert.notEqual(bucket, 'operating_expenses', `${code} reaches operating_expenses but is not in OUTGOINGS_CODES`);
    assert.notEqual(bucket, 'cash_payments', `${code} reaches cash_payments but is not in OUTGOINGS_CODES`);
  }

  // The LEFT JOIN misses: a ledger row with no transaction behind it carries no
  // code, so the IN clause drops it — and so does the classifier, which falls
  // through to the source type and lands elsewhere. An empty set and an
  // unbucketed row are the same answer, not an accident.
  assert.equal(bucketFor('transaction', null), 'other');
  assert.equal(bucketFor(null, null), 'other');
});
