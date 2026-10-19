import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFeeMovement, planFeeRepost, currentFeeColumns, changedFeeColumns } from '../services/feeAudit';

const WALLET = 'a1a1a1a1-0000-0000-0000-000000000001';
const DRAWER = 'b2b2b2b2-0000-0000-0000-000000000002';

// --- classifyFeeMovement -------------------------------------------------

test('a movement posted as its declared mode says is ok', () => {
  // in-OFF: the account lands the whole 500, the till hands 490 (D42).
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: false, charges: 0,
    actualAccountTotal: 500, actualDrawerNet: -490, hasDrawer: true,
  });
  assert.equal(verdict.status, 'ok');
  assert.deepEqual(verdict.declared, { accountTotal: 500, drawerNet: -490 });
});

test('a cash-out posted on top is ok, and the charges ride with it', () => {
  const verdict = classifyFeeMovement({
    direction: 'out', amount: 500, fee: 10, feeAddedToBalance: true, charges: 25,
    actualAccountTotal: -525, actualDrawerNet: 535, hasDrawer: true,
  });
  assert.equal(verdict.status, 'ok');
  assert.deepEqual(verdict.declared, { accountTotal: -525, drawerNet: 535 });
});

test('the posting D42 wrote for a cash-in on top is now named as wrong, not as the other cell', () => {
  // in-ON declared; the rows are D42's own posting — the account landed
  // amount + fee and the till handed the whole amount over. Under D46 neither
  // cell wants those figures: the account lands the amount and the till keeps
  // the fee, so this is exactly the row the fee re-post exists to correct
  // (transactions 3 and 21, ₱20 between them).
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 510, actualDrawerNet: -500, hasDrawer: true,
  });
  assert.equal(verdict.status, 'neither');
  assert.deepEqual(verdict.declared, { accountTotal: 500, drawerNet: -490 });
  assert.deepEqual(verdict.opposite, { accountTotal: 500, drawerNet: -490 });
});

test('the cash-in posting written before D42 is the one D46 wants, so it reads ok again', () => {
  // in-ON declared; the account landed the bare amount and the till carried
  // the fee — which is what the books should have said all along. D46 restores
  // that cell, so the row no longer needs correcting.
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 500, actualDrawerNet: -490, hasDrawer: true,
  });
  assert.equal(verdict.status, 'ok');
});

test('the out-OFF cell of the old rule is named the same way', () => {
  // out-OFF declared, rows are the pre-D42 posting: the account handed the
  // whole amount and the till was credited the fee it never received.
  const verdict = classifyFeeMovement({
    direction: 'out', amount: 500, fee: 10, feeAddedToBalance: false, charges: 0,
    actualAccountTotal: -500, actualDrawerNet: 510, hasDrawer: true,
  });
  assert.equal(verdict.status, 'opposite');
  assert.deepEqual(verdict.declared, { accountTotal: -490, drawerNet: 500 });
});

test('figures that match neither mode are named neither', () => {
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 530, actualDrawerNet: -520, hasDrawer: true,
  });
  assert.equal(verdict.status, 'neither');
});

test('a non-cash movement is judged on its account alone', () => {
  // No drawer rows: the drawer leg is null on every side and never votes. The
  // account still lands the bare amount under D46 — a fee has nowhere to sit
  // but the income report when there is no tin — so the figure this always
  // posted is the right one.
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 500, actualDrawerNet: null, hasDrawer: false,
  });
  assert.equal(verdict.status, 'ok');
  assert.equal(verdict.declared.drawerNet, null);
  assert.equal(verdict.opposite.drawerNet, null);
});

// --- planFeeRepost -------------------------------------------------------

test('re-posting a cash-in between the two fee modes moves no peso, only the tender', () => {
  // Since D46 both cash-in cells land `amount` on the account and net the till
  // to fee − amount: the flag alone decides which side carries the fee's own
  // row, never a balance. So flipping it plans the same figures — which is
  // also why correcting transactions 3 and 21 still works: their figures are
  // wrong under either mode, and the re-post plans the right ones from the
  // amount and the fee, not from the flag.
  const plan = planFeeRepost({
    direction: 'in',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: { feeAddedToBalance: false },
  });
  assert.deepEqual(plan.columns, { amount: 500, fee: 10, net_amount: 500, fee_added_to_balance: false });
  assert.deepEqual(plan.amounts, { [WALLET]: 500, [DRAWER]: 490 });
});

test('re-posting fixes the amount and the fee together, charges untouched', () => {
  const plan = planFeeRepost({
    direction: 'in',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: '[{"amount":"25.00"}]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: { amount: 600 },
  });
  assert.equal(plan.columns.net_amount, 600, 'the corrected amount, the fee standing outside it (D46)');
  // The account lands 600 + 25 charges; the till nets fee − that = −615, the
  // ₱10 already credited back against the ₱625 it hands over.
  assert.deepEqual(plan.amounts, { [WALLET]: 625, [DRAWER]: 615 });
});

test('the out-OFF target cuts the fee from what the account hands out', () => {
  const plan = planFeeRepost({
    direction: 'out',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: { feeAddedToBalance: false },
  });
  assert.equal(plan.columns.net_amount, 490);
  assert.deepEqual(plan.amounts, { [WALLET]: 490, [DRAWER]: 500 });
});

test('a movement with no drawer plans against the account alone', () => {
  const plan = planFeeRepost({
    direction: 'in',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: null,
    primaryAccountId: WALLET, drawerAccountId: null,
    target: {},
  });
  // The account lands the amount (D46); with no tin to hold the fee it is
  // income the income report books and the ledger does not carry.
  assert.deepEqual(plan.amounts, { [WALLET]: 500 });
});

test('a target whose drawer nets to zero carries a zero, not a missing key', () => {
  // in-OFF with the fee equal to the whole amount: the till hands nothing.
  const plan = planFeeRepost({
    direction: 'in',
    recordAmount: '10.00', recordFee: '10.00', recordFeeAddedToBalance: false,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: {},
  });
  assert.deepEqual(plan.amounts, { [WALLET]: 10, [DRAWER]: 0 });
});

test('a fee inside the amount larger than the amount is refused, as at creation', () => {
  assert.throws(
    () => planFeeRepost({
      direction: 'in',
      recordAmount: '100.00', recordFee: '10.00', recordFeeAddedToBalance: true,
      additionalCharges: '[]',
      primaryAccountId: WALLET, drawerAccountId: DRAWER,
      target: { amount: 10, fee: 20, feeAddedToBalance: false },
    }),
    (err: any) => err.statusCode === 400 && /cannot exceed the transaction amount/.test(err.message)
  );
});

test('the plan declares signed targets and the direction each is measured in', () => {
  // The sign a delta is measured in is the plan's own — never the account's
  // first row, whose history may face the other way (D43's defect, 2026-10-15).
  const inOff = planFeeRepost({
    direction: 'in',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: { feeAddedToBalance: false },
  });
  assert.deepEqual(inOff.targets, { accountTotal: 500, drawerNet: -490 });
  assert.deepEqual(inOff.signs, { [WALLET]: 1, [DRAWER]: -1 });

  const outOff = planFeeRepost({
    direction: 'out',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: { feeAddedToBalance: false },
  });
  assert.deepEqual(outOff.targets, { accountTotal: -490, drawerNet: 500 });
  assert.deepEqual(outOff.signs, { [WALLET]: -1, [DRAWER]: 1 });

  const solo = planFeeRepost({
    direction: 'in',
    recordAmount: '500.00', recordFee: '10.00', recordFeeAddedToBalance: true,
    additionalCharges: null,
    primaryAccountId: WALLET, drawerAccountId: null,
    target: {},
  });
  assert.deepEqual(solo.targets, { accountTotal: 500, drawerNet: null });
  assert.deepEqual(solo.signs, { [WALLET]: 1 });

  const zeroNet = planFeeRepost({
    direction: 'in',
    recordAmount: '10.00', recordFee: '10.00', recordFeeAddedToBalance: false,
    additionalCharges: '[]',
    primaryAccountId: WALLET, drawerAccountId: DRAWER,
    target: {},
  });
  assert.deepEqual(zeroNet.targets, { accountTotal: 10, drawerNet: 0 });
});

// --- currentFeeColumns / changedFeeColumns --------------------------------

test('the record reads as figures whatever pg hands over', () => {
  assert.deepEqual(
    currentFeeColumns({ amount: '500.00', fee: '10.00', net_amount: '510.00', fee_added_to_balance: null }),
    { amount: 500, fee: 10, net_amount: 510, fee_added_to_balance: true }
  );
});

test('only the columns that differ are reported changed', () => {
  const before = { amount: 500, fee: 10, net_amount: 510, fee_added_to_balance: true };
  assert.equal(changedFeeColumns(before, { ...before }), null);
  assert.deepEqual(
    changedFeeColumns(before, { ...before, fee_added_to_balance: false }),
    { fee_added_to_balance: false }
  );
  assert.deepEqual(
    changedFeeColumns(before, { amount: 480, fee: 10, net_amount: 490, fee_added_to_balance: false }),
    { amount: 480, net_amount: 490, fee_added_to_balance: false }
  );
});
