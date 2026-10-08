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
