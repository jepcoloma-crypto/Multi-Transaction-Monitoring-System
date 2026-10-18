import { api } from './api';

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

export interface ReconciliationStatus {
  periodDays: number;
  accounts: OverdueAccount[];
}

/**
 * Accounts this branch has let slip past their reconciliation period.
 *
 * Advisory rather than fatal, for the same reason the shift panel is. A page
 * that could not read this list should not take the cash position down with
 * it, and an operator should still see their drawer figures whether or not
 * this answered — so a failure resolves to `null` rather than throwing, and
 * the caller owns only its own loading state.
 *
 * The `null` is worth keeping distinct from an empty list on the screen too:
 * "nobody is overdue" and "we could not tell" are different facts, and a
 * dashboard that printed both as "all clear" would be lying in one of them.
 *
 * The endpoint is `/reconciliations`, plural — the page is `/reconciliation`,
 * singular, and the two are easy to cross. Getting it wrong here 404s, which
 * this catch turns into `null`, which hides the card; the failure is silent by
 * design and so has to be avoided rather than noticed.
 */
export const fetchOverdueReconciliations = async (branchId?: string): Promise<ReconciliationStatus | null> => {
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  const qs = params.toString();
  try {
    return await api.get<ReconciliationStatus>(`/reconciliations/overdue${qs ? `?${qs}` : ''}`);
  } catch {
    return null;
  }
};
