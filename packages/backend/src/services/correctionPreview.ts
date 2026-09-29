// Pure preview engine: takes the ledger state an account is in right now and
// returns what a proposed correction would leave behind. It never touches the
// database, so the preview the operator sees and the gate the commit checks are
// the same arithmetic, and both are testable without a server.
//
// Corrections append. The original row keeps the amount it was posted with, and
// a correcting row of the opposite sign is written after it — the same thing a
// reversal does. Rewriting the original would silently move history, which is
// what the completed-transaction lock exists to prevent.
import { createError } from '../middleware/error';
import { auditLedger, compareWriteOrder, toCents, fromCents } from './ledgerAudit';
import type { AccountAudit, LedgerAuditAccount, LedgerAuditEntry } from './ledgerAudit';
import type { LedgerRowRef } from './ledgerQuery';

export interface PlannedChange {
  ledgerId: string;
  accountId: string;
  entryType: string;
  fromAmount: number;
  toAmount: number;
  balanceDelta: number;
}

export interface CorrectionEntry {
  accountId: string;
  entryType: 'credit' | 'debit';
  amount: number;
  balanceAfter: number;
}

export interface Simulation {
  changes: PlannedChange[];
  corrections: CorrectionEntry[];
  balances: { accountId: string; before: number; after: number }[];
  affectedAccountsAfter: AccountAudit[];
  problems: string[];
}

export function simulateCorrection(
  accounts: LedgerAuditAccount[],
  entries: LedgerAuditEntry[],
  rows: LedgerRowRef[],
  amounts: unknown
): Simulation {
  if (typeof amounts !== 'object' || amounts === null || Array.isArray(amounts)) {
    throw createError(400, 'amounts must be an object keyed by account id');
  }
  const proposed = amounts as Record<string, unknown>;

  const ownedAccounts = new Set(rows.map((r) => r.account_id));
  for (const key of Object.keys(proposed)) {
    if (!ownedAccounts.has(key)) {
      throw createError(400, `amounts includes an account this record does not touch: ${key}`);
    }
  }

  const changes: PlannedChange[] = rows.map((row) => {
    const raw = proposed[row.account_id];
    if (raw === undefined) throw createError(400, `amounts is missing account ${row.account_id}`);
    const to = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!Number.isFinite(to)) throw createError(400, `amount for account ${row.account_id} is not a number`);
    if (to < 0) throw createError(400, `amount for account ${row.account_id} cannot be negative`);

    const from = parseFloat(row.amount);
    const balanceDelta = (row.entry_type === 'credit' ? 1 : -1) * (toCents(to) - toCents(from));
    return {
      ledgerId: row.id,
      accountId: row.account_id,
      entryType: row.entry_type,
      fromAmount: from,
      toAmount: to,
      balanceDelta,
    };
  });

  const sortedByAccount = groupInWriteOrder(entries);
  const ownedRowIds = new Set(rows.map((r) => r.id));
  const ownedSourceId = entries.find((e) => ownedRowIds.has(e.id))?.source_id ?? null;
  const deltaByAccount = new Map<string, number>();
  for (const account of accounts) deltaByAccount.set(account.id, 0);
  for (const change of changes) {
    deltaByAccount.set(change.accountId, (deltaByAccount.get(change.accountId) ?? 0) + change.balanceDelta);
  }

  const problems: string[] = [];
  const corrections: CorrectionEntry[] = [];
  const simulatedAccounts: LedgerAuditAccount[] = [];
  const simulatedEntries: LedgerAuditEntry[] = [];

  for (const account of accounts) {
    const delta = deltaByAccount.get(account.id) ?? 0;
    const list = sortedByAccount.get(account.id) || [];
    const balanceAfter = fromCents(toCents(account.current_balance) + delta);

    if (balanceAfter < 0) problems.push(`account ${account.name} would fall to ${balanceAfter.toFixed(2)}`);

    simulatedAccounts.push({ ...account, current_balance: balanceAfter });
    simulatedEntries.push(...list);

    if (delta !== 0) {
      const last = list[list.length - 1];
      const chainEnd = last ? toCents(last.balance_after) : toCents(account.opening_balance);
      corrections.push({
        accountId: account.id,
        entryType: delta > 0 ? 'credit' : 'debit',
        amount: fromCents(Math.abs(delta)),
        balanceAfter: fromCents(chainEnd + delta),
      });
      // Dated after every existing row so the write-order sort puts the
      // correction last, matching where it will really land, and carrying the
      // source it corrects so the preview does not report it as unlinked.
      const stamp = new Date((last ? new Date(last.created_at).getTime() : Date.now()) + 1000);
      simulatedEntries.push({
        id: `correction-${account.id}`,
        account_id: account.id,
        entry_type: delta > 0 ? 'credit' : 'debit',
        amount: fromCents(Math.abs(delta)),
        balance_after: fromCents(chainEnd + delta),
        source_id: ownedSourceId,
        created_at: stamp,
      });
    }
  }

  const after = auditLedger(simulatedAccounts, simulatedEntries);

  const balances = accounts.map((account) => ({
    accountId: account.id,
    before: parseFloat(String(account.current_balance)),
    after: fromCents(toCents(account.current_balance) + (deltaByAccount.get(account.id) ?? 0)),
  }));

  return { changes, corrections, balances, affectedAccountsAfter: after.accounts, problems };
}

function groupInWriteOrder(entries: LedgerAuditEntry[]): Map<string, LedgerAuditEntry[]> {
  const groups = new Map<string, LedgerAuditEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.account_id);
    if (bucket) bucket.push(entry);
    else groups.set(entry.account_id, [entry]);
  }
  for (const list of groups.values()) list.sort(compareWriteOrder);
  return groups;
}
