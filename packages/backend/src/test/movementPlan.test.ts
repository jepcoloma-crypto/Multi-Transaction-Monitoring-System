import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMovementInputs, movementRefusals, paymentPlan, fundingProblem } from '../services/movementPlan';

// The posting matrix the owner confirmed, in the figures from his own books,
// run through the one planner the entry route and the entry preview now share.
// If a rule change ever moves a peso between the drawer and a channel, it has
// to break one of these first.
const THRESHOLD = 10000;

const walletPlan = (overrides: Record<string, unknown> = {}) =>
  paymentPlan({
    direction: 'in',
    code: 'cash_in',
    accountTypeCode: 'gcash',
    amount: 500,
    fee: 10,
    feeAddedToBalance: true,
    paymentMethod: 'cash',
    expenseThreshold: THRESHOLD,
    isAdminCreator: false,
    ...overrides,
  });

test('cash received → e-money sent: the drawer gains the amount and the fee, the channel loses the amount', () => {
  // The audit's own row: a customer handed over ₱30,300 for a ₱30,000 e-money
  // send plus a ₱300 fee (#281). The drawer's credit is the whole handover.
  const plan = walletPlan({ direction: 'out', code: 'cash_out', amount: 30000, fee: 300 });

  assert.deepEqual(plan.problems, [], 'this is a legal, completed movement');
  assert.equal(plan.entryType, 'debit', 'the channel account is debited');
  assert.equal(plan.netAmount, 30000, 'the channel loses exactly the amount');
  assert.equal(plan.totalAmount, 30000);
  assert.deepEqual(plan.drawerLeg, { amount: 30300, entryType: 'credit' }, 'the drawer gains amount plus fee');
  assert.equal(plan.cashBehavior, 'in', 'the badge reads: cash enters the drawer');
  assert.equal(plan.finalStatus, 'completed');
});

test('e-money received → cash paid out: the drawer loses the amount less the fee withheld', () => {
  // The sentence the flow promises the entry form: "This will post: Cash on
  // Hand −24,550 · Sheryll's e-wallet +24,800."
  const plan = walletPlan({ amount: 24800, fee: 250 });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.entryType, 'credit', "Sheryll's e-wallet is credited");
  assert.equal(plan.netAmount, 24800, 'the fee never shrinks the credit (D40)');
  assert.deepEqual(plan.drawerLeg, { amount: 24550, entryType: 'debit' }, 'Cash on Hand −24,550');
  assert.equal(plan.cashBehavior, 'out', 'the badge reads: cash leaves the drawer');
});

test('a fee inside the amount posts exactly like a fee paid on top (D40)', () => {
  // The customer e-money-sends ₱510 of which ₱10 is the fee: the balance
  // lands the whole ₱510, the drawer nets ₱10 − ₱510 = −₱500, and the fee is
  // income. Identical postings to the fee-on-top row above — only the tender
  // record differs.
  const plan = walletPlan({ feeAddedToBalance: false });

  assert.equal(plan.feeInside, true, 'the tender record survives as a record');
  assert.equal(plan.netAmount, 500, 'the fee never shrinks what the credit lands on');
  assert.deepEqual(plan.drawerLeg, { amount: 490, entryType: 'debit' }, 'the drawer nets fee − amount');
});

test('a fee inside the amount never shrinks what a debit removes', () => {
  const plan = walletPlan({ direction: 'out', code: 'cash_out', feeAddedToBalance: false });

  assert.equal(plan.netAmount, 500, 'the whole amount leaves the channel');
  assert.deepEqual(plan.drawerLeg, { amount: 510, entryType: 'credit' }, 'the drawer retains the fee');
});

test('a movement settled by e-wallet touches no drawer at all', () => {
  const plan = walletPlan({ paymentMethod: 'gcash' });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.drawerLeg, null);
  assert.equal(plan.cashBehavior, 'none', 'the badge reads: no cash');
});

test('a movement booked straight onto the cash account is cash by its own direction', () => {
  // Owner funding counted into the float: the account leg *is* the drawer, so
  // the badge answers from the direction, not from a second row that does not
  // exist (resolveDrawerLeg keeps the pair from posting against one balance).
  const plan = walletPlan({ direction: 'in', code: 'owner_funding', accountTypeCode: 'cash', paymentMethod: null });

  assert.deepEqual(plan.problems, [], 'the blank method is answered by the account itself');
  assert.equal(plan.paymentMethod, 'cash', 'a cash account can only have been paid in cash');
  assert.equal(plan.cashBehavior, 'in');
  assert.equal(plan.finalStatus, 'pending', 'owner money waits for a second signature');
  assert.equal(plan.requiresApproval, true);
});

test('an administrator takes owner money at once, so it never sits in a queue the count cannot see', () => {
  const plan = walletPlan({
    direction: 'in', code: 'owner_funding', accountTypeCode: 'cash', paymentMethod: null, isAdminCreator: true,
  });

  assert.equal(plan.finalStatus, 'completed');
});

test('a cash movement with no tender is refused, naming the tenders that count', () => {
  const plan = walletPlan({ paymentMethod: null });

  assert.deepEqual(plan.problems, [
    'A cash in needs a payment method: cash, gcash, bank, maya',
  ]);
});

test('a tender the system does not know is refused rather than posted blind', () => {
  const plan = walletPlan({ paymentMethod: 'bitcoin' });

  assert.equal(plan.problems[0], 'Payment method must be one of: cash, gcash, bank, maya, provider_interest');
});

test('a cash account cannot claim it was paid by an e-wallet', () => {
  const plan = walletPlan({ accountTypeCode: 'cash', paymentMethod: 'gcash' });

  assert.ok(
    plan.problems.some((p) => p.includes('A cash account holds physical cash, so it cannot have been paid by gcash')),
    'the disagreement is refused, never overwritten'
  );
});

test('a charge the provider bills us is a second row, and only on money moving in or out', () => {
  const ok = walletPlan({ providerCharge: '25.5' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.providerCharge, 25.5);

  const onAdjustment = walletPlan({ direction: 'adjustment', code: 'adjustment_in', providerCharge: 25 });
  assert.equal(
    onAdjustment.problems[0],
    'A provider charge can only be recorded on a cash-in or cash-out'
  );
});

test('a charge cannot ride on a row that waits for approval', () => {
  const plan = walletPlan({ code: 'operating_expense', amount: 50000, providerCharge: 25 });

  assert.equal(plan.finalStatus, 'pending', 'over the threshold, this waits');
  assert.equal(
    plan.problems[0],
    'A provider charge can only be recorded on a transaction that completes now'
  );
});

test('a non-administrator cannot create an ordinary movement as pending', () => {
  const plan = walletPlan({ requestedStatus: 'pending' });

  assert.equal(
    plan.problems[0],
    'Only owner fund movements, operating expenses, cash payments and borrowings can be created as pending'
  );
});

test('additional charges ride on the account leg without touching the drawer leg', () => {
  const plan = walletPlan({ additionalCharges: [{ amount: '50' }, { amount: 25 }] });

  assert.equal(plan.totalCharges, 75);
  assert.equal(plan.totalAmount, 575, 'what the account leg moves includes the charges');
  assert.deepEqual(
    plan.drawerLeg,
    { amount: 565, entryType: 'debit' },
    'the drawer hands over the full 575 less the 10 it withholds as its fee'
  );
});

test('a fee inside the amount larger than the amount is refused, not silently swallowed', () => {
  const plan = walletPlan({ amount: 50, fee: 100, feeAddedToBalance: false });

  assert.ok(plan.problems.includes(
    'Fee cannot exceed the transaction amount when the fee is taken inside the amount'
  ));
});

test('the type refusals come back in the order the commit always threw them', () => {
  const both = movementRefusals('expense', 10);
  assert.equal(both.length, 2, 'the Expense type and its fee are both refused');
  assert.ok(both[0].startsWith('The Expense type records a provider charge'));
  assert.ok(both[1].startsWith('An Expense row cannot carry a fee'));
  assert.deepEqual(movementRefusals('cash_in', 10), [], 'an ordinary type refuses nothing');
});

test('input guards name what is wrong before any rule is consulted', () => {
  assert.equal(validateMovementInputs(Number.NaN, 0), 'Amount must be a number');
  assert.equal(validateMovementInputs(-1, 0), 'Amount cannot be negative');
  assert.equal(validateMovementInputs(100, -5), 'Fee cannot be negative');
  assert.equal(validateMovementInputs(100, 0), null);
});

test('a balance that is exactly enough is enough, to the centavo', () => {
  // 0.1 + 0.2 lands above 0.3 in binary floats; comparing the rounded total is
  // what keeps an exact balance from being rejected as short.
  const check = { entryType: 'debit' as const, status: 'completed', providerCharge: 0, totalAmount: 0.1 + 0.2 };
  assert.equal(fundingProblem({ ...check, balance: 0.3 }), null);
  assert.equal(fundingProblem({ ...check, balance: 0.29 }), 'Insufficient balance');
});

test('a pending row and a credit are never checked against the balance', () => {
  assert.equal(
    fundingProblem({ balance: 0, entryType: 'debit', status: 'pending', totalAmount: 500, providerCharge: 0 }),
    null,
    'a proposal withdraws nothing yet'
  );
  assert.equal(
    fundingProblem({ balance: 0, entryType: 'credit', status: 'completed', totalAmount: 500, providerCharge: 0 }),
    null
  );
});

test('a charge is a second debit the balance has to carry, and the refusal says so', () => {
  const problem = fundingProblem({
    balance: 500, entryType: 'debit', status: 'completed', totalAmount: 500, providerCharge: 25,
  });
  assert.equal(problem, 'Insufficient balance for the transaction plus the provider charge');
});
