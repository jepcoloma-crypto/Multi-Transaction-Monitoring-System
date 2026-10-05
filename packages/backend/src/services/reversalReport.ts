// Shapes raw reversal rows into the payload the reversal report and its CSV
// export both render. Pure — no network, no Prisma — so the totals and the
// reason/actor fallbacks are testable without a database.

const NUMERIC = /^-?\d+(\.\d+)?$/;
const REVERSAL_PREFIX = /^Reversal:\s*/;

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

const reasonFromDescription = (description: unknown): string | null => {
  const text = asText(description);
  if (!text) return null;
  const stripped = text.replace(REVERSAL_PREFIX, '').trim();
  return stripped === '' ? null : stripped;
};

// A reversal records its reason in a different place depending on how it ran:
// an approved request carries its own, a direct administrator reversal only
// writes the audit entry, and the compensating entry's description is the last
// surviving copy. Anything reading a reversal's reason needs this order.
export function reversalReason(
  requestReason: unknown,
  auditReason: unknown,
  description: unknown,
): string | null {
  return asText(requestReason) ?? asText(auditReason) ?? reasonFromDescription(description);
}

export interface ReversalSourceRow {
  id: string;
  transaction_number: number | string;
  amount: number | string;
  net_amount: number | string;
  additional_charges?: unknown;
  reference_number?: string | null;
  description?: string | null;
  transaction_date?: unknown;
  type_name?: string | null;
  direction?: string | null;
  account_name?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  created_by?: string | null;
  reversal_id?: string | null;
  reversal_number?: number | string | null;
  reversal_amount?: number | string | null;
  reversed_at?: unknown;
  reversal_description?: string | null;
  original_entry_type?: string | null;
  reversal_entry_type?: string | null;
  ledger_amount?: number | string | null;
  ledger_balance_after?: number | string | null;
  request_status?: string | null;
  reason?: string | null;
  audit_reason?: string | null;
  requested_by?: string | null;
  approved_by?: string | null;
  audit_actor?: string | null;
  requested_at?: unknown;
  decided_at?: unknown;
}

export interface ReversalRequestSourceRow {
  id: string;
  entity_type: string;
  entity_id: string;
  transaction_number?: number | string | null;
  account_name?: string | null;
  branch_id?: string | null;
  branch_name?: string | null;
  status: string;
  reversal_amount: number | string;
  reason?: string | null;
  requested_by?: string | null;
  approved_by?: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface ReversalReportRow {
  id: string;
  transactionNumber: number;
  accountName: string | null;
  branchId: string | null;
  branchName: string | null;
  typeName: string | null;
  direction: string | null;
  originalAmount: number;
  chargesAmount: number;
  originalTotal: number;
  reversedAmount: number | null;
  reversalNumber: number | null;
  reversedAt: string | null;
  originalEntryType: string | null;
  reversalEntryType: string | null;
  ledgerAmount: number | null;
  ledgerBalanceAfter: number | null;
  reason: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  reversedBy: string | null;
  requestStatus: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  createdBy: string | null;
  referenceNumber: string | null;
  transactionDate: string | null;
  hasCompensatingEntry: boolean;
}

export interface ReversalRequestReportRow {
  id: string;
  entityType: string;
  entityId: string;
  transactionNumber: number | null;
  accountName: string | null;
  branchId: string | null;
  branchName: string | null;
  status: string;
  amount: number;
  reason: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
}

export interface ReversalSummary {
  reversedCount: number;
  originalTotal: number;
  reversedTotal: number;
  requestCount: number;
  pendingRequests: number;
  approvedRequests: number;
  rejectedRequests: number;
  pendingRequestAmount: number;
}

export interface ReversalReport {
  reversals: ReversalReportRow[];
  requests: ReversalRequestReportRow[];
  summary: ReversalSummary;
}

export function buildReversalReport(
  reversalRows: ReversalSourceRow[],
  requestRows: ReversalRequestSourceRow[],
): ReversalReport {
  let originalCents = 0;
  let reversedCents = 0;

  const reversals = reversalRows.map((row) => {
    const chargesCents = chargeCents(row.additional_charges);
    const originalCentsForRow = toCents(row.net_amount) + chargesCents;
    originalCents += originalCentsForRow;

    const hasEntry = asText(row.reversal_id) !== null;
    const rowReversedCents = hasEntry ? toCents(row.reversal_amount) : 0;
    reversedCents += rowReversedCents;

    const requestedBy = asText(row.requested_by);
    const approvedBy = asText(row.approved_by);
    const auditActor = asText(row.audit_actor);

    return {
      id: row.id,
      transactionNumber: asCountOrNull(row.transaction_number) ?? 0,
      accountName: asText(row.account_name),
      branchId: asText(row.branch_id),
      branchName: asText(row.branch_name),
      typeName: asText(row.type_name),
      direction: asText(row.direction),
      originalAmount: money(toCents(row.net_amount)),
      chargesAmount: money(chargesCents),
      originalTotal: money(originalCentsForRow),
      reversedAmount: hasEntry ? money(rowReversedCents) : null,
      reversalNumber: asCountOrNull(row.reversal_number),
      reversedAt: asDate(row.reversed_at),
      originalEntryType: asText(row.original_entry_type),
      reversalEntryType: asText(row.reversal_entry_type),
      ledgerAmount: row.ledger_amount === null || row.ledger_amount === undefined ? null : money(toCents(row.ledger_amount)),
      ledgerBalanceAfter: row.ledger_balance_after === null || row.ledger_balance_after === undefined ? null : money(toCents(row.ledger_balance_after)),
      reason: reversalReason(row.reason, row.audit_reason, row.reversal_description),
      requestedBy,
      approvedBy,
      reversedBy: approvedBy ?? auditActor ?? requestedBy,
      requestStatus: asText(row.request_status),
      requestedAt: asDate(row.requested_at),
      decidedAt: asDate(row.decided_at),
      createdBy: asText(row.created_by),
      referenceNumber: asText(row.reference_number),
      transactionDate: asDate(row.transaction_date),
      hasCompensatingEntry: hasEntry,
    } satisfies ReversalReportRow;
  });

  let requestCount = 0;
  let pendingRequests = 0;
  let approvedRequests = 0;
  let rejectedRequests = 0;
  let pendingRequestCents = 0;

  const requests = requestRows.map((row) => {
    const status = asText(row.status) ?? 'unknown';
    const amountCents = toCents(row.reversal_amount);
    requestCount += 1;
    if (status === 'pending') { pendingRequests += 1; pendingRequestCents += amountCents; }
    else if (status === 'approved') approvedRequests += 1;
    else if (status === 'rejected') rejectedRequests += 1;

    return {
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      transactionNumber: asCountOrNull(row.transaction_number),
      accountName: asText(row.account_name),
      branchId: asText(row.branch_id),
      branchName: asText(row.branch_name),
      status,
      amount: money(amountCents),
      reason: asText(row.reason),
      requestedBy: asText(row.requested_by),
      approvedBy: asText(row.approved_by),
      requestedAt: asDate(row.created_at),
      decidedAt: asDate(row.updated_at),
    } satisfies ReversalRequestReportRow;
  });

  return {
    reversals,
    requests,
    summary: {
      reversedCount: reversals.length,
      originalTotal: money(originalCents),
      reversedTotal: money(reversedCents),
      requestCount,
      pendingRequests,
      approvedRequests,
      rejectedRequests,
      pendingRequestAmount: money(pendingRequestCents),
    },
  };
}
