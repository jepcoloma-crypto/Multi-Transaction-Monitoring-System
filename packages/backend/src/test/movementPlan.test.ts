import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMovementInputs, movementRefusals, paymentPlan, fundingProblem, netAmountOf } from '../services/movementPlan';
import { drawerLeg } from '../services/cashManagement';

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

test('e-money received → cash paid out: the fee is the till\'s, so the wallet lands the amount alone', () => {
  // The sentence the flow promises the entry form, on the owner's own numbers:
  // a ₱24,800 cash-in with the ₱250 fee collected on top lands ₱24,800 on
  // Sheryll's wallet and takes the ₱250 as the till's own income line — the
  // receiving balance is never credited a fee (D46, which reversed D42's "in,
  // fee on top" cell after it credited the customer the fee itself). The till
  // hands over ₱24,800 against the ₱250 credited back to it, so it nets
  // ₱24,550 — the figure it was short by before.
  const plan = walletPlan({ amount: 24800, fee: 250 });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.entryType, 'credit', "Sheryll's e-wallet is credited");
  assert.equal(plan.netAmount, 24800, 'the account lands the amount and never the fee (D46)');
  assert.equal(plan.feeOnDrawer, true, 'the ₱250 is the till\'s own row');
  assert.deepEqual(plan.drawerLeg, { amount: 24550, entryType: 'debit' }, 'Cash on Hand −24,550');
  assert.equal(plan.cashBehavior, 'out', 'the badge reads: cash leaves the drawer');
});

test('a fee inside a cash-in is cut from the drawer, not the account', () => {
  // The customer e-money-sends ₱500 of which ₱10 is the fee: the balance
  // lands the whole ₱500, the drawer nets ₱10 − ₱500 = −₱490 — what
  // physically crossed the tin — and the fee is income. Since D46 both cash-in
  // cells land `amount` and net the drawer the same way; they differ in which
  // side carries the fee's own row, and this is the half where the figures
  // never moved.
  const plan = walletPlan({ feeAddedToBalance: false });

  assert.equal(plan.feeInside, true, 'the tender record survives as a record');
  assert.equal(plan.netAmount, 500, 'the fee never shrinks what the credit lands on');
  assert.deepEqual(plan.drawerLeg, { amount: 490, entryType: 'debit' }, 'the drawer nets fee − amount');
});

test('a fee carved from a cash-out is cut from what the account hands out', () => {
  // ₱500 of cash crosses the tin, of which ₱10 is the fee: the channel hands
  // over ₱490 and the drawer keeps ₱500 (D42). The old rule took the whole
  // ₱500 out of the channel and credited the drawer ₱510 — ₱10 that was
  // never counted.
  const plan = walletPlan({ direction: 'out', code: 'cash_out', feeAddedToBalance: false });

  assert.equal(plan.netAmount, 490, 'the fee is cut from what the account hands out');
  assert.deepEqual(plan.drawerLeg, { amount: 500, entryType: 'credit' }, 'the drawer retains the fee');
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

test('a bills payment with no tender is refused the same way', () => {
  // The entry form's half of the drawer rule: settling a bill at the counter
  // has to say how the money changed hands, or the drawer side of it has
  // nothing to be computed from — that silence is how a counter payment
  // posted the wallet leg and lost the till's ₱4,181.
  const plan = walletPlan({ code: 'bill_payment', direction: 'out', paymentMethod: null });

  assert.deepEqual(plan.problems, [
    'A bill payment needs a payment method: cash, gcash, bank, maya',
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

test('an Adjustment Out debits the account it lands on; an Adjustment In credits it', () => {
  // Both carry direction 'adjustment' — the type family — so the code carries
  // the sign. Booked on the drawer itself (the cash-event form's shape: no
  // method typed, the cash account answering for it), the till's own row is
  // the movement: an Adjustment Out is the ₱20 that brings an overstated
  // drawer down, and planning it off the family value would have credited
  // that ₱20 IN instead.
  const out = walletPlan({
    direction: 'adjustment',
    code: 'adjustment_out',
    accountTypeCode: 'cash',
    amount: 20,
    fee: 0,
    paymentMethod: undefined as unknown as string,
  });
  assert.deepEqual(out.problems, []);
  assert.equal(out.paymentMethod, 'cash', "the drawer's own account answers the tender question");
  assert.equal(out.entryType, 'debit', 'the drawer hands the money out');
  assert.equal(out.cashBehavior, 'out', 'the badge reads: cash leaves the drawer');
  assert.equal(out.finalStatus, 'completed', 'an adjustment is not one of the controlled types — it settles at once');

  const intoWallet = walletPlan({ direction: 'adjustment', code: 'adjustment_in', amount: 20, fee: 0 });
  assert.equal(intoWallet.entryType, 'credit', 'money in still credits the account it lands on');
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

test('additional charges ride the account leg and the drawer hands them over', () => {
  const plan = walletPlan({ additionalCharges: [{ amount: '50' }, { amount: 25 }] });

  assert.equal(plan.totalCharges, 75);
  assert.equal(plan.netAmount, 500, 'the account lands the amount; the ₱10 fee is the till\'s (D46)');
  assert.equal(plan.totalAmount, 575, 'what the account leg moves is the amount plus the charges');
  assert.deepEqual(
    plan.drawerLeg,
    { amount: 565, entryType: 'debit' },
    'the drawer hands over 575 less the 10 it withholds as its fee'
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

test('a cash-in lands the amount and never the fee, whichever way the tender carried it (D46)', () => {
  // Collected on top: the customer handed ₱310 for a ₱300 cash-in, so the
  // e-wallet credits ₱300 and the ₱10 belongs to the till — D42 had it land
  // amount + fee on the account, which credited the customer the fee itself.
  assert.equal(
    netAmountOf({ direction: 'in', amount: 300, fee: 10, feeAddedToBalance: true }).netAmount,
    300
  );
  // Cut from the amount: the whole typed figure lands, the fee having been
  // inside it all along (D42's other cell, unchanged).
  assert.equal(
    netAmountOf({ direction: 'in', amount: 3030, fee: 30, feeAddedToBalance: false }).netAmount,
    3030
  );
  // No fee: the amount, plainly.
  assert.equal(
    netAmountOf({ direction: 'in', amount: 500, fee: 0, feeAddedToBalance: true }).netAmount,
    500
  );
});

test('a cash-out still reads the flag: a fee carved from what leaves is cut from the debit', () => {
  assert.equal(
    netAmountOf({ direction: 'out', amount: 2500, fee: 30, feeAddedToBalance: true }).netAmount,
    2500
  );
  assert.equal(
    netAmountOf({ direction: 'out', amount: 2500, fee: 30, feeAddedToBalance: false }).netAmount,
    2470
  );
});

test('every cell still grows the books by exactly the fee (D24)', () => {
  const cells: Array<[string, number, number, boolean]> = [
    ['in', 300, 10, true],
    ['in', 3030, 30, false],
    ['out', 2500, 30, true],
    ['out', 2500, 30, false],
  ];
  for (const [direction, amount, fee, feeAddedToBalance] of cells) {
    const context = `${direction} amount=${amount} fee=${fee} onTop=${feeAddedToBalance}`;
    const { netAmount } = netAmountOf({ direction, amount, fee, feeAddedToBalance });
    const signed = direction === 'in' ? netAmount : -netAmount;
    const leg = drawerLeg(signed, fee);
    const drawerNet = leg ? (leg.entryType === 'credit' ? leg.amount : -leg.amount) : 0;
    assert.equal(Math.round((signed + drawerNet) * 100) / 100, fee, context);
  }
});

test('a fee taken inside the amount still cannot exceed it', () => {
  assert.equal(
    netAmountOf({ direction: 'in', amount: 5, fee: 10, feeAddedToBalance: false }).exceeds,
    true
  );
  assert.equal(
    netAmountOf({ direction: 'in', amount: 10, fee: 10, feeAddedToBalance: false }).exceeds,
    false
  );
  // Only the inside reading refuses: a fee on top is never a cut of the amount.
  assert.equal(
    netAmountOf({ direction: 'in', amount: 5, fee: 10, feeAddedToBalance: true }).exceeds,
    false
  );
});

// The contract the cash-event form's "How it arrived" field relies on. A
// borrowing is not a cash movement (migration 041 / D11), so nothing here is
// newly required by the planner — what is being pinned is that stating a route
// on one stays harmless, and that a route a cash account cannot have had is
// still refused rather than quietly rewritten.
const borrow = (overrides: Record<string, unknown> = {}) =>
  paymentPlan({
    direction: 'in',
    code: 'loan_received',
    accountTypeCode: 'bank',
    amount: 5000,
    fee: 0,
    feeAddedToBalance: true,
    paymentMethod: 'bank',
    expenseThreshold: THRESHOLD,
    isAdminCreator: true,
    ...overrides,
  });

test('a borrowing into a wallet keeps its route and plans no counterparty leg', () => {
  // This is why the field was worth adding: a loan that arrived as a transfer
  // touches only the balance it landed on, so no leg may be planned for the
  // till. If one ever were, borrowing 5,000 would show the books 10,000 apart
  // from the debt that explains it.
  const plan = borrow();

  assert.deepEqual(plan.problems, [], 'a route on a borrowing is legal');
  assert.equal(plan.paymentMethod, 'bank', 'the route the operator chose is what gets stored');
  assert.equal(plan.drawerLeg, null, 'a transfer into a wallet never crosses the till');
  assert.equal(plan.finalStatus, 'completed');
});

test('a borrowing may not claim a route the account could not have had', () => {
  // Refused with the account named, because a cash account holds physical
  // cash. The alternative — overwriting it to 'cash' — would record a
  // movement nobody chose, which is the rule this system refuses everywhere.
  const plan = borrow({ accountTypeCode: 'cash', paymentMethod: 'bank' });

  assert.equal(plan.problems.length, 1, 'exactly one refusal, not a silent correction');
  assert.match(plan.problems[0], /cash account holds physical cash/);
  assert.match(plan.problems[0], /bank/, 'the message says which route was impossible');
});

test('a repayment plans the opposite leg to the advance it hands back', () => {
  const advance = borrow({ accountTypeCode: 'cash', paymentMethod: 'cash' });
  const repayment = borrow({ code: 'loan_repayment', direction: 'out', accountTypeCode: 'cash', paymentMethod: 'cash' });

  assert.deepEqual(repayment.problems, []);
  assert.equal(repayment.entryType, 'debit', 'paying a lender debits the account it comes from');
  assert.equal(advance.entryType, 'credit', 'receiving the advance credits it');
  assert.equal(repayment.drawerLeg?.entryType, 'credit', 'cash handed back leaves the till as a credit to it');
  assert.equal(advance.drawerLeg?.entryType, 'debit');
});

test('the planner still permits a borrowing with no route, so the form is what enforces one', () => {
  // Deliberate, and worth saying out loud: migration 041 kept borrowings out
  // of D11, so the server does not require a tender for them. The cash-event
  // form does — otherwise the route is lost and "what form was it given in"
  // becomes unrecoverable. If this assertion ever fails, someone has moved the
  // rule server-side, which is a decision to make, not an accident to discover.
  const plan = borrow({ paymentMethod: null });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.paymentMethod, null);
  assert.equal(plan.drawerLeg, null, 'a blank route still plans no counterparty leg');
});
