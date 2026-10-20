import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCashTransactionsReport,
  type CashSourceRow,
  type InterestSourceRow,
  type LoadingSourceRow,
} from '../services/cashTransactionsReport';

const cash = (overrides: Partial<CashSourceRow> = {}): CashSourceRow => ({
  id: 'c1',
  transaction_number: '100',
  transaction_date: '2026-10-14T08:00:00Z',
  amount: '1000.00',
  fee: '60.00',
  fee_added_to_balance: true,
  direction: 'in',
  type_name: 'Cash In',
  account_name: 'Jed Bautista',
  branch_name: 'Main Branch',
  ...overrides,
});

const loading = (overrides: Partial<LoadingSourceRow> = {}): LoadingSourceRow => ({
  id: 'l1',
  transaction_number: '50',
  created_at: '2026-10-14T08:00:00Z',
  total_revenue: '1438.00',
  profit: '67.00',
  product_name: 'Globe 100',
  account_name: 'Loading Wallet',
  branch_name: 'Main Branch',
  ...overrides,
});

test('fees split by mode and the three income types sum to totalIncome', () => {
  const { summary } = buildCashTransactionsReport(
    [
      cash({ id: 'c1', fee: '60.00', fee_added_to_balance: true }), // on-top
      cash({ id: 'c2', fee: '40.00', fee_added_to_balance: false }), // inside
    ],
    [loading({ id: 'l1', profit: '67.00' })], // loading margin
  );

  assert.equal(summary.feeOnTop.total, 60);
  assert.equal(summary.feeOnTop.count, 1);
  assert.equal(summary.feeInside.total, 40);
  assert.equal(summary.feeInside.count, 1);
  assert.equal(summary.loadingMargin.total, 67);
  assert.equal(summary.loadingMargin.count, 1);
  assert.equal(summary.totalIncome, 167);
  // A fee is on top or inside, a loading sale is neither — so the three are
  // disjoint and their sum is the whole of what the period earned, the figure
  // the dashboard's two income cards add back to.
  assert.equal(
    summary.feeOnTop.total + summary.feeInside.total + summary.loadingMargin.total,
    summary.totalIncome,
  );
});

test('charges ride the row as reference and never join the income total', () => {
  // A charge folded into the amount (a Home Credit cut, say) is the customer's
  // own money passing through the till: the report carries it for
  // reconciliation, and not a peso of it may reach the income figures.
  const source: CashSourceRow[] = [
    cash({ id: 'c1', fee: '50.00', fee_added_to_balance: true, additional_charges: '15.00' }),
    cash({ id: 'c2', fee: '40.00', fee_added_to_balance: false, additional_charges: '7.50' }),
    cash({ id: 'c3', fee: '10.00' }),
  ];

  const { rows, summary } = buildCashTransactionsReport(source, [loading()]);

  assert.equal(rows.find((row) => row.id === 'c1')?.charges, 15);
  assert.equal(rows.find((row) => row.id === 'c2')?.charges, 7.5);
  assert.equal(rows.find((row) => row.id === 'c3')?.charges, 0, 'a row with no charges reads zero, never NaN');
  assert.equal(rows.find((row) => row.kind === 'loading')?.charges, 0, 'a loading sale carries no charges of its own');
  assert.equal(summary.charges, 22.5, 'the summary is the rows added up');
  assert.equal(summary.totalIncome, 167, '50 + 40 + 10 of fees plus the 67 margin — charges excluded');

  const onTop = buildCashTransactionsReport(source, [loading()], 'on-top');
  assert.equal(onTop.summary.charges, 15, 'the drill-down re-sums charges from the rows it shows');
  assert.equal(onTop.summary.totalIncome, 60);
});

test('a fee mode the column never stated reads as on-top', () => {
  const { rows, summary } = buildCashTransactionsReport(
    [cash({ fee: '60.00', fee_added_to_balance: null })],
    [],
  );

  // Migration 012 defaults the column to true, so a NULL beside it has to mean
  // the same thing — on top — or an older row would quietly change treatment.
  assert.equal(rows[0].incomeType, 'on-top');
  assert.equal(summary.feeOnTop.total, 60);
  assert.equal(summary.feeOnTop.count, 1);
  assert.equal(summary.feeInside.total, 0);
});

test('pg hands money over as strings and the cents survive the trip', () => {
  const { summary } = buildCashTransactionsReport(
    [cash({ fee: '10.10' })],
    [loading({ profit: '0.05' })],
  );

  // A float adder gives 10.150000000000002 here; the report has to show 10.15.
  assert.equal(summary.feeOnTop.total, 10.1);
  assert.equal(summary.loadingMargin.total, 0.05);
  assert.equal(summary.totalIncome, 10.15);
});

test('a column of pennies sums exactly rather than drifting', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    cash({ id: `c${i}`, fee: '0.10', fee_added_to_balance: true }),
  );
  const { summary } = buildCashTransactionsReport(many, []);

  assert.equal(summary.feeOnTop.total, 10);
  assert.equal(summary.totalIncome, 10);
});

test('a loading sale carries its margin as income, not a fee mode', () => {
  const { rows, summary } = buildCashTransactionsReport(
    [],
    [loading({ total_revenue: '1438.00', profit: '67.00' })],
  );

  assert.equal(rows[0].kind, 'loading');
  assert.equal(rows[0].incomeType, 'loading');
  // The selling price reached the drawer (context beside the income); the
  // margin is what the sale earned. The two must not be confused.
  assert.equal(rows[0].amount, 1438);
  assert.equal(rows[0].income, 67);
  assert.equal(rows[0].direction, null);
  assert.equal(summary.loadingMargin.total, 67);
  assert.equal(summary.loadingMargin.count, 1);
  assert.equal(summary.feeOnTop.total, 0);
});

test('a loading sale that lost money reduces the total instead of flooring at zero', () => {
  const { summary } = buildCashTransactionsReport(
    [cash({ fee: '100.00' })],
    [loading({ profit: '-25.00' })],
  );

  assert.equal(summary.loadingMargin.total, -25);
  assert.equal(summary.totalIncome, 75);
});

test('a field the database left out reads as zero or null, never NaN', () => {
  const { rows, summary } = buildCashTransactionsReport([{ id: 'c1' }], [{ id: 'l1' }]);

  assert.equal(rows[0].income, 0);
  assert.equal(rows[0].amount, 0);
  assert.equal(rows[0].accountName, null);
  assert.equal(rows[0].day, null);
  assert.equal(summary.totalIncome, 0);
  assert.equal(Number.isNaN(summary.totalIncome), false);
});

test('a non-numeric value in a money column is ignored rather than poisoning the total', () => {
  const { rows, summary } = buildCashTransactionsReport(
    [cash({ id: 'c1', fee: '10.00' }), cash({ id: 'c2', fee: 'not a number' })],
    [],
  );

  assert.equal(rows[0].income, 10);
  assert.equal(rows[1].income, 0);
  assert.equal(summary.feeOnTop.total, 10);
  assert.equal(Number.isNaN(summary.totalIncome), false);
});

test('rows are newest first, with cash before loading on the same day', () => {
  const { rows } = buildCashTransactionsReport(
    [
      cash({ id: 'c-old', transaction_date: '2026-10-13T08:00:00Z' }),
      cash({ id: 'c-new', transaction_date: '2026-10-14T08:00:00Z' }),
    ],
    [loading({ id: 'l1', created_at: '2026-10-14T08:00:00Z' })],
  );

  // The two 14 Oct rows tie on day; cash precedes loading so the order is
  // reproducible between renders rather than depending on query arrival.
  assert.deepEqual(rows.map((r) => r.id), ['c-new', 'l1', 'c-old']);
});

test('an instant just past Manila midnight files under the next day', () => {
  // 16:30 UTC is 00:30 the next day in Manila, so the row belongs to Oct 14 —
  // not the Oct 13 its UTC stamp would print. The whole report groups by the
  // operator's calendar day, so getting this wrong shifts every boundary row.
  const { rows } = buildCashTransactionsReport(
    [cash({ transaction_date: '2026-10-13T16:30:00Z' })],
    [],
  );

  assert.equal(rows[0].day, '2026-10-14');
});

test('a row with no date sinks to the bottom rather than sorting unpredictably', () => {
  const { rows } = buildCashTransactionsReport(
    [
      cash({ id: 'c-nodate', transaction_date: null }),
      cash({ id: 'c-dated', transaction_date: '2026-10-14T08:00:00Z' }),
    ],
    [],
  );

  assert.deepEqual(rows.map((r) => r.id), ['c-dated', 'c-nodate']);
});

test('the system number prints as a number and reads null when absent', () => {
  const { rows } = buildCashTransactionsReport(
    [cash({ id: 'c1', transaction_number: '49690' }), cash({ id: 'c2', transaction_number: null })],
    [],
  );

  assert.equal(rows.find((r) => r.id === 'c1')?.transactionNumber, '49690');
  assert.equal(rows.find((r) => r.id === 'c2')?.transactionNumber, null);
});

test('the external reference is carried verbatim, alphanumeric codes included', () => {
  const { rows } = buildCashTransactionsReport(
    [cash({ id: 'c1', reference_number: '389A2' }), cash({ id: 'c2', reference_number: '68975' })],
    [loading({ id: 'l1', reference_number: 'LD-9' })],
  );

  // A code like `389A2` carries meaning a numeric cast would strip, so it is
  // kept as it stands — and a purely numeric reference survives the trip too.
  assert.equal(rows.find((r) => r.id === 'c1')?.referenceNumber, '389A2');
  assert.equal(rows.find((r) => r.id === 'c2')?.referenceNumber, '68975');
  assert.equal(rows.find((r) => r.id === 'l1')?.referenceNumber, 'LD-9');
});

test('an absent external reference reads as null so the cell can show a dash', () => {
  const { rows } = buildCashTransactionsReport([cash({ reference_number: null })], []);

  assert.equal(rows[0].referenceNumber, null);
});

test('the handling drill-down narrows the rows and re-sums the summary from them', () => {
  const cashRows = [
    cash({ id: 'c1', fee: '60.00', fee_added_to_balance: true }),
    cash({ id: 'c2', fee: '40.00', fee_added_to_balance: false }),
  ];
  const loadingRows = [loading({ id: 'l1', profit: '67.00' })];

  const onTop = buildCashTransactionsReport(cashRows, loadingRows, 'on-top');
  assert.deepEqual(onTop.rows.map((r) => r.id), ['c1']);
  assert.equal(onTop.summary.feeOnTop.total, 60);
  assert.equal(onTop.summary.feeInside.total, 0);
  assert.equal(onTop.summary.loadingMargin.total, 0);
  assert.equal(onTop.summary.totalIncome, 60);

  const inside = buildCashTransactionsReport(cashRows, loadingRows, 'inside');
  assert.deepEqual(inside.rows.map((r) => r.id), ['c2']);
  assert.equal(inside.summary.totalIncome, 40);

  const loadingOnly = buildCashTransactionsReport(cashRows, loadingRows, 'loading');
  assert.deepEqual(loadingOnly.rows.map((r) => r.id), ['l1']);
  assert.equal(loadingOnly.summary.loadingMargin.total, 67);
  assert.equal(loadingOnly.summary.totalIncome, 67);
});

test('a filtered summary still adds up to the rows on screen', () => {
  const { rows, summary } = buildCashTransactionsReport(
    [cash({ fee: '10.10', fee_added_to_balance: true }), cash({ id: 'c2', fee: '0.05', fee_added_to_balance: true })],
    [],
    'on-top',
  );

  // The invariant the whole report rests on: whatever the filter, the total is
  // the visible rows added up — never a stale figure from the unfiltered set.
  assert.equal(rows.length, summary.feeOnTop.count);
  const summedCents = rows.reduce((acc, r) => acc + Math.round(r.income * 100), 0);
  assert.equal(summedCents, Math.round(summary.totalIncome * 100));
});

test('a cash row never counts toward the loading total and vice versa', () => {
  const { summary, rows } = buildCashTransactionsReport(
    [cash({ fee: '10.00', fee_added_to_balance: true })],
    [loading({ profit: '5.00' })],
  );

  // Each row contributes to exactly one of the three buckets, so a cash fee
  // cannot leak into the loading count or the other way round.
  assert.equal(rows.filter((r) => r.incomeType === 'on-top').length, summary.feeOnTop.count);
  assert.equal(rows.filter((r) => r.incomeType === 'loading').length, summary.loadingMargin.count);
  assert.equal(summary.feeOnTop.count + summary.feeInside.count + summary.loadingMargin.count, rows.length);
});

const interest = (overrides: Partial<InterestSourceRow> = {}): InterestSourceRow => ({
  id: 'i1',
  transaction_number: '44',
  transaction_date: '2026-10-19T08:00:00Z',
  amount: '10.00',
  type_name: 'Owner Funding',
  account_name: 'Joyce Bautista',
  branch_name: 'Main Branch',
  ...overrides,
});

test('provider interest is a fourth income type and joins totalIncome', () => {
  const { summary } = buildCashTransactionsReport(
    [
      cash({ id: 'c1', fee: '60.00', fee_added_to_balance: true }), // on-top
      cash({ id: 'c2', fee: '40.00', fee_added_to_balance: false }), // inside
    ],
    [loading({ id: 'l1', profit: '67.00' })],
    null,
    [interest({ amount: '10.00' })],
  );

  // Four disjoint types: a fee is either on top or inside, a loading sale is
  // neither, and an interest credit is a credit rather than a charge — so the
  // sum is the whole of what the period earned and no peso is counted twice.
  assert.equal(summary.providerInterest.total, 10);
  assert.equal(summary.providerInterest.count, 1);
  assert.equal(summary.totalIncome, 177);
});

test('the handling filter narrows to interest on its own', () => {
  const only = buildCashTransactionsReport(
    [cash({ id: 'c1', fee: '60.00' })],
    [loading({ id: 'l1', profit: '67.00' })],
    'provider-interest',
    [interest({ id: 'i1', amount: '10.00' }), interest({ id: 'i2', amount: '5.96' })],
  );

  assert.deepEqual(only.rows.map((r) => r.id), ['i1', 'i2']);
  assert.equal(only.summary.providerInterest.total, 15.96);
  assert.equal(only.summary.totalIncome, 15.96, 'the summary follows the rows on screen, mid-filter');
});

test('an interest row carries its whole credit as income and no charges beside it', () => {
  const { rows } = buildCashTransactionsReport([], [], null, [interest({ amount: '5.96' })]);

  // Nothing was billed alongside a credit the provider simply made, so the
  // charges column is zero rather than a figure a reader would have to explain
  // away — and the amount and the income are the same figure on purpose.
  assert.equal(rows[0].kind, 'interest');
  assert.equal(rows[0].incomeType, 'provider-interest');
  assert.equal(rows[0].amount, 5.96);
  assert.equal(rows[0].income, 5.96);
  assert.equal(rows[0].charges, 0);
});

test('interest sorts beside the transactions of its own day rather than after the sales', () => {
  const { rows } = buildCashTransactionsReport(
    [cash({ id: 'c1', transaction_number: '100', transaction_date: '2026-10-19T08:00:00Z' })],
    [loading({ id: 'l1', transaction_number: '50', created_at: '2026-10-19T08:00:00Z' })],
    null,
    [interest({ id: 'i1', transaction_number: '44', transaction_date: '2026-10-19T08:00:00Z' })],
  );

  // A credit is a transaction, not a sale, so it belongs among the movements
  // it resembles. Three kinds on one day means the old cash-before-loading
  // comparison would have been undefined for one of them; the rank list is
  // what keeps the page reproducible between renders.
  assert.deepEqual(rows.map((r) => r.kind), ['cash', 'interest', 'loading']);
});

test('a caller that supplies no interest reports none rather than crashing', () => {
  const { rows, summary } = buildCashTransactionsReport([cash({ id: 'c1', fee: '60.00' })], []);

  assert.equal(rows.length, 1);
  assert.equal(summary.providerInterest.total, 0);
  assert.equal(summary.providerInterest.count, 0);
});
