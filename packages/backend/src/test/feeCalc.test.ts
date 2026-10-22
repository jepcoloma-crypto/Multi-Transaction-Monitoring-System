import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTieredFee, FeeConfigRow, FeeTierRow } from '../services/feeCalc';

// The ATM Withdrawal rule exactly as it sits in transaction_fees: a
// flat_per_step over base 3,000 stepping 1,000 at a time for 10, floored at
// 30, with no tiers of its own. Every figure below is the schedule the owner
// confirmed: 30 at or below 3,000, then 30 + 10 per full or part 1,000 above.
const ATM: FeeConfigRow = {
  fee_type: 'flat_per_step',
  fee_value: 30,
  calculation_method: 'bracket',
  base_amount: 3000,
  step_amount: 1000,
  step_fee: 10,
  min_fee: 30,
};

// --- the ATM schedule ----------------------------------------------------

test('an ATM withdrawal at or below the 3,000 base charges the flat 30', () => {
  assert.equal(calculateTieredFee(ATM, [], 500), 30);
  assert.equal(calculateTieredFee(ATM, [], 2000), 30);
  assert.equal(calculateTieredFee(ATM, [], 3000), 30);
});

test('an ATM withdrawal above the base adds 10 per 1,000, rounding a part step up', () => {
  assert.equal(calculateTieredFee(ATM, [], 3001), 40);
  assert.equal(calculateTieredFee(ATM, [], 4000), 40);
  assert.equal(calculateTieredFee(ATM, [], 5000), 50);
  assert.equal(calculateTieredFee(ATM, [], 10000), 100);
  assert.equal(calculateTieredFee(ATM, [], 25000), 250);
});

test('the ATM fee grows with the amount instead of sitting flat', () => {
  // The defect this guards: the step columns were never read, so every amount
  // answered the same figure. A schedule that never moves is not a schedule.
  const at2k = calculateTieredFee(ATM, [], 2000);
  const at25k = calculateTieredFee(ATM, [], 25000);
  assert.ok(at25k !== undefined && at2k !== undefined);
  assert.ok(Number(at25k) > Number(at2k), `expected growth, got ${at2k} then ${at25k}`);
});

// --- rule shapes this change must leave alone ----------------------------
//
// feeCalc serves every fee rule in the system, not just this one. The three
// shapes below are what the other seven rules are made of; a flat_per_step
// branch that reached past its own case would change what cash-in, bill
// payment and load purchase charge.

test('a fixed rule with no tiers returns null so the caller falls back to fee_value', () => {
  // Load DITO Sim: fixed, zero tiers. movementFee reads Number(fee_value).
  const fixed: FeeConfigRow = { fee_type: 'fixed', fee_value: 15, calculation_method: 'bracket' };
  assert.equal(calculateTieredFee(fixed, [], 99999), null);
});

test('a bracket rule still answers its matching tier, not the step branch', () => {
  // Globe Load / Smart Load: fixed, bracket, three tiers.
  const tiers: FeeTierRow[] = [
    { min_amount: 1, max_amount: 100, fee_type: 'fixed', fee_value: 5 },
    { min_amount: 101, max_amount: 500, fee_type: 'fixed', fee_value: 10 },
    { min_amount: 501, max_amount: null, fee_type: 'fixed', fee_value: 15 },
  ];
  const bracket: FeeConfigRow = { fee_type: 'fixed', fee_value: 0, calculation_method: 'bracket' };
  assert.equal(calculateTieredFee(bracket, tiers, 50), 5);
  assert.equal(calculateTieredFee(bracket, tiers, 250), 10);
  assert.equal(calculateTieredFee(bracket, tiers, 5000), 15);
});

test('a per_amount rule still walks its chunks the way cash-in and bill payment charge', () => {
  // Cash-in: a 1,000-chunk rule priced per full chunk.
  const tiers: FeeTierRow[] = [
    { min_amount: 1, max_amount: 1000, fee_type: 'fixed', fee_value: 10 },
  ];
  const perAmount: FeeConfigRow = { fee_type: 'fixed', fee_value: 0, calculation_method: 'per_amount' };
  assert.equal(calculateTieredFee(perAmount, tiers, 5000), 50);
  assert.equal(calculateTieredFee(perAmount, tiers, 500), 10);
});
