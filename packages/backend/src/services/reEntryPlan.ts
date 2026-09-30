// Plans a "correct and re-enter": undo the original record where it stands and
// write its replacement onto the corrected accounts.
//
// The original is never rewritten — only its status changes, exactly as the
// reversal flow does — because editing account_id on a completed record would
// both move history in place and leave one record owning ledger rows on accounts
// it no longer claims. Splitting into original (reversed) plus replacement keeps
// every record's rows on its own accounts, so verifyShape still holds for both.
//
// Rows are mapped by the account they sit on rather than by entry_type: a
// transfer that was already amount-corrected owns credit and debit rows on both
// sides, so direction alone no longer identifies the source.
import { createError } from '../middleware/error';
import type { PlannedRow } from './correctionPreview';
import type { LedgerRowRef } from './ledgerQuery';

export type ReEntryKind = 'account' | 'transfer';

export const RE_ENTERABLE: Record<string, ReEntryKind> = {
  transaction: 'account',
  loading: 'account',
  transfer: 'transfer',
};

export interface ReEntryAccounts {
  accountId?: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
}

export interface OriginalAccounts {
  accountId?: string | null;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
}

export interface ReEntryMove {
  role: 'account' | 'source' | 'destination';
  from: string;
  to: string;
}

export interface ReEntryPlan {
  planned: PlannedRow[];
  moves: ReEntryMove[];
  newAccountIds: string[];
}

export function planReEntry(
  sourceType: string,
  rows: LedgerRowRef[],
  original: OriginalAccounts,
  requested: ReEntryAccounts,
  originalId: string,
  newRecordId: string
): ReEntryPlan {
  const kind = RE_ENTERABLE[sourceType];
  if (!kind) throw createError(400, `${sourceType} records cannot be re-entered`);
  if (rows.length === 0) throw createError(409, 'no ledger rows are linked to this record');

  const pairs: { role: ReEntryMove['role']; from: string; to: string }[] = [];

  if (kind === 'account') {
    const from = original.accountId;
    if (!from) throw createError(409, 'the original record has no account');
    const to = required(requested.accountId, 'accountId');
    if (rows.some((r) => r.account_id !== from)) {
      throw createError(409, 'a single-account record owns ledger rows on more than one account');
    }
    pairs.push({ role: 'account', from, to });
  } else {
    const source = original.sourceAccountId;
    const destination = original.destinationAccountId;
    if (!source || !destination) throw createError(409, 'the original transfer is missing an account');
    const toSource = required(requested.sourceAccountId, 'sourceAccountId');
    const toDestination = required(requested.destinationAccountId, 'destinationAccountId');
    if (toSource === toDestination) throw createError(400, 'Source and destination must be different');
    pairs.push({ role: 'source', from: source, to: toSource });
    pairs.push({ role: 'destination', from: destination, to: toDestination });
  }

  const targets = new Map<string, string>(pairs.map((p) => [p.from, p.to]));

  const moves: ReEntryMove[] = pairs.map((p) => ({ ...p }));
  let moved = false;
  const planned: PlannedRow[] = [];

  // Reversals first: the original is undone before its replacement is written.
  for (const row of rows) {
    const to = targets.get(row.account_id);
    if (!to) throw createError(409, 'a ledger row sits on an account the original record does not claim');
    if (to !== row.account_id) moved = true;
    planned.push({
      accountId: row.account_id,
      entryType: row.entry_type === 'credit' ? 'debit' : 'credit',
      amount: parseFloat(row.amount),
      sourceId: originalId,
    });
  }

  if (!moved) throw createError(400, 'The record already sits on those accounts — nothing to re-enter');

  for (const row of rows) {
    planned.push({
      accountId: targets.get(row.account_id)!,
      entryType: row.entry_type as 'credit' | 'debit',
      amount: parseFloat(row.amount),
      sourceId: newRecordId,
    });
  }

  return { planned, moves, newAccountIds: [...targets.values()] };
}

function required(value: string | undefined, field: string): string {
  if (!value) throw createError(400, `${field} is required`);
  return value;
}
