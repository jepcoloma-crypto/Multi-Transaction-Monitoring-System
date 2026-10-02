import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpenseReport, buildExpenseDetail, type ExpenseSourceRow, type ExpenseDetailSourceRow } from '../services/expenseReport';
import { buildIncomeReport, type IncomeSourceRow } from '../services/incomeReport';

const row = (overrides: Partial<ExpenseSourceRow> = {}): ExpenseSourceRow => ({
  account_id: 'acc-1',
  account_name: 'Jed Bautista',
  provider_name: 'TNT',
  account_type: 'E-Wallet',
  transfer_count: 0,
  transfer_service_fee: 0,
  ...overrides,
});

test('every total is the sum of the components printed beside it', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_count: '3', transfer_service_fee: '30.00' }),
  ]);

  assert.equal(rows[0].serviceFees, 30);
  assert.equal(rows[0].totalExpense, 30);
  // An operator has to be able to walk across the row and reach the last
  // column without trusting a figure they cannot reconstruct.
  assert.equal(rows[0].serviceFees, rows[0].totalExpense);
  assert.equal(summary.serviceFees, 30);
  assert.equal(summary.totalExpense, 30);
  assert.equal(summary.transferCount, 3);
});

test('the service charge on a transfer is reported as money out', () => {
  // Sender debited 5010, receiver credited 5000: the 10 leaves the pool.
  const { rows, summary } = buildExpenseReport([row({ transfer_service_fee: '10.00' })]);

  assert.equal(rows[0].serviceFees, 10);
  assert.equal(summary.totalExpense, 10);
  // Never negative — the charge is deducted from the sender, it is not a
  // refund or a credit to the company.
  assert.equal(summary.totalExpense < 0, false);
});

test('the same charge is totalled as expense and nowhere as income', () => {
  const source: ExpenseSourceRow[] = [
    row({ transfer_count: '4', transfer_service_fee: '10.00' }),
  ];
  const incomeSource: IncomeSourceRow[] = [
    {
      account_id: 'acc-1',
      account_name: 'Jed Bautista',
      txn_fees: '1800.00',
      additional_charges: '30.00',
      transfer_count: '4',
      transfer_fees: '10.00',
      load_margin: '46.00',
    },
  ];

  const expense = buildExpenseReport(source);
  const income = buildIncomeReport(incomeSource);

  // The figure stays visible on the income payload so the two reports can be
  // seen to describe one charge — but only the expense report totals it.
  assert.equal(income.summary.transferFees, expense.summary.totalExpense);
  assert.equal(income.summary.feeIncome, 1830);
  assert.equal(income.summary.totalIncome, 1876);
  assert.equal(expense.summary.totalExpense, 10);
  // Income plus expense equals the old income figure, so the 10.00 that used
  // to sit inside income has moved rather than been counted twice.
  assert.equal(income.summary.totalIncome + expense.summary.totalExpense, 1886);
});

test('pg hands money over as strings and the cents survive the trip', () => {
  const { rows } = buildExpenseReport([row({ transfer_service_fee: '10.10' })]);

  assert.equal(rows[0].serviceFees, 10.1);
});

test('a column of pennies sums exactly rather than drifting', () => {
  const many = Array.from({ length: 100 }, (_, i) => row({ account_id: `acc-${i}`, transfer_service_fee: '0.10' }));
  const { summary } = buildExpenseReport(many);

  assert.equal(summary.serviceFees, 10);
  assert.equal(summary.totalExpense, 10);
});

test('an account that paid nothing is still listed rather than dropped', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_service_fee: '10.00' }),
    row({ account_id: 'acc-2', account_name: 'Nelia Mae Timbang' }),
  ]);

  assert.equal(rows.length, 2);
  assert.equal(summary.accounts, 2);
  assert.equal(summary.payingAccounts, 1);
  assert.equal(rows[1].totalExpense, 0);
});

test('rows are ordered largest spender first, then by name', () => {
  const { rows } = buildExpenseReport([
    row({ account_id: 'a', account_name: 'Beta', transfer_service_fee: '10.00' }),
    row({ account_id: 'b', account_name: 'Alpha', transfer_service_fee: '20.00' }),
    row({ account_id: 'c', account_name: 'Gamma', transfer_service_fee: '10.00' }),
  ]);

  assert.deepEqual(rows.map((r) => r.accountName), ['Alpha', 'Beta', 'Gamma']);
});

test('a field the database left out reads as zero, never NaN', () => {
  const { rows, summary } = buildExpenseReport([{ account_id: 'acc-1', account_name: 'Bare' }]);

  assert.equal(rows[0].serviceFees, 0);
  assert.equal(rows[0].totalExpense, 0);
  assert.equal(summary.totalExpense, 0);
  assert.equal(Number.isNaN(summary.totalExpense), false);
});

test('a non-numeric value in a money column is ignored rather than poisoning the total', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_service_fee: '10.00' }),
    row({ account_id: 'acc-2', transfer_service_fee: 'not a number' }),
  ]);

  assert.equal(rows[0].serviceFees, 10);
  assert.equal(rows[1].serviceFees, 0);
  assert.equal(summary.serviceFees, 10);
  assert.equal(Number.isNaN(summary.totalExpense), false);
});

test('counts arrive as strings from pg and come back as integers', () => {
  const { rows, summary } = buildExpenseReport([row({ transfer_count: '7' })]);

  assert.equal(rows[0].transferCount, 7);
  assert.equal(summary.transferCount, 7);
});

test('an account with no name falls back to its identifier rather than a blank cell', () => {
  const { rows } = buildExpenseReport([{ account_id: 'acc-9', account_name: '   ' }]);

  assert.equal(rows[0].accountName, 'acc-9');
});

test('a transfer with no service charge counts as a transfer but costs nothing', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_count: '2', transfer_service_fee: '0.00' }),
  ]);

  assert.equal(rows[0].transferCount, 2);
  assert.equal(rows[0].serviceFees, 0);
  assert.equal(summary.payingAccounts, 0);
  assert.equal(summary.totalExpense, 0);
});

const detailRow = (overrides: Partial<ExpenseDetailSourceRow> = {}): ExpenseDetailSourceRow => ({
  id: 'trf-1',
  transfer_number: 28,
  transfer_reference: 'TRF-2026-000028',
  transfer_date: '2026-09-25T14:19:00.000Z',
  destination_name: 'Benito Bautista',
  transfer_amount: '22000.00',
  transfer_fee: '10.00',
  ...overrides,
});

test('the drill-down totals its own rows rather than repeating the account row', () => {
  const detail = buildExpenseDetail([
    detailRow(),
    detailRow({ id: 'trf-2', transfer_number: 21, transfer_amount: '5000.00', transfer_fee: '0.00' }),
    detailRow({ id: 'trf-3', transfer_number: 25, transfer_amount: '1500.00', transfer_fee: '20.00' }),
  ]);

  // Summed from the three rows above, not read off the aggregate that produced
  // the account row. Two independently computed figures either agree or show
  // that they do not.
  assert.equal(detail.summary.transferCount, 3);
  assert.equal(detail.summary.transferAmount, 28500);
  assert.equal(detail.summary.serviceFees, 30);
});

test('the drill-down reproduces the account row exactly', () => {
  const accountRow = buildExpenseReport([
    row({ transfer_count: '3', transfer_service_fee: '30.00' }),
  ]).rows[0];

  const detail = buildExpenseDetail([
    detailRow(),
    detailRow({ id: 'trf-2', transfer_amount: '5000.00', transfer_fee: '0.00' }),
    detailRow({ id: 'trf-3', transfer_amount: '1500.00', transfer_fee: '20.00' }),
  ]);

  // Both sides are built from the same transfers by different code: the row
  // from an aggregate in SQL, the drill-down from the fetched rows. They are
  // compared on screen, so they must be built the same way here too.
  assert.equal(detail.summary.transferCount, accountRow.transferCount);
  assert.equal(detail.summary.serviceFees, accountRow.serviceFees);
});

test('a transfer with no fee still appears, because the row counts it', () => {
  const detail = buildExpenseDetail([
    detailRow({ id: 'trf-1', transfer_fee: '0.00' }),
    detailRow({ id: 'trf-2', transfer_fee: '0.00' }),
  ]);

  assert.equal(detail.rows.length, 2);
  assert.equal(detail.summary.transferCount, 2);
  assert.equal(detail.summary.serviceFees, 0);
});

test('an account that sent nothing returns an empty drill-down, not a broken one', () => {
  const detail = buildExpenseDetail([]);

  assert.deepEqual(detail.rows, []);
  assert.equal(detail.summary.transferCount, 0);
  assert.equal(detail.summary.transferAmount, 0);
  assert.equal(detail.summary.serviceFees, 0);
  assert.equal(Number.isNaN(detail.summary.serviceFees), false);
});

test('the drill-down keeps the reference, date and destination an auditor reads', () => {
  const detail = buildExpenseDetail([detailRow()]);

  assert.equal(detail.rows[0].transferReference, 'TRF-2026-000028');
  assert.equal(detail.rows[0].transferNumber, 28);
  assert.equal(detail.rows[0].destinationName, 'Benito Bautista');
  assert.equal(detail.rows[0].transferDate, '2026-09-25T14:19:00.000Z');
  assert.equal(detail.rows[0].amount, 22000);
  assert.equal(detail.rows[0].fee, 10);
});

test('a column the database left out reads as empty rather than as a blank reference', () => {
  const detail = buildExpenseDetail([{ id: 'trf-1', transfer_fee: '10.00' }]);

  assert.equal(detail.rows[0].transferReference, null);
  assert.equal(detail.rows[0].transferNumber, null);
  assert.equal(detail.rows[0].destinationName, null);
  assert.equal(detail.rows[0].transferDate, null);
  assert.equal(detail.rows[0].fee, 10);
  assert.equal(detail.summary.transferCount, 1);
});

test('a non-numeric fee is ignored rather than poisoning the drill-down total', () => {
  const detail = buildExpenseDetail([
    detailRow(),
    detailRow({ id: 'trf-2', transfer_fee: 'not a number' }),
  ]);

  assert.equal(detail.summary.serviceFees, 10);
  assert.equal(Number.isNaN(detail.summary.serviceFees), false);
});
