// The integrity report's shape, and where a finding sends you next (design IC2).
//
// A finding says two surfaces disagree — it cannot say which one is wrong, and
// correcting today's ₱20 needed a policy decision (D46) before anybody could
// know. So the bridge is deliberately narrow: where an existing correction path
// can justify the fix, name the tool that owns it and let an administrator
// confirm there with a reason and a preview. Where none applies, name nothing.
// A tool that guessed would have moved the money the wrong way with output that
// looked identical to a correct fix, which is the same class of error the
// correction exists to repair.

export interface IntegrityFinding {
  transactionNumber: number | null;
  referenceNumber: string | null;
  direction: string | null;
  amount: number | null;
  fee: number | null;
  /** What the check says should have been there. */
  expected: number | null;
  /** What the ledger actually holds. */
  actual: number | null;
  detail: string;
}

export interface IntegrityCheck {
  id: string;
  title: string;
  /** What the check asserts, stated so a reader can disagree with it. */
  states: string;
  status: 'pass' | 'findings';
  checked: number;
  summary: string;
  findings: IntegrityFinding[];
}

export interface IntegrityReport {
  checks: IntegrityCheck[];
  ranAt: string;
  movements: number;
  clean: boolean;
}

export interface FixerRoute {
  href: string;
  label: string;
  hint: string;
}

const FIXERS: Record<string, FixerRoute> = {
  'till-income': {
    href: '/fee-audit',
    label: 'Fee re-post',
    hint: 'Moves a fee between the customer and the till, as delta rows with a reason.',
  },
  'fee-placement': {
    href: '/fee-audit',
    label: 'Fee re-post',
    hint: 'Re-posts the fee to the side its tender names, appending the difference.',
  },
  'net-amount': {
    href: '/amount-corrections',
    label: 'Amount correction',
    hint: "Brings a record back in line with the rows it actually wrote.",
  },
};

/** The correction tool a finding bridges to, or null when none can be justified. */
export const fixerFor = (checkId: string): FixerRoute | null => FIXERS[checkId] ?? null;

export const totalFindings = (report: IntegrityReport): number =>
  report.checks.reduce((n, c) => n + c.findings.length, 0);

/** The first check worth opening when the report lands: the one that disagrees. */
export const firstDisagreeing = (report: IntegrityReport): string | null =>
  report.checks.find((c) => c.status === 'findings')?.id ?? null;

export const directionLabel = (direction: string | null): string =>
  direction === 'in'
    ? 'Cash-In'
    : direction === 'out'
      ? 'Cash-Out'
      : direction === 'adjustment'
        ? 'Adjustment'
        : 'Movement';
