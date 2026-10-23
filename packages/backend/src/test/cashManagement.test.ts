import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, buildCashStatement, BUCKET_LABELS, EXPENSE_BUCKETS, isCashMovement, isPaymentMethod, isMovementPaymentMethod, importTypeRefusal, touchesDrawer, drawerLeg, drawerLegs, feeRowDescription, isFeeLedgerRow, unwindDrawerLeg, chargeDrawerLeg, drawerAccountId, toCashRecordRow, cashRecordsCsv, cashExpenseTotal, resolveCashAccountMethod, directTypeRefusal, expenseFeeRefusal, controlledApproval, CONTROLLED_TXN_CODES, CASH_EVENT_APPROVAL_CODES, HEAD_OFFICE_APPROVAL_CODES, isControlledType, approvalAuditAction } from '../services/cashManagement';
import { feeOnDrawerOf } from '../services/movementPlan';
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
  // A provider's interest credit posts under `owner_funding` — it has no type
  // of its own — but it is not the owner's money, and filing it as capital made
  // Sources and Uses answer "how much did the owner contribute" with what a
  // provider paid. The row's own description already said otherwise: the form
  // beside it skips the "Owner funding via" headline for this exact method.
  assert.equal(bucketFor('transaction', 'owner_funding', 'provider_interest'), 'other_income');
  // Everything else the owner hands over stays capital, and a caller that cannot
  // say how the money arrived keeps the historical reading.
  assert.equal(bucketFor('transaction', 'owner_funding', 'cash'), 'owner_capital');
  assert.equal(bucketFor('transaction', 'owner_funding', null), 'owner_capital');
  assert.equal(bucketFor('transaction', 'owner_funding', 'gcash'), 'owner_capital');
  // The outward code is never judged on the method: money leaving the company
  // cannot be a credit the provider paid in.
  assert.equal(bucketFor('transaction', 'owner_return', 'provider_interest'), 'owner_capital');
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
    'adjustment_in', 'adjustment_out', 'loan_received', 'loan_repayment',
    'cash_payment',
    'something_unrecognised',
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

test('interest moves to Other Income without leaving the sources side or changing a total', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main Branch', opening: 100, current: 115.96 },
  ];
  const rows: LedgerFlowRow[] = [
    { branch_id: 'b1', entry_type: 'credit', amount: '10.00', source_type: 'transaction', txn_code: 'owner_funding', payment_method: 'provider_interest' },
    { branch_id: 'b1', entry_type: 'credit', amount: '5.96', source_type: 'transaction', txn_code: 'owner_funding', payment_method: 'provider_interest' },
  ];

  const statement = buildCashStatement(rows, branches);

  // The whole point of the correction: Owner Capital must stop claiming an
  // interest credit as an owner contribution.
  assert.equal(statement.sources.find((l) => l.bucket === 'owner_capital'), undefined);
  const other = statement.sources.find((l) => l.bucket === 'other_income');
  assert.ok(other, 'interest missing from Other Income');
  assert.equal(other.amount, 15.96);
  assert.equal(other.count, 2);
  assert.equal(other.label, 'Other Income');

  // And it stays a source under the new label — sources and uses follow the
  // entry's direction, never the bucket — so opening + sources - uses still
  // ties to the balance beside it.
  assert.equal(statement.totals.sources, 15.96);
  assert.equal(statement.totals.uses, 0);
  assert.equal(statement.totals.closing, 115.96);
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

test('only the money-through-the-drawer codes count as cash movements', () => {
  assert.equal(isCashMovement('cash_in'), true);
  assert.equal(isCashMovement('cash_out'), true);
  assert.equal(isCashMovement('customer_payment'), true);
  assert.equal(isCashMovement('customer_withdrawal'), true);
  // A bills payment settled at the counter hands cash across the drawer — the
  // wallet pays the biller and the till keeps the customer's money. Declared
  // method-less there was nowhere for its drawer side to come from, so the leg
  // (amount, charges and fee) vanished while the wallet still paid out.
  assert.equal(isCashMovement('bill_payment'), true);

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
  const codes = ['cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal', 'bill_payment'];
  for (const code of codes) {
    const reason = importTypeRefusal(code);
    assert.notEqual(reason, null, `${code} would be imported undeclared`);
    assert.match(reason as string, /cannot be imported/);
    assert.match(reason as string, /entry form/);
  }
});

test('import still accepts every type that needs no tender', () => {
  for (const code of ['owner_funding', 'owner_return', 'operating_expense', 'transfer_in', 'transfer_out', 'adjustment_in', 'load_purchase', null, undefined, '']) {
    assert.equal(importTypeRefusal(code), null, `${String(code)} should import`);
  }
});

test('every cash movement code reports into the customer cash bucket', () => {
  // The two vocabularies are declared independently, so this is the check that
  // they still agree: a movement asked for a payment method had better be one
  // of the rows counted as money moving through the branch.
  const codes = ['cash_in', 'cash_out', 'customer_payment', 'customer_withdrawal', 'bill_payment'];
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
  // The drawer answers from the account's whole figure and its fee — D42's
  // formula, untouched by D46 — so these examples quote the four-cell net.
  // Cash in, fee inside: the account lands the ₱500 the customer sent, ₱500
  // leaves the drawer and the ₱10 comes back as income, so the drawer nets
  // −490; since D46 a cash-in's fee collected on top nets exactly the same.
  assert.deepEqual(drawerLeg(500, 10), { amount: 490, entryType: 'debit' });
  // A smaller landing nets less out of the drawer.
  assert.deepEqual(drawerLeg(490, 10), { amount: 480, entryType: 'debit' });
  // Cash out, fee on top: ₱500 leaves the account, ₱500 arrives in the drawer
  // plus the ₱10 income on top, so the drawer nets +510.
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

// The rows the drawer really writes (D37/D46): the fee credited back to the
// till first whenever the tender put it there, then the movement itself. The
// flag is `feeOnDrawerOf`'s answer, not the direction — a cash-in collected on
// top carries its fee to the till like a cash-out does, and a cash-in whose fee
// was cut from the amount writes only the net. Either way the rows sum to
// `drawerLeg`, so no balance moves.

test("a cash-out's drawer keeps D37's split: the fee, then the movement", () => {
  // ₱500 comes back to the till and the ₱10 income is on top — the customer
  // paid the fee in cash, so it lands in the till as its own line.
  assert.deepEqual(drawerLegs(-500, 10, true), [
    { amount: 10, entryType: 'credit', role: 'fee' },
    { amount: 500, entryType: 'credit', role: 'movement' },
  ]);
  // No fee: one row, exactly as before — the split changes nothing when there
  // is nothing to split.
  assert.deepEqual(drawerLegs(-500, 0, false), [
    { amount: 500, entryType: 'credit', role: 'movement' },
  ]);
});

test("a cash-in collected on top hands the till its fee as its own line (D46)", () => {
  // The customer handed ₱310 for a ₱300 cash-in: the account lands ₱300, the
  // till keeps the ₱10 as the income line it is, so it gives up ₱290 net.
  assert.deepEqual(drawerLegs(300, 10, true), [
    { amount: 10, entryType: 'credit', role: 'fee' },
    { amount: 300, entryType: 'debit', role: 'movement' },
  ]);
  // And the split is still just the net row said out loud.
  assert.equal(
    drawerLegs(300, 10, true).reduce((sum, r) => sum + (r.entryType === 'credit' ? r.amount : -r.amount), 0),
    -290
  );
});

test("a cash-in whose fee was cut from the amount posts the net alone (D42)", () => {
  // ₱3,030 typed with a ₱30 fee inside it: the account still lands the whole
  // ₱3,030 and the till hands over ₱3,000, the fee riding the receiving side.
  assert.deepEqual(drawerLegs(3030, 30, false), [
    { amount: 3000, entryType: 'debit', role: 'movement' },
  ]);
  // The whole account figure crossing the till nets the same single row.
  assert.deepEqual(drawerLegs(1500, 20, false), [
    { amount: 1480, entryType: 'debit', role: 'movement' },
  ]);
});

test('the drawer rows net to the drawer leg, so no balance moves', () => {
  const signedOf = (leg: { amount: number; entryType: 'credit' | 'debit' }): number =>
    leg.entryType === 'credit' ? leg.amount : -leg.amount;

  const cases: Array<[number, number, boolean]> = [
    [1480, 20, true],
    [1500, 20, false],
    [-500, 10, true],
    [-500, 0, false],
    [1500, 20, true],
    [-500, 10, false],
    [0, 20, true],
    [0, 0, false],
    [10, 10, true],
    [10, 10, false],
    [0.1 + 0.2, 0.01, true],
    [300, 10, true],
    [3030, 30, false],
  ];

  for (const [signedAmount, fee, feeOnDrawer] of cases) {
    const context = `signedAmount=${signedAmount} fee=${fee} feeOnDrawer=${feeOnDrawer}`;
    const rows = drawerLegs(signedAmount, fee, feeOnDrawer);
    const split = rows.reduce((sum, row) => sum + signedOf(row), 0);
    const net = drawerLeg(signedAmount, fee);
    const single = net ? signedOf(net) : 0;
    assert.equal(Math.round(split * 100) / 100, Math.round(single * 100) / 100, context);

    // And the identity D24 pins still holds over the rows: account plus drawer
    // grows the books by exactly the fee the income report books.
    assert.equal(
      Math.round((signedAmount + split) * 100) / 100,
      fee,
      context
    );
  }
});

test('rows that net to zero write nothing, like the net row they replace', () => {
  // ₱20 fee on a ₱20 movement: the books still grow by the fee (the account's
  // own ₱20), so nothing is owed to the drawer either way.
  assert.deepEqual(drawerLegs(20, 20, true), []);
  assert.deepEqual(drawerLegs(20, 20, false), []);
  assert.deepEqual(drawerLegs(0, 0, true), []);
  assert.deepEqual(drawerLegs(0, 0, false), []);
});

test('which side takes the fee row is one rule, asked once (D46)', () => {
  // A cash-out always put its fee in the till — the customer paid it in cash.
  assert.equal(feeOnDrawerOf({ direction: 'out', fee: 30, feeAddedToBalance: true }), true);
  assert.equal(feeOnDrawerOf({ direction: 'out', fee: 30, feeAddedToBalance: false }), true);
  // A cash-in's fee belongs to the till when it was collected on top, and to
  // the receiving account when it was cut from the amount (D42, unchanged).
  assert.equal(feeOnDrawerOf({ direction: 'in', fee: 10, feeAddedToBalance: true }), true);
  assert.equal(feeOnDrawerOf({ direction: 'in', fee: 10, feeAddedToBalance: false }), false);
  // A null reads as on top, exactly as `fee_added_to_balance IS NOT FALSE` does.
  assert.equal(feeOnDrawerOf({ direction: 'in', fee: 10, feeAddedToBalance: true }), true);
  // No fee, no row to place — inert rather than guessed at.
  assert.equal(feeOnDrawerOf({ direction: 'in', fee: 0, feeAddedToBalance: true }), false);
  assert.equal(feeOnDrawerOf({ direction: 'out', fee: 0, feeAddedToBalance: true }), false);
});

test('the fee row names itself so a statement can tell it apart', () => {
  assert.equal(
    feeRowDescription('Cash-in for Jessica'),
    'Service fee — Cash-in for Jessica'
  );
  assert.equal(feeRowDescription(null), 'Service fee');
  assert.equal(feeRowDescription(''), 'Service fee');

  assert.equal(isFeeLedgerRow('Service fee — Cash-in for Jessica'), true);
  assert.equal(isFeeLedgerRow('Service fee'), true);
  // A description that merely mentions a fee keeps its fee column: the prefix
  // has to name the whole row, not the subject of the sentence.
  assert.equal(isFeeLedgerRow('Service fee billed monthly'), false);
  assert.equal(isFeeLedgerRow('Monthly service fee collected'), false);
  assert.equal(isFeeLedgerRow(null), false);
  assert.equal(isFeeLedgerRow(undefined), false);
});

// The unwind pair: what a reversal posts to the drawer, and what a charge
// adjustment posts to it. Both read the rows the original wrote rather than
// recomputing a figure the reversal would state differently (fee 0).

const drawerRow = (amount: number, entryType: 'debit' | 'credit') => ({
  account_id: 'drawer-1',
  amount: amount.toFixed(2),
  entry_type: entryType,
});

test('an unwind is the exact opposite of what the movement recorded', () => {
  // With no fee to keep, the unwind is the mirror: that ₱1,500 cash-in posted
  // a ₱1,480 debit on the drawer, and a credit of ₱1,480 takes it back.
  // Recomputing from the reversal's own figures would not agree with the
  // ₱1,480 that actually posted.
  assert.deepEqual(unwindDrawerLeg([drawerRow(1480, 'debit')]), {
    accountId: 'drawer-1', amount: 1480, entryType: 'credit',
  });
  // A cash-out put ₱510 into the drawer; its unwind takes it out again.
  assert.deepEqual(unwindDrawerLeg([drawerRow(510, 'credit')]), {
    accountId: 'drawer-1', amount: 510, entryType: 'debit',
  });
});

test('the fee comes back inside the movement, so the mirror alone is the whole unwind (D40)', () => {
  // The recorded rows are the fee credited to the till and the movement
  // settling against it, so mirroring their sum hands back the net the drawer
  // actually moved: that ₱1,480 debit (the ₱20 fee row and the ₱1,500
  // movement netted) is taken back by a credit of ₱1,480, and the ₱20 income
  // is refunded alongside it — sitting nowhere in the till where the next
  // count would fail to find it.
  assert.deepEqual(unwindDrawerLeg([drawerRow(1480, 'debit')]), {
    accountId: 'drawer-1', amount: 1480, entryType: 'credit',
  });
  // A cash-out that put ₱510 into the drawer gives back the full ₱510 —
  // the ₱10 fee included, since a reversal refunds the fee with the movement.
  assert.deepEqual(unwindDrawerLeg([drawerRow(510, 'credit')]), {
    accountId: 'drawer-1', amount: 510, entryType: 'debit',
  });
});

test('a movement that never touched the drawer unwinds nothing', () => {
  assert.equal(unwindDrawerLeg([]), null);
  assert.equal(drawerAccountId([]), null);
});

test('rows a correction appended to the drawer are summed, not counted twice', () => {
  // Corrections append, so one record can own two rows on the drawer — the
  // unwind has to cancel what they add up to.
  assert.deepEqual(
    unwindDrawerLeg([drawerRow(100, 'credit'), drawerRow(40, 'debit')]),
    { accountId: 'drawer-1', amount: 60, entryType: 'debit' },
  );
  // A pair that cancels exactly writes no row at all: a 0.00 entry carries no
  // information and would show up as a movement in the statement.
  assert.equal(unwindDrawerLeg([drawerRow(75, 'credit'), drawerRow(75, 'debit')]), null);
  // Centavo-exact, so a string read from a NUMERIC column cannot leave a
  // residue the count would have to explain.
  assert.equal(unwindDrawerLeg([drawerRow(0.1 + 0.2, 'credit'), drawerRow(0.3, 'debit')]), null);
});

test('a drawer side spanning two accounts is refused rather than guessed at', () => {
  const rows = [drawerRow(10, 'credit'), { ...drawerRow(10, 'debit'), account_id: 'drawer-2' }];
  assert.throws(() => unwindDrawerLeg(rows), (err: any) => err.statusCode === 409);
  // The same rule decides a charge adjustment — one drawer, not a choice.
  assert.throws(() => chargeDrawerLeg(rows, 5, 'credit'), (err: any) => err.statusCode === 409);
});

test('a reversal hands back exactly what the original booked, whichever way the fee was paid', () => {
  const signedOf = (leg: { amount: number; entryType: 'credit' | 'debit' }): number =>
    leg.entryType === 'credit' ? leg.amount : -leg.amount;
  // `+ 0` normalizes a computed −0 to 0 so a strict comparison cannot fail on
  // the sign of zero in the no-fee case.
  const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

  // [signed account leg, fee]. The original's two legs sum to the fee it
  // books, and the reversal's two legs sum to that fee negated — a complete
  // undo, whichever way the fee was paid, because a reversal mirrors the
  // recorded rows rather than recomputing them (D40), so the fee comes back
  // with the movement under D46's cells too. That is what the income report
  // says about the same row: a reversed transaction is totalled wholly as
  // refunded, so nothing that was undone is still claimed as earned.
  const cases: [number, number][] = [
    [500, 10],    // cash-in, fee inside
    [-500, 10],   // cash-out, fee on top
    [-500, 0],    // no fee: nothing to refund
  ];

  for (const [signedAmount, fee] of cases) {
    const context = `signedAmount=${signedAmount} fee=${fee}`;
    const originalDrawer = drawerLeg(signedAmount, fee);

    // The identity the income report leans on: the original's two legs sum to
    // the fee it books.
    const originalBooks = signedAmount + (originalDrawer ? signedOf(originalDrawer) : 0);
    assert.equal(round2(originalBooks), fee, context);

    const unwind = unwindDrawerLeg(
      originalDrawer ? [drawerRow(originalDrawer.amount, originalDrawer.entryType)] : [],
    );
    const reversalAccount = -signedAmount;
    const reversalDrawer = unwind ? signedOf(unwind) : 0;
    const reversalBooks = reversalAccount + reversalDrawer;
    assert.equal(round2(reversalBooks), round2(-fee), context);
    // Stated without a -0 that could fail a strict comparison.
    assert.equal(round2(originalBooks + reversalBooks), 0, context);
  }
});

test('a charge adjustment takes the drawer the other way from the account', () => {
  const rows = [drawerRow(1480, 'debit')];

  // Added to a cash-in, the account is credited, so the drawer hands it out.
  assert.deepEqual(chargeDrawerLeg(rows, 100, 'credit'), {
    accountId: 'drawer-1', amount: 100, entryType: 'debit',
  });
  // Added to a cash-out, the account is debited, so the drawer receives it.
  assert.deepEqual(chargeDrawerLeg(rows, 100, 'debit'), {
    accountId: 'drawer-1', amount: 100, entryType: 'credit',
  });
  // A charge taken back off a cash-in: the account is debited the amount it
  // had been credited, and the drawer takes it back — the route already flips
  // the account's direction for a negative delta, so the drawer follows it.
  assert.deepEqual(chargeDrawerLeg(rows, -100, 'debit'), {
    accountId: 'drawer-1', amount: 100, entryType: 'credit',
  });
  // Nothing to move: no delta, or no drawer side to move.
  assert.equal(chargeDrawerLeg(rows, 0, 'credit'), null);
  assert.equal(chargeDrawerLeg([], 100, 'credit'), null);
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
  transaction_id: 'c9d1f0a2-0000-4000-8000-000000000253',
  transaction_status: 'completed',
  reversed_by_number: null,
  reversed_by_at: null,
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

test('a register row carries the transaction id the reversal action needs', () => {
  // The number identifies a row to a reader; the id is what the reverse
  // endpoint takes. Serving only the number would leave the register unable
  // to act on its own rows.
  const row = toCashRecordRow(raw({}));
  assert.equal(row.transactionNumber, 253);
  assert.equal(row.transactionId, 'c9d1f0a2-0000-4000-8000-000000000253');
});

test('a ledger row with no transaction carries no id and no status, so it cannot be offered a reversal', () => {
  // Transfers, adjustments and gap fixes write ledger rows with no transaction
  // behind them. Passing an id through would offer an action that can only
  // fail, so the number governs: no number, no id. The status goes with them —
  // a row with no transaction has no standing to report, and a register that
  // printed one would be inventing a fact.
  const row = toCashRecordRow(raw({ transaction_number: null, transaction_id: 'should-not-appear', transaction_status: 'reversed' }));
  assert.equal(row.transactionNumber, null);
  assert.equal(row.transactionId, null);
  assert.equal(row.transactionStatus, null);
});

test('a reversed row keeps its entry, carries its status, and names what undid it', () => {
  // Reversing never deletes the entry — the posting happened, and a ledger that
  // erased it could no longer be audited. But the money has since been given
  // back, and a column of figures cannot tell a reader that: without the status
  // a refunded expense reads as spending that still stands. Naming the row that
  // undid it turns the flag into something checkable.
  const row = toCashRecordRow(raw({
    transaction_status: 'reversed',
    reversed_by_number: 389,
    reversed_by_at: '2026-10-11T14:27:42.000Z',
  }));
  assert.equal(row.transactionStatus, 'reversed');
  assert.equal(row.reversedByNumber, 389);
  assert.equal(row.reversedAt, '2026-10-11T14:27:42.000Z');
  assert.equal(row.amount, '1045.00');

  // The export carries the same facts — a printed register is the one a reader
  // cannot click on.
  const csv = cashRecordsCsv([row]);
  assert.ok(csv.includes('"reversed"'), `the export must carry the status too: ${csv}`);
  assert.ok(csv.includes('"389"'), `the export must carry the reversal too: ${csv}`);
});

test('a row nothing undid carries no reversal link, and a half-parsed one is dropped rather than shown', () => {
  // The link is offered as a fact, so it is either a transaction number the
  // reader can go and look at, or it is absent. A row with no transaction
  // behind it cannot have one at all, and a reference that will not parse is
  // worth nothing printed — a reader would follow it and find nothing.
  const standing = toCashRecordRow(raw({}));
  assert.equal(standing.reversedByNumber, null);
  assert.equal(standing.reversedAt, null);

  const broken = toCashRecordRow(raw({
    transaction_status: 'reversed',
    reversed_by_number: 'not-a-number',
    reversed_by_at: 'not-a-date',
  }));
  assert.equal(broken.reversedByNumber, null);
  assert.equal(broken.reversedAt, null);
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
    toCashRecordRow(raw({ id: 'e3', amount: '50.00', txn_code: 'refund' })),          // payments
    toCashRecordRow(raw({ id: 'x1', amount: '200000.00', txn_code: 'owner_return' })),
    toCashRecordRow(raw({ id: 'x2', amount: '7220.00', txn_code: 'cash_out' })),
    toCashRecordRow(raw({ id: 'x3', amount: '1500.00', txn_code: 'transfer_out' })),
  ];
  assert.equal(cashExpenseTotal(rows), '1125.00');
});

test('a bills payment collected at the counter is never company spending', () => {
  // The drawer row of a bills payment is the customer's own money arriving —
  // the wallet paid the biller, the till kept the cash — so filing it under
  // "Payments & Bills" would report money the company received as money the
  // company spent. Cash leaving the drawer to settle a bill of the company's
  // own has `cash_payment`, whose bucket sits outside the expense total.
  const row = toCashRecordRow(raw({ id: 'bp1', amount: '4181.00', txn_code: 'bill_payment' }));
  assert.equal(cashExpenseTotal([row]), '0.00');
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

test('borrowed cash is a source of its own, never owner capital and never income', () => {
  // The three ways this could have been recorded are the three ways it would
  // have lied. As `owner_funding` it reports debt as equity; as `other_income`
  // it claims the company earned money it has to give back; as an adjustment it
  // claims the balance had been wrong. A bucket of its own is also what makes
  // the outstanding balance readable as sources less uses.
  assert.equal(bucketFor('transaction', 'loan_received'), 'borrowings');
  assert.equal(bucketFor('transaction', 'loan_repayment'), 'borrowings');
  assert.equal(BUCKET_LABELS.borrowings, 'Borrowings');
});

test('paying a loan back is not spending', () => {
  // Handing back principal leaves the drawer exactly as an owner return does:
  // the money was never the company's to spend, so totalling it as a cost would
  // report the size of the loan as the cost of being in business. Interest on
  // that loan is a real cost and still arrives as its own expense row.
  const rows = [
    toCashRecordRow(raw({ id: 'b1', amount: '50000.00', txn_code: 'loan_received', entry_type: 'credit' })),
    toCashRecordRow(raw({ id: 'b2', amount: '10000.00', txn_code: 'loan_repayment' })),
    toCashRecordRow(raw({ id: 'c1', amount: '1045.00' })),
  ];
  assert.equal(cashExpenseTotal(rows), '1045.00');
});

test('a borrowing waits for a second signature unless an administrator records it', () => {
  // A loan creates a debt the company has to repay, so it follows the owner
  // money rule rather than the threshold: anyone else leaves it for approval,
  // an administrator takes it at once because the cash has already arrived in
  // the drawer and a pending row would leave the shift's expected figure behind
  // the physical count.
  assert.deepEqual(controlledApproval('loan_received', 50000, 3000, true), {
    controlled: true,
    requiresApproval: false,
  });
  assert.deepEqual(controlledApproval('loan_repayment', 10000, 3000, false), {
    controlled: true,
    requiresApproval: true,
  });
});

test('an adjustment waits for a second signature in both directions', () => {
  // The one type with no customer or lender behind it: an adjustment moves the
  // drawer on its own. `adjustment_out` takes cash out of the till and
  // `adjustment_in` puts it there, so a counter holding `transactions.write`
  // could otherwise empty or refill a drawer alone. Both settle against cash
  // that has already physically moved, so an administrator still takes one at
  // once — the same borrowing rule, for the same reason.
  assert.deepEqual(controlledApproval('adjustment_in', 15150, 3000, true), {
    controlled: true,
    requiresApproval: false,
  });
  assert.deepEqual(controlledApproval('adjustment_out', 15150, 3000, true), {
    controlled: true,
    requiresApproval: false,
  });
  assert.deepEqual(controlledApproval('adjustment_in', 15150, 3000, false), {
    controlled: true,
    requiresApproval: true,
  });
  assert.deepEqual(controlledApproval('adjustment_out', 1, 3000, false), {
    controlled: true,
    requiresApproval: true,
  });
  // Not threshold-gated. Size has nothing to do with it: a one-peso
  // adjustment invents a peso exactly as a fifteen-thousand one does, so the
  // question is only who signed for it.
  assert.equal(controlledApproval('adjustment_in', 1, 3000, false).requiresApproval, true);
  assert.equal(controlledApproval('adjustment_in', 1, 999999, true).requiresApproval, false);
});

test('only controlled types may be created as a pending request', () => {
  // `controlled` is the whole answer the create route needs before it either
  // accepts `status: 'pending'` or refuses it, and a borrowing has to be in
  // the set or an administrator's loan could not be left for approval at all.
  assert.equal(controlledApproval('loan_received', 1, 3000, false).controlled, true);
  assert.equal(controlledApproval('loan_repayment', 1, 3000, false).controlled, true);
  assert.equal(controlledApproval('owner_funding', 1, 3000, false).controlled, true);
  assert.equal(controlledApproval('operating_expense', 1, 3000, false).controlled, true);
  assert.equal(controlledApproval('cash_in', 1, 3000, false).controlled, false);
  assert.equal(controlledApproval('refund', 1, 3000, false).controlled, false);
});

test('an operating expense still settles under the threshold and waits above it', () => {
  // Untouched by the borrowing work: the threshold is about size, not about
  // who recorded it, so an administrator goes through approval above it too.
  assert.equal(controlledApproval('operating_expense', 2999, 3000, false).requiresApproval, false);
  assert.equal(controlledApproval('operating_expense', 3001, 3000, false).requiresApproval, true);
  assert.equal(controlledApproval('operating_expense', 3001, 3000, true).requiresApproval, true);
  // Below it an ordinary operator settles at once, as they always have.
  assert.equal(controlledApproval('operating_expense', 100, 3000, false).requiresApproval, false);
});

test('a cash payment is a bucket of its own, not an operating expense', () => {
  // Folding it into operating_expenses would report every peso handed to a
  // supplier as the cost of running the business, which is the exact lie the
  // type exists to prevent.
  assert.equal(bucketFor('transaction', 'cash_payment'), 'cash_payments');
  assert.equal(BUCKET_LABELS.cash_payments, 'Cash Payments');
  assert.notEqual(bucketFor('transaction', 'cash_payment'), 'operating_expenses');
});

test('a cash payment leaves the drawer and is never counted as an expense', () => {
  // The whole point of the type. Cash on hand falls and the shift's expected
  // figure falls with it, but the expense total must not move a peso.
  const rows = [
    toCashRecordRow(raw({ id: 'p1', amount: '5000.00', txn_code: 'cash_payment' })),
    toCashRecordRow(raw({ id: 'e1', amount: '1045.00' })),                          // operating_expenses
    toCashRecordRow(raw({ id: 'e2', amount: '50.00', txn_code: 'refund' })),          // payments
  ];
  assert.equal(cashExpenseTotal(rows), '1095.00');
  assert.equal(
    cashExpenseTotal([toCashRecordRow(raw({ id: 'p1', amount: '5000.00', txn_code: 'cash_payment' }))]),
    '0.00',
  );
});

test('the cash payments bucket sits outside every expense bucket', () => {
  // The single assertion the classification rests on: added here by mistake,
  // supplier payments would start flowing into every expense figure at once.
  assert.equal(EXPENSE_BUCKETS.includes('cash_payments'), false);
});

test('a cash payment is its own line in Sources and Uses, and the statement still balances', () => {
  const branches: BranchBalance[] = [
    { id: 'b1', code: 'MAIN', name: 'Main Branch', opening: 1000, current: 650 },
  ];
  const rows: LedgerFlowRow[] = [
    { branch_id: 'b1', entry_type: 'debit', amount: '300.00', source_type: 'transaction', txn_code: 'operating_expense' },
    { branch_id: 'b1', entry_type: 'debit', amount: '50.00', source_type: 'transaction', txn_code: 'cash_payment' },
  ];

  const statement = buildCashStatement(rows, branches);

  // In Uses, because a peso that left and appears nowhere is a peso nobody can
  // explain — but on a line of its own rather than folded into the expense one.
  const line = statement.uses.find((l) => l.bucket === 'cash_payments');
  assert.ok(line, 'a cash payment must still appear in Uses');
  assert.equal(line.amount, 50);
  assert.equal(line.label, 'Cash Payments');
  assert.equal(statement.uses.find((l) => l.bucket === 'operating_expenses')?.amount, 300);
  assert.equal(statement.totals.uses, 350);
  assert.equal(statement.totals.closing, 650);
  assert.equal(statement.totals.balanced, true);
});

test('a cash payment follows the expense threshold, above it even for an administrator', () => {
  // One setting governs both ways cash walks out of the drawer. Letting a
  // payment through more easily than the expense beside it would make the
  // threshold decorative.
  assert.equal(controlledApproval('cash_payment', 2999, 3000, false).requiresApproval, false);
  assert.equal(controlledApproval('cash_payment', 3001, 3000, false).requiresApproval, true);
  assert.equal(controlledApproval('cash_payment', 3001, 3000, true).requiresApproval, true);
  assert.equal(controlledApproval('cash_payment', 100, 3000, false).requiresApproval, false);
  // And it may be left for approval at all, or the queue could never hold one.
  assert.equal(controlledApproval('cash_payment', 1, 3000, false).controlled, true);
});

test('a cash account can only have been paid by cash', () => {
  // Its balance *is* the drawer's cash, so a blank is answered by the account
  // rather than refused — every one of the 20 transactions already on a cash
  // account in production carries `cash`, and this makes that impossible to
  // get wrong rather than merely true so far.
  assert.deepEqual(resolveCashAccountMethod('cash', null), { action: 'force', method: 'cash' });
  assert.deepEqual(resolveCashAccountMethod('cash', undefined), { action: 'force', method: 'cash' });
  assert.deepEqual(resolveCashAccountMethod('cash', ''), { action: 'force', method: 'cash' });
  assert.deepEqual(resolveCashAccountMethod('cash', 'cash'), { action: 'accept', method: 'cash' });
});

test('a wallet method on a drawer account is refused, not silently overwritten', () => {
  // Overwriting would record something the operator did not choose, and a
  // refusal is the only outcome that tells them why the shift would otherwise
  // close short against money nobody counted.
  for (const method of ['gcash', 'bank', 'maya', 'provider_interest']) {
    const outcome = resolveCashAccountMethod('cash', method);
    assert.equal(outcome.action, 'refuse', `${method} should be refused on a cash account`);
    assert.match(outcome.action === 'refuse' ? outcome.message : '', new RegExp(method));
  }
  assert.deepEqual(resolveCashAccountMethod('cash', '  '), { action: 'force', method: 'cash' });
});

test('wallet and bank accounts keep every method the operator may name', () => {
  // Bank and e-wallet accounts are not the drawer, so forcing `cash` on one
  // would invent a physical handover nobody made.
  for (const accountType of ['e-wallet', 'bank', 'other', 'loading']) {
    assert.deepEqual(
      resolveCashAccountMethod(accountType, 'bank'),
      { action: 'accept', method: 'bank' },
      `${accountType} should accept bank`,
    );
    assert.deepEqual(
      resolveCashAccountMethod(accountType, null),
      { action: 'accept', method: null },
      `${accountType} should leave a blank alone`,
    );
  }
  assert.deepEqual(resolveCashAccountMethod(null, 'gcash'), { action: 'accept', method: 'gcash' });
  assert.deepEqual(resolveCashAccountMethod(undefined, null), { action: 'accept', method: null });
});

test('a hand-typed Expense row is refused and points at the queue it would have skipped', () => {
  // `expense` is the system's own row: written beside a cash movement carrying
  // a provider charge and linked back through linked_transaction_id. Typed in
  // it posts a debit with no recipient, and settles instantly — only owner
  // funding and operating expenses route through the approval queue, so it
  // would have spent company money with no second signature.
  const reason = directTypeRefusal('expense');
  assert.ok(reason, 'a standalone Expense row must be refused');
  assert.match(reason as string, /provider charge/);
  assert.match(reason as string, /operating expense/);
  assert.match(reason as string, /system/);
});

test('every other type may still be recorded directly', () => {
  for (const code of [
    'operating_expense', 'cash_in', 'cash_out', 'owner_funding', 'owner_return',
    'bill_payment', 'load_purchase', 'adjustment_in', 'service_fee', null, undefined, '',
  ]) {
    assert.equal(directTypeRefusal(code), null, `${String(code)} should be recordable`);
  }
});

test('a fee on a cost would report the company as having earned from an expense', () => {
  assert.notEqual(expenseFeeRefusal('expense', 10), null);
  assert.notEqual(expenseFeeRefusal('expense', 0.01), null);
  assert.match(expenseFeeRefusal('expense', 10) as string, /fee is income/);

  assert.equal(expenseFeeRefusal('expense', 0), null);
  assert.equal(expenseFeeRefusal('expense', -5), null);
  for (const code of ['operating_expense', 'cash_in', 'bill_payment', null, undefined]) {
    assert.equal(expenseFeeRefusal(code, 10), null, `${String(code)} may carry a fee`);
  }
});

// The controlled-code list is one set, shared by creation and settlement — the
// drift between the two (creation knew eight codes, approval knew four) is
// exactly the bug this consolidation exists to prevent, so the test pins the
// whole set and the boundary around it.
test('CONTROLLED_TXN_CODES names every movement that needs a second person', () => {
  assert.deepEqual(
    [...CONTROLLED_TXN_CODES].sort(),
    ['adjustment_in', 'adjustment_out', 'cash_payment', 'loan_received', 'loan_repayment', 'operating_expense', 'owner_funding', 'owner_return'],
  );
});

test('isControlledType agrees with controlledApproval about the eight codes', () => {
  for (const code of CONTROLLED_TXN_CODES) {
    assert.equal(isControlledType(code), true, `${code} is controlled`);
    assert.equal(controlledApproval(code, 1, 3000, false).controlled, true, `${code} is controlled by controlledApproval too`);
  }
  for (const code of ['cash_in', 'cash_out', 'transfer_in', 'expense', 'refund', 'other_income', 'load_purchase', null, undefined]) {
    assert.equal(isControlledType(code), false, `${String(code)} is not controlled`);
  }
});

test('adjustments and borrowings sit behind the administrator-only bar', () => {
  for (const code of CASH_EVENT_APPROVAL_CODES) {
    assert.equal(HEAD_OFFICE_APPROVAL_CODES.has(code), true, `${code} is a head-office release`);
    assert.equal(approvalAuditAction(code, 'approved'), 'transaction.cash_event_approved');
    assert.equal(approvalAuditAction(code, 'rejected'), 'transaction.cash_event_rejected');
  }
  assert.equal(HEAD_OFFICE_APPROVAL_CODES.has('owner_funding'), false);
  assert.equal(HEAD_OFFICE_APPROVAL_CODES.has('owner_return'), false);
});

test('approval audit actions keep the three kinds apart', () => {
  assert.equal(approvalAuditAction('operating_expense', 'approved'), 'transaction.expense_approved');
  assert.equal(approvalAuditAction('cash_payment', 'approved'), 'transaction.expense_approved');
  assert.equal(approvalAuditAction('operating_expense', 'rejected'), 'transaction.expense_rejected');
  assert.equal(approvalAuditAction('owner_funding', 'approved'), 'transaction.owner_fund_approved');
  assert.equal(approvalAuditAction('owner_return', 'rejected'), 'transaction.owner_fund_rejected');
});
