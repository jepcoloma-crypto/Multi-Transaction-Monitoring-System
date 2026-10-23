// Branch cash position — where the company's cash actually is, right now.
//
// Every other cash report answers a period: what moved, what was spent, what a
// shift counted. This one answers the question asked at the start of a day and
// before a close — "what is in the tills" — so it is a snapshot, not a range.
// It has no date window on purpose: opening float and expected closing are
// live shift figures, a counted closing belongs to the shift that settled it,
// and the drawer balance is what the ledger says this instant.
//
// The drawer account is identified by its type, not its name (D29): a branch
// can have exactly one open cash account and legacy cash beyond it. `frozen`
// money — cash on the books but no longer in anyone's hands — is reported
// beside, never inside, the countable till, the same split the statement makes
// (`splitCashRows`). A branch with no cash account at all — Reina Mercedes,
// whose drawer has never been tracked — appears with its state rather than
// vanishing, because an empty row is how the report answers "why is this
// branch not in the total".
//
// Pure: the route reads the accounts, shifts and variance counts, this decides
// what they mean.

const money = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

export interface CashPositionBranch {
  branchId: string;
  name: string | null;
  /** The branch's drawer account, or null when no cash account is tracked. */
  drawerAccountId: string | null;
  drawerAccountName: string | null;
  drawerBalance: number | null;
  /** True when the drawer balance includes cash a shift has already handed back. */
  hasOpenShift: boolean;
  shiftDate: string | null;
  openingFloat: number | null;
  expectedClosing: number | null;
  openedBy: string | null;
  /** The most recent settled shift, if any. */
  lastCountedClosing: number | null;
  lastVariance: number | null;
  lastShiftDate: string | null;
  /** Shifts closed with a variance nobody has answered for yet. */
  unresolvedVarianceCount: number;
  frozenBalance: number | null;
}

export interface CashPositionReport {
  branches: CashPositionBranch[];
  summary: {
    /** The countable tills: every drawer's ledger balance. */
    totalDrawerBalance: number;
    /** Branches with a shift open right now. */
    openShiftCount: number;
    unresolvedVarianceCount: number;
    /** Branches with no cash account at all — never inside the total above. */
    untrackedCount: number;
  };
}

// Biggest till first: the branch holding the most cash is where a question
// about cash is likeliest to start. Ties break alphabetically.
const byBalance = (a: CashPositionBranch, b: CashPositionBranch): number =>
  (b.drawerBalance ?? 0) - (a.drawerBalance ?? 0) || (a.name ?? '').localeCompare(b.name ?? '');

export function buildCashPositionReport(branches: CashPositionBranch[]): CashPositionReport {
  let totalDrawer = 0;
  let openShifts = 0;
  let unresolved = 0;
  let untracked = 0;

  for (const branch of branches) {
    if (branch.drawerAccountId === null) {
      untracked += 1;
      continue;
    }
    totalDrawer += branch.drawerBalance ?? 0;
    if (branch.hasOpenShift) openShifts += 1;
    unresolved += branch.unresolvedVarianceCount;
  }

  const ordered = [...branches].sort(byBalance);

  return {
    branches: ordered,
    summary: {
      totalDrawerBalance: money(totalDrawer),
      openShiftCount: openShifts,
      unresolvedVarianceCount: unresolved,
      untrackedCount: untracked,
    },
  };
}
