import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, buildCashStatement, BUCKET_LABELS, isCashMovement, isPaymentMethod, isMovementPaymentMethod, importTypeRefusal, touchesDrawer, drawerLeg, toCashRecordRow, cashRecordsCsv, cashExpenseTotal } from '../services/cashManagement';
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

test('import refuses a cash movement rather than inventing a tender', () => {
  // A CSV row has nowhere to declare how the money changed hands, and import
  // sits outside the shift gate as well. Both are enforced by the entry form,
  // so the refusal has to land before any row, balance or ledger entry exists.
  const codes = ['cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal'];
  for (const code of codes) {
    const reason = importTypeRefusal(code);
    assert.notEqual(reason, null, `${code} would be imported undeclared`);
    assert.match(reason as string, /cannot be imported/);
    assert.match(reason as string, /entry form/);
  }
});

test('import still accepts every type that needs no tender', () => {
  for (const code of ['owner_funding', 'owner_return', 'operating_expense', 'transfer_in', 'transfer_out', 'bill_payment', 'adjustment_in', 'load_purchase', null, undefined, '']) {
    assert.equal(importTypeRefusal(code), null, `${String(code)} should import`);
  }
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

test('the drawer moves opposite to the account and keeps the fee', () => {
  // Cash in, separate: ₱500 lands in the account, ₱500 leaves the drawer and
  // ₱10 comes back as income, so the drawer nets −490.
  assert.deepEqual(drawerLeg(500, 10), { amount: 490, entryType: 'debit' });
  // Cash in, deducted: the account only lands ₱490, so the drawer nets −480.
  assert.deepEqual(drawerLeg(490, 10), { amount: 480, entryType: 'debit' });
  // Cash out: ₱500 leaves the account, ₱500 arrives in the drawer plus the
  // ₱10 income on top, so the drawer nets +510. Both fee modes land here
  // because a debit is never shrunk by a deducted fee (D13).
  assert.deepEqual(drawerLeg(-500, 10), { amount: 510, entryType: 'credit' });
  // Cash out with no fee is a plain ₱500 into the drawer.
  assert.deepEqual(drawerLeg(-500, 0), { amount: 500, entryType: 'credit' });
});

test('both legs together equal the fee, so the books grow by the fee alone', () => {
  // The identity that ties the cash statement to the income report: whatever
  // the account leg, the drawer leg makes up the difference to the fee. Adding
  // them in the same direction grows the total by 2×signedAmount + fee instead
  // — ₱990 on a ₱500 cash-in, against the ₱10 the income report books.
  const signedOf = (leg: { amount: number; entryType: 'credit' | 'debit' }): number =>
    leg.entryType === 'credit' ? leg.amount : -leg.amount;

  const cases: Array<[number, number]> = [
    [500, 10],
    [490, 10],
    [-500, 10],
    [-500, 0],
    [0, 0],
    [10, 10],
  ];

  for (const [signedAmount, fee] of cases) {
    const leg = drawerLeg(signedAmount, fee);
    const drawerDelta = leg ? signedOf(leg) : 0;
    assert.equal(
      Math.round((signedAmount + drawerDelta) * 100) / 100,
      fee,
      `signedAmount=${signedAmount} fee=${fee}`
    );
  }
});

test('a movement that changes nothing physical writes no drawer row', () => {
  assert.equal(drawerLeg(0, 0), null);
});

test('the drawer figure is rounded to centavos rather than left to float error', () => {
  assert.deepEqual(drawerLeg(0.1 + 0.2, 0), { amount: 0.3, entryType: 'debit' });
  assert.deepEqual(drawerLeg(-(0.1 + 0.2), 0.01), { amount: 0.31, entryType: 'credit' });
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

test('cash expenses count only the rows where the company was the party that paid', () => {
  // The owner drawing capital back out and a customer being handed their money
  // both leave the drawer, and neither is spending. Totalling every debit would
  // have booked a 200,000 owner return as an expense.
  const rows = [
    toCashRecordRow(raw({ id: 'e1', amount: '1045.00' })),                          // operating_expenses
    toCashRecordRow(raw({ id: 'e2', amount: '30.00', txn_code: 'expense' })),       // provider_charges
    toCashRecordRow(raw({ id: 'e3', amount: '50.00', txn_code: 'bill_payment' })),  // payments
    toCashRecordRow(raw({ id: 'x1', amount: '200000.00', txn_code: 'owner_return' })),
    toCashRecordRow(raw({ id: 'x2', amount: '7220.00', txn_code: 'cash_out' })),
    toCashRecordRow(raw({ id: 'x3', amount: '1500.00', txn_code: 'transfer_out' })),
  ];
  assert.equal(cashExpenseTotal(rows), '1125.00');
});

test('money coming back through an expense bucket is not counted as spending', () => {
  // A credit in an expense bucket is a refund arriving, so adding it would
  // overstate what was paid out.
  const rows = [
    toCashRecordRow(raw({ id: 'e1', amount: '1000.00' })),
    toCashRecordRow(raw({ id: 'e2', amount: '400.00', entry_type: 'credit' })),
  ];
  assert.equal(cashExpenseTotal(rows), '1000.00');
});

test('a register with nothing to total reads 0.00, never an empty or NaN figure', () => {
  assert.equal(cashExpenseTotal([]), '0.00');
  assert.equal(
    cashExpenseTotal([toCashRecordRow(raw({ id: 'i1', txn_code: 'owner_funding', entry_type: 'credit' }))]),
    '0.00',
  );
});

test('the total adds up across every row it is handed, not one page of them', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    toCashRecordRow(raw({ id: `m${i}`, amount: '1045.00' })),
  );
  assert.equal(cashExpenseTotal(rows), '7315.00');
});
