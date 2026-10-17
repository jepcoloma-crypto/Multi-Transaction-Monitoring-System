// The Account Statement's footer totals, read in one pass over its entries.
//
// Money in and money out stay gross on purpose: a reversal and the row that
// answered it are two movements that really happened, and dropping either
// would stop the footer from tying to the balance column beside it — the
// statement's memo already says how much of the gross that self-cancelling
// pair is.
//
// Fees and charges are the other way round. They are reference columns over
// what actually stands: a reversal hands back everything the original
// carried, so the undone row's fee and charge are no longer anyone's money,
// and the row that undid them carries no fee or charge of its. Every other
// report already totals them that way from SQL — the income report and the
// shift report count completed rows only and report the reversed figure
// beside the total, and the income drill-down splits earned from refunded —
// so this reads the same rule from statement_status, the exact vocabulary
// the row badges use: 'reversed' is the movement that was undone, 'reversal'
// is the entry that undid it.
//
// A movement's fee rides on its ordinary rows as a memo with the row that
// *is* the fee blanked (D37), so summing the column across the rows that
// stand counts each standing fee once.
export interface StatementTotalsEntry {
  entry_type?: string | null;
  amount?: string | number | null;
  fee?: string | number | null;
  charges_total?: string | number | null;
  statement_status?: string | null;
}

const asAmount = (value: string | number | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const undoesOrWasUndone = (entry: StatementTotalsEntry): boolean =>
  entry.statement_status === 'reversed' || entry.statement_status === 'reversal';

export const statementTotals = (entries: StatementTotalsEntry[]): {
  moneyIn: number;
  moneyOut: number;
  fees: number;
  charges: number;
} => {
  let moneyIn = 0;
  let moneyOut = 0;
  let fees = 0;
  let charges = 0;

  for (const entry of entries) {
    const amount = asAmount(entry.amount);
    if (entry.entry_type === 'credit') moneyIn += amount;
    else if (entry.entry_type === 'debit') moneyOut += amount;

    if (undoesOrWasUndone(entry)) continue;
    fees += asAmount(entry.fee);
    charges += asAmount(entry.charges_total);
  }

  return { moneyIn, moneyOut, fees, charges };
};
