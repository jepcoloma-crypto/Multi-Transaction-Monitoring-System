// Shapes owner fund movements into the "Add Funds" report. Pure — no network,
// no database — so the totals that say how much the owner put in or took out
// are testable without one.
//
// The report covers the two controlled types, `owner_funding` and
// `owner_return`, and covers every one that has settled. Settled is the point:
// a pending request has moved no money and belongs on the approver's queue,
// not on a report whose totals describe the accounts. Rows that were refused
// are likewise out — the report says what happened to the books, and a
// rejection happened to nothing.
//
// `approved_by` is deliberately nullable in the output. An administrator
// recording an owner movement settles it at once with no second signature, and
// a report that printed an empty approver would read as a missing join rather
// than as what actually happened. `settled_directly` carries that distinction
// so the screen can name it.
//
// The settled amount is net_amount plus any additional charges, matching the
// arithmetic the approval path itself performs before it moves the money. A
// report summing a different figure than the ledger did would be a second
// definition of what an owner movement cost.
//
// Totals are accumulated in whole centavos, for the same reason the shift
// report does: a total a centavo off from its own rows is a total nobody
// trusts.

const NUMERIC = /^-?\d+(\.\d+)?$/;

const toCents = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  return NUMERIC.test(trimmed) ? Math.round(Number(trimmed) * 100) : 0;
};

const money = (cents: number): number => cents / 100;

const asText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const asDate = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
};

const asCountOrNull = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const chargeCents = (raw: unknown): number => {
  if (!Array.isArray(raw)) return 0;
  let total = 0;
  for (const item of raw) {
    const amount = (item as { amount?: unknown } | null)?.amount;
    if (typeof amount === 'string' && NUMERIC.test(amount.trim())) total += Math.round(Number(amount.trim()) * 100);
    else if (typeof amount === 'number' && Number.isFinite(amount)) total += Math.round(amount * 100);
  }
  return total;
};

export type OwnerFundKind = 'funding' | 'return';

export interface OwnerFundSourceRow {
  id: string;
  transaction_number: number | string;
  kind: string | null;
  net_amount: number | string;
  additional_charges?: unknown;
  status: string | null;
  payment_method?: string | null;
  reference_number?: string | null;
  description?: string | null;
  notes?: string | null;
  transaction_date?: unknown;
  created_at?: unknown;
  account_id?: string | null;
  account_name?: string | null;
  branch_id?: string | null;
  branch_code?: string | null;
  branch_name?: string | null;
  requested_by?: string | null;
  approved_by?: string | null;
  approval_audit_actor?: string | null;
  approved_at?: unknown;
}

export interface OwnerFundRow {
  id: string;
  transactionNumber: number;
  kind: OwnerFundKind;
  amount: number;
  status: string | null;
  paymentMethod: string | null;
  referenceNumber: string | null;
  description: string | null;
  notes: string | null;
  transactionDate: string | null;
  requestedAt: string | null;
  accountId: string | null;
  accountName: string | null;
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  // True when no approver is named because an administrator recorded the
  // movement and it settled immediately, with nobody to sign off a second time.
  settledDirectly: boolean;
}

export interface OwnerFundSummary {
  movements: number;
  fundedCount: number;
  returnedCount: number;
  totalFunded: number;
  totalReturned: number;
  // What the owner's money netted across the accounts in range. Signed: a
  // period where returns exceeded funding is negative, and saying so plainly
  // is more use than reporting the two sides with the sign left off.
  netToAccounts: number;
  accountsTouched: number;
  // Movements an administrator settled without a second signature, so the
  // headline can say how much of the period's money never crossed a queue.
  settledDirectly: number;
  settledDirectlyAmount: number;
}

export interface OwnerFundReport {
  movements: OwnerFundRow[];
  summary: OwnerFundSummary;
}

// `owner_funding` adds money to an account, `owner_return` takes it back out.
// Anything else reaching here is a type the caller already filtered, so it is
// treated as a funding row rather than dropped: silently omitting a row would
// make the totals disagree with the count printed above them.
const asKind = (code: unknown): OwnerFundKind => (code === 'owner_return' ? 'return' : 'funding');

// Whether the row is the owner's own money. A provider's interest credit is
// booked under the `owner_funding` type code and told apart only by its
// payment method (2292e91), so the code alone would report the provider's
// money as the owner's — naming a provider as someone who put cash in. The
// statement already counts the same row as other income, so leaving it in
// here would put Owner Capital at odds with the report sitting beside it.
//
// Judged here rather than left to the caller's WHERE clause because this is
// what the report means, and the payment method is the only field that can
// say it. Dropped before the map, not inside it, so the count printed above
// the totals is the same set the totals were summed from.
const isOwnerMoney = (row: OwnerFundSourceRow): boolean =>
  asText(row.payment_method) !== 'provider_interest';

export function buildOwnerFundReport(rows: OwnerFundSourceRow[]): OwnerFundReport {
  const owned = rows.filter(isOwnerMoney);
  let fundedCents = 0;
  let returnedCents = 0;
  let directCents = 0;
  let fundedCount = 0;
  let returnedCount = 0;
  let settledDirectly = 0;
  const accounts = new Set<string>();

  const movements = owned.map((row) => {
    const kind = asKind(row.kind);
    // Charges ride with the amount because that is the figure the approval path
    // posts to the account. Reporting net alone would understate what moved.
    const cents = toCents(row.net_amount) + chargeCents(row.additional_charges);
    const amount = money(cents);

    if (kind === 'return') { returnedCents += cents; returnedCount += 1; }
    else { fundedCents += cents; fundedCount += 1; }

    // An approver's name is the username on the approval column, falling back
    // to whoever signed the audit entry. Both are read rather than one, because
    // the column is written by the approval route while the audit row is written
    // alongside it, and either can be the one that survives a later correction.
    const approvedBy = asText(row.approved_by) ?? asText(row.approval_audit_actor);
    const directly = approvedBy === null;
    if (directly) { settledDirectly += 1; directCents += cents; }

    if (row.account_id) accounts.add(row.account_id);

    return {
      id: row.id,
      transactionNumber: asCountOrNull(row.transaction_number) ?? 0,
      kind,
      amount,
      status: asText(row.status),
      paymentMethod: asText(row.payment_method),
      referenceNumber: asText(row.reference_number),
      description: asText(row.description),
      notes: asText(row.notes),
      transactionDate: asDate(row.transaction_date),
      requestedAt: asDate(row.created_at),
      accountId: asText(row.account_id),
      accountName: asText(row.account_name),
      branchId: asText(row.branch_id),
      branchCode: asText(row.branch_code),
      branchName: asText(row.branch_name),
      requestedBy: asText(row.requested_by),
      approvedBy,
      approvedAt: asDate(row.approved_at),
      settledDirectly: directly,
    } satisfies OwnerFundRow;
  });

  return {
    movements,
    summary: {
      movements: movements.length,
      fundedCount,
      returnedCount,
      totalFunded: money(fundedCents),
      totalReturned: money(returnedCents),
      netToAccounts: money(fundedCents - returnedCents),
      accountsTouched: accounts.size,
      settledDirectly,
      settledDirectlyAmount: money(directCents),
    },
  };
}
