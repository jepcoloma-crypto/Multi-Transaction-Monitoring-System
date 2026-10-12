// The drawer's own questions, both asked here so the cash-management screen,
// the shift report and the entry route can never answer them differently.
//
// Two questions, two answers — and neither answer is generalized to the other:
//
//   Movements — did physical cash move? — key on the branch's cash-type
//   accounts, because cash is cash whether or not the books happen to split it
//   across two of them, and anything that touched physical cash has to be in
//   the count.
//
//   Balances — what does the drawer hold right now? — key on the branch's
//   Drawer: its oldest OPEN cash account, the very account the entry route
//   writes a movement's drawer leg to. A till is counted against one account,
//   and a report that summed a second one (the legacy Revolving Fund, once
//   cutover freezes it) would tell an operator to expect cash nobody can hand
//   over. See `drawerFlagSql`, `splitCashRows` and `drawerBalance`.
//
// `drawerMovementRows` is the first question; everything else here is the
// second. The window itself is discussed where it is defined, below.

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
  // The transaction's status, and the row that undid it where one was posted.
  // A movement inside a shift's window can have been given back — the posting
  // happened and still counts, because the reversal is a second posting in the
  // same window — and a reader checking the expected figure should see that
  // rather than be left to notice that two rows cancel.
  transaction_status: string | null;
  reversed_by_number: number | null;
  reversed_by_at: string | null;
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
            t.transaction_number, t.payee, tt.code AS txn_code,
            t.status AS transaction_status,
            rev.transaction_number AS reversed_by_number, rev.created_at AS reversed_by_at
     FROM ledger_entries l
     JOIN accounts a ON a.id = l.account_id
     JOIN account_types ct ON ct.id = a.account_type_id
     LEFT JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
     -- The row that undid this one, found by the reference every reversal
     -- carries ("REV-" + its number). Gated on the status so a completed row
     -- can never be linked to a namesake, and LEFT so a reversed row whose
     -- reversal predates that convention still shows as reversed.
     LEFT JOIN transactions rev
            ON t.status = 'reversed' AND rev.reference_number = 'REV-' || t.transaction_number
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

/**
 * The Drawer, as one SQL expression every balance figure wraps in a subquery:
 * true when a cash-account row is its branch's oldest OPEN cash account.
 *
 * Deliberately the posting rule's rule — `resolveDrawerLeg` picks its target
 * by the same status and the same order — so the account a movement's drawer
 * leg lands on, the balance a shift closes against and the Cash on hand line
 * are the same account by construction. `status <> 'closed'` is what makes
 * cutover a data change and not a code change: the moment the legacy Revolving
 * Fund is frozen, every balance figure moves to the new Drawer with this
 * predicate untouched.
 *
 * Written once because three rewordings of "the drawer" is exactly how a till
 * count and the report that audits it end up naming different accounts and
 * disagreeing by a whole balance. Window expressions cannot sit in a WHERE, so
 * callers select it as a column in a subquery and filter outside — which also
 * lets a query keep rows of both kinds when it needs to show them separately
 * (`splitCashRows`).
 */
export function drawerFlagSql(alias: string): string {
  return (
    `${alias}.status <> 'closed' AND ` +
    `ROW_NUMBER() OVER (PARTITION BY ${alias}.branch_id, ${alias}.status <> 'closed' ` +
    `ORDER BY ${alias}.created_at ASC) = 1`
  );
}

export interface ClassifiedCashRow {
  name: string;
  balance: string | number;
  is_drawer: boolean;
}

export interface CashSplit {
  /** What the branch can count out of a drawer: its Drawers' balances. */
  drawer: number;
  drawerAccounts: string;
  /** Cash that is not the till — the frozen legacy line after cutover. */
  frozen: number;
  frozenAccounts: string;
}

/**
 * The two halves of a scope's cash accounts: its Drawers and everything else.
 *
 * `is_drawer` comes from `drawerFlagSql`; this only adds up what the SQL
 * classified, in cents so fractional balances cannot drift, and keeps the
 * account-name lists the statement prints beside each figure (distinct,
 * alphabetical, the way the old `string_agg(DISTINCT ... ORDER BY)` printed
 * them). The halves partition the rows exactly — drawer + frozen is every cash
 * peso in scope, so either figure still reconciles against the account total
 * the way D14 requires.
 *
 * Before cutover the frozen half is empty: one open cash account per branch
 * and none closed, as the production check that accompanied this change
 * confirmed. After cutover it is the Legacy Revolving Fund's line.
 */
export function splitCashRows(rows: ClassifiedCashRow[]): CashSplit {
  let drawerCents = 0;
  let frozenCents = 0;
  const drawerNames = new Set<string>();
  const frozenNames = new Set<string>();
  for (const row of rows) {
    const parsed = parseFloat(String(row.balance));
    const cents = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
    if (row.is_drawer) {
      drawerCents += cents;
      drawerNames.add(row.name);
    } else {
      frozenCents += cents;
      frozenNames.add(row.name);
    }
  }
  const names = (set: Set<string>) => [...set].sort().join(', ');
  return {
    drawer: drawerCents / 100,
    drawerAccounts: names(drawerNames),
    frozen: frozenCents / 100,
    frozenAccounts: names(frozenNames),
  };
}

export async function drawerBalance(branchId: string): Promise<number> {
  // The Drawer's own balance, not the branch's cash accounts added together:
  // the three callers (a shift's live check, its opening cross-check and its
  // closing) stand this figure against a counted float, and a float is counted
  // in one till. Until cutover the two readings coincide — one open cash
  // account per branch, none closed — which is precisely when the rule can be
  // pointed at the right account without anyone seeing a figure move.
  const row = await queryOne<{ balance: string | null }>(
    `SELECT balance FROM (
       SELECT a.current_balance AS balance, ${drawerFlagSql('a')} AS is_drawer
       FROM accounts a
       JOIN account_types t ON t.id = a.account_type_id
       WHERE t.code = 'cash' AND a.branch_id = $1
     ) d
     WHERE d.is_drawer`,
    [branchId],
  );
  const parsed = parseFloat(String(row?.balance ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}
