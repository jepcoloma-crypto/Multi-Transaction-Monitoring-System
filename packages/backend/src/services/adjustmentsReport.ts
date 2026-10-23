// Adjustments register — the correction book for the drawers.
//
// Where an adjustment lives in the ledger and where an operator thinks it lives
// are not the same table. An adjustment is the one cash event that can exist
// *before* it moves money: since D49 both directions wait for a second signature
// from anyone but an administrator, so a row recorded by a counter sits pending
// until someone approves it — and a pending transaction has no ledger rows. A
// report built on ledger entries would therefore not only miss the pending
// ones, it would miss precisely the ones that matter most: an adjustment
// awaiting approval has not touched the drawer, and the close reads OVER until
// it does.
//
// So this register reads `transactions`, the one place that holds a pending row
// at all, and it says what a row is rather than trusting what it looks like:
//
//   adjustment_out  is BOTH an operator's correction AND the code the books use
//                   to undo a cash-in (R2 found the reversed cash-ins posting
//                   their unwind as adjustment_out, reference `REV-<number>`).
//                   Those counter-rows are labelled `reversal`, never counted as
//                   a correction somebody took out of the till.
//
//   status          a pending row has not moved the drawer; a completed row has;
//                   a reversed original handed its movement straight back.
//
// The direction comes from the code (adjustment_in credits the drawer,
// adjustment_out debits it — the same reading `paymentPlan` forces), not from a
// ledger entry_type, because a pending row has no entry to read.
//
// Pure: the route reads the rows, this decides what they mean.

import { isReversalRow } from './cashEventsReport';
import { manilaDateKey } from './manilaTime';

const cents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (value: number): number => value / 100;

export const ADJUSTMENT_CODES: readonly ['adjustment_in', 'adjustment_out'] = ['adjustment_in', 'adjustment_out'];

const DIRECTION: Record<(typeof ADJUSTMENT_CODES)[number], 'in' | 'out'> = {
  adjustment_in: 'in',
  adjustment_out: 'out',
};

const LABEL: Record<(typeof ADJUSTMENT_CODES)[number], string> = {
  adjustment_in: 'Adjustment in',
  adjustment_out: 'Adjustment out',
};

export interface AdjustmentSourceRow {
  id?: string | number;
  branch_id: string;
  branch_name?: string | null;
  account_name?: string | null;
  txn_code?: string | null;
  amount: string | number;
  payment_method?: string | null;
  transaction_number?: string | number | null;
  reference_number?: string | null;
  payee?: string | null;
  description?: string | null;
  status?: string | null;
  recorded_by_username?: string | null;
  transaction_date?: string | Date | null;
}

export type AdjustmentRole = 'manual' | 'reversal';

export interface AdjustmentRow {
  id: string;
  code: 'adjustment_in' | 'adjustment_out';
  label: string;
  direction: 'in' | 'out';
  /** Manila day the adjustment is dated to, `YYYY-MM-DD`, or null. */
  day: string | null;
  /** Signed by direction: an adjustment in is positive, out is negative. */
  amount: number;
  branchId: string;
  branchName: string | null;
  accountName: string | null;
  status: string | null;
  transactionNumber: string | null;
  referenceNumber: string | null;
  payee: string | null;
  description: string | null;
  recordedBy: string | null;
  role: AdjustmentRole;
}

export interface AdjustmentBranchLine {
  branchId: string;
  name: string | null;
  /** Money added to the drawer, pesos. */
  in: number;
  /** Money taken out of the drawer, pesos. */
  out: number;
  net: number;
  count: number;
}

export interface AdjustmentsReport {
  rows: AdjustmentRow[];
  branches: AdjustmentBranchLine[];
  summary: {
    /** All adjustments in, pesos. */
    totalIn: number;
    /** All adjustments out, pesos. */
    totalOut: number;
    net: number;
    count: number;
    /** Rows still awaiting a second signature — none of these have moved money. */
    pendingCount: number;
    /** Counter-rows of reversals, shown and summed but never counted as corrections. */
    reversalCount: number;
  };
}

// Newest first: a correction book is read against memory, and the row just
// recorded is the one an operator checks first.
const byNewest = (a: AdjustmentRow, b: AdjustmentRow): number =>
  (b.day ?? '').localeCompare(a.day ?? '') || Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label);

export function buildAdjustmentsReport(rows: AdjustmentSourceRow[]): AdjustmentsReport {
  const listed: AdjustmentRow[] = [];
  const byBranch = new Map<string, { name: string | null; inCents: number; outCents: number; count: number }>();

  let totalIn = 0;
  let totalOut = 0;
  let pendingCount = 0;
  let reversalCount = 0;

  for (const row of rows) {
    const code = ADJUSTMENT_CODES.find((c) => c === String(row.txn_code ?? ''));
    // A row this report was not asked for is ignored rather than guessed at:
    // the route selects on the two codes, so anything else here is a caller's
    // mistake that must not land in a total.
    if (!code) continue;

    const isOut = code === 'adjustment_out';
    const signed = isOut ? -cents(row.amount) : cents(row.amount);
    if (isOut) totalOut += cents(row.amount);
    else totalIn += cents(row.amount);

    const role: AdjustmentRole = isReversalRow(row) ? 'reversal' : 'manual';
    if (role === 'reversal') reversalCount += 1;
    if (row.status === 'pending') pendingCount += 1;

    const branch = byBranch.get(row.branch_id)
      || { name: row.branch_name ?? null, inCents: 0, outCents: 0, count: 0 };
    if (isOut) branch.outCents += cents(row.amount);
    else branch.inCents += cents(row.amount);
    branch.count += 1;
    byBranch.set(row.branch_id, branch);

    listed.push({
      id: String(row.id ?? `${row.transaction_number ?? ''}:${row.transaction_date ?? ''}:${signed}`),
      code,
      label: LABEL[code],
      direction: DIRECTION[code],
      day: dayKey(row.transaction_date),
      amount: money(signed),
      branchId: row.branch_id,
      branchName: row.branch_name ?? null,
      accountName: row.account_name ?? null,
      status: row.status ?? null,
      transactionNumber: row.transaction_number === null || row.transaction_number === undefined
        ? null
        : String(row.transaction_number),
      referenceNumber: row.reference_number ?? null,
      payee: row.payee ?? null,
      description: row.description ?? null,
      recordedBy: row.recorded_by_username ?? null,
      role,
    });
  }

  listed.sort(byNewest);

  const branches: AdjustmentBranchLine[] = [...byBranch.entries()]
    .map(([branchId, b]) => ({
      branchId,
      name: b.name,
      in: money(b.inCents),
      out: money(b.outCents),
      net: money(b.inCents - b.outCents),
      count: b.count,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || (a.name ?? '').localeCompare(b.name ?? ''));

  return {
    rows: listed,
    branches,
    summary: {
      totalIn: money(totalIn),
      totalOut: money(totalOut),
      net: money(totalIn - totalOut),
      count: listed.length,
      pendingCount,
      reversalCount,
    },
  };
}

// The day a row is dated to, through the operating clock so a 23:30 posting
// reads as the day the operator worked rather than the UTC day it was written
// in. Null rather than invented when nothing readable is there.
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
