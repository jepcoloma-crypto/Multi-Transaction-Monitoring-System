import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, buildCashStatement, BUCKET_LABELS, isCashMovement, isPaymentMethod, isMovementPaymentMethod, touchesDrawer, drawerLeg, toCashRecordRow, cashRecordsCsv } from '../services/cashManagement';
import type { BranchBalance, LedgerFlowRow, CashRecordRaw } from '../services/cashManagement';

test('an operating expense lands in its own bucket, never the provider charge bucket', () => {
  assert.equal(bucketFor('transaction', 'operating_expense'), 'operating_expenses');
  // `expense` already means provider charge and both reports filter on it
  // literally, so confusing the two would move rent into the charge column.
  assert.equal(bucketFor('transaction', 'expense'), 'provider_charges');
});

test('a transaction type code outranks the generic source type', () => {
  assert.equal(bucketFor('transaction', 'owner_funding'), 'owner_capital');
  assert.equal(bucketFor('transaction', 'owner_return'), 'owner_capital');
  assert.equal(bucketFor('transaction', 'adjustment_in'), 'adjustments');
  assert.equal(bucketFor('transaction', 'transfer_out'), 'transfers');
});

test('rows with no transaction are bucketed by their source type', () => {
  assert.equal(bucketFor('transfer', null), 'transfers');
  assert.equal(bucketFor('loading', null), 'load');
  assert.equal(bucketFor('adjustment', null), 'adjustments');
  assert.equal(bucketFor('gap_fix', null), 'corrections');
  assert.equal(bucketFor('transaction', null), 'other');
  assert.equal(bucketFor(null, null), 'other');
});

test('every reachable bucket has a display label', () => {
  const codes = [
    'owner_funding', 'owner_return', 'transfer_in', 'transfer_out',
    'cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal',
    'load_purchase', 'operating_expense', 'expense', 'service_fee',
    'bill_payment', 'refund', 'other_income', 'refund_received',
    'adjustment_in', 'adjustment_out', 'something_unrecognised',
  ];
  for (const code of codes) {
    const bucket = bucketFor('transaction', code);
    assert.ok(BUCKET_LABELS[bucket], `no label for ${bucket} (${code})`);
  }
});

test('opening plus sources minus uses equals closing', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main Branch', opening: 1000, current: 1165 },
  ];
  const rows: LedgerFlowRow[] = [
    { branch_id: 'b1', entry_type: 'credit', amount: '500.00', source_type: 'transaction', txn_code: 'owner_funding' },
    { branch_id: 'b1', entry_type: 'credit', amount: '100.00', source_type: 'transfer', txn_code: null },
    { branch_id: 'b1', entry_type: 'debit', amount: '300.00', source_type: 'transaction', txn_code: 'operating_expense' },
    { branch_id: 'b1', entry_type: 'debit', amount: '135.00', source_type: 'transaction', txn_code: 'load_purchase' },
  ];

  const statement = buildCashStatement(rows, branches);

  assert.equal(statement.totals.opening, 1000);
  assert.equal(statement.totals.sources, 600);
  assert.equal(statement.totals.uses, 435);
  assert.equal(statement.totals.closing, 1165);
  assert.equal(statement.totals.difference, 0);
  assert.equal(statement.totals.balanced, true);
});

test('a statement that does not tie to the balances reports the difference', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main', opening: 0, current: 50 },
  ];

  const statement = buildCashStatement([], branches);

  assert.equal(statement.totals.closing, 0);
  assert.equal(statement.totals.current, 50);
  assert.equal(statement.totals.difference, -50);
  assert.equal(statement.totals.balanced, false);
});

test('each branch keeps its own sources and uses', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main', opening: 100, current: 150 },
    { id: 'b2', code: 'RM', name: 'Reina Mercedes', opening: 0, current: 80 },
  ];
  const rows: LedgerFlowRow[] = [
    { branch_id: 'b1', entry_type: 'credit', amount: 100, source_type: 'transaction', txn_code: 'cash_in' },
    { branch_id: 'b1', entry_type: 'debit', amount: 50, source_type: 'transaction', txn_code: 'operating_expense' },
    { branch_id: 'b2', entry_type: 'credit', amount: 80, source_type: 'transaction', txn_code: 'owner_funding' },
  ];

  const statement = buildCashStatement(rows, branches);
  const main = statement.branches.find((b) => b.code === 'MAIN')!;
  const rm = statement.branches.find((b) => b.code === 'RM')!;

  assert.equal(main.sources, 100);
  assert.equal(main.uses, 50);
  assert.equal(main.closing, 150);
  assert.equal(rm.closing, 80);
  assert.equal(statement.totals.closing, 230);
  assert.equal(statement.totals.balanced, true);
});

test('operating expenses are reported under uses only, with their own label', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main', opening: 500, current: 300 },
  ];
  const rows: LedgerFlowRow[] = [
    { branch_id: 'b1', entry_type: 'debit', amount: '200', source_type: 'transaction', txn_code: 'operating_expense' },
  ];

  const statement = buildCashStatement(rows, branches);
  const line = statement.uses.find((l) => l.bucket === 'operating_expenses');

  assert.ok(line, 'operating expenses missing from uses');
  assert.equal(line.amount, 200);
  assert.equal(line.count, 1);
  assert.equal(line.label, 'Operating Expenses');
  assert.equal(statement.sources.find((l) => l.bucket === 'operating_expenses'), undefined);
});

test('amounts are summed in cents so fractional totals do not drift', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main', opening: 0, current: 0.3 },
  ];
  const rows: LedgerFlowRow[] = [0.1, 0.1, 0.1].map((amount) => ({
    branch_id: 'b1',
    entry_type: 'credit' as const,
    amount,
    source_type: 'transaction',
    txn_code: 'cash_in',
  }));

  const statement = buildCashStatement(rows, branches);

  assert.equal(statement.totals.sources, 0.3);
  assert.equal(statement.totals.balanced, true);
});

test('a branch with no activity at all still reports a balanced zero statement', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main', opening: 0, current: 0 },
    { id: 'b2', code: 'RM', name: 'Reina Mercedes', opening: 0, current: 0 },
  ];

  const statement = buildCashStatement([], branches);

  assert.equal(statement.sources.length, 0);
  assert.equal(statement.uses.length, 0);
  assert.equal(statement.branches.length, 2);
  assert.equal(statement.totals.difference, 0);
  assert.equal(statement.totals.balanced, true);
});

test('only the four money-through-the-drawer codes count as cash movements', () => {
  assert.equal(isCashMovement('cash_in'), true);
  assert.equal(isCashMovement('cash_out'), true);
  assert.equal(isCashMovement('customer_payment'), true);
  assert.equal(isCashMovement('customer_withdrawal'), true);

  // These move money between accounts rather than through them, so asking the
  // operator how the cash was handed over would be a meaningless question.
  assert.equal(isCashMovement('owner_funding'), false);
  assert.equal(isCashMovement('operating_expense'), false);
  assert.equal(isCashMovement('adjustment_in'), false);
  assert.equal(isCashMovement(null), false);
  assert.equal(isCashMovement(undefined), false);
});

test('every cash movement code reports into the customer cash bucket', () => {
  // The two vocabularies are declared independently, so this is the check that
  // they still agree: a movement asked for a payment method had better be one
  // of the rows counted as money moving through the branch.
  const codes = ['cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal'];
  for (const code of codes) {
    assert.equal(isCashMovement(code), true, `${code} is no longer a cash movement`);
    assert.equal(bucketFor('transaction', code), 'customer_cash', `${code} left the cash bucket`);
  }
});

test('a payment method has to be one the system understands', () => {
  for (const value of ['cash', 'gcash', 'bank', 'maya', 'provider_interest']) {
    assert.equal(isPaymentMethod(value), true, `${value} should be accepted`);
  }

  assert.equal(isPaymentMethod('bitcoin'), false);
  assert.equal(isPaymentMethod('Cash'), false);
  assert.equal(isPaymentMethod(''), false);
  assert.equal(isPaymentMethod(null), false);
  assert.equal(isPaymentMethod(undefined), false);
  assert.equal(isPaymentMethod(12), false);
});

test('a cash movement may not be recorded as paid by provider interest', () => {
  assert.equal(isMovementPaymentMethod('cash'), true);
  assert.equal(isMovementPaymentMethod('gcash'), true);
  assert.equal(isMovementPaymentMethod('bank'), true);
  assert.equal(isMovementPaymentMethod('maya'), true);

  // Interest income describes where a credit came from, not how cash changed
  // hands, so it stays legal on the column while being refused here.
  assert.equal(isMovementPaymentMethod('provider_interest'), false);
  assert.equal(isMovementPaymentMethod('cash'), isPaymentMethod('cash'));
});

test('every accepted movement method is also a legal stored value', () => {
  for (const value of ['cash', 'gcash', 'bank', 'maya']) {
    assert.equal(isPaymentMethod(value), true, `${value} is on the movement list but not the column list`);
  }
});

test('only physical cash touches the drawer', () => {
  assert.equal(touchesDrawer('cash'), true);

  // A GCash or bank movement lands in the wallet without passing through the
  // drawer, so giving it a second leg would count the same peso twice.
  assert.equal(touchesDrawer('gcash'), false);
  assert.equal(touchesDrawer('bank'), false);
  assert.equal(touchesDrawer('maya'), false);
  assert.equal(touchesDrawer('provider_interest'), false);
  // Historical rows are NULL on purpose and must stay single-legged rather than
  // defaulting to the drawer.
  assert.equal(touchesDrawer(null), false);
  assert.equal(touchesDrawer(undefined), false);
});

test('the drawer receives the fee on top of an inflow', () => {
  // Deducted: ₱490 lands in the wallet, ₱500 of physical cash is received.
  assert.deepEqual(drawerLeg(490, 10), { amount: 500, entryType: 'credit' });
  // Separate: ₱500 lands and the ₱10 fee is paid in cash on top.
  assert.deepEqual(drawerLeg(500, 10), { amount: 510, entryType: 'credit' });
});

test('the drawer keeps the fee on an outflow', () => {
  // Both fee modes land on the same figure: ₱500 comes out of the wallet and
  // ₱490 is physically handed over.
  assert.deepEqual(drawerLeg(-500, 10), { amount: 490, entryType: 'debit' });
  assert.deepEqual(drawerLeg(-500, 0), { amount: 500, entryType: 'debit' });
});

test('a deducted fee stays in the drawer instead of disappearing', () => {
  // The wallet loses ₱500 and ₱490 is handed over, so ₱10 of the withdrawal is
  // the company's fee and it is still in the drawer. Had the debit been posted
  // as ₱490, this same expression would have returned −480 and the ₱10 would
  // have existed nowhere at all while the income report counted it as earned.
  const leg = drawerLeg(-500, 10)!;
  assert.equal(leg.amount, 490);
  assert.equal(Math.abs(-500) - leg.amount, 10);
});

test('a movement that changes nothing physical writes no drawer row', () => {
  assert.equal(drawerLeg(0, 0), null);
});

test('the drawer figure is rounded to centavos rather than left to float error', () => {
  assert.deepEqual(drawerLeg(0.1 + 0.2, 0), { amount: 0.3, entryType: 'credit' });
  assert.deepEqual(drawerLeg(-(0.1 + 0.2), 0.01), { amount: 0.29, entryType: 'debit' });
});

test('a shift float is a class of its own, not lumped into Other', () => {
  // A shift writes no ledger row, so this names the classification a float row
  // must land in if one is ever posted from a shift rather than silently
  // reading as an unexplained correction.
  assert.equal(bucketFor('opening_float', null), 'opening_float');
  assert.equal(bucketFor('shift', null), 'opening_float');
  assert.equal(BUCKET_LABELS.opening_float, 'Opening Float');
});

const raw = (over: Partial<CashRecordRaw>): CashRecordRaw => ({
  id: 'l1',
  entry_date: '2026-10-07T15:21:25.562Z',
  entry_type: 'debit',
  amount: '1045.00',
  balance_after: '130782.00',
  source_type: 'transaction',
  reference_number: null,
  description: 'Operating expense',
  account_name: 'Revolving Fund',
  branch_code: 'MAIN',
  branch_name: 'Main Branch',
  transaction_number: 253,
  transaction_date: '2026-10-07T15:21:25.562Z',
  payee: null,
  txn_code: 'operating_expense',
  payment_method: null,
  created_by_username: 'admin',
  ...over,
});

test('a register row reads its class from the same bucket the statement totals by', () => {
  const row = toCashRecordRow(raw({}));
  assert.equal(row.bucket, 'operating_expenses');
  assert.equal(row.category, 'Operating Expenses');
  assert.equal(row.direction, 'out');
  assert.equal(row.amount, '1045.00');
  assert.equal(row.balanceAfter, '130782.00');
  assert.equal(row.transactionNumber, 253);
});

test('a credit reads as money in, a debit as money out', () => {
  assert.equal(toCashRecordRow(raw({ entry_type: 'credit' })).direction, 'in');
  assert.equal(toCashRecordRow(raw({ entry_type: 'debit' })).direction, 'out');
});

test('a register row is filed under its business date, not the posting instant', () => {
  // The expense was entered for Sep 25 but posted into the drawer on Oct 7.
  // The register lists it under Sep 25 and keeps the posting instant beside it.
  const row = toCashRecordRow(raw({
    transaction_date: '2026-09-25T15:21:25.551Z',
    entry_date: '2026-10-07T15:21:25.562Z',
  }));
  assert.equal(row.businessDate, '2026-09-25T15:21:25.551Z');
  assert.equal(row.entryDate, '2026-10-07T15:21:25.562Z');
});

test('a row with no transaction falls back to its posting instant for the date', () => {
  // A transfer or adjustment has no business date to name, so it must still be
  // filed under a real day rather than an empty or invalid one.
  const row = toCashRecordRow(raw({
    source_type: 'transfer', txn_code: null, transaction_number: null, transaction_date: null,
  }));
  assert.equal(row.businessDate, '2026-10-07T15:21:25.562Z');
  assert.equal(row.businessDate, row.entryDate);
});

test('an unparseable business date falls back rather than reaching the formatter as garbage', () => {
  const row = toCashRecordRow(raw({ transaction_date: 'not-a-date' }));
  assert.equal(row.businessDate, row.entryDate);
});

test('a register row with no transaction keeps its source type and names no txn', () => {
  const row = toCashRecordRow(raw({
    source_type: 'transfer', txn_code: null, transaction_number: null,
  }));
  assert.equal(row.bucket, 'transfers');
  assert.equal(row.transactionNumber, null);
});

test('an unrecognised row is classified rather than left blank', () => {
  // The register is the drawer's complete history, so a row it cannot place
  // still has to appear — under Other, not missing.
  const row = toCashRecordRow(raw({ source_type: null, txn_code: null }));
  assert.equal(row.bucket, 'other');
  assert.equal(row.category, 'Other');
});

test('the register carries the posting instant, unrounded', () => {
  const row = toCashRecordRow(raw({ entry_date: '2026-10-07T15:21:25.562Z' }));
  assert.equal(row.entryDate, '2026-10-07T15:21:25.562Z');
});

test('a row with a null entry date does not throw or invent one', () => {
  const row = toCashRecordRow(raw({ entry_date: null as unknown as string }));
  assert.equal(row.entryDate, new Date(null as unknown as number).toISOString());
});

test('the CSV leads with the business day and keeps the posting instant beside it', () => {
  const csv = cashRecordsCsv([
    toCashRecordRow(raw({
      transaction_date: '2026-09-25T15:21:25.551Z',
      entry_date: '2026-10-07T15:21:25.562Z',
    })),
  ]);
  const lines = csv.split('\r\n');

  assert.ok(csv.startsWith('\uFEFF'), 'the BOM is what makes Excel read the file');
  assert.ok(lines[0].includes('"Business Day"') && lines[0].includes('"Posted At"') && lines[0].includes('"Balance After"'));
  assert.ok(lines[1].includes('"2026-09-25 23:21"'), `expected the Sep 25 business day, got ${lines[1]}`);
  assert.ok(lines[1].includes('"2026-10-07 23:21"'), `expected the Oct 7 posting instant, got ${lines[1]}`);
});

test('the CSV reads every date in Manila, not UTC', () => {
  // 2026-10-07T18:00Z is 2026-10-08 02:00 in Manila — a row near midnight must
  // export as the Manila day, not the UTC one. The bug this guards is a
  // last-day-off export.
  const csv = cashRecordsCsv([
    toCashRecordRow(raw({ id: 'l2', transaction_number: null, transaction_date: null, entry_date: '2026-10-07T18:00:00.000Z' })),
  ]);
  assert.ok(csv.includes('"2026-10-08 02:00"'), `expected Manila Oct 8, got ${csv}`);
});

test('the CSV quotes a description so a comma or quote cannot break a column', () => {
  const csv = cashRecordsCsv([
    toCashRecordRow(raw({ description: 'Rent, "October"' })),
  ]);
  assert.ok(csv.includes('"Rent, ""October"""'), 'a comma or quote must be escaped, not dropped');
});

test('the CSV writes a null field as an empty cell, never as the text null', () => {
  const csv = cashRecordsCsv([
    toCashRecordRow(raw({ payee: null, reference_number: null, transaction_number: null, payment_method: null })),
  ]);
  assert.ok(!csv.includes('null'), `a null leaked into the file: ${csv}`);
});
