// The drawer's own ledger window. Two queries the cash-management screen and the
// shift report have to agree on, kept in one place so a shift's expected figure
// and the report that later audits it can never drift apart on what counts as
// "the drawer" or where its window starts and ends.
//
// The drawer is keyed on the branch's cash-type accounts rather than on one
// named account, because it is the branch's physical cash whether or not it
// happens to be split across two of them — and anything that touched physical
// cash has to be in the count.

import { query, queryOne } from '../database/connection';
import type { ShiftMovement } from './shifts';

// The window a shift's drawer covers, as `[from, to)`.
//
// `opened_at` is stamped with sub-second precision, but a transaction's
// `entry_date` carries only the minute the operator typed — the date field on
// the form has no seconds. Compared raw, a movement made in the opening minute
// reads as earlier than the shift itself and drops out of the drawer: the
// funding that sets the float, or the first payout of the day, would simply
// not count, and every figure derived from them (expected closing, variance,
// the report that audits both) would be wrong. So the window opens at the
// start of the opening minute, which belongs to the shift.
//
// The close stays exact. `closed_at` carries seconds too, movements are stamped
// at `:00`, and the upper bound only has to admit those — no widening needed.
export function drawerWindow(
  openedAt: string | Date,
  closedAt?: string | Date | null,
): { from: Date; to: Date } {
  const from = new Date(openedAt);
  // Flooring in UTC rather than local time: Manila and this host are both
  // whole-minute offsets, so they share minute boundaries and no zone is
  // named either way.
  from.setUTCSeconds(0, 0);
  const to = closedAt ? new Date(closedAt) : new Date();
  return { from, to };
}

export async function drawerMovements(
  branchId: string,
  openedAt: string | Date,
  closedAt?: string | Date | null,
): Promise<ShiftMovement[]> {
  const { from, to } = drawerWindow(openedAt, closedAt);
  return query<ShiftMovement>(
    `SELECT l.entry_type, l.amount
     FROM ledger_entries l
     JOIN accounts a ON a.id = l.account_id
     JOIN account_types ct ON ct.id = a.account_type_id
     WHERE ct.code = 'cash' AND a.branch_id = $1
       AND l.entry_date >= $2 AND l.entry_date < $3`,
    [branchId, from.toISOString(), to.toISOString()],
  );
}

export async function drawerBalance(branchId: string): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `SELECT COALESCE(SUM(a.current_balance), 0) AS balance
     FROM accounts a
     JOIN account_types t ON t.id = a.account_type_id
     WHERE t.code = 'cash' AND a.branch_id = $1`,
    [branchId],
  );
  const parsed = parseFloat(String(row?.balance ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}
