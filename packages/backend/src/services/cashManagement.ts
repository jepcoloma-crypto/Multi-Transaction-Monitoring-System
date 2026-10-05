// Shapes ledger rows into a Sources and Uses statement with a tie-out against
// account balances. Pure — no network, no database — so every bucket and
// subtotal is testable without one.
//
// The statement is built from ledger_entries rather than from the income
// report's figures on purpose. Fee income is not a separate credit anywhere in
// the ledger: a transfer posts one debit to the sender and one credit to the
// receiver, and the fee rides inside them. A statement that tried to reproduce
// totalIncome would therefore stop adding up to the balance it exists to
// explain.
//
// So the two answer different questions and are not expected to agree:
//   this one   — where did the cash physically move
//   income     — what did the company earn
//
// Because every ledger row lands in exactly one bucket, the tie-out holds by
// construction: opening + Σsources − Σuses = closing. If it ever does not,
// rows have been dropped or double-counted, which is what the check exposes.

export type CashBucket =
  | 'owner_capital'
  | 'transfers'
  | 'customer_cash'
  | 'load'
  | 'operating_expenses'
  | 'provider_charges'
  | 'payments'
  | 'other_income'
  | 'adjustments'
  | 'corrections'
  | 'other';

export const BUCKET_LABELS: Record<CashBucket, string> = {
  owner_capital: 'Owner Capital',
  transfers: 'Branch Transfers',
  customer_cash: 'Customer Cash',
  load: 'Load',
  operating_expenses: 'Operating Expenses',
  provider_charges: 'Provider Charges',
  payments: 'Payments & Bills',
  other_income: 'Other Income',
  adjustments: 'Adjustments',
  corrections: 'Corrections',
  other: 'Other',
};

const toCents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

// The movement codes where money can physically change hands, and so the only
// ones asked for a payment method. These are the codes the drawer gate keys on;
// every other type is money moving between accounts rather than through them.
export const CASH_MOVEMENT_CODES = [
  'cash_in',
  'cash_out',
  'customer_payment',
  'customer_withdrawal',
] as const;

// Everything the column may store, matching paymentMethodOptions on the client.
export const PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya', 'provider_interest'] as const;

// provider_interest is excluded from what a cash movement may carry: it
// describes where an interest credit came from, not how cash was handed over,
// and accepting it on a cash movement would record a method the operator could
// not have used.
export const MOVEMENT_PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type MovementPaymentMethod = (typeof MOVEMENT_PAYMENT_METHODS)[number];

export function isCashMovement(code: string | null | undefined): boolean {
  return (CASH_MOVEMENT_CODES as readonly string[]).includes(String(code));
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isMovementPaymentMethod(value: unknown): value is MovementPaymentMethod {
  return typeof value === 'string' && (MOVEMENT_PAYMENT_METHODS as readonly string[]).includes(value);
}

// The drawer participates only when the money is physically handed over. A
// GCash or bank movement lands in the wallet without passing through it, and
// giving those a drawer leg would double-count the same peso.
export function touchesDrawer(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === 'cash';
}

const money = (cents: number): number => cents / 100;

// A ledger row carries either a transaction (source_type 'transaction', with
// the type code reachable through it) or a non-transaction source such as a
// transfer, a loading operation, an admin balance edit or a gap fix. The
// transaction's type code is the more specific signal, so it wins whenever it
// is present — including for adjustment rows, which post through the same path
// as any other transaction even though their name suggests otherwise.
export function bucketFor(sourceType: string | null | undefined, txnCode: string | null | undefined): CashBucket {
  if (txnCode) {
    switch (txnCode) {
      case 'owner_funding':
      case 'owner_return':
        return 'owner_capital';
      case 'transfer_in':
      case 'transfer_out':
        return 'transfers';
      case 'cash_in':
      case 'cash_out':
      case 'customer_payment':
      case 'customer_withdrawal':
        return 'customer_cash';
      case 'load_purchase':
        return 'load';
      case 'operating_expense':
        return 'operating_expenses';
      case 'expense':
        return 'provider_charges';
      case 'service_fee':
      case 'bill_payment':
      case 'refund':
        return 'payments';
      case 'other_income':
      case 'refund_received':
        return 'other_income';
      case 'adjustment_in':
      case 'adjustment_out':
        return 'adjustments';
      default:
        return 'other';
    }
  }

  switch (sourceType) {
    case 'transfer':
      return 'transfers';
    case 'loading':
      return 'load';
    case 'adjustment':
      return 'adjustments';
    case 'gap_fix':
      return 'corrections';
    default:
      return 'other';
  }
}

export interface LedgerFlowRow {
  branch_id: string;
  entry_type: 'credit' | 'debit';
  amount: string | number;
  source_type: string | null;
  txn_code: string | null;
}

export interface BranchBalance {
  id: string;
  code: string;
  name: string;
  opening: string | number;
  current: string | number;
}

export interface BucketLine {
  bucket: CashBucket;
  label: string;
  amount: number;
  count: number;
}

export interface BranchStatement {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  sources: number;
  uses: number;
  closing: number;
  current: number;
}

export interface CashStatement {
  sources: BucketLine[];
  uses: BucketLine[];
  branches: BranchStatement[];
  totals: {
    opening: number;
    sources: number;
    uses: number;
    closing: number;
    current: number;
    difference: number;
    balanced: boolean;
  };
}

const sortByAmount = (a: BucketLine, b: BucketLine): number =>
  b.amount - a.amount || a.label.localeCompare(b.label);

export function buildCashStatement(rows: LedgerFlowRow[], branches: BranchBalance[]): CashStatement {
  const sourceCents = new Map<CashBucket, number>();
  const sourceCounts = new Map<CashBucket, number>();
  const useCents = new Map<CashBucket, number>();
  const useCounts = new Map<CashBucket, number>();

  const branchSources = new Map<string, number>();
  const branchUses = new Map<string, number>();

  for (const row of rows) {
    const bucket = bucketFor(row.source_type, row.txn_code);
    const cents = toCents(row.amount);
    const isCredit = row.entry_type === 'credit';

    const totals = isCredit ? sourceCents : useCents;
    const counts = isCredit ? sourceCounts : useCounts;
    totals.set(bucket, (totals.get(bucket) || 0) + cents);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);

    const perBranch = isCredit ? branchSources : branchUses;
    perBranch.set(row.branch_id, (perBranch.get(row.branch_id) || 0) + cents);
  }

  const sources: BucketLine[] = [...sourceCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: sourceCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const uses: BucketLine[] = [...useCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: useCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const branchStatements: BranchStatement[] = branches.map((branch) => {
    const opening = toCents(branch.opening);
    const branchSource = branchSources.get(branch.id) || 0;
    const branchUse = branchUses.get(branch.id) || 0;
    return {
      branchId: branch.id,
      code: branch.code,
      name: branch.name,
      opening: money(opening),
      sources: money(branchSource),
      uses: money(branchUse),
      closing: money(opening + branchSource - branchUse),
      current: toCents(branch.current) / 100,
    };
  });

  const sum = (pick: (b: BranchStatement) => number): number =>
    branchStatements.reduce((total, b) => total + toCents(pick(b)), 0);

  const opening = sum((b) => b.opening);
  const branchSourceTotal = sum((b) => b.sources);
  const branchUseTotal = sum((b) => b.uses);
  const closing = sum((b) => b.closing);
  const current = sum((b) => b.current);
  const difference = closing - current;

  return {
    sources,
    uses,
    branches: branchStatements,
    totals: {
      opening: money(opening),
      sources: money(branchSourceTotal),
      uses: money(branchUseTotal),
      closing: money(closing),
      current: money(current),
      difference: money(difference),
      // Only expected to be zero when the period reaches the present. A
      // statement covering a past window closes at its own end date and will
      // legitimately differ from today's balance.
      balanced: difference === 0,
    },
  };
}
