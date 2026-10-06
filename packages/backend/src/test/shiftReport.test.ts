import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShiftReport } from '../services/shiftReport';
import type { ShiftReportSourceRow } from '../services/shiftReport';

const baseRow = (overrides: Partial<ShiftReportSourceRow> = {}): ShiftReportSourceRow => ({
  id: 'shift-1',
  shift_date: '2026-10-04',
  status: 'closed',
  branch_code: 'MAIN',
  branch_name: 'Main Branch',
  opened_by_username: 'joyce',
  closed_by_username: 'admin',
  opened_at: '2026-10-04T08:00:00+00:00',
  closed_at: '2026-10-04T17:00:00+00:00',
  opening_float: '10000.00',
  counted_closing: '11500.00',
  expected_closing: '11500.00',
  variance: '0.00',
  notes: null,
  cash_in: '2400.00',
  cash_out: '900.00',
  ...overrides,
});

test('a closed shift carries its own settled figures rather than recomputed ones', () => {
  const report = buildShiftReport([baseRow()]);

  assert.equal(report.shifts.length, 1);
  const shift = report.shifts[0];
  assert.equal(shift.status, 'closed');
  assert.equal(shift.openingFloat, 10000);
  assert.equal(shift.cashIn, 2400);
  assert.equal(shift.cashOut, 900);
  assert.equal(shift.expectedClosing, 11500);
  assert.equal(shift.countedClosing, 11500);
  assert.equal(shift.variance, 0);
  assert.equal(shift.closedByUsername, 'admin');
});

test('a shift that landed short is reported short and counted in the headline', () => {
  const report = buildShiftReport([baseRow({
    counted_closing: '11450.00',
    variance: '-50.00',
  })]);

  assert.equal(report.shifts[0].variance, -50);
  assert.equal(report.summary.shortCount, 1);
  assert.equal(report.summary.overCount, 0);
  assert.equal(report.summary.balancedCount, 0);
  assert.equal(report.summary.totalVariance, -50);
});

test('a count over the expectation is reported over', () => {
  const report = buildShiftReport([baseRow({
    counted_closing: '11560.00',
    variance: '60.00',
  })]);

  assert.equal(report.shifts[0].variance, 60);
  assert.equal(report.summary.overCount, 1);
  assert.equal(report.summary.shortCount, 0);
});

test('an open shift has no counted figure, and cannot be short or over', () => {
  const report = buildShiftReport([baseRow({
    id: 'shift-open',
    status: 'open',
    closed_at: null,
    closed_by_username: null,
    counted_closing: null,
    expected_closing: null,
    variance: null,
    notes: null,
  })]);

  const shift = report.shifts[0];
  assert.equal(shift.status, 'open');
  assert.equal(shift.countedClosing, null);
  assert.equal(shift.expectedClosing, null);
  assert.equal(shift.variance, null);
  // Movements still show: the drawer is live, and what has come in and gone out
  // is knowable before the count.
  assert.equal(shift.cashIn, 2400);
  assert.equal(shift.cashOut, 900);

  assert.equal(report.summary.openShifts, 1);
  assert.equal(report.summary.closedShifts, 0);
  assert.equal(report.summary.totalCounted, 0);
  assert.equal(report.summary.totalVariance, 0);
  assert.equal(report.summary.shortCount, 0);
  assert.equal(report.summary.overCount, 0);
});

test('totals are summed in centavos so the column does not drift from its rows', () => {
  const report = buildShiftReport([
    baseRow({ id: 'a', counted_closing: '11500.10', variance: '0.10' }),
    baseRow({ id: 'b', counted_closing: '11500.20', variance: '0.20' }),
  ]);

  assert.equal(report.summary.totalCounted, 23000.30);
  assert.equal(report.summary.totalVariance, 0.30);
});

test('float and movements total across open and closed shifts alike', () => {
  const report = buildShiftReport([
    baseRow({ id: 'a', opening_float: '10000.00', cash_in: '2400.00', cash_out: '900.00' }),
    baseRow({
      id: 'b',
      status: 'open',
      opening_float: '5000.00',
      cash_in: '100.00',
      cash_out: '50.00',
      counted_closing: null,
      expected_closing: null,
      variance: null,
      closed_at: null,
      closed_by_username: null,
    }),
  ]);

  assert.equal(report.summary.totalShifts, 2);
  assert.equal(report.summary.openShifts, 1);
  assert.equal(report.summary.closedShifts, 1);
  assert.equal(report.summary.totalOpeningFloat, 15000);
  assert.equal(report.summary.totalCashIn, 2500);
  assert.equal(report.summary.totalCashOut, 950);
});

test('a blank or unreadable figure contributes zero rather than NaN', () => {
  const report = buildShiftReport([baseRow({
    opening_float: '',
    counted_closing: 'not a number',
    variance: null,
    cash_in: undefined as unknown as string,
    cash_out: null as unknown as string,
  })]);

  const shift = report.shifts[0];
  assert.equal(shift.openingFloat, 0);
  assert.equal(shift.countedClosing, 0);
  assert.equal(shift.cashIn, 0);
  assert.equal(shift.cashOut, 0);
  assert.equal(report.summary.totalOpeningFloat, 0);
});

test('an empty period reports no shifts and no totals', () => {
  const report = buildShiftReport([]);

  assert.deepEqual(report.shifts, []);
  assert.equal(report.summary.totalShifts, 0);
  assert.equal(report.summary.totalVariance, 0);
  assert.equal(report.summary.shortCount, 0);
});
