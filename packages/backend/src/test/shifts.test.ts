import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedClosing, netMovement, classifyVariance, VARIANCE_LABELS } from '../services/shifts';
import type { ShiftMovement, VarianceStatus } from '../services/shifts';

const inCash = (amount: string | number): ShiftMovement => ({ entry_type: 'credit', amount });
const outCash = (amount: string | number): ShiftMovement => ({ entry_type: 'debit', amount });

test('the drawer should hold the counted float plus what came in less what went out', () => {
  const movements = [inCash('2400.00'), outCash('900.00')];

  assert.equal(expectedClosing('10000.00', movements), 11500);
  assert.equal(netMovement(movements), 1500);
});

test('a shift with no movement closes on the float it opened with', () => {
  assert.equal(expectedClosing('10000.00', []), 10000);
  assert.equal(netMovement([]), 0);
});

test('a count short of the expectation is reported short, not adjusted away', () => {
  const report = classifyVariance('10000.00', [inCash('2400.00'), outCash('900.00')], '11450.00');

  assert.equal(report.openingFloat, 10000);
  assert.equal(report.expected, 11500);
  assert.equal(report.counted, 11450);
  assert.equal(report.variance, -50);
  assert.equal(report.status, 'short');
});

test('a count over the expectation is reported over', () => {
  const report = classifyVariance('10000.00', [inCash('100.00')], '10150.00');

  assert.equal(report.variance, 50);
  assert.equal(report.status, 'over');
});

test('a count that matches is balanced to the centavo', () => {
  const report = classifyVariance('10000.00', [inCash('2400.00'), outCash('900.00')], '11500.00');

  assert.equal(report.variance, 0);
  assert.equal(report.status, 'balanced');
});

test('the comparison is made in whole centavos so float error cannot fake a shortage', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point. Compared as
  // floats this reports a shortage of a fraction of a centavo, which would put
  // a permanently red badge in front of an operator.
  const movements = [inCash('0.10'), inCash('0.20')];
  const report = classifyVariance('0.00', movements, '0.30');

  assert.equal(expectedClosing('0.00', movements), 0.3);
  assert.equal(report.variance, 0);
  assert.equal(report.status, 'balanced');
});

test('an unreadable amount contributes nothing rather than poisoning the total', () => {
  const movements = [inCash('100.00'), inCash('not a number'), inCash(null as any), outCash('')];

  assert.equal(expectedClosing('50.00', movements), 150);
  assert.equal(netMovement(movements), 100);
});

test('every variance status has a badge label', () => {
  const statuses: VarianceStatus[] = ['balanced', 'over', 'short'];
  for (const status of statuses) {
    assert.ok(VARIANCE_LABELS[status], `no label for ${status}`);
  }
  assert.equal(VARIANCE_LABELS.balanced, 'BALANCED');
  assert.equal(VARIANCE_LABELS.short, 'SHORT');
});

test('the shift always reports its own counted float, not a balance read back from the drawer', () => {
  // D16: the expected figure and the drawer's balance are two independent
  // readings. Deriving the float from the account would make the two agree by
  // construction and leave the cross-check with nothing to catch.
  const report = classifyVariance('7500.55', [], '7500.55');

  assert.equal(report.openingFloat, 7500.55);
  assert.equal(report.expected, 7500.55);
});
