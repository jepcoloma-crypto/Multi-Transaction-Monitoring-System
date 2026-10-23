// Borrowings & repayments — the company's debt, lender by lender.
//
// The statement's `borrowingsOutstanding` is one company-wide net that cannot
// say who is owed. This report puts each lender on its own line (received,
// repaid, net), reads the flows from `transactions` so a pending borrowing —
// which has no ledger rows — is still shown as agreed-but-not-yet-moved, and
// carries the ledger's own outstanding-to-date figure beside the flows so the
// sheet and the statement can never disagree about how much is owed.
//
// Pure: the route reads the rows and the outstanding figure, this decides what
// they mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBorrowingsReport,
  BORROWING_CODES,
  type BorrowingSourceRow,
} from '../services/borrowingsReport';

const row = (overrides: Partial<BorrowingSourceRow> = {}): BorrowingSourceRow => ({
  id: 'l1',
  branch_id: 'b1',
  branch_name: 'Main Branch',
  account_name: 'Ma. Jessica Bautista',
  txn_code: 'loan_received',
  amount: '50000.00',
  payment_method: 'bank',
  transaction_number: '301',
  reference_number: null,
  payee: 'Ma. Jessica Bautista',
  description: 'Working capital',
  status: 'completed',
  recorded_by_username: 'admin',
  transaction_date: '2026-10-14T00:00:00Z',
  ...overrides,
});

test('the report reads exactly the two loan codes', () => {
  assert.deepEqual([...BORROWING_CODES].sort(), ['loan_received', 'loan_repayment']);
});

test('received, repaid and net are signed the right way round', () => {
  const report = buildBorrowingsReport([
    row({ id: 'a', txn_code: 'loan_received', amount: '50000.00' }),
    row({ id: 'b', txn_code: 'loan_repayment', amount: '10000.00' }),
  ]);
  assert.equal(report.summary.received, 50000);
  assert.equal(report.summary.repaid, 10000);
  assert.equal(report.summary.net, 40000);
  const repaid = report.rows.find((r) => r.id === 'b');
  assert.equal(repaid?.amount, -10000);
});

test('each lender sits on its own line, netting to what that lender moved', () => {
  const report = buildBorrowingsReport([
    row({ id: 'a', payee: 'Ma. Jessica Bautista', amount: '50000.00' }),
    row({ id: 'b', payee: 'Ma. Jessica Bautista', txn_code: 'loan_repayment', amount: '10000.00' }),
    row({ id: 'c', payee: 'Nelia Mae Timbang', amount: '15000.00' }),
  ]);
  assert.equal(report.lenders.length, 2);
  const jessica = report.lenders.find((l) => l.lender === 'Ma. Jessica Bautista');
  assert.equal(jessica?.received, 50000);
  assert.equal(jessica?.repaid, 10000);
  assert.equal(jessica?.net, 40000);
  const nelia = report.lenders.find((l) => l.lender === 'Nelia Mae Timbang');
  assert.equal(nelia?.net, 15000);
});

test('a blank payee is named rather than dropped, so the rows still add back', () => {
  const report = buildBorrowingsReport([
    row({ id: 'a', payee: null, amount: '1000.00' }),
    row({ id: 'b', payee: '   ', amount: '2000.00' }),
  ]);
  assert.equal(report.lenders.length, 1);
  assert.equal(report.lenders[0].lender, 'Unnamed lender');
  assert.equal(report.lenders[0].received, 3000);
});

test('an unknown code is ignored rather than guessed at', () => {
  const report = buildBorrowingsReport([row({ id: 'a', txn_code: 'adjustment_in' })]);
  assert.equal(report.summary.count, 0);
});

test('a pending borrowing is shown and counted, but flagged as not yet moved', () => {
  const report = buildBorrowingsReport([
    row({ id: 'a', status: 'pending', amount: '20000.00' }),
    row({ id: 'b', status: 'completed', amount: '5000.00' }),
  ]);
  assert.equal(report.summary.pendingCount, 1);
  assert.equal(report.summary.received, 25000);
});

test('the outstanding headline is the ledger figure the route passes in, untouched', () => {
  const report = buildBorrowingsReport([row({ id: 'a', amount: '100.00' })], 40500);
  assert.equal(report.summary.outstandingToDate, 40500);
  // And it defaults to zero when the route has nothing to pass.
  assert.equal(buildBorrowingsReport([]).summary.outstandingToDate, 0);
});

test('branch lines subtotal, and the biggest debt is listed first', () => {
  const report = buildBorrowingsReport([
    row({ id: 'a', branch_id: 'b1', branch_name: 'Main Branch', amount: '5000.00' }),
    row({ id: 'b', branch_id: 'b2', branch_name: 'Reina Mercedes', amount: '20000.00' }),
  ]);
  assert.deepEqual(report.branches.map((br) => br.branchId), ['b2', 'b1']);
  assert.equal(report.branches[0].received, 20000);
});
