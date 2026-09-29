// Pure preview engine: takes the ledger state an account is in right now and
// returns what a proposed correction would leave behind. It never touches the
// database, so the preview the operator sees and the gate the commit checks are
// the same arithmetic, and both are testable without a server.
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

export interface Simulation {
  changes: PlannedChange[];
  ledgerRows: { id: string; accountId: string; amountAfter: number; balanceAfter: number }[];
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
  const deltaByAccount = new Map<string, number>();
  for (const account of accounts) deltaByAccount.set(account.id, 0);
  for (const change of changes) {
    deltaByAccount.set(change.accountId, (deltaByAccount.get(change.accountId) ?? 0) + change.balanceDelta);
  }

  // The chain shifts from the first owned row onward; rows written before it are
  // history this correction does not touch. The owned row's amount changes too —
  // moving only balance_after would leave netMovement stale and the chain broken.
  const firstOwnedIndex = new Map<string, number>();
  for (const row of rows) {
    const list = sortedByAccount.get(row.account_id) || [];
    const index = list.findIndex((e) => e.id === row.id);
    const current = firstOwnedIndex.get(row.account_id);
    if (index !== -1 && (current === undefined || index < current)) {
      firstOwnedIndex.set(row.account_id, index);
    }
  }

  const amountForLedgerId = new Map<string, number>();
  for (const change of changes) amountForLedgerId.set(change.ledgerId, change.toAmount);

  const simulatedEntries: LedgerAuditEntry[] = [];
  for (const [accountId, list] of sortedByAccount) {
    const delta = deltaByAccount.get(accountId) ?? 0;
    const start = firstOwnedIndex.get(accountId) ?? list.length;
    list.forEach((entry, i) => {
      const proposedAmount = amountForLedgerId.get(entry.id);
      const balanceAfter = delta === 0 || i < start
        ? entry.balance_after
        : fromCents(toCents(entry.balance_after) + delta);
      simulatedEntries.push({
        ...entry,
        amount: proposedAmount === undefined ? entry.amount : proposedAmount,
        balance_after: balanceAfter,
      });
    });
  }

  const problems: string[] = [];
  const simulatedAccounts = accounts.map((account) => {
    const next = fromCents(toCents(account.current_balance) + (deltaByAccount.get(account.id) ?? 0));
    if (next < 0) problems.push(`account ${account.name} would fall to ${next.toFixed(2)}`);
    return { ...account, current_balance: next };
  });

  const after = auditLedger(simulatedAccounts, simulatedEntries);

  const ledgerRows = rows.map((row) => {
    const change = changes.find((c) => c.ledgerId === row.id)!;
    const entry = simulatedEntries.find((e) => e.id === row.id)!;
    return {
      id: row.id,
      accountId: row.account_id,
      amountAfter: change.toAmount,
      balanceAfter: parseFloat(String(entry.balance_after)),
    };
  });

  const balances = accounts.map((account) => ({
    accountId: account.id,
    before: parseFloat(String(account.current_balance)),
    after: fromCents(toCents(account.current_balance) + (deltaByAccount.get(account.id) ?? 0)),
  }));

  return { changes, ledgerRows, balances, affectedAccountsAfter: after.accounts, problems };
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
