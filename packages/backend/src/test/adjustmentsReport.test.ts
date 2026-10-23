// Adjustments register — the correction book for the drawers.
//
// Read from `transactions` rather than ledger rows, because a pending
// adjustment has no ledger rows and the pending ones are exactly what the
// register exists to show: an adjustment recorded by anyone but an
// administrator waits for a second signature, and until it is approved it has
// not touched the drawer. The two `adjustment_out` rows a reversal posts as
// its counter-row (reference `REV-<number>`) are labelled `reversal`, never
// counted as corrections somebody took out of the till.
//
// Pure: the route reads the rows, this decides what they mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdjustmentsReport,
  ADJUSTMENT_CODES,
  type AdjustmentSourceRow,
} from '../services/adjustmentsReport';

const row = (overrides: Partial<AdjustmentSourceRow> = {}): AdjustmentSourceRow => ({
  id: 'a1',
  branch_id: 'b1',
  branch_name: 'Main Branch',
  account_name: 'Revolving Fund',
  txn_code: 'adjustment_in',
  amount: '15150.00',
  payment_method: 'cash',
  transaction_number: '475',
  reference_number: null,
  payee: null,
  description: 'Cash handed over by Reina Mercedes',
  status: 'pending',
  recorded_by_username: 'remittancevanessa',
  transaction_date: '2026-10-22T00:00:00Z',
  ...overrides,
});

test('the register is built from exactly the two adjustment codes, and none is unnamed', () => {
  assert.deepEqual([...ADJUSTMENT_CODES].sort(), ['adjustment_in', 'adjustment_out']);
});

test('an adjustment in is money in, an adjustment out is money out, and the net is signed', () => {
  const report = buildAdjustmentsReport([
    row({ id: 'a', txn_code: 'adjustment_in', amount: '15150.00' }),
    row({ id: 'b', txn_code: 'adjustment_out', amount: '5000.00', status: 'completed' }),
  ]);
  assert.equal(report.summary.totalIn, 15150);
  assert.equal(report.summary.totalOut, 5000);
  assert.equal(report.summary.net, 10150);
  assert.equal(report.rows[0].direction, 'in');
  assert.equal(report.rows[1].direction, 'out');
  assert.equal(report.rows[0].amount, 15150);
  assert.equal(report.rows[1].amount, -5000);
});

test('a pending row is counted and flagged, because it has not moved the drawer', () => {
  const report = buildAdjustmentsReport([
    row({ id: 'a', status: 'pending' }),
    row({ id: 'b', status: 'completed' }),
  ]);
  assert.equal(report.summary.pendingCount, 1);
  assert.equal(report.summary.count, 2);
  const pending = report.rows.find((r) => r.id === 'a');
  assert.equal(pending?.status, 'pending');
});

test('a reversal counter-row is shown and summed but never counted as a correction', () => {
  const report = buildAdjustmentsReport([
    // The counter-row a reversal writes, per the probe that found the pattern.
    row({ id: 'rev', txn_code: 'adjustment_out', amount: '500.00', reference_number: 'REV-100', transaction_number: '100', status: 'completed' }),
    row({ id: 'manual', txn_code: 'adjustment_out', amount: '300.00', reference_number: null, status: 'completed' }),
  ]);
  assert.equal(report.summary.reversalCount, 1);
  const reversal = report.rows.find((r) => r.id === 'rev');
  assert.equal(reversal?.role, 'reversal');
  assert.equal(report.rows.find((r) => r.id === 'manual')?.role, 'manual');
  // Both still move the drawer, so both are in the total.
  assert.equal(report.summary.totalOut, 800);
});

test('an unknown code is ignored rather than guessed at', () => {
  const report = buildAdjustmentsReport([
    row({ id: 'a', txn_code: 'loan_received' }),
  ]);
  assert.equal(report.summary.count, 0);
  assert.equal(report.rows.length, 0);
});

test('rows sort newest first, with the latest day ahead of a tie by magnitude', () => {
  const report = buildAdjustmentsReport([
    row({ id: 'old', amount: '90000.00', transaction_date: '2026-10-20T00:00:00Z' }),
    row({ id: 'new', amount: '100.00', transaction_date: '2026-10-23T00:00:00Z' }),
  ]);
  assert.deepEqual(report.rows.map((r) => r.id), ['new', 'old']);
});

test('branch lines subtotal per branch, with a null amount read as zero', () => {
  const report = buildAdjustmentsReport([
    row({ id: 'a', branch_id: 'b1', branch_name: 'Main Branch', amount: '1000.00' }),
    row({ id: 'b', branch_id: 'b1', branch_name: 'Main Branch', amount: '2000.00', txn_code: 'adjustment_out', status: 'completed' }),
    row({ id: 'c', branch_id: 'b2', branch_name: 'Reina Mercedes', amount: null as unknown as string }),
  ]);
  assert.equal(report.branches.length, 2);
  const main = report.branches.find((br) => br.branchId === 'b1');
  assert.equal(main?.in, 1000);
  assert.equal(main?.out, 2000);
  assert.equal(main?.net, -1000);
  const rm = report.branches.find((br) => br.branchId === 'b2');
  assert.equal(rm?.in, 0);
  assert.equal(report.summary.totalIn, 1000);
});
