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

test('a row written before the fee rode the account is named as the opposite mode', () => {
  // in-ON declared, but the rows are the pre-D42 posting: the account landed
  // the bare amount and the till carried the fee. The opposite mode expects
  // exactly that, so the row is one fee away from its declaration.
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 500, actualDrawerNet: -490, hasDrawer: true,
  });
  assert.equal(verdict.status, 'opposite');
  assert.deepEqual(verdict.declared, { accountTotal: 510, drawerNet: -500 });
  assert.deepEqual(verdict.opposite, { accountTotal: 500, drawerNet: -490 });
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
  // No drawer rows: the drawer leg is null on every side and never votes.
  const verdict = classifyFeeMovement({
    direction: 'in', amount: 500, fee: 10, feeAddedToBalance: true, charges: 0,
    actualAccountTotal: 500, actualDrawerNet: null, hasDrawer: false,
  });
  assert.equal(verdict.status, 'opposite');
  assert.equal(verdict.declared.drawerNet, null);
  assert.equal(verdict.opposite.drawerNet, null);
});

// --- planFeeRepost -------------------------------------------------------

test('re-posting under the other mode moves the fee between the two pools', () => {
  // in declared ON, correcting to OFF: the account gives back the fee it was
  // credited and the till hands out less — the deltas that make both legs
  // match the other cell.
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
  assert.equal(plan.columns.net_amount, 610, 'the fee rides the corrected amount too (D42)');
  assert.deepEqual(plan.amounts, { [WALLET]: 635, [DRAWER]: 625 });
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
  assert.deepEqual(plan.amounts, { [WALLET]: 510 });
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
