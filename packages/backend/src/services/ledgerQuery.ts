import { query } from '../database/connection';
import type { LedgerAuditAccount, LedgerAuditEntry } from './ledgerAudit';

export interface LedgerScope {
  clause: string | null;
  params: any[];
}

export interface LedgerDataSet {
  accounts: LedgerAuditAccount[];
  entries: LedgerAuditEntry[];
}

const ACCOUNT_COLUMNS = 'a.id, a.name, a.status, a.opening_balance, a.current_balance';
const ENTRY_COLUMNS =
  'le.account_id, le.id, le.entry_type, le.amount, le.balance_after, le.source_id, le.created_at';

// The single place that reads ledger data for auditing, so the balance report
// and the correction preview can never drift apart on scoping or row order.
export async function loadScopedLedger(scope: LedgerScope): Promise<LedgerDataSet> {
  const where = scope.clause ? `WHERE ${scope.clause}` : '';

  const accounts = await query<LedgerAuditAccount>(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM accounts a
     ${where}
     ORDER BY a.name, a.id`,
    scope.params
  );

  const entries = await query<LedgerAuditEntry>(
    `SELECT ${ENTRY_COLUMNS}
     FROM ledger_entries le
     JOIN accounts a ON a.id = le.account_id
     ${where}
     ORDER BY le.created_at, le.id`,
    scope.params
  );

  return { accounts, entries };
}

export async function loadLedgerForAccounts(accountIds: string[]): Promise<LedgerDataSet> {
  if (accountIds.length === 0) return { accounts: [], entries: [] };

  const accounts = await query<LedgerAuditAccount>(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM accounts a WHERE a.id = ANY($1)
     ORDER BY a.name, a.id`,
    [accountIds]
  );

  const entries = await query<LedgerAuditEntry>(
    `SELECT ${ENTRY_COLUMNS}
     FROM ledger_entries le
     WHERE le.account_id = ANY($1)
     ORDER BY le.created_at, le.id`,
    [accountIds]
  );

  return { accounts, entries };
}

export interface LedgerRowRef {
  id: string;
  account_id: string;
  entry_type: string;
  amount: string;
  balance_after: string;
  created_at: Date;
}

export function loadLedgerRowsBySource(sourceType: string, sourceId: string): Promise<LedgerRowRef[]> {
  return query<LedgerRowRef>(
    `SELECT le.id, le.account_id, le.entry_type, le.amount, le.balance_after, le.created_at
     FROM ledger_entries le
     WHERE le.source_type = $1 AND le.source_id = $2
     ORDER BY le.created_at, le.id`,
    [sourceType, sourceId]
  );
}
