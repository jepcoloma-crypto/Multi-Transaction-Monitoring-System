import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomeReport, type IncomeSourceRow } from '../services/incomeReport';

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

  assert.equal(rows[0].feeIncome, 1840);
  assert.equal(rows[0].totalIncome, 1886);
  assert.equal(summary.feeIncome, 1840);
  assert.equal(summary.totalIncome, 1886);
  // An operator has to be able to walk left across the row and reach the last
  // column without trusting a figure they cannot reconstruct.
  assert.equal(rows[0].txnFees + rows[0].additionalCharges + rows[0].transferFees, rows[0].feeIncome);
  assert.equal(rows[0].feeIncome + rows[0].loadMargin, rows[0].totalIncome);
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
  // twice for one transaction.
  assert.equal(rows[0].feeIncome, 1815);
  assert.equal(summary.feeIncome, 1815);
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
