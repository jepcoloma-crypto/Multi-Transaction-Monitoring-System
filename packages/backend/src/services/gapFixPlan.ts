// Pure gap-fix planner — no database, no network, so the propose endpoint, the
// approve gate and unit tests all agree on what closing a given gap writes
// (AGENTS.md architecture rule 1).

import type { AccountAudit } from './ledgerAudit';

export type GapFixDirection = 'record_entry' | 'adjust_balance';

export const GAP_FIX_DIRECTIONS: readonly string[] = ['record_entry', 'adjust_balance'];

export const GAP_FIX_LABELS: Record<GapFixDirection, string> = {
  record_entry: 'the balance is right, the ledger is missing the entry that explains it',
  adjust_balance: 'the ledger is right, the account balance is wrong',
};

export interface GapFixPlan {
  direction: GapFixDirection;
  /** expected − current: negative means the balance exceeds what the ledger explains. */
  gap: number;
  amount: number;
  /** Only set for record_entry; adjust_balance writes no ledger row. */
  entryType: 'credit' | 'debit' | null;
  /** balance_after of the appended row — always the untouched account balance. */
  balanceAfter: number | null;
  /** Only set for adjust_balance: the balance the ledger already implies. */
  newBalance: number | null;
  problems: string[];
}

export function isGapFixDirection(value: unknown): value is GapFixDirection {
  return typeof value === 'string' && GAP_FIX_DIRECTIONS.includes(value);
}

// A gap fix can only close the balance disagreement. It is worth attempting when
// the disagreement is the account's sole defect, which means the ledger chain has
// to be internally sound and has to terminate where it says it should — otherwise
// no choice of direction leaves the account reconciling afterwards.
function ledgerIsCoherent(audit: AccountAudit, problems: string[]): void {
  if (audit.chainBreaks > 0) {
    problems.push(`${audit.chainBreaks} broken chain link(s) — a gap fix closes the balance, it does not repair the chain`);
  }
  if (audit.negativeBalances > 0) {
    problems.push(`${audit.negativeBalances} negative balance row(s) — a gap fix would leave them in place`);
  }

  const terminal = audit.lastLedgerBalance ?? audit.openingBalance;
  if (terminal !== audit.expectedBalance) {
    problems.push(
      `the ledger ends at ${terminal.toFixed(2)} but opening balance plus movement expects ` +
        `${audit.expectedBalance.toFixed(2)} — the chain disagrees with itself, which a gap fix cannot settle`
    );
  }
}

export function planGapFix(audit: AccountAudit, direction: string): GapFixPlan {
  const problems: string[] = [];

  if (!isGapFixDirection(direction)) {
    problems.push(`unknown direction "${direction}" — expected one of ${GAP_FIX_DIRECTIONS.join(', ')}`);
  }
  if (!Number.isFinite(audit.gap)) {
    problems.push('the account balance could not be read');
  } else if (audit.gap === 0) {
    problems.push('this account has no balance gap to fix');
  } else {
    ledgerIsCoherent(audit, problems);
  }

  const gap = Number.isFinite(audit.gap) ? audit.gap : 0;
  const amount = Math.abs(gap);
  const plan: GapFixPlan = {
    direction: (isGapFixDirection(direction) ? direction : 'record_entry') as GapFixDirection,
    gap,
    amount,
    entryType: null,
    balanceAfter: null,
    newBalance: null,
    problems,
  };

  if (problems.length > 0 || !isGapFixDirection(direction)) return plan;

  if (direction === 'record_entry') {
    // The appended row has to land exactly on the balance that is already there,
    // so the chain link and the gap close with one and the same signed amount.
    plan.entryType = gap < 0 ? 'credit' : 'debit';
    plan.balanceAfter = audit.currentBalance;
    if (plan.balanceAfter < 0) {
      plan.problems.push('the entry would be appended to a negative account balance');
    }
  } else {
    plan.newBalance = audit.expectedBalance;
    if (plan.newBalance < 0) {
      plan.problems.push('the fix would take the account below zero');
    }
  }

  return plan;
}
