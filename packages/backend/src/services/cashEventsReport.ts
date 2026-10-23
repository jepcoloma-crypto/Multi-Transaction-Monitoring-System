// R2 — Cash Events: the six things the module's cash-event form records, plus
// the one code that looks like one and is not.
//
//   loan_received, loan_repayment, other_income, refund, refund_received,
//   adjustment_out — the six the form offers (CashManagement.tsx
//   CASH_EVENT_TYPES) — and adjustment_in, which the form never offers.
//
// `adjustment_in` is included for one reason, found by probing the live ledger
// rather than by reading the code: on 2026-10-19 two reversed cash-ins posted
// their unwind as `adjustment_out` transactions (transactions.ts picks
// adjustment_out/in to cancel an in/out original). `adjustment_out` is therefore
// BOTH a thing an operator records by hand AND the code the books use to undo
// something else. A report that filtered on the code and printed the result as
// "adjustments" would show those two unwinds as though somebody had taken cash
// out of the till by hand — the precise kind of self-consistent-but-wrong
// figure the integrity checks were written to catch.
//
// So every row is classified, not trusted: a transaction whose reference is
// `REV-<number>` is a reversal's counter-row and is labelled `reversal`. It is
// still listed and still summed — the cash really did move, and the statement's
// Adjustments bucket counts it too — but a reader can tell it apart, and the
// summary counts manual events separately from bookkeeping.
//
// Borrowings are summed as flows (received, repaid, net) rather than as a
// balance on purpose: "what is still owed" is already answered by the position
// statement's `borrowingsOutstanding`, which knows to exclude reversed rows and
// to run to the end of the period rather than across it. Rebuilding that figure
// here would be a second opinion on the same debt.
//
// Built on ledger rows for the same reason as Sources and Uses: the statement
// has no status filter, so counting `transactions` instead would drop reversed
// originals the bucket beside it keeps.
//
// Pure: the route reads the rows, this decides what they mean.

import { manilaDateKey } from './manilaTime';

const cents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (value: number): number => value / 100;

export const CASH_EVENT_KINDS = [
  'loan_received',
  'loan_repayment',
  'other_income',
  'refund_received',
  'refund',
  'adjustment_in',
  'adjustment_out',
] as const;

export type CashEventKind = (typeof CASH_EVENT_KINDS)[number];

// The labels the module's own form uses, so an event reads the same on the
// report as it did on the button that recorded it. The two adjustment lines are
// named plainly; the row beside them says whether it was recorded by hand.
export const CASH_EVENT_LABELS: Record<CashEventKind, string> = {
  loan_received: 'Borrowed funds received',
  loan_repayment: 'Loan repaid',
  other_income: 'Other income received',
  refund_received: 'Refund received back',
  refund: 'Refund paid out',
  adjustment_in: 'Adjustment in',
  adjustment_out: 'Adjustment out',
};

// The route each event takes, as the type itself declares it. Read from the
// constants rather than from the rows because the ledger records an
// adjustment's direction as 'adjustment' — neither in nor out — and posting
// decides it (movementPlan forces adjustment_out to a debit).
const DIRECTION: Record<CashEventKind, 'in' | 'out'> = {
  loan_received: 'in',
  other_income: 'in',
  refund_received: 'in',
  adjustment_in: 'in',
  loan_repayment: 'out',
  refund: 'out',
  adjustment_out: 'out',
};

/** The transaction type codes this report reads, for the route's WHERE clause. */
export const CASH_EVENT_CODES: readonly string[] = [...CASH_EVENT_KINDS];

const KIND_BY_CODE = new Map<string, CashEventKind>(CASH_EVENT_CODES.map((code) => [code, code as CashEventKind]));

const REVERSAL_PREFIX = 'REV-';

/**
 * Whether a transaction is the counter-row of a reversal.
 *
 * A reversal carries `REV-<the number of the transaction it undid>` as its
 * reference. When the row's own transaction number is supplied it has to match,
 * so a reference naming some other transaction cannot make this one look like a
 * reversal. A row that predates the numbered column still reads as one from the
 * prefix alone.
 */
export function isReversalRow(row: { reference_number?: string | number | null; transaction_number?: string | number | null }): boolean {
  const reference = String(row.reference_number ?? '');
  if (!reference.startsWith(REVERSAL_PREFIX)) return false;
  const named = reference.slice(REVERSAL_PREFIX.length);
  if (!named) return false;
  const own = row.transaction_number;
  if (own === null || own === undefined || own === '') return true;
  return named === String(own);
}

export interface CashEventSourceRow {
  id?: string | number;
  branch_id: string;
  branch_name?: string | null;
  entry_type: 'credit' | 'debit';
  amount: string | number;
  source_type?: string | null;
  txn_code?: string | null;
  payment_method?: string | null;
  transaction_id?: string | null;
  transaction_number?: string | number | null;
  status?: string | null;
  reference_number?: string | null;
  payee?: string | null;
  description?: string | null;
  recorded_by_username?: string | null;
  entry_date?: string | Date | null;
}

export interface CashEventRow {
  id: string;
  kind: CashEventKind;
  label: string;
  /** Manila day, `YYYY-MM-DD`, or null when the row carries no readable date. */
  day: string | null;
  direction: 'in' | 'out';
  /** Signed by the ledger: money in is positive, money out is negative. */
  amount: number;
  branchId: string;
  branchName: string | null;
  transactionNumber: string | null;
  payee: string | null;
  referenceNumber: string | null;
  description: string | null;
  recordedBy: string | null;
  /** `manual` for a recorded event, `reversal` for a counter-row. */
  role: 'manual' | 'reversal';
}

export interface CashEventKindLine {
  kind: CashEventKind;
  label: string;
  direction: 'in' | 'out';
  amount: number;
  count: number;
}

export interface CashEventsReport {
  rows: CashEventRow[];
  kinds: CashEventKindLine[];
  summary: {
    net: number;
    borrowed: number;
    repaid: number;
    borrowingsNet: number;
    count: number;
    manualCount: number;
    reversalCount: number;
  };
}

// The day a row files under, through the operating clock so a 23:30 posting
// reads as the day the operator worked rather than the UTC day it was written
// in. Null rather than invented when nothing readable is there — a fabricated
// date on a cash event is worse than a blank one.
const dayKey = (value: string | Date | null | undefined): string | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : manilaDateKey(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : manilaDateKey(parsed);
  }
  return null;
};

export function buildCashEventsReport(rows: CashEventSourceRow[]): CashEventsReport {
  const listed: CashEventRow[] = [];
  const kindTotals = new Map<CashEventKind, { cents: number; count: number }>();

  let net = 0;
  let borrowed = 0;
  let repaid = 0;
  let manualCount = 0;
  let reversalCount = 0;

  for (const row of rows) {
    const kind = KIND_BY_CODE.get(String(row.txn_code ?? ''));
    // A row this report was not asked for is ignored rather than guessed at: the
    // route selects on the seven codes, and anything else reaching here is a
    // caller's mistake that must not land in a total.
    if (!kind) continue;

    const signed = row.entry_type === 'credit' ? cents(row.amount) : -cents(row.amount);
    const role: 'manual' | 'reversal' = isReversalRow(row) ? 'reversal' : 'manual';

    net += signed;
    if (kind === 'loan_received') borrowed += signed;
    if (kind === 'loan_repayment') repaid += -signed;
    if (role === 'manual') manualCount += 1;
    else reversalCount += 1;

    const line = kindTotals.get(kind) || { cents: 0, count: 0 };
    line.cents += signed;
    line.count += 1;
    kindTotals.set(kind, line);

    listed.push({
      id: String(row.id ?? `${row.transaction_id ?? ''}:${row.entry_date ?? ''}:${signed}`),
      kind,
      label: CASH_EVENT_LABELS[kind],
      day: dayKey(row.entry_date),
      direction: DIRECTION[kind],
      amount: money(signed),
      branchId: row.branch_id,
      branchName: row.branch_name ?? null,
      transactionNumber: row.transaction_number === null || row.transaction_number === undefined
        ? null
        : String(row.transaction_number),
      payee: row.payee ?? null,
      referenceNumber: row.reference_number ?? null,
      description: row.description ?? null,
      recordedBy: row.recorded_by_username ?? null,
      role,
    });
  }

  // Newest first: this is a register of what happened, and the last thing
  // recorded is what an operator checks against memory.
  listed.sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || b.amount - a.amount || a.label.localeCompare(b.label));

  const kinds: CashEventKindLine[] = CASH_EVENT_KINDS
    .filter((kind) => kindTotals.has(kind))
    .map((kind) => ({
      kind,
      label: CASH_EVENT_LABELS[kind],
      direction: DIRECTION[kind],
      amount: money(kindTotals.get(kind)!.cents),
      count: kindTotals.get(kind)!.count,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label));

  return {
    rows: listed,
    kinds,
    summary: {
      net: money(net),
      borrowed: money(borrowed),
      repaid: money(repaid),
      borrowingsNet: money(borrowed - repaid),
      count: listed.length,
      manualCount,
      reversalCount,
    },
  };
}
