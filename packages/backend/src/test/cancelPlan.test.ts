import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movementTotalOf, planLoadingCancel, planTransactionCancel } from '../services/cancelPlan';
import type { CancelAccount, CancelRow } from '../services/cancelPlan';

const CHANNEL = '10000000-0000-0000-0000-000000000001';
const DRAWER = '10000000-0000-0000-0000-000000000002';

const account = (id: string, balance: number, overrides: Partial<CancelAccount> = {}): CancelAccount => ({
  id,
  name: id === DRAWER ? 'Revolving Fund' : 'Globe E-Money',
  status: 'active',
  current_balance: balance,
  ...overrides,
});

const row = (id: string, accountId: string, entryType: string, amount: number | string): CancelRow => ({
  id,
  account_id: accountId,
  entry_type: entryType,
  amount,
});

// ------------------------------------------------------------------
// movementTotalOf — the figure every reversal path moves
// ------------------------------------------------------------------

test('movementTotalOf folds charges into the net', () => {
  assert.equal(
    movementTotalOf({ net_amount: '1000.00', amount: '900.00', additional_charges: [{ amount: '150.00' }, { amount: '50' }] }),
    1200,
  );
});

test('movementTotalOf falls back to the amount when the record predates net_amount', () => {
  assert.equal(movementTotalOf({ net_amount: null, amount: '750.00', additional_charges: [] }), 750);
});

// ------------------------------------------------------------------
// planLoadingCancel — a sale's rows mirrored one for one
// ------------------------------------------------------------------

test('a sale’s channel and till rows are mirrored one for one', () => {
  const plan = planLoadingCancel(
    { status: 'completed' },
    [row('r1', CHANNEL, 'debit', 105), row('r2', DRAWER, 'credit', 120)],
    [account(CHANNEL, 1000), account(DRAWER, 500)],
  );

  assert.equal(plan.safe, true);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.mirrors.length, 2);
  assert.deepEqual(
    plan.mirrors.map((m) => ({ accountId: m.accountId, entryType: m.entryType, amount: m.amount })),
    [
      { accountId: CHANNEL, entryType: 'credit', amount: 105 },
      { accountId: DRAWER, entryType: 'debit', amount: 120 },
    ],
  );
  // The deduction returns to the account that paid; the retail price walks out
  // of the till. Before + delta = after, the three numbers the preview shows.
  assert.deepEqual(plan.affected, [
    { accountId: CHANNEL, name: 'Globe E-Money', before: 1000, delta: 105, after: 1105 },
    { accountId: DRAWER, name: 'Revolving Fund', before: 500, delta: -120, after: 380 },
  ]);
  assert.deepEqual(plan.accountIds, [CHANNEL, DRAWER]);
});

test('a till that cannot hand the money back is refused, with the figures', () => {
  const plan = planLoadingCancel(
    { status: 'completed' },
    [row('r1', CHANNEL, 'debit', 105), row('r2', DRAWER, 'credit', 120)],
    [account(CHANNEL, 1000), account(DRAWER, 100)],
  );

  assert.equal(plan.safe, false);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /Revolving Fund would fall to -20\.00/);
  assert.match(plan.problems[0], /may not go below zero/);
});

test('a closed account refuses the cancellation', () => {
  const plan = planLoadingCancel(
    { status: 'completed' },
    [row('r1', CHANNEL, 'debit', 105)],
    [account(CHANNEL, 1000, { status: 'closed' })],
  );

  assert.equal(plan.safe, false);
  assert.deepEqual(plan.problems, ['Globe E-Money is closed — closed accounts cannot move']);
});

test('a record that never wrote rows has nothing to cancel', () => {
  const plan = planLoadingCancel({ status: 'completed' }, [], [account(CHANNEL, 1000)]);

  assert.equal(plan.safe, false);
  assert.deepEqual(plan.problems, ['This sale wrote no ledger rows — there is nothing to cancel']);
  assert.deepEqual(plan.mirrors, []);
});

test('only a completed sale may be cancelled', () => {
  const rows = [row('r1', CHANNEL, 'debit', 105)];

  const reversed = planLoadingCancel({ status: 'reversed' }, rows, [account(CHANNEL, 1000)]);
  assert.equal(reversed.safe, false);
  assert.deepEqual(reversed.problems, ['This loading sale is already cancelled']);

  const pending = planLoadingCancel({ status: 'pending' }, rows, [account(CHANNEL, 1000)]);
  assert.equal(pending.safe, false);
  assert.deepEqual(pending.problems, ['Only completed loading sales can be cancelled']);
});

test('a row pointing at a vanished account is a problem, not a crash', () => {
  const plan = planLoadingCancel(
    { status: 'completed' },
    [row('r1', 'missing-account', 'debit', 105)],
    [account(CHANNEL, 1000)],
  );

  assert.equal(plan.safe, false);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /no longer exists|points at an account/);
});

// ------------------------------------------------------------------
// planTransactionCancel — record figure on the account, recorded rows on the till
// ------------------------------------------------------------------

const cashIn = (overrides: Record<string, unknown> = {}) => ({
  status: 'completed',
  code: 'cash_in',
  direction: 'in',
  account_id: CHANNEL,
  net_amount: '4299.00',
  amount: '4299.00',
  additional_charges: [],
  ...overrides,
});

test('a cash-in reverses as a debit on the account and a debit on the till', () => {
  const plan = planTransactionCancel(
    cashIn() as any,
    [row('a1', CHANNEL, 'credit', 4299)],
    [row('t1', DRAWER, 'credit', 4249)],
    [account(CHANNEL, 10000), account(DRAWER, 8000)],
  );

  assert.equal(plan.safe, true);
  assert.deepEqual(plan.accountLeg, { accountId: CHANNEL, entryType: 'debit', amount: 4299 });
  assert.deepEqual(plan.drawerLeg, { accountId: DRAWER, entryType: 'debit', amount: 4249 });
  assert.deepEqual(plan.affected, [
    { accountId: CHANNEL, name: 'Globe E-Money', before: 10000, delta: -4299, after: 5701 },
    { accountId: DRAWER, name: 'Revolving Fund', before: 8000, delta: -4249, after: 3751 },
  ]);
  assert.deepEqual(plan.notes, []);
});

test('the till’s leg mirrors its rows as they now stand — corrections included', () => {
  // Two rows on the till: the sale's own credit and a correction that took 50
  // back out. The unwind answers with their sum, not with the record's figure.
  const plan = planTransactionCancel(
    cashIn() as any,
    [row('a1', CHANNEL, 'credit', 4299)],
    [row('t1', DRAWER, 'credit', 4249), row('t2', DRAWER, 'debit', 50)],
    [account(CHANNEL, 10000), account(DRAWER, 8000)],
  );

  assert.deepEqual(plan.drawerLeg, { accountId: DRAWER, entryType: 'debit', amount: 4199 });
});

test('a cash-out returns to the account as a credit', () => {
  const plan = planTransactionCancel(
    cashIn({ direction: 'out', code: 'cash_out', net_amount: '1000.00', amount: '1000.00' }) as any,
    [row('a1', CHANNEL, 'debit', 1000)],
    [],
    [account(CHANNEL, 5000)],
  );

  assert.equal(plan.safe, true);
  assert.deepEqual(plan.accountLeg, { accountId: CHANNEL, entryType: 'credit', amount: 1000 });
  assert.equal(plan.drawerLeg, null);
  assert.deepEqual(plan.affected, [
    { accountId: CHANNEL, name: 'Globe E-Money', before: 5000, delta: 1000, after: 6000 },
  ]);
});

test('additional charges ride into the account leg', () => {
  const plan = planTransactionCancel(
    cashIn({ net_amount: '1000.00', amount: '900.00', additional_charges: [{ amount: '200.00' }] }) as any,
    [row('a1', CHANNEL, 'credit', 1200)],
    [],
    [account(CHANNEL, 5000)],
  );

  assert.equal(plan.accountLeg.amount, 1200);
});

test('a record whose rows disagree with its columns says so, in pesos', () => {
  const plan = planTransactionCancel(
    cashIn() as any, // record says 4299
    [row('a1', CHANNEL, 'credit', 5000)], // rows actually sum 5000
    [],
    [account(CHANNEL, 10000)],
  );

  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /sum 5000\.00 while its record says 4299\.00/);
  assert.match(plan.notes[0], /701\.00 would remain/);
  // The note is information, not a refusal: approval posts the record's figure
  // exactly as it always has.
  assert.equal(plan.safe, true);
});

test('already reversed, unsettled and adjustment records are refused', () => {
  const accounts = [account(CHANNEL, 10000)];

  assert.equal(planTransactionCancel(cashIn({ status: 'reversed' }) as any, [], [], accounts).safe, false);
  assert.deepEqual(planTransactionCancel(cashIn({ status: 'pending' }) as any, [], [], accounts).problems,
    ['Only completed transactions can be reversed']);
  assert.deepEqual(planTransactionCancel(cashIn({ code: 'adjustment_in' }) as any, [], [], accounts).problems,
    ['Adjustment transactions cannot be reversed']);
});

test('an account that would drop below zero refuses the approval', () => {
  const plan = planTransactionCancel(
    cashIn() as any,
    [row('a1', CHANNEL, 'credit', 4299)],
    [],
    [account(CHANNEL, 1000)],
  );

  assert.equal(plan.safe, false);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /Globe E-Money would fall to -3299\.00/);
});

test('a closed account refuses the approval', () => {
  const plan = planTransactionCancel(
    cashIn() as any,
    [row('a1', CHANNEL, 'credit', 4299)],
    [],
    [account(CHANNEL, 10000, { status: 'closed' })],
  );

  assert.equal(plan.safe, false);
  assert.deepEqual(plan.problems, ['Globe E-Money is closed — closed accounts cannot move']);
});
