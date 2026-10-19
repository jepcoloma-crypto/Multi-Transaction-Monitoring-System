// A movement's history: what it wrote, and who then touched it.
//
// The ledger keeps every row it ever wrote and `audit_logs` records who acted
// and why, but for a long time nothing joined them. Answering "what happened
// to txn 3, and who authorised it?" meant running three queries by hand and
// reading description prefixes to work out which row was which. The ₱20 found
// on 2026-10-19 was found that way, by people.
//
// This file holds only the shape and the labels — no fetching, no React — so
// each rule here is testable against fixture rows.

export interface MovementRow {
  id: string;
  /** `debit` or `credit`, as the ledger recorded it. */
  entryType: string;
  amount: number;
  /** The running balance this row left its account at, in write order. */
  balanceAfter: number;
  description: string | null;
  /** fee | movement | correction | reversal | null (migration 048). */
  role: string | null;
  accountName: string | null;
  accountId: string;
  createdAt: string;
}

/** One column an audit entry changed. */
export interface ChangedColumn {
  column: string;
  from: unknown;
  to: unknown;
}

export interface TrailEvent {
  id: string;
  action: string;
  username: string | null;
  reason: string | null;
  createdAt: string;
  changed: ChangedColumn[];
}

export interface MovementSummary {
  id: string;
  transactionNumber: number;
  referenceNumber: string | null;
  amount: number;
  fee: number;
  netAmount: number;
  feeAddedToBalance: boolean;
  status: string;
  paymentMethod: string | null;
  description: string | null;
  direction: string | null;
  typeName: string | null;
  accountName: string | null;
  transactionDate: string;
  enteredAt: string;
}

export interface MovementHistory {
  transaction: MovementSummary;
  rows: MovementRow[];
  trail: TrailEvent[];
  corrections: number;
  touched: boolean;
}

/**
 * How a row's role reads on screen.
 *
 * An unlabelled row says so rather than being sorted silently into a bucket.
 * The label is presentation; `role` remains what identifies the row.
 */
export const roleLabel = (role: string | null): string =>
  role === 'fee'
    ? 'Service fee'
    : role === 'movement'
      ? 'Movement'
      : role === 'correction'
        ? 'Correction'
        : role === 'reversal'
          ? 'Reversal'
          : 'Unlabelled';

/** Whether a label is trustworthy enough to group by, or is a gap worth naming. */
export const isUnlabelled = (role: string | null): boolean => role === null;

/** The ledger rows that moved money after the movement was first written. */
export const laterRows = (rows: MovementRow[]): MovementRow[] =>
  rows.filter((r) => r.role === 'correction' || r.role === 'reversal');

/**
 * Which side of the books a row sits on, for a reader who has not memorised
 * that debit means "the account received" for one direction and "the account
 * handed over" for another.
 */
export const sideLabel = (entryType: string): string =>
  entryType === 'credit' ? 'In' : entryType === 'debit' ? 'Out' : entryType;
