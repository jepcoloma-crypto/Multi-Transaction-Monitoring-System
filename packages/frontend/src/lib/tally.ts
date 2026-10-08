// The tally behind a drawer count: how many of each note and coin were in the
// drawer, and what those pieces add up to.
//
// Subtotals are computed in centavos because one of the denominations is
// ₱0.25, which has no exact binary float. A tally that drifts by a fraction of
// a centavo cannot be reconciled against a count that does not, and a mismatch
// the operator cannot explain is how a control turns into noise.

export interface Denomination {
  label: string;
  cents: number;
}

/**
 * How many pieces of one denomination were entered.
 *
 * Blank, partial and unusable input all count as none rather than throwing:
 * the grid is typed into one box at a time and an empty box is a box not yet
 * filled, not an error.
 */
export function denomQty(denoms: Record<string, string>, label: string): number {
  const parsed = parseInt(denoms[label] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** What the entered quantities add up to, in centavos. */
export function tallyCents(denominations: Denomination[], denoms: Record<string, string>): number {
  return denominations.reduce((sum, d) => sum + denomQty(denoms, d.label) * d.cents, 0);
}

/**
 * Whether a tally was actually taken.
 *
 * An empty grid is not a count of zero: it means the operator counted a total
 * by hand instead, and that figure has to stay editable rather than being
 * pinned at 0.00 by a grid nobody filled in.
 */
export function tallyUsed(denominations: Denomination[], denoms: Record<string, string>): boolean {
  return denominations.some((d) => denomQty(denoms, d.label) > 0);
}

/**
 * One denomination's line, in pesos — the unit it is printed in.
 *
 * The arithmetic above stays in centavos and this is the only place that
 * divides, so a display that reads ten times too large cannot be produced by
 * feeding centavos to a helper whose name does not say what it holds.
 */
export function denomSubtotalPesos(denomination: Denomination, quantity: number): number {
  return (denomination.cents * quantity) / 100;
}

/** What a tally adds up to, in pesos. */
export function tallyPesos(denominations: Denomination[], denoms: Record<string, string>): number {
  return tallyCents(denominations, denoms) / 100;
}
