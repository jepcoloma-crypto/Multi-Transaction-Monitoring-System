import { reversalReason } from './reversalReport';

// A statement row is one of three things: the original transaction a reversal
// undid, the compensating entry the reversal wrote, or an ordinary movement.
// Which one it is decides what the row says, and each of the three is answered
// from a different column, so the branching lives here instead of in the report
// query where it cannot be exercised without a database.

export interface StatementReversalRow {
  reference_number?: string | null;
  description?: string | null;
  transaction_id?: string | null;
  transaction_number?: number | string | null;
  transaction_reference?: string | null;
  transaction_status?: string | null;
  transfer_id?: string | null;
  transfer_status?: string | null;
  transfer_number?: number | string | null;
  transfer_reference?: string | null;
  type_name?: string | null;
  reversal_request_reason?: unknown;
  reversal_audit_reason?: unknown;
  reversal_entry_description?: unknown;
  reverses_id?: string | null;
  reverses_number?: number | string | null;
  reverses_type_name?: string | null;
}

export interface StatementReversalView {
  isReversed: boolean;
  isCompensating: boolean;
  resolvesTo: string | null;
  ofNumber: number | null;
  status: string | null;
  reason: string | null;
  typeDisplay: string | null;
  reference: string | null;
  label: string | null;
  numberDisplay: string | null;
  referenceDisplay: string | null;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const asRef = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const statementReversal = (row: StatementReversalRow): StatementReversalView => {
  const reversalRef = /^REV-([0-9]+)$/.exec(row.reference_number ?? '');
  const isReversed = row.transaction_status === 'reversed';
  // The reference alone is not enough: it has to name a transaction we hold, or
  // an operator typing that shape into a free-text reference would read as a
  // reversal. The join supplies reverses_id only when the number resolves.
  const isCompensating = reversalRef !== null && Boolean(row.reverses_id);
  const ofNumber = isReversed
    ? asNumber(row.transaction_number)
    : isCompensating ? asNumber(row.reverses_number) : null;

  // The trail joins read through `t`, which on a compensating row is the
  // reversal itself rather than what it undid. That row still has its reason in
  // its own description, which is the same fallback the original would reach.
  const reason = isCompensating
    ? reversalReason(null, null, row.description)
    : reversalReason(row.reversal_request_reason, row.reversal_audit_reason, row.reversal_entry_description);

  const transactionNumber = asNumber(row.transaction_number);
  const transferNumber = asNumber(row.transfer_number);
  // The ledger entry's own reference is blank on 14 cash rows and all 14
  // transfer rows, so the source has to be the transaction, which always carries
  // one, and the transfer's generated TRF- reference elsewhere.
  const reference = isCompensating
    ? asRef(row.reference_number)
    : row.transaction_id
      ? asRef(row.transaction_reference)
      : row.transfer_id ? asRef(row.transfer_reference) : null;

  return {
    isReversed,
    isCompensating,
    // Both rows carry the id of the other, which is what lets a statement link a
    // Sep 25 cash-out to the Sep 28 entry that undid it.
    resolvesTo: isReversed ? (row.transaction_id ?? null) : isCompensating ? (row.reverses_id ?? null) : null,
    ofNumber,
    status: isCompensating ? 'reversal' : (row.transaction_status ?? row.transfer_status ?? null),
    reason,
    // The Type column answers which row this is against the original, so the
    // reversal shows the adjustment type it is stored under. The ledger side
    // still comes from entry_type, never from this type's direction.
    typeDisplay: row.type_name ?? null,
    reference,
    label: isCompensating ? `Reversal of ${row.reverses_type_name || 'Transaction'} #${asNumber(row.reverses_number)}` : null,
    numberDisplay: transactionNumber !== null ? `#${transactionNumber}` : transferNumber !== null ? `#${transferNumber}` : null,
    referenceDisplay: reference,
  };
};