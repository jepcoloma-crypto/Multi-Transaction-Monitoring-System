import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpenseReport, buildExpenseDetail, type ExpenseSourceRow, type ExpenseDetailSourceRow, type ExpenseChargeSourceRow, type ExpenseOperatingSourceRow } from '../services/expenseReport';
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

test('the total walks across both expense columns, not only the first', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_service_fee: '40.00', provider_charges: '25.00' }),
  ]);

  // The reason the total is summed here rather than carried in its own column:
  // a figure that arrives pre-totalled cannot be checked against the components
  // printed beside it, so an operator can only ever trust it.
  assert.equal(rows[0].serviceFees, 40);
  assert.equal(rows[0].providerCharges, 25);
  assert.equal(rows[0].totalExpense, 65);
  assert.equal(summary.serviceFees, 40);
  assert.equal(summary.providerCharges, 25);
  assert.equal(summary.totalExpense, 65);
  assert.equal(summary.payingAccounts, 1);
});

test('a provider charge with no transfers still makes the account a payer', () => {
  const { rows, summary } = buildExpenseReport([
    row({ transfer_count: '0', transfer_service_fee: '0.00', provider_charges: '10.00' }),
    row({ account_id: 'acc-2', account_name: 'Benito Bautista' }),
  ]);

  // Charged on a cash movement rather than a transfer, so there is nothing in
  // the Transfers column to hint that this account spent anything at all.
  assert.equal(rows[0].accountName, 'Jed Bautista');
  assert.equal(rows[0].providerCharges, 10);
  assert.equal(rows[0].totalExpense, 10);
  assert.equal(summary.transferCount, 0);
  assert.equal(summary.serviceFees, 0);
  assert.equal(summary.totalExpense, 10);
  assert.equal(summary.payingAccounts, 1);
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
  assert.equal(income.summary.feeIncome, 1800);
  assert.equal(income.summary.totalIncome, 1846);
  assert.equal(expense.summary.totalExpense, 10);
  // Income plus expense accounts for the transfer charge that moved out of
  // income but leaves the 30.00 of additional charges out of both: 1,846 +
  // 10 is the 1,886 these figures used to reach, less those 30.00.
  assert.equal(income.summary.totalIncome + expense.summary.totalExpense, 1856);
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

// A provider charge: a row typed `expense` linked back to the cash movement
// that provoked it (migration 032).
const chargeRow = (overrides: Partial<ExpenseChargeSourceRow> = {}): ExpenseChargeSourceRow => ({
  id: 'exp-1',
  transaction_number: 200,
  transaction_date: '2026-09-25T14:19:00.000Z',
  description: 'Provider charge on transaction #168 (not billed to the customer)',
  amount: '10.00',
  linked_transaction_number: 168,
  ...overrides,
});

test('the drill-down totals its own rows rather than repeating the account row', () => {
  const detail = buildExpenseDetail({
    transfers: [
      detailRow(),
      detailRow({ id: 'trf-2', transfer_number: 21, transfer_amount: '5000.00', transfer_fee: '0.00' }),
      detailRow({ id: 'trf-3', transfer_number: 25, transfer_amount: '1500.00', transfer_fee: '20.00' }),
    ],
    charges: [],
    operating: [],
  });

  // Summed from the three rows above, not read off the aggregate that produced
  // the account row. Two independently computed figures either agree or show
  // that they do not.
  assert.equal(detail.summary.transferCount, 3);
  assert.equal(detail.summary.transferAmount, 28500);
  assert.equal(detail.summary.serviceFees, 30);
  assert.equal(detail.summary.totalExpense, 30);
});

test('the drill-down reproduces the account row exactly', () => {
  const accountRow = buildExpenseReport([
    row({ transfer_count: '3', transfer_service_fee: '30.00', provider_charges: '45.00' }),
  ]).rows[0];

  const detail = buildExpenseDetail({
    transfers: [
      detailRow(),
      detailRow({ id: 'trf-2', transfer_amount: '5000.00', transfer_fee: '0.00' }),
      detailRow({ id: 'trf-3', transfer_amount: '1500.00', transfer_fee: '20.00' }),
    ],
    charges: [
      chargeRow({ amount: '10.00' }),
      chargeRow({ id: 'exp-2', amount: '35.00' }),
    ],
    operating: [],
  });

  // Both sides are built from the same rows by different code: the account row
  // from aggregates in SQL, the drill-down from the fetched rows. They are
  // compared on screen, so they must be built the same way here too. Both
  // components AND their total are checked, because a drill-down that matched
  // on the two component columns while disagreeing on the total would still
  // fail to explain the number the operator clicked.
  assert.equal(detail.summary.transferCount, accountRow.transferCount);
  assert.equal(detail.summary.serviceFees, accountRow.serviceFees);
  assert.equal(detail.summary.providerCharges, accountRow.providerCharges);
  assert.equal(detail.summary.totalExpense, accountRow.totalExpense);
  assert.equal(detail.summary.chargeCount, 2);
  assert.equal(accountRow.totalExpense, 75);
});

test('a transfer with no fee still appears, because the row counts it', () => {
  const detail = buildExpenseDetail({
    transfers: [
      detailRow({ id: 'trf-1', transfer_fee: '0.00' }),
      detailRow({ id: 'trf-2', transfer_fee: '0.00' }),
    ],
    charges: [],
    operating: [],
  });

  assert.equal(detail.transfers.length, 2);
  assert.equal(detail.summary.transferCount, 2);
  assert.equal(detail.summary.serviceFees, 0);
  assert.equal(detail.summary.totalExpense, 0);
});

test('an account that spent nothing returns an empty drill-down, not a broken one', () => {
  const detail = buildExpenseDetail({ transfers: [], charges: [], operating: [] });

  assert.deepEqual(detail.transfers, []);
  assert.deepEqual(detail.charges, []);
  assert.equal(detail.summary.transferCount, 0);
  assert.equal(detail.summary.transferAmount, 0);
  assert.equal(detail.summary.serviceFees, 0);
  assert.equal(detail.summary.chargeCount, 0);
  assert.equal(detail.summary.providerCharges, 0);
  assert.equal(detail.summary.totalExpense, 0);
  assert.equal(Number.isNaN(detail.summary.serviceFees), false);
});

test('the drill-down keeps the reference, date and destination an auditor reads', () => {
  const detail = buildExpenseDetail({ transfers: [detailRow()], charges: [], operating: [] });

  assert.equal(detail.transfers[0].transferReference, 'TRF-2026-000028');
  assert.equal(detail.transfers[0].transferNumber, 28);
  assert.equal(detail.transfers[0].destinationName, 'Benito Bautista');
  assert.equal(detail.transfers[0].transferDate, '2026-09-25T14:19:00.000Z');
  assert.equal(detail.transfers[0].amount, 22000);
  assert.equal(detail.transfers[0].fee, 10);
});

test('a column the database left out reads as empty rather than as a blank reference', () => {
  const detail = buildExpenseDetail({ transfers: [{ id: 'trf-1', transfer_fee: '10.00' }], charges: [], operating: [] });

  assert.equal(detail.transfers[0].transferReference, null);
  assert.equal(detail.transfers[0].transferNumber, null);
  assert.equal(detail.transfers[0].destinationName, null);
  assert.equal(detail.transfers[0].transferDate, null);
  assert.equal(detail.transfers[0].fee, 10);
  assert.equal(detail.summary.transferCount, 1);
});

test('a non-numeric fee is ignored rather than poisoning the drill-down total', () => {
  const detail = buildExpenseDetail({
    transfers: [detailRow(), detailRow({ id: 'trf-2', transfer_fee: 'not a number' })],
    charges: [],
    operating: [],
  });

  assert.equal(detail.summary.serviceFees, 10);
  assert.equal(Number.isNaN(detail.summary.serviceFees), false);
});

test('provider charges are listed, linked to the cash movement that caused them', () => {
  const detail = buildExpenseDetail({
    transfers: [],
    charges: [chargeRow(), chargeRow({ id: 'exp-2', transaction_number: 201, amount: '25.00' })],
    operating: [],
  });

  assert.equal(detail.charges.length, 2);
  assert.equal(detail.summary.chargeCount, 2);
  assert.equal(detail.summary.providerCharges, 35);
  assert.equal(detail.charges[0].linkedTransactionNumber, 168);
  assert.equal(detail.charges[0].amount, 10);
  assert.equal(
    detail.charges[0].description,
    'Provider charge on transaction #168 (not billed to the customer)'
  );
});

test('a charge with no origin still stands on its own as a bare number', () => {
  const detail = buildExpenseDetail({
    transfers: [],
    charges: [{ id: 'exp-9', amount: '10.00' }],
    operating: [],
  });

  assert.equal(detail.charges[0].transactionNumber, null);
  assert.equal(detail.charges[0].transactionDate, null);
  assert.equal(detail.charges[0].linkedTransactionNumber, null);
  assert.equal(detail.charges[0].description, null);
  assert.equal(detail.summary.totalExpense, 10);
});

test('a non-numeric charge amount is ignored rather than poisoning the total', () => {
  const detail = buildExpenseDetail({
    transfers: [detailRow()],
    charges: [{ id: 'exp-1', amount: 'not a number' }],
    operating: [],
  });

  assert.equal(detail.summary.providerCharges, 0);
  assert.equal(detail.summary.totalExpense, 10);
  assert.equal(Number.isNaN(detail.summary.totalExpense), false);
});

// An operating expense paid out of the account (typed `operating_expense`,
// migration 034) — a third component, deliberately separate from the provider
// charge even though both arrive as ordinary transactions.
const operatingRow = (overrides: Partial<ExpenseOperatingSourceRow> = {}): ExpenseOperatingSourceRow => ({
  id: 'opx-1',
  transaction_number: 300,
  transaction_date: '2026-09-26T09:00:00.000Z',
  description: 'Electrical bill - September',
  payee: 'Meralco',
  amount: '1500.00',
  ...overrides,
});

test('operating expenses are a third component, never folded into provider charges', () => {
  const report = buildExpenseReport([
    row({
      transfer_count: '0',
      transfer_service_fee: '0.00',
      provider_charges: '45.00',
      operating_expenses: '1500.00',
    }),
  ]);
  const accountRow = report.rows[0];

  // The whole point of the separate type: rent must not land in the charge
  // column, which only `tt.code = 'expense'` may populate.
  assert.equal(accountRow.providerCharges, 45);
  assert.equal(accountRow.operatingExpenses, 1500);
  assert.equal(accountRow.totalExpense, 1545);
  assert.equal(report.summary.operatingExpenses, 1500);
  assert.equal(report.summary.totalExpense, 1545);
});

test('the drill-down lists operating expenses with payee and reproduces the account row', () => {
  const accountRow = buildExpenseReport([
    row({ transfer_count: '0', transfer_service_fee: '0.00', provider_charges: '0.00', operating_expenses: '1500.00' }),
  ]).rows[0];

  const detail = buildExpenseDetail({ transfers: [], charges: [], operating: [operatingRow()] });

  assert.equal(detail.operating.length, 1);
  assert.equal(detail.operating[0].payee, 'Meralco');
  assert.equal(detail.operating[0].description, 'Electrical bill - September');
  assert.equal(detail.operating[0].amount, 1500);
  assert.equal(detail.summary.operatingCount, 1);
  assert.equal(detail.summary.operatingExpenses, accountRow.operatingExpenses);
  assert.equal(detail.summary.totalExpense, accountRow.totalExpense);
});

test('an account that paid no operating expenses reports a zero component, not a missing one', () => {
  const detail = buildExpenseDetail({ transfers: [], charges: [], operating: [] });

  assert.deepEqual(detail.operating, []);
  assert.equal(detail.summary.operatingCount, 0);
  assert.equal(detail.summary.operatingExpenses, 0);
  assert.equal(detail.summary.totalExpense, 0);
});

test('a non-numeric operating amount is ignored rather than poisoning the total', () => {
  const detail = buildExpenseDetail({
    transfers: [],
    charges: [],
    operating: [operatingRow({ amount: 'not a number' })],
  });

  assert.equal(detail.summary.operatingExpenses, 0);
  assert.equal(Number.isNaN(detail.summary.totalExpense), false);
});

test('an operating expense with no payee still stands on its own as a bare number', () => {
  const detail = buildExpenseDetail({
    transfers: [],
    charges: [],
    operating: [{ id: 'opx-9', amount: '250.00' }],
  });

  assert.equal(detail.operating[0].payee, null);
  assert.equal(detail.operating[0].description, null);
  assert.equal(detail.operating[0].transactionNumber, null);
  assert.equal(detail.summary.totalExpense, 250);
});
