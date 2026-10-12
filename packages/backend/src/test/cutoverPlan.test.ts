import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutoverPlan } from '../services/cutover';

// The owner's recorded choice (flow doc §9): transfer the count out of the
// legacy fund into the new Drawer and freeze the remainder on the legacy line.
// These tests pin that mechanism's arithmetic and its refusals — the same
// plan object the dry run prints and the --commit run applies, so pinning it
// once pins both.

test('the count moves out and the remainder freezes on the legacy line', () => {
  const plan = cutoverPlan(
    {
      branchName: 'Main Branch',
      legacyName: 'Revolving Fund',
      legacyBalance: 117249,
      counted: 20000,
    },
    { today: '2026-10-13' }
  );

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.transfer, 20000, 'the whole count is handed out of the fund');
  assert.equal(plan.drawerAfter, 20000, 'the Drawer opens with exactly what was counted');
  assert.equal(plan.remainder, 97249, 'the fund freezes holding what the count did not take');
  assert.equal(
    plan.drawerAfter + plan.remainder,
    117249,
    'nothing is invented or lost: till plus frozen line is still the books'
  );
  assert.equal(plan.movesMoney, true);
  assert.equal(plan.reference, 'CUTOVER-2026-10-13');
});

test('a count larger than the fund is refused, with both figures named', () => {
  const plan = cutoverPlan({
    branchName: 'Main Branch',
    legacyName: 'Revolving Fund',
    legacyBalance: 117249,
    counted: 150000,
  });

  assert.equal(plan.problems.length, 1, 'one refusal, said once');
  assert.match(plan.problems[0], /150000\.00/, 'the count is named');
  assert.match(plan.problems[0], /117249\.00/, 'the books figure is named');
  assert.match(plan.problems[0], /Revolving Fund/, 'the fund is named');
  assert.equal(plan.movesMoney, false, 'a refused plan moves nothing');
});

test('a negative count is refused', () => {
  const plan = cutoverPlan({
    branchName: 'Main Branch',
    legacyName: 'Revolving Fund',
    legacyBalance: 100,
    counted: -5,
  });

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /cannot be negative/);
  assert.equal(plan.movesMoney, false);
});

test('a count that is not a number is refused, not coerced', () => {
  const plan = cutoverPlan({
    branchName: 'Main Branch',
    legacyName: 'Revolving Fund',
    legacyBalance: 100,
    counted: Number('oops'),
  });

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /must be a number/);
  assert.equal(plan.movesMoney, false);
});

test('a books balance that is not a number is refused, not treated as zero', () => {
  const plan = cutoverPlan({
    branchName: 'Main Branch',
    legacyName: 'Revolving Fund',
    legacyBalance: Number('oops'),
    counted: 10,
  });

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /legacy fund's balance must be a number/);
  assert.equal(plan.movesMoney, false);
});

test('a zero count against a funded legacy freezes everything, moving nothing', () => {
  const plan = cutoverPlan({
    branchName: 'Reina Mercedes',
    legacyName: 'Revolving Fund',
    legacyBalance: 5000,
    counted: 0,
  });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.movesMoney, false, 'no ledger rows: nothing physically moved');
  assert.equal(plan.remainder, 5000, 'the whole balance is what freezes');
  assert.equal(plan.drawerAfter, 0, 'the Drawer opens empty because the count was empty');
});

test('a branch with nothing on either side cuts over cleanly', () => {
  const plan = cutoverPlan({
    branchName: 'Reina Mercedes',
    legacyName: 'Revolving Fund',
    legacyBalance: 0,
    counted: 0,
  });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.movesMoney, false);
  assert.equal(plan.remainder, 0);
});

test('the arithmetic is exact in centavos, never in binary floats', () => {
  // 0.3 − 0.1 in binary floats is 0.19999999999999998; a frozen line that
  // reads 0.20 on screen while holding a fraction of a centavo is a line no
  // auditor can tie to a count.
  const plan = cutoverPlan({
    branchName: 'Main Branch',
    legacyName: 'Revolving Fund',
    legacyBalance: 0.1 + 0.2,
    counted: 0.1,
  });

  assert.deepEqual(plan.problems, []);
  assert.equal(plan.remainder, 0.2);
  assert.equal(plan.transfer, 0.1);
});

test('each ledger description stands alone as the labeled line', () => {
  const plan = cutoverPlan(
    {
      branchName: 'Main Branch',
      legacyName: 'Revolving Fund',
      legacyBalance: 117249,
      counted: 20000,
    },
    { reference: 'CUTOVER-2026-10-13' }
  );

  assert.match(plan.drawerDescription, /20000\.00/, 'the count is named');
  assert.match(plan.drawerDescription, /Revolving Fund/, 'where it came from is named');
  assert.match(plan.legacyDescription, /freezes at 97249\.00/, 'what remains is named');
  assert.match(plan.legacyDescription, /new Drawer/, 'where the count went is named');
  assert.equal(plan.reference, 'CUTOVER-2026-10-13');
});
