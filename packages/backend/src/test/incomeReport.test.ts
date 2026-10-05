import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomeReport, buildIncomeDetail, type IncomeSourceRow } from '../services/incomeReport';

const row = (overrides: Partial<IncomeSourceRow> = {}): IncomeSourceRow => ({
  account_id: 'acc-1',
  account_name: 'Jed Bautista',
  provider_name: 'TNT',
  account_type: 'E-Wallet',
  txn_count: 0,
  txn_fees: 0,
  additional_charges: 0,
  reversed_excluded: 0,
  transfer_count: 0,
  transfer_fees: 0,
  load_count: 0,
  load_revenue: 0,
  load_cost: 0,
  load_margin: 0,
  ...overrides,
});

test('every total is the sum of the components printed beside it', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '1800.00', additional_charges: '30.00', transfer_fees: '10.00', load_margin: '46.00' }),
  ]);

  assert.equal(rows[0].feeIncome, 1800);
  assert.equal(rows[0].totalIncome, 1846);
  assert.equal(summary.feeIncome, 1800);
  assert.equal(summary.totalIncome, 1846);
  // An operator has to be able to walk left across the row and reach the last
  // column without trusting a figure they cannot reconstruct. Charges are the
  // exception the next test covers: they print on the row but are deliberately
  // outside both totals, so the addition stops at fee income.
  assert.equal(rows[0].txnFees, rows[0].feeIncome);
  assert.equal(rows[0].feeIncome + rows[0].loadMargin, rows[0].totalIncome);
});

test('additional charges are carried on the row but never totalled as income', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '1800.00', additional_charges: '30.00', load_margin: '46.00' }),
  ]);

  // The charge is a figure the operator reads, not revenue the company earned,
  // so it gets a column and a card of its own. Folding it into feeIncome made
  // the card claim 1,830 of income the account had not made.
  assert.equal(rows[0].additionalCharges, 30);
  assert.equal(summary.additionalCharges, 30);
  assert.equal(rows[0].feeIncome, 1800);
  assert.equal(summary.feeIncome, 1800);
  assert.equal(rows[0].totalIncome, 1846);
  assert.equal(summary.totalIncome, 1846);
  // Charging the customer shows up on the row, but no total absorbs it.
  assert.equal(rows[0].txnFees + rows[0].additionalCharges + rows[0].loadMargin, 1876);
  assert.notEqual(rows[0].txnFees + rows[0].additionalCharges, rows[0].feeIncome);
});

test('a transfer service charge is carried on the row but never totalled as income', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '1800.00', additional_charges: '30.00', transfer_fees: '10.00', load_margin: '46.00' }),
  ]);

  // The sender is debited the amount plus this charge and the receiver is
  // credited only the amount, so it is money out and belongs to the expense
  // report. Leaving it here would put the same peso on two reports.
  assert.equal(rows[0].transferFees, 10);
  assert.equal(summary.transferFees, 10);
  assert.equal(rows[0].feeIncome, 1800);
  assert.equal(summary.totalIncome, 1846);
  // Every figure the row carries stays visible, and only fees and loading
  // margin reach the total — charges and transfer fees sit beside it.
  assert.equal(
    rows[0].txnFees + rows[0].additionalCharges + rows[0].transferFees + rows[0].loadMargin,
    1886,
  );
});

test('pg hands money over as strings and the cents survive the trip', () => {
  const { rows } = buildIncomeReport([row({ txn_fees: '10.10', load_margin: '0.05' })]);

  // A float adder gives 10.150000000000002 here; the report has to show 10.15.
  assert.equal(rows[0].feeIncome, 10.1);
  assert.equal(rows[0].totalIncome, 10.15);
});

test('a column of pennies sums exactly rather than drifting', () => {
  const many = Array.from({ length: 100 }, (_, i) => row({ account_id: `acc-${i}`, txn_fees: '0.10' }));
  const { summary } = buildIncomeReport(many);

  assert.equal(summary.txnFees, 10);
  assert.equal(summary.feeIncome, 10);
  assert.equal(summary.totalIncome, 10);
});

test('an account that earned nothing is still listed rather than dropped', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '10.00' }),
    row({ account_id: 'acc-2', account_name: 'Nelia Mae Timbang' }),
  ]);

  assert.equal(rows.length, 2);
  assert.equal(summary.accounts, 2);
  assert.equal(summary.earningAccounts, 1);
  assert.equal(rows[1].totalIncome, 0);
});

test('rows are ordered largest earner first, then by name', () => {
  const { rows } = buildIncomeReport([
    row({ account_id: 'a', account_name: 'Beta', txn_fees: '10.00' }),
    row({ account_id: 'b', account_name: 'Alpha', txn_fees: '900.00' }),
    row({ account_id: 'c', account_name: 'Gamma', txn_fees: '10.00' }),
  ]);

  assert.deepEqual(rows.map((r) => r.accountName), ['Alpha', 'Beta', 'Gamma']);
});

test('a reversed fee is reported as excluded and never reaches income', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '1800.00', additional_charges: '15.00', reversed_excluded: '250.00' }),
  ]);

  assert.equal(rows[0].reversedExcluded, 250);
  assert.equal(summary.reversedExcluded, 250);
  // The reversal refunded the fee, so counting it here would pay the company
  // twice for one transaction. The 15.00 of charges beside it never entered
  // feeIncome in the first place.
  assert.equal(rows[0].feeIncome, 1800);
  assert.equal(summary.feeIncome, 1800);
  assert.equal(rows[0].additionalCharges, 15);
});

test('a loading that lost money reduces the total instead of flooring at zero', () => {
  const { rows, summary } = buildIncomeReport([row({ txn_fees: '100.00', load_margin: '-25.00' })]);

  assert.equal(rows[0].loadMargin, -25);
  assert.equal(rows[0].totalIncome, 75);
  assert.equal(summary.loadMargin, -25);
  assert.equal(summary.totalIncome, 75);
});

test('a field the database left out reads as zero, never NaN', () => {
  const { rows, summary } = buildIncomeReport([{ account_id: 'acc-1', account_name: 'Bare' }]);

  assert.equal(rows[0].feeIncome, 0);
  assert.equal(rows[0].totalIncome, 0);
  assert.equal(summary.totalIncome, 0);
  assert.equal(Number.isNaN(summary.totalIncome), false);
});

test('a non-numeric value in a money column is ignored rather than poisoning the total', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_fees: '10.00' }),
    row({ account_id: 'acc-2', txn_fees: 'not a number' }),
  ]);

  assert.equal(rows[0].txnFees, 10);
  assert.equal(rows[1].txnFees, 0);
  assert.equal(summary.txnFees, 10);
  assert.equal(Number.isNaN(summary.feeIncome), false);
});

test('counts arrive as strings from pg and come back as integers', () => {
  const { rows, summary } = buildIncomeReport([
    row({ txn_count: '88', transfer_count: '7', load_count: '17' }),
  ]);

  assert.equal(rows[0].txnCount, 88);
  assert.equal(summary.txnCount, 88);
  assert.equal(summary.transferCount, 7);
  assert.equal(summary.loadCount, 17);
});

test('an account with no name falls back to its identifier rather than a blank cell', () => {
  const { rows } = buildIncomeReport([{ account_id: 'acc-9', account_name: '   ' }]);

  assert.equal(rows[0].accountName, 'acc-9');
});

// The tree behind an account row.

test('the cash tab totals exactly what the account row prints beside it', () => {
  const detail = buildIncomeDetail({
    cash: [
      { id: 'c1', status: 'completed', fee: '1800.00', charges: '30.00' },
      { id: 'c2', status: 'completed', fee: '0.00', charges: '0.00' },
      { id: 'c3', status: 'reversed', fee: '175.00', charges: '15.00' },
    ],
  });
  const parent = buildIncomeReport([
    { account_id: 'a', account_name: 'Jed', txn_fees: '1800.00', additional_charges: '30.00', reversed_excluded: '190.00' },
  ]);

  // The whole point of the drill-down is that two independently summed figures
  // agree. If they were both copied from one source they could not disagree.
  assert.equal(detail.summary.earned, parent.rows[0].txnFees + parent.rows[0].additionalCharges);
  assert.equal(detail.summary.refunded, parent.rows[0].reversedExcluded);
  assert.equal(detail.summary.cashCount, 3);
  assert.equal(detail.summary.cashCompletedCount, 2);
  assert.equal(detail.summary.cashReversedCount, 1);
});

test('a reversed fee is totalled as refunded and never reaches earned', () => {
  const { cash, summary } = buildIncomeDetail({
    cash: [
      { id: 'c1', status: 'completed', fee: '10.00', charges: '5.00' },
      { id: 'c2', status: 'reversed', fee: '25.00', charges: '15.00' },
    ],
  });

  assert.equal(summary.earnedFee, 10);
  assert.equal(summary.earnedCharges, 5);
  assert.equal(summary.earned, 15);
  assert.equal(summary.refundedFee, 25);
  assert.equal(summary.refundedCharges, 15);
  assert.equal(summary.refunded, 40);
  assert.equal(cash[0].isReversed, false);
  assert.equal(cash[1].isReversed, true);
  assert.equal(cash[1].feeCharges, 40);
});

test('a row with no fee or charge still appears, contributing nothing', () => {
  const { cash, summary } = buildIncomeDetail({
    cash: [{ id: 'c1', status: 'completed', fee: '0.00', charges: null }],
  });

  assert.equal(cash.length, 1);
  assert.equal(cash[0].feeCharges, 0);
  assert.equal(summary.earned, 0);
  assert.equal(summary.cashCompletedCount, 1);
});

test('the loading tab totals revenue, cost and margin from its own rows', () => {
  const { loading, summary } = buildIncomeDetail({
    loading: [
      { id: 'l1', total_revenue: '10.10', total_cost: '10.05', profit: '0.05' },
      { id: 'l2', total_revenue: '20.00', total_cost: '19.00', profit: '1.00' },
    ],
  });

  assert.equal(loading[0].revenue, 10.1);
  assert.equal(loading[0].cost, 10.05);
  assert.equal(summary.loadRevenue, 30.1);
  assert.equal(summary.loadCost, 29.05);
  // 0.05 + 1.00 summed as floats is 1.0500000000000003.
  assert.equal(summary.loadMargin, 1.05);
  assert.equal(summary.loadingCount, 2);
});

test('a fractional quantity survives rather than being rounded down', () => {
  const { loading } = buildIncomeDetail({ loading: [{ id: 'l1', quantity: '1.5' }] });

  assert.equal(loading[0].quantity, 1.5);
});

test('the transfers tab totals its fee from source-side rows only', () => {
  const { transfers, summary } = buildIncomeDetail({
    transfers: [
      { id: 't1', transfer_amount: '5000.00', transfer_fee: '10.00', transfer_reference: 'TRF-2026-000021' },
      { id: 't2', transfer_amount: '1200.00', transfer_fee: '0.00' },
    ],
  });

  assert.equal(transfers[0].transferReference, 'TRF-2026-000021');
  assert.equal(summary.transferAmount, 6200);
  assert.equal(summary.transferFees, 10);
  assert.equal(summary.transferCount, 2);
});

test('an account with no activity in the period yields three empty tabs, not an error', () => {
  const detail = buildIncomeDetail({});

  assert.deepEqual(detail.cash, []);
  assert.deepEqual(detail.loading, []);
  assert.deepEqual(detail.transfers, []);
  assert.equal(detail.summary.cashCount, 0);
  assert.equal(detail.summary.earned, 0);
  assert.equal(detail.summary.refunded, 0);
  assert.equal(detail.summary.loadMargin, 0);
  assert.equal(detail.summary.transferFees, 0);
  assert.equal(detail.summary.earned + detail.summary.refunded, 0);
});

test('a timestamp becomes an ISO string the frontend can parse', () => {
  const { cash, loading, transfers } = buildIncomeDetail({
    cash: [{ id: 'c1', transaction_date: new Date('2026-09-25T14:06:00.000Z') }],
    loading: [{ id: 'l1', created_at: '2026-09-26T02:00:00Z' }],
    transfers: [{ id: 't1', transfer_date: null }],
  });

  assert.equal(cash[0].transactionDate, '2026-09-25T14:06:00.000Z');
  assert.equal(loading[0].createdAt, '2026-09-26T02:00:00.000Z');
  assert.equal(transfers[0].transferDate, null);
});

test('an absent transaction number reads as null so the cell can show a dash', () => {
  const { cash, loading, transfers } = buildIncomeDetail({
    cash: [{ id: 'c1', transaction_number: null }],
    loading: [{ id: 'l1' }],
    transfers: [{ id: 't1', transfer_number: '21' }],
  });

  assert.equal(cash[0].transactionNumber, null);
  assert.equal(loading[0].transactionNumber, null);
  assert.equal(transfers[0].transferNumber, 21);
});

test('rows stay in the order the query handed them; the service does not re-sort', () => {
  const { transfers } = buildIncomeDetail({ transfers: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] });

  assert.deepEqual(transfers.map((t) => t.id), ['t1', 't2', 't3']);
});

test('a row carries its branch across the row mapping', () => {
  // The query returns snake_case and the payload is camelCase, so a branch
  // that is selected but not copied here reaches the renderer as undefined
  // and every subtotal silently groups under one unknown branch.
  const [carried] = buildIncomeReport([
    row({ branch_id: '239c3926-3745-4e4e-b73a-63c9fe8c8a17', branch_name: 'Main Branch' }),
  ]).rows;

  assert.equal(carried.branchId, '239c3926-3745-4e4e-b73a-63c9fe8c8a17');
  assert.equal(carried.branchName, 'Main Branch');
});

test('a row the query gave no branch reads as null, never undefined', () => {
  // Two accounts can share a name across branches, so an absent branch must
  // not quietly become an empty string that prints as a blank cell -- and
  // undefined would not be caught by a `|| '—'` fallback either.
  const [bare] = buildIncomeReport([row()]).rows;

  assert.equal(bare.branchId, null);
  assert.equal(bare.branchName, null);
});
