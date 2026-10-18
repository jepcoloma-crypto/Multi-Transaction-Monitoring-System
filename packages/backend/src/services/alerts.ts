import { query } from '../database/connection';
import { settingNumber } from './settings';
import { overdueReconciliations } from './reconciliationStatus';

// One statement per candidate rather than a read-then-write pair. The
// existence check moved inside the INSERT, so two overlapping runs cannot both
// pass the check and both write — the half-open window the old pair had.
//
// Every parameter carries an explicit cast, because the statement uses three of
// them twice. A bare `$1` in the SELECT list has no context to be read from, so
// the parser deduces text, while `alert_type = $1` beside it deduces character
// varying — one parameter, two types, and the database refuses the statement
// outright rather than choosing. Casting every occurrence states the type once
// and removes the disagreement. (This was found only at runtime: a probe with
// literal values binds nothing and so exercises none of it.)
const insertIfNew = async (
  values: [string, string, string, string | null, string, string, string],
): Promise<number> => {
  const [alertType, severity, entity, entityId, title, message, data] = values;
  const inserted = await query(
    `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
     SELECT $1::varchar, $2::varchar, $3::varchar, $4::uuid, $5::varchar, $6::text, $7::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts
       WHERE alert_type = $1::varchar AND entity = $3::varchar
         AND entity_id IS NOT DISTINCT FROM $4::uuid AND is_read = false
     )`,
    [alertType, severity, entity, entityId, title, message, data],
  );
  return inserted.length;
};

export async function generateAlerts(): Promise<number> {
  let alertsCreated = 0;
  const money = (value: string | number): string =>
    parseFloat(String(value)).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 1. Low balance alerts
  const criticalThreshold = await settingNumber('critical_balance_threshold', 100);
  const lowAccounts = await query(
    `SELECT id, name, current_balance, minimum_balance FROM accounts WHERE status = 'active' AND current_balance <= minimum_balance`
  );

  for (const acct of lowAccounts) {
    alertsCreated += await insertIfNew([
      'low_balance',
      parseFloat(String(acct.current_balance)) <= criticalThreshold ? 'critical' : 'warning',
      'account',
      acct.id,
      `Low Balance: ${acct.name}`,
      `Account "${acct.name}" has ₱${money(acct.current_balance)}, below minimum ₱${money(acct.minimum_balance)}`,
      JSON.stringify({ balance: acct.current_balance, minimum: acct.minimum_balance }),
    ]);
  }

  // 2. Critical balance alerts
  const criticalAccounts = await query(
    `SELECT id, name, current_balance FROM accounts WHERE status = 'active' AND current_balance <= $1`, [criticalThreshold]
  );

  for (const acct of criticalAccounts) {
    alertsCreated += await insertIfNew([
      'critical_balance',
      'critical',
      'account',
      acct.id,
      `CRITICAL: ${acct.name}`,
      `Account "${acct.name}" has critically low balance: ₱${money(acct.current_balance)}`,
      JSON.stringify({ balance: acct.current_balance }),
    ]);
  }

  // 3. Pending transfer alerts
  const pendingHours = await settingNumber('pending_transfer_alert_hours', 24);
  // make_interval rather than a string spliced into the SQL: the hours figure
  // is a setting an administrator can edit, and a non-numeric value belongs in
  // a clean error rather than inside a statement the database has to parse.
  const stalePending = await query(
    `SELECT t.id, t.transfer_number, t.transfer_amount, sa.name as source_name, da.name as destination_name, t.created_at
     FROM transfers t
     JOIN accounts sa ON t.source_account_id = sa.id
     JOIN accounts da ON t.destination_account_id = da.id
     WHERE t.status = 'pending' AND t.created_at < NOW() - make_interval(hours => $1)`,
    [Math.round(pendingHours)]
  );

  for (const tx of stalePending) {
    alertsCreated += await insertIfNew([
      'pending_transfer',
      'warning',
      'transfer',
      tx.id,
      `Pending Transfer #${tx.transfer_number}`,
      `Transfer #${tx.transfer_number} has been pending for over ${pendingHours}h. Amount: ₱${money(tx.transfer_amount)} (${tx.source_name} → ${tx.destination_name})`,
      JSON.stringify({ transferNumber: tx.transfer_number, amount: tx.transfer_amount }),
    ]);
  }

  // 4. Large transaction alerts
  const largeThreshold = await settingNumber('large_transaction_threshold', 50000);
  const largeTxns = await query(
    `SELECT t.id, t.transaction_number, t.amount, tt.name as type_name, a.name as account_name
     FROM transactions t
     JOIN transaction_types tt ON t.transaction_type_id = tt.id
     JOIN accounts a ON t.account_id = a.id
     WHERE t.amount >= $1 AND t.status = 'completed'
     AND t.created_at > NOW() - INTERVAL '24 hours'`, [largeThreshold]
  );

  for (const tx of largeTxns) {
    alertsCreated += await insertIfNew([
      'large_transaction',
      'info',
      'transaction',
      tx.id,
      `Large Transaction: ${tx.type_name}`,
      `Transaction #${tx.transaction_number} on ${tx.account_name}: ₱${money(tx.amount)}`,
      JSON.stringify({ transactionNumber: tx.transaction_number, amount: tx.amount }),
    ]);
  }

  // 5. Reconciliation overdue alerts. The list is shared with the cash
  // dashboard, which reports the same accounts against the same period, so
  // there is one definition of "overdue" and one answer to which accounts it
  // names rather than two that could drift apart.
  const { periodDays, accounts: unreconciledAccounts } = await overdueReconciliations();

  for (const acct of unreconciledAccounts) {
    alertsCreated += await insertIfNew([
      'reconciliation_overdue',
      'warning',
      'account',
      acct.accountId,
      `Reconciliation Overdue: ${acct.accountName}`,
      `Account "${acct.accountName}" hasn't been reconciled in over ${periodDays} days`,
      JSON.stringify({ daysSince: acct.daysSince }),
    ]);
  }

  return alertsCreated;
}
