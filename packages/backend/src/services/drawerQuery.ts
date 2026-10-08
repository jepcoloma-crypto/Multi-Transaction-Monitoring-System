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
// Bounded by when a row was **posted** (`ledger_entries.created_at`), not by the
// business day it files under (`entry_date`). A shift is a physical span — the
// drawer opens at an instant and cash leaves it when a row is written — while
// `entry_date` is an accounting attribution picked from a date field that need
// not fall inside that span at all. The shift this was found on was opened on
// 8 October for the 25 September business day, so every movement it made was
// stamped 25 September and a window over `entry_date` counted none of them: the
// shift showed an expected figure equal to its raw opening float and would have
// closed reporting a shortage of everything it had paid out. Two readings only
// cross-check if they measure the same thing (design D16).
//
// Both bounds are exact. `created_at` is stamped by the database with sub-second
// precision, so there is no minute to widen over — and widening would be wrong
// here. That shift opened 9.7 seconds after the funding that set its float, and
// a window starting at the top of that minute would admit the funding as a
// movement on top of the count that already includes it.
export function drawerWindow(
  openedAt: string | Date,
  closedAt?: string | Date | null,
): { from: Date; to: Date } {
  return {
    from: new Date(openedAt),
    to: closedAt ? new Date(closedAt) : new Date(),
  };
}

// One cash row as the drawer lists it: `entry_type` and `amount` are what the
// expected figure is computed from, the rest is what the screen shows against it.
export interface DrawerRow extends ShiftMovement {
  id: string;
  entry_date: string;
  created_at: string;
  balance_after: string | number;
  source_type: string | null;
  reference_number: string | null;
  description: string | null;
  account_name: string;
  transaction_number: number | null;
  payee: string | null;
  txn_code: string | null;
}

/**
 * Every cash row posted inside the shift's window, in posting order.
 *
 * The one query behind both the arithmetic and the list that explains it: the
 * movements `expectedClosing` sums and the rows shown under it are read
 * together, so the two can never disagree about which rows a figure came from.
 * The header's promise that these are kept in one place is only true if there
 * is one of them.
 */
export async function drawerMovementRows(
  branchId: string,
  openedAt: string | Date,
  closedAt?: string | Date | null,
): Promise<DrawerRow[]> {
  const { from, to } = drawerWindow(openedAt, closedAt);
  return query<DrawerRow>(
    `SELECT l.id, l.entry_date, l.created_at, l.entry_type, l.amount, l.balance_after,
            l.source_type, l.reference_number, l.description, a.name AS account_name,
            t.transaction_number, t.payee, tt.code AS txn_code
     FROM ledger_entries l
     JOIN accounts a ON a.id = l.account_id
     JOIN account_types ct ON ct.id = a.account_type_id
     LEFT JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
     WHERE ct.code = 'cash' AND a.branch_id = $1
       AND l.created_at >= $2 AND l.created_at < $3
     ORDER BY l.created_at, l.id`,
    [branchId, from.toISOString(), to.toISOString()],
  );
}

export async function drawerMovements(
  branchId: string,
  openedAt: string | Date,
  closedAt?: string | Date | null,
): Promise<ShiftMovement[]> {
  const rows = await drawerMovementRows(branchId, openedAt, closedAt);
  return rows.map(({ entry_type, amount }) => ({ entry_type, amount }));
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
