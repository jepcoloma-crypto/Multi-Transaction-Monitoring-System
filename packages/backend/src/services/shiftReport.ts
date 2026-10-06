// Shapes shift rows into the cash-count report. Pure — no network, no database —
// so the totals that say whether a branch was short are testable without one.
//
// The report is one row per shift and deliberately reads the figures the shift
// itself recorded rather than recomputing them. A closed shift is a settled
// document: it carries its own expected closing, counted closing and variance,
// and those are the numbers an operator signed off on. Recomputing expected
// from today's ledger would fold in any correction or reversal dated inside the
// window that arrived after the shift closed, and would quietly rewrite a
// variance someone is accountable for. An open shift has no settled figures, so
// its counted closing and variance are null rather than provisional guesses.
//
// Totals are accumulated in whole centavos. A column of rounded floats can sum
// to something that disagrees with the sum of the underlying centavos by a
// fraction, and a report whose total is a centavo off from its own rows is a
// report nobody trusts.

const toCents = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (cents: number): number => cents / 100;

export interface ShiftReportSourceRow {
  id: string;
  shift_date: string | null;
  status: string | null;
  branch_code: string | null;
  branch_name: string | null;
  opened_by_username: string | null;
  closed_by_username: string | null;
  opened_at: string | Date | null;
  closed_at: string | Date | null;
  opening_float: string | number | null;
  counted_closing: string | number | null;
  expected_closing: string | number | null;
  variance: string | number | null;
  notes: string | null;
  // Cash handed in and out across the shift's own window, resolved by the caller
  // from the drawer's ledger entries. Kept out of the stored row because an entry
  // dated inside the window can arrive after close, and the report shows both the
  // settled figure and the movement detail behind it rather than choosing one.
  cash_in: string | number;
  cash_out: string | number;
}

export interface ShiftReportRow {
  id: string;
  shiftDate: string | null;
  status: 'open' | 'closed';
  branchCode: string | null;
  branchName: string | null;
  openedByUsername: string | null;
  closedByUsername: string | null;
  openedAt: string | null;
  closedAt: string | null;
  openingFloat: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number | null;
  countedClosing: number | null;
  variance: number | null;
  notes: string | null;
}

export interface ShiftReportSummary {
  totalShifts: number;
  openShifts: number;
  closedShifts: number;
  totalOpeningFloat: number;
  totalCashIn: number;
  totalCashOut: number;
  totalExpected: number;
  totalCounted: number;
  totalVariance: number;
  // A count of shifts that landed short, so the headline can say how many drawers
  // need explaining rather than only how much money they were off by. Both counts
  // are over closed shifts only — an open shift has not been counted yet, so it
  // cannot be short or over, only outstanding.
  shortCount: number;
  overCount: number;
  balancedCount: number;
}

export interface ShiftReport {
  shifts: ShiftReportRow[];
  summary: ShiftReportSummary;
}

const isOpen = (status: string | null): boolean => status !== 'closed';

const asIso = (value: string | Date | null): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export function buildShiftReport(rows: ShiftReportSourceRow[]): ShiftReport {
  const shifts: ShiftReportRow[] = rows.map((row) => {
    const open = isOpen(row.status);
    return {
      id: row.id,
      shiftDate: row.shift_date,
      status: open ? 'open' : 'closed',
      branchCode: row.branch_code,
      branchName: row.branch_name,
      openedByUsername: row.opened_by_username,
      closedByUsername: row.closed_by_username,
      openedAt: asIso(row.opened_at),
      closedAt: asIso(row.closed_at),
      openingFloat: money(toCents(row.opening_float)),
      cashIn: money(toCents(row.cash_in)),
      cashOut: money(toCents(row.cash_out)),
      // Null on an open shift is the report saying "not yet counted" rather than
      // "counted as zero" — the distinction matters when the alternative is a
      // variance column that reads as a clean balance.
      expectedClosing: open ? null : money(toCents(row.expected_closing)),
      countedClosing: open ? null : money(toCents(row.counted_closing)),
      variance: open ? null : money(toCents(row.variance)),
      notes: row.notes,
    };
  });

  let openingCents = 0;
  let inCents = 0;
  let outCents = 0;
  let expectedCents = 0;
  let countedCents = 0;
  let varianceCents = 0;
  let shortCount = 0;
  let overCount = 0;
  let balancedCount = 0;
  let openShifts = 0;

  for (const shift of shifts) {
    openingCents += toCents(shift.openingFloat);
    inCents += toCents(shift.cashIn);
    outCents += toCents(shift.cashOut);
    if (shift.status === 'open') {
      openShifts += 1;
      continue;
    }
    expectedCents += toCents(shift.expectedClosing);
    countedCents += toCents(shift.countedClosing);
    const variance = toCents(shift.variance);
    varianceCents += variance;
    if (variance < 0) shortCount += 1;
    else if (variance > 0) overCount += 1;
    else balancedCount += 1;
  }

  return {
    shifts,
    summary: {
      totalShifts: shifts.length,
      openShifts,
      closedShifts: shifts.length - openShifts,
      totalOpeningFloat: money(openingCents),
      totalCashIn: money(inCents),
      totalCashOut: money(outCents),
      totalExpected: money(expectedCents),
      totalCounted: money(countedCents),
      totalVariance: money(varianceCents),
      shortCount,
      overCount,
      balancedCount,
    },
  };
}
