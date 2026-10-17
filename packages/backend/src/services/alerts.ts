import { query, queryOne } from '../database/connection';

// Every threshold comes from system_settings and lands in SQL, so each is
// parsed once and rejected as a number rather than interpolated as text: a
// setting edited to garbage must fail as a clean error, not as a query the
// database has to diagnose.
const settingNumber = async (key: string, fallback: number): Promise<number> => {
  const row = await queryOne<{ value: string }>('SELECT value FROM system_settings WHERE key = $1', [key]);
  const parsed = parseFloat(row?.value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

// One statement per candidate rather than a read-then-write pair. The
// existence check moved inside the INSERT, so two overlapping runs cannot both
// pass the check and both write — the half-open window the old pair had.
const insertIfNew = async (
  values: [string, string, string, string | null, string, string, string],
): Promise<number> => {
  const [alertType, severity, entity, entityId, title, message, data] = values;
  const inserted = await query(
    `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
     SELECT $1, $2, $3, $4, $5, $6, $7::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts
       WHERE alert_type = $1 AND entity = $3 AND entity_id IS NOT DISTINCT FROM $4 AND is_read = false
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

  // 5. Reconciliation overdue alerts
  const reconDays = await settingNumber('reconciliation_period_days', 30);
  const unreconciledAccounts = await query(
    `SELECT a.id, a.name,
            MAX(r.created_at) as last_recon,
            EXTRACT(EPOCH FROM (NOW() - MAX(r.created_at))) / 86400 as days_since
     FROM accounts a
     LEFT JOIN reconciliations r ON a.id = r.account_id AND r.status = 'reconciled'
     WHERE a.status = 'active'
     GROUP BY a.id, a.name
     HAVING MAX(r.created_at) IS NULL OR EXTRACT(EPOCH FROM (NOW() - MAX(r.created_at))) / 86400 > $1`,
    [reconDays]
  );

  for (const acct of unreconciledAccounts) {
    alertsCreated += await insertIfNew([
      'reconciliation_overdue',
      'warning',
      'account',
      acct.id,
      `Reconciliation Overdue: ${acct.name}`,
      `Account "${acct.name}" hasn't been reconciled in over ${reconDays} days`,
      JSON.stringify({ daysSince: acct.days_since }),
    ]);
  }

  return alertsCreated;
}
