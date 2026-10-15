// The reconciliation gates every writer that appends to the ledger shares.
// Lifted out of routes/corrections.ts so a cancellation approval can re-audit
// inside its own transaction the same way corrections, gap fixes and fee
// re-posts do — one source for the gate, or the gates drift (§34's lesson).
//
// No database, no network beyond the reads: the same pure auditLedger verdict
// every other commit gate already asks for.

import { query } from '../database/connection';
import { auditLedger } from './ledgerAudit';

const ENTRY_COLUMNS =
  'le.account_id, le.id, le.entry_type, le.amount, le.balance_after, le.source_id, le.created_at';
const ACCOUNT_COLUMNS = 'a.id, a.name, a.status, a.opening_balance, a.current_balance';

const ACCOUNTS_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ANY($1) ORDER BY a.name, a.id`;
const ACCOUNT_ENTRIES_SQL = `SELECT ${ENTRY_COLUMNS} FROM ledger_entries le WHERE le.account_id = ANY($1) ORDER BY le.created_at, le.id`;

export interface LoadedLedger {
  accounts: any[];
  entries: any[];
}

// Reads through the transaction client when one is supplied, so the gate checks
// the same uncommitted state the writer is about to commit.
export async function loadAccountsAndEntries(accountIds: string[], client?: any): Promise<LoadedLedger> {
  if (accountIds.length === 0) return { accounts: [], entries: [] };

  if (client) {
    const accounts = await client.query(ACCOUNTS_SQL, [accountIds]);
    const entries = await client.query(ACCOUNT_ENTRIES_SQL, [accountIds]);
    return { accounts: accounts.rows, entries: entries.rows };
  }

  const accounts = await query(ACCOUNTS_SQL, [accountIds]);
  const entries = await query(ACCOUNT_ENTRIES_SQL, [accountIds]);
  return { accounts, entries };
}

// Every affected account re-audited on the same connection that is about to
// commit — chain, balance and last-row all have to hold after the write, or the
// write does not happen.
export async function auditInside(client: any, accountIds: string[]) {
  const { accounts, entries } = await loadAccountsAndEntries(accountIds, client);
  return auditLedger(accounts, entries);
}

// Closed accounts refuse every writer the same way — the cutover freezes the
// legacy fund by closing it, and a correction, re-entry, gap fix or
// cancellation landing afterwards would move the frozen line the runbook just
// set. Owner's rule, recorded with the cutover: closed is closed. Returns the
// offending names so each path can refuse in its own voice, while every preview
// uses the same list to take back their safe verdict: a preview that called a
// closed account safe would be lying about what its commit does.
export function closedAccountNames(accounts: Array<{ name: string; status?: string }>): string[] {
  return accounts.filter((a) => a.status === 'closed').map((a) => a.name);
}
