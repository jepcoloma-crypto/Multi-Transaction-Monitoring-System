// Expected cash at the close of a shift, and how a counted figure differs from
// it. Pure — no network, no database — so the arithmetic that decides whether a
// branch is short can be tested without one.
//
// A shift records what was counted, never a movement. The expected figure is
// arithmetic over movements that already exist, which is what keeps a
// discrepancy an event to investigate rather than a balance someone adjusted
// away (design D14). Reconciliation already uses this shape — expected, actual,
// variance, status — per account; this is the same at branch granularity.
//
// The expected figure is built from the shift's own counted opening float and
// not from the account's opening balance, so the two readings stay independent:
// if they are derived from each other they can never disagree, and a check that
// cannot disagree with itself is not a check (design D16).

const toCents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (cents: number): number => cents / 100;

export type VarianceStatus = 'balanced' | 'over' | 'short';

export const VARIANCE_LABELS: Record<VarianceStatus, string> = {
  balanced: 'BALANCED',
  over: 'OVER',
  short: 'SHORT',
};

export interface ShiftMovement {
  entry_type: 'credit' | 'debit';
  amount: string | number;
}

function movementCents(movements: ShiftMovement[]): number {
  let cents = 0;
  for (const movement of movements) {
    cents += movement.entry_type === 'credit' ? toCents(movement.amount) : -toCents(movement.amount);
  }
  return cents;
}

/** Cash handed in less cash handed out, across the shift's window. */
export function netMovement(movements: ShiftMovement[]): number {
  return money(movementCents(movements));
}

/**
 * What the drawer should hold when the shift closes.
 *
 * A field the database left out or a row that is not a number contributes
 * nothing rather than turning the whole total into NaN: one unreadable figure
 * must not be able to make every branch's shift un-closeable.
 */
export function expectedClosing(
  openingFloat: string | number,
  movements: ShiftMovement[]
): number {
  return money(toCents(openingFloat) + movementCents(movements));
}

export interface VarianceReport {
  openingFloat: number;
  expected: number;
  counted: number;
  variance: number;
  status: VarianceStatus;
}

/**
 * Compare what was counted against what should have been there.
 *
 * The comparison is made in whole centavos so a column of fractions cannot
 * accumulate float error and report a shortage of a fraction of a centavo —
 * which would train an operator to ignore a badge that is always slightly red.
 */
export function classifyVariance(
  openingFloat: string | number,
  movements: ShiftMovement[],
  countedClosing: string | number
): VarianceReport {
  const expected = expectedClosing(openingFloat, movements);
  const counted = money(toCents(countedClosing));
  const variance = money(toCents(counted) - toCents(expected));

  return {
    openingFloat: money(toCents(openingFloat)),
    expected,
    counted,
    variance,
    status: variance === 0 ? 'balanced' : variance > 0 ? 'over' : 'short',
  };
}
