import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAmountCorrection,
  columnsChanged,
  isAmountable,
  AMOUNT_FIELDS,
} from '../services/amountFields';
import type { AmountPlan } from '../services/amountFields';

interface RowLike {
  account_id: string;
  entry_type: string;
}

const creditRow = (id = 'a1'): RowLike => ({ account_id: id, entry_type: 'credit' });
const debitRow = (id = 'a1'): RowLike => ({ account_id: id, entry_type: 'debit' });

const transactionRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  amount: '400.00',
  fee: '20.00',
  net_amount: '400.00',
  fee_added_to_balance: true,
  additional_charges: JSON.stringify([{ name: 'Handling', amount: '25.00' }]),
  ...overrides,
});

const transferRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  transfer_amount: '1000.00',
  transfer_fee: '25.00',
  total_source_deduction: '1025.00',
  destination_amount: '1000.00',
  ...overrides,
});

const loadingRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  quantity: 10,
  unit_cost: '5.00',
  unit_price: '8.00',
  total_cost: '50.00',
  total_revenue: '80.00',
  profit: '30.00',
  provider_convenience_fee: '20.00',
  company_additional_charge: '3.00',
  ...overrides,
});

const plan = (
  sourceType: string,
  record: Record<string, unknown>,
  rows: RowLike[],
  proposed: unknown
): AmountPlan => planAmountCorrection(sourceType, record, rows, proposed);

const throwsStatus = (fn: () => unknown, statusCode: number, pattern: RegExp) =>
  assert.throws(
    fn,
    (e: any) => e.statusCode === statusCode && pattern.test(e.message),
    `expected ${pattern} with ${statusCode}`
  );

test('a transaction posts net amount plus charges to the ledger', () => {
  const result = plan('transaction', transactionRecord(), [creditRow()], { amount: 500 });

  assert.deepEqual(result.columns, { amount: 500, fee: 20, net_amount: 500 });
  assert.deepEqual(result.amounts, { a1: 525 });
});

test('a fee deducted from the amount reduces what the ledger receives', () => {
  const record = transactionRecord({ fee_added_to_balance: false });
  const result = plan('transaction', record, [creditRow()], { amount: 500 });

  assert.equal(result.columns.net_amount, 480);
  assert.deepEqual(result.amounts, { a1: 505 });
});

test('a fee larger than the amount it is deducted from is refused', () => {
  const record = transactionRecord({ fee_added_to_balance: false });
  throwsStatus(
    () => plan('transaction', record, [creditRow()], { amount: 10, fee: 20 }),
    400,
    /cannot exceed the transaction amount/
  );
});

test('charges are summed and an unreadable charge list is refused, never guessed', () => {
  const result = plan(
    'transaction',
    transactionRecord({ additional_charges: '[{"amount":"10.00"},{"amount":"15.50"}]' }),
    [creditRow()],
    { amount: 400 }
  );
  assert.deepEqual(result.amounts, { a1: 425.5 });

  throwsStatus(
    () =>
      plan('transaction', transactionRecord({ additional_charges: 'not json' }), [creditRow()], {}),
    400,
    /could not be read/
  );
});

test('a transfer splits the amount across the source deduction and the destination', () => {
  const rows: RowLike[] = [debitRow('src'), creditRow('dst')];
  const result = plan('transfer', transferRecord(), rows, { transfer_amount: 1500 });

  assert.deepEqual(result.columns, {
    transfer_amount: 1500,
    transfer_fee: 25,
    total_source_deduction: 1525,
    destination_amount: 1500,
  });
  assert.deepEqual(result.amounts, { src: 1525, dst: 1500 });
});

test('a transfer finds each side by the first row written on that account', () => {
  // The source was corrected downward before, so it now owns a debit and a
  // credit row. Matching on entry type alone would hand the destination amount
  // to the wrong account.
  const rows: RowLike[] = [
    debitRow('src'),
    creditRow('src'),
    creditRow('dst'),
    debitRow('dst'),
  ];
  const result = plan('transfer', transferRecord(), rows, { transfer_amount: 900 });

  assert.deepEqual(result.amounts, { src: 925, dst: 900 });
});

test('a transfer with no destination credit row is refused', () => {
  throwsStatus(
    () => plan('transfer', transferRecord(), [debitRow('src')], {}),
    400,
    /both a source debit and a destination credit/
  );
});

test('a transfer amount of zero is refused', () => {
  throwsStatus(
    () => plan('transfer', transferRecord(), [debitRow('src'), creditRow('dst')], { transfer_amount: 0 }),
    400,
    /must be greater than zero/
  );
});

test('loading posts cost plus the provider fee, and the totals recompute', () => {
  const result = plan('loading', loadingRecord(), [debitRow()], { quantity: 5 });

  assert.deepEqual(result.columns, {
    quantity: 5,
    unit_cost: 5,
    unit_price: 8,
    total_cost: 25,
    total_revenue: 40,
    profit: 15,
    provider_convenience_fee: 10,
    company_additional_charge: 3,
  });
  assert.deepEqual(result.amounts, { a1: 35 });
});

test('the provider fee follows quantity so its per-unit rate survives the edit', () => {
  const scaled = plan('loading', loadingRecord(), [debitRow()], { quantity: 10 });
  assert.equal(scaled.columns.provider_convenience_fee, 20);

  const typed = plan('loading', loadingRecord(), [debitRow()], {
    quantity: 10,
    provider_convenience_fee: 55,
  });
  assert.equal(typed.columns.provider_convenience_fee, 55);
});

test('selling price changes revenue and profit but never the ledger', () => {
  const result = plan('loading', loadingRecord(), [debitRow()], { unit_price: 12 });

  assert.equal(result.columns.total_revenue, 120);
  assert.equal(result.columns.profit, 70);
  assert.deepEqual(result.amounts, { a1: 70 });
});

test('profit can be set directly and may be negative', () => {
  const loss = plan('loading', loadingRecord(), [debitRow()], { profit: -25 });
  assert.equal(loss.columns.profit, -25);
  assert.deepEqual(loss.amounts, { a1: 70 });

  const kept = plan('loading', loadingRecord(), [debitRow()], { profit: 12 });
  assert.equal(kept.columns.profit, 12);
});

test('a quantity that is not a whole number of at least one is refused', () => {
  throwsStatus(() => plan('loading', loadingRecord(), [debitRow()], { quantity: 2.5 }), 400, /whole number/);
  throwsStatus(() => plan('loading', loadingRecord(), [debitRow()], { quantity: 0 }), 400, /at least 1/);
});

test('a field that is not on the editable list is refused', () => {
  throwsStatus(
    () => plan('transaction', transactionRecord(), [creditRow()], { status: 'completed' }),
    400,
    /not an editable amount field/
  );
  throwsStatus(
    () => plan('transaction', transactionRecord(), [creditRow()], [1, 2, 3]),
    400,
    /must be an object/
  );
});

test('sources without record-side amounts are refused', () => {
  assert.equal(isAmountable('reconciliation'), false);
  assert.equal(isAmountable('__proto__'), false);
  assert.equal(isAmountable('transaction'), true);

  throwsStatus(
    () => plan('reconciliation', {}, [creditRow()], {}),
    400,
    /not correctable for reconciliation/
  );
});

test('a record with no ledger rows cannot be planned against', () => {
  throwsStatus(() => plan('transaction', transactionRecord(), [], {}), 400, /no ledger rows/);
});

test('every editable field is declared with a label and a bound', () => {
  for (const [sourceType, fields] of Object.entries(AMOUNT_FIELDS)) {
    assert.ok(fields.length > 0, `${sourceType} has no editable fields`);
    for (const field of fields) {
      assert.ok(field.key && field.label, `${sourceType}.${field.key} is incompletely specified`);
      assert.ok(field.kind === 'money' || field.kind === 'qty');
    }
  }
});

test('columnsChanged reports a real difference rather than a formatting one', () => {
  const record = transactionRecord();
  assert.equal(columnsChanged(record, { amount: 400, fee: 20, net_amount: 400 }), false);
  assert.equal(columnsChanged(record, { amount: 400.0000001, fee: 20, net_amount: 400 }), false);
  assert.equal(columnsChanged(record, { amount: 401, fee: 20, net_amount: 401 }), true);
  assert.equal(columnsChanged(transactionRecord({ fee: null }), { fee: 0 }), true);
});

test('a figure that may not go negative is refused', () => {
  throwsStatus(() => plan('transaction', transactionRecord(), [creditRow()], { amount: -1 }), 400, /cannot be below 0/);
  throwsStatus(() => plan('loading', loadingRecord(), [debitRow()], { unit_price: -2 }), 400, /cannot be below 0/);
});

test('a figure that is not a number is refused before it can reach the ledger', () => {
  throwsStatus(() => plan('transaction', transactionRecord(), [creditRow()], { amount: 'abc' }), 400, /is not a number/);
  throwsStatus(() => plan('loading', loadingRecord(), [debitRow()], { quantity: 'two' }), 400, /whole number/);
});

test('a record carrying no charges contributes nothing to the ledger', () => {
  const absent = plan('transaction', transactionRecord({ additional_charges: null }), [creditRow()], {});
  assert.deepEqual(absent.amounts, { a1: 400 });

  const alreadyParsed = plan(
    'transaction',
    transactionRecord({ additional_charges: [{ amount: '10.00' }] }),
    [creditRow()],
    {}
  );
  assert.deepEqual(alreadyParsed.amounts, { a1: 410 });
});

test('a charge list that is not an array is refused rather than counted as zero', () => {
  throwsStatus(
    () => plan('transaction', transactionRecord({ additional_charges: '{"a":1}' }), [creditRow()], {}),
    400,
    /could not be read/
  );
  throwsStatus(
    () => plan('transaction', transactionRecord({ additional_charges: 42 }), [creditRow()], {}),
    400,
    /could not be read/
  );
});

test('a missing record reports not found instead of failing on undefined', () => {
  throwsStatus(() => plan('transaction', null as any, [creditRow()], {}), 404, /No transaction found/);
});

test('a provider fee keeps its stored total when the old quantity cannot be read', () => {
  const result = plan('loading', loadingRecord({ quantity: null }), [debitRow()], { quantity: 3 });
  assert.equal(result.columns.provider_convenience_fee, 20);
});
