import { api } from './api';

// Only the components the shift panel prints are declared; the endpoint sends
// the whole report summary so the panel and the report stay one payload, and a
// narrower type here keeps the render honest about what it actually reads.
export interface ShiftActivityBranch {
  branchId: string;
  branchName: string;
  shiftDate: string;
  income: {
    txnFees: number;
    loadMargin: number;
    totalIncome: number;
  };
  expense: {
    serviceFees: number;
    providerCharges: number;
    operatingExpenses: number;
    totalExpense: number;
  };
}

export interface ShiftActivity {
  shiftDates: string[];
  branches: ShiftActivityBranch[];
  totals: {
    income: { txnFees: number; loadMargin: number; total: number };
    expense: { serviceFees: number; providerCharges: number; operatingExpenses: number; total: number };
    net: number;
  };
}

/**
 * Income and expense for the business day the open shift belongs to.
 *
 * The period is the shift's own, never a filter the client is allowed to
 * invent (D18), so the only thing that narrows it is the branch — the same
 * narrowing the statement uses, which is why the two panels cannot describe
 * different places.
 *
 * Advisory rather than fatal. With no shift open the endpoint answers with an
 * empty set anyway, and a panel that failed to load should read as "nothing
 * to show" rather than taking the cash position down with it — so a failure
 * resolves to `null` instead of throwing, and the caller only owns its
 * loading flag.
 */
export const fetchShiftActivity = async (branchId?: string): Promise<ShiftActivity | null> => {
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  const qs = params.toString();
  try {
    return await api.get<ShiftActivity>(`/reports/shift-activity${qs ? `?${qs}` : ''}`);
  } catch {
    return null;
  }
};
