import { query } from '../database/connection';
import { settingNumber } from './settings';

export interface OverdueAccount {
  accountId: string;
  accountName: string;
  branchId: string | null;
  branchName: string | null;
  currentBalance: number;
  lastReconciledAt: string | null;
  /** Whole days since the last sign-off, or null when there has never been one. */
  daysSince: number | null;
}

export interface OverdueReconciliations {
  periodDays: number;
  accounts: OverdueAccount[];
}

const asNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const asNumberOrNull = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const asText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Active accounts whose last reconciliation is older than the configured
 * period, or which have never had one at all.
 *
 * Written once and used by both the alert pass and the cash dashboard. Two
 * spellings of "overdue" would let one screen call an account current while
 * the other beside it called it past due, and an operator would have no way to
 * tell which of them was lying.
 *
 * Only rows marked `reconciled` count. Creating a reconciliation leaves it
 * `matched` or `variance`, and applying an adjustment leaves it `adjusted` —
 * all three are work in progress. An account is past due until somebody signs
 * it off, which is the same line the alert has always drawn.
 *
 * The scope is passed in rather than taken from a request, because the alert
 * pass has no request: it runs on a schedule and answers for every branch,
 * while the dashboard answers only for the one it is scoped to.
 */
export const overdueReconciliations = async (
  scope: { clause: string | null; params: any[] } = { clause: null, params: [] },
): Promise<OverdueReconciliations> => {
  const periodDays = await settingNumber('reconciliation_period_days', 30);

  // $1 is the period; the caller's scope starts at $2 and is numbered by
  // whoever built it, so `branchClause` has to be handed 2 as its first index.
  // Postgres binds by placeholder number rather than by where it appears, so
  // the scope condition may sit anywhere in the text and still take the right
  // values.
  const rows = await query<{
    id: string;
    name: string;
    branch_id: string | null;
    branch_name: string | null;
    current_balance: unknown;
    last_reconciled_at: unknown;
    days_since: unknown;
  }>(
    `SELECT a.id, a.name, a.branch_id, br.name AS branch_name, a.current_balance,
            MAX(r.created_at) AS last_reconciled_at,
            EXTRACT(EPOCH FROM (NOW() - MAX(r.created_at))) / 86400 AS days_since
     FROM accounts a
     LEFT JOIN branches br ON br.id = a.branch_id
     LEFT JOIN reconciliations r ON a.id = r.account_id AND r.status = 'reconciled'
     WHERE a.status = 'active' ${scope.clause ? `AND ${scope.clause}` : ''}
     GROUP BY a.id, a.name, a.branch_id, br.name, a.current_balance
     HAVING MAX(r.created_at) IS NULL
         OR EXTRACT(EPOCH FROM (NOW() - MAX(r.created_at))) / 86400 > $1
     -- Never reconciled first: an account with no sign-off at all has been
     -- silent longer than one that stopped a month ago. Then by how much is
     -- unverified, because the account holding real money outranks six that
     -- hold nothing — alphabetical put the ₱31,880 second, indistinguishable
     -- from the dormant rows around it, and the sort is the only thing
     -- standing between an operator and a list they have to read twice.
     ORDER BY days_since DESC NULLS FIRST, a.current_balance DESC, a.name`,
    [periodDays, ...scope.params],
  );

  return {
    periodDays,
    accounts: rows.map((row) => {
      const days = asNumberOrNull(row.days_since);
      return {
        accountId: row.id,
        accountName: row.name,
        branchId: asText(row.branch_id),
        branchName: asText(row.branch_name),
        currentBalance: asNumber(row.current_balance),
        lastReconciledAt: asText(row.last_reconciled_at),
        // Rounded up for display. The comparison above keeps the exact
        // fraction, so an account at 30.2 days past a 30-day period is listed
        // — but floored it would read "30 days", the same figure as the period
        // it has just failed. Rounded up it reads 31, which is the truth and
        // cannot be mistaken for being on time.
        daysSince: days === null ? null : Math.ceil(days),
      };
    }),
  };
};
