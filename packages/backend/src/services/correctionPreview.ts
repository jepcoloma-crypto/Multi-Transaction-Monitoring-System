// Pure preview engine: takes the ledger state an account is in right now and
// returns what a proposed correction would leave behind. It never touches the
// database, so the preview the operator sees and the gate the commit checks are
// the same arithmetic, and both are testable without a server.
//
// Corrections append. The original row keeps the amount it was posted with, and
// a correcting row of the opposite sign is written after it — the same thing a
// reversal does. Rewriting the original would silently move history, which is
// what the completed-transaction lock exists to prevent.
//
// Two callers plan differently but commit the same way: an amount correction
// (Phase 3) derives one row per account from the proposed amounts, and a
// re-entry (Phase 4) derives a reversal row plus a re-entry row per account.
// Both run through appendPlannedRows so the gate always sees what really lands.
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

export interface PlannedRow {
  accountId: string;
  entryType: 'credit' | 'debit';
  amount: number;
  sourceId: string | null;
}

export interface Simulation {
  changes: PlannedChange[];
  corrections: CorrectionEntry[];
  balances: { accountId: string; before: number; after: number }[];
  affectedAccountsAfter: AccountAudit[];
  problems: string[];
}

export interface AppendResult {
  corrections: CorrectionEntry[];
  applied: PlannedRow[];
  simulatedAccounts: LedgerAuditAccount[];
  simulatedEntries: LedgerAuditEntry[];
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

  const ownedRowIds = new Set(rows.map((r) => r.id));
  const sourceId = entries.find((e) => ownedRowIds.has(e.id))?.source_id ?? null;

  const deltaByAccount = new Map<string, number>();
  for (const account of accounts) deltaByAccount.set(account.id, 0);
  for (const change of changes) {
    deltaByAccount.set(change.accountId, (deltaByAccount.get(change.accountId) ?? 0) + change.balanceDelta);
  }

  const planned: PlannedRow[] = [];
  for (const account of accounts) {
    const delta = deltaByAccount.get(account.id) ?? 0;
    if (delta === 0) continue;
    planned.push({
      accountId: account.id,
      entryType: delta > 0 ? 'credit' : 'debit',
      amount: fromCents(Math.abs(delta)),
      sourceId,
    });
  }

  const appended = appendPlannedRows(accounts, entries, planned);
  const after = auditLedger(appended.simulatedAccounts, appended.simulatedEntries);

  const balances = accounts.map((account) => ({
    accountId: account.id,
    before: parseFloat(String(account.current_balance)),
    after: fromCents(toCents(account.current_balance) + (deltaByAccount.get(account.id) ?? 0)),
  }));

  return {
    changes,
    corrections: appended.corrections,
    balances,
    affectedAccountsAfter: after.accounts,
    problems: appended.problems,
  };
}

// Appends the planned rows to the supplied ledger state and returns what the
// accounts would look like afterwards. Balances follow the account, not the
// chain, because that is what updateAccountBalance actually does — so an
// account that is already out of sync stays out of sync and the gate catches it.
export function appendPlannedRows(
  accounts: LedgerAuditAccount[],
  entries: LedgerAuditEntry[],
  planned: PlannedRow[]
): AppendResult {
  const sortedByAccount = groupInWriteOrder(entries);
  const stampBase = new Map<string, number>();
  for (const account of accounts) {
    const list = sortedByAccount.get(account.id) || [];
    const last = list.length ? new Date(list[list.length - 1].created_at).getTime() : 0;
    stampBase.set(account.id, Math.max(last, Date.now()));
  }

  const rowsByAccount = new Map<string, PlannedRow[]>();
  for (const row of planned) {
    const bucket = rowsByAccount.get(row.accountId);
    if (bucket) bucket.push(row);
    else rowsByAccount.set(row.accountId, [row]);
  }

  const problems = new Set<string>();
  const corrections: CorrectionEntry[] = [];
  const applied: PlannedRow[] = [];
  const simulatedAccounts: LedgerAuditAccount[] = [];
  const simulatedEntries: LedgerAuditEntry[] = [];

  for (const account of accounts) {
    const list = sortedByAccount.get(account.id) || [];
    simulatedEntries.push(...list);

    let running = toCents(account.current_balance);
    const ordered = chooseOrder(running, rowsByAccount.get(account.id) || []);
    applied.push(...ordered);

    let tick = 0;
    for (const row of ordered) {
      running += row.entryType === 'credit' ? toCents(row.amount) : -toCents(row.amount);
      const balanceAfter = fromCents(running);
      if (running < 0) {
        problems.add(`account ${account.name} would fall to ${balanceAfter.toFixed(2)}`);
      }
      corrections.push({
        accountId: account.id,
        entryType: row.entryType,
        amount: row.amount,
        balanceAfter,
      });
      // Dated after every existing row so the write-order sort puts the planned
      // rows last, matching where they will really land, and carrying the source
      // they belong to so the preview does not report them as unlinked.
      simulatedEntries.push({
        id: `planned-${account.id}-${++tick}`,
        account_id: account.id,
        entry_type: row.entryType,
        amount: row.amount,
        balance_after: balanceAfter,
        source_id: row.sourceId,
        created_at: new Date((stampBase.get(account.id) ?? Date.now()) + tick * 1000),
      });
    }

    simulatedAccounts.push({ ...account, current_balance: fromCents(running) });
  }

  return { corrections, applied, simulatedAccounts, simulatedEntries, problems: [...problems] };
}

// A re-entry writes a reversal and a replacement onto an account that keeps the
// money (its own source or destination did not change). Reversing first is the
// honest sequence, but taken literally it can drive that account negative for a
// row that nets to nothing — a correction the operator did not ask for. Swap the
// two only when that is the difference, so the gate never rejects on a dip the
// final balance does not actually have.
function chooseOrder(startCents: number, rows: PlannedRow[]): PlannedRow[] {
  if (rows.length < 2) return rows;
  if (!dipsNegative(startCents, rows)) return rows;
  const swapped = [...rows].reverse();
  return dipsNegative(startCents, swapped) ? rows : swapped;
}

function dipsNegative(startCents: number, rows: PlannedRow[]): boolean {
  let running = startCents;
  for (const row of rows) {
    running += row.entryType === 'credit' ? toCents(row.amount) : -toCents(row.amount);
    if (running < 0) return true;
  }
  return false;
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
