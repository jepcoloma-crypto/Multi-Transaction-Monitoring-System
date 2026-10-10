import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedClosing, netMovement, classifyVariance, drawerDifference, openingReasonError, openShiftDateProblem, VARIANCE_LABELS, countDetailCents, countDetailError, normalizeCountDetail, varianceReasonError, DENOMINATIONS, VARIANCE_REASONS } from '../services/shifts';
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

test('a tally is added in centavos so a column of twenty-five centavo coins cannot drift', () => {
  const detail = { '1000': 3, '50': 2, '0.25': 4 };

  assert.equal(countDetailCents(detail), 300_000 + 10_000 + 100);
  assert.equal(countDetailError(detail, 3101), null);
});

test('a breakdown that disagrees with the declared count is refused, and says by how much', () => {
  const detail = { '100': 5 };

  assert.equal(countDetailError(detail, '450'), 'The denominations add to 500.00, which is 50.00 more than the 450.00 declared');
  assert.equal(countDetailError(detail, '550'), 'The denominations add to 500.00, which is 50.00 short of the 550.00 declared');
});

test('a total typed by hand, with no breakdown behind it, is not an error', () => {
  // Every shift recorded before the tally existed has to keep closing, and
  // counting a total without enumerating notes is still a count.
  assert.equal(countDetailError(null, '100455'), null);
  assert.equal(countDetailError(undefined, '100455'), null);
  assert.equal(countDetailError({}, '100455'), null);
  assert.equal(countDetailError({ '100': 0 }, '100455'), null);
});

test('a note this counter does not track cannot enter a tally silently', () => {
  assert.match(countDetailError({ '3': 1 }, '3') ?? '', /is not a note or coin/);
  assert.match(countDetailError({ '100': 1.5 }, '150') ?? '', /whole number/);
});

test('only the counts that were actually entered are stored', () => {
  assert.deepEqual(normalizeCountDetail({ '1000': 2, '500': 0, '20': '', '3': 4 }), { '1000': 2 });
  assert.equal(normalizeCountDetail({ '1000': 0 }), null);
  assert.equal(normalizeCountDetail('1000'), null);
});

test('a shift that balanced owes no explanation and is never asked for one', () => {
  assert.equal(varianceReasonError(0, undefined, undefined), null);
  assert.equal(varianceReasonError(0, 'made-up', ''), null);
});

test('a shift that differs from the expected count must say why', () => {
  assert.match(varianceReasonError(-50, '', '') ?? '', /must say why/);
  assert.match(varianceReasonError(-50, undefined, '') ?? '', /must say why/);
  assert.match(varianceReasonError(50, 'made-up', '') ?? '', /not a recognised reason/);
  assert.equal(varianceReasonError(-50, 'recount', ''), null);
});

test('half a peso is a variance; so is a fraction of a centavo', () => {
  assert.match(varianceReasonError(0.01, '', '') ?? '', /must say why/);
});

test('the catch-all reason cannot stand in for saying what happened', () => {
  assert.match(varianceReasonError(-1, 'other', '   ') ?? '', /needs the notes/);
  assert.equal(varianceReasonError(-1, 'other', 'Till was short a twenty at lunch'), null);
});

test('the denominations are the notes a counter here would actually be handed', () => {
  assert.deepEqual(
    DENOMINATIONS.map((d) => d.label),
    ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.25'],
  );
  for (const denomination of DENOMINATIONS) {
    assert.equal(countDetailCents({ [denomination.label]: 1 }), denomination.cents);
  }
});

test('every reason the screen offers is one the server would accept', () => {
  for (const key of Object.keys(VARIANCE_REASONS)) {
    assert.equal(varianceReasonError(-1, key, key === 'other' ? 'stated' : ''), null, key);
  }
});

test('the second reading agrees when the expected figure and the drawer match', () => {
  assert.equal(drawerDifference(78980, 78980), 0);
});

test('the second reading names the gap, and which side is higher', () => {
  // The float counted at open was 74860 against a drawer of 74680: the shift
  // opened 180 out of step and must still say so after it locks.
  assert.equal(drawerDifference(79160, 78980), 180);
  assert.equal(drawerDifference(78980, 79160), -180);
});

// The whole point of keeping this figure is that it reduces to the opening
// float less the drawer at open, because the movement posts into both sides.
// If a balance of movements ever failed to cancel, the reading would drift with
// the shift's traffic and stop meaning what it says it means.
test('the movement cancels, so the reading is fixed when the shift opens', () => {
  const float = 74680;
  const drawerAtOpen = 74680;
  for (const net of [0, 4300, -2500, 0.35, 999999.99]) {
    assert.equal(drawerDifference(float + net, drawerAtOpen + net), 0, `net ${net}`);
  }
  // The mismatch case: float above the books by 180, whatever the traffic.
  for (const net of [0, 4300, -2500]) {
    assert.equal(drawerDifference(74860 + net, 74680 + net), 180, `net ${net}`);
  }
});

test('a fraction of a centavo reads as agreement, not as a gap', () => {
  assert.equal(drawerDifference(74680.001, 74680), 0);
  assert.equal(drawerDifference(74680, 74680.001), 0);
});

test('a float that matches its drawer owes no explanation', () => {
  assert.equal(openingReasonError(0, '', ''), null);
  assert.equal(openingReasonError(0, null, null), null);
});

test('a float that missed the drawer cannot open without saying why', () => {
  assert.match(openingReasonError(180, '', '') ?? '', /must say why it differs/);
  assert.match(openingReasonError(-180, undefined, undefined) ?? '', /must say why it differs/);
});

test('the explanation is drawn from the list a variance uses', () => {
  for (const key of Object.keys(VARIANCE_REASONS)) {
    assert.equal(openingReasonError(180, key, key === 'other' ? 'stated' : ''), null, key);
  }
});

test('the opening difference rejects a reason nobody could have chosen', () => {
  assert.match(openingReasonError(180, 'made_up', '') ?? '', /is not a recognised reason/);
});

test('the catch-all still has to say what happened, here as much as at close', () => {
  assert.match(openingReasonError(180, 'other', '   ') ?? '', /needs the notes/);
  assert.equal(openingReasonError(180, 'other', 'Drawer held an unbelted twenty from yesterday'), null);
});

test('a shift cannot claim a day that has not happened yet', () => {
  const problem = openShiftDateProblem('2026-10-11', '2026-10-10', false, true);
  assert.equal(problem?.status, 400);
  assert.match(problem?.message ?? '', /in the future/);
});

test('the future is refused to everybody, taken or not', () => {
  assert.equal(openShiftDateProblem('2026-10-11', '2026-10-10', true, false)?.status, 400);
});

test('a day already recorded is refused to everybody, administrator included', () => {
  const problem = openShiftDateProblem('2026-10-09', '2026-10-10', true, true);
  assert.equal(problem?.status, 409);
  assert.match(problem?.message ?? '', /already has a shift for 2026-10-09/);
});

test('an already-taken day is reported as taken, not as somebody else lacking permission', () => {
  assert.equal(openShiftDateProblem('2026-10-09', '2026-10-10', true, false)?.status, 409);
});

test('a past day is a call only an administrator may make', () => {
  const refused = openShiftDateProblem('2026-10-09', '2026-10-10', false, false);
  assert.equal(refused?.status, 403);
  assert.match(refused?.message ?? '', /Only an administrator/);
  assert.equal(openShiftDateProblem('2026-10-09', '2026-10-10', false, true), null);
});

test("today needs nobody's leave, so a shift opened on the day is unaffected", () => {
  assert.equal(openShiftDateProblem('2026-10-10', '2026-10-10', false, false), null);
});
