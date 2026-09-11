import { query, queryOne } from '../database/connection';

export async function generateAlerts(): Promise<number> {
  let alertsCreated = 0;

  // 1. Low balance alerts
  const lowBalanceSetting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'low_balance_threshold'");
  const lowThreshold = parseFloat(lowBalanceSetting?.value || '1000');

  const criticalBalanceSetting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'critical_balance_threshold'");
  const criticalThreshold = parseFloat(criticalBalanceSetting?.value || '100');

  const lowAccounts = await query(
    `SELECT id, name, current_balance, minimum_balance FROM accounts WHERE status = 'active' AND current_balance <= minimum_balance`
  );

  for (const acct of lowAccounts) {
    const existing = await queryOne(
      `SELECT id FROM alerts WHERE entity = 'account' AND entity_id = $1 AND alert_type = 'low_balance' AND is_read = false`,
      [acct.id]
    );
    if (!existing) {
      const severity = parseFloat(acct.current_balance) <= criticalThreshold ? 'critical' : 'warning';
      await query(
        `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
         VALUES ('low_balance', $1, 'account', $2, $3, $4, $5)`,
        [severity, acct.id, `Low Balance: ${acct.name}`,
         `Account "${acct.name}" has ₱${parseFloat(acct.current_balance).toLocaleString('en-PH', { minimumFractionDigits: 2 })}, below minimum ₱${parseFloat(acct.minimum_balance).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`,
         JSON.stringify({ balance: acct.current_balance, minimum: acct.minimum_balance })]
      );
      alertsCreated++;
    }
  }

  // 2. Critical balance alerts
  const criticalAccounts = await query(
    `SELECT id, name, current_balance FROM accounts WHERE status = 'active' AND current_balance <= $1`, [criticalThreshold]
  );

  for (const acct of criticalAccounts) {
    const existing = await queryOne(
      `SELECT id FROM alerts WHERE entity = 'account' AND entity_id = $1 AND alert_type = 'critical_balance' AND is_read = false`,
      [acct.id]
    );
    if (!existing) {
      await query(
        `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
         VALUES ('critical_balance', 'critical', 'account', $1, $2, $3, $4)`,
        [acct.id, `CRITICAL: ${acct.name}`,
         `Account "${acct.name}" has critically low balance: ₱${parseFloat(acct.current_balance).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`,
         JSON.stringify({ balance: acct.current_balance })]
      );
      alertsCreated++;
    }
  }

  // 3. Pending transfer alerts
  const pendingHoursSetting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'pending_transfer_alert_hours'");
  const pendingHours = parseInt(pendingHoursSetting?.value || '24');

  const stalePending = await query(
    `SELECT t.id, t.transfer_number, t.transfer_amount, sa.name as source_name, da.name as destination_name, t.created_at
     FROM transfers t
     JOIN accounts sa ON t.source_account_id = sa.id
     JOIN accounts da ON t.destination_account_id = da.id
     WHERE t.status = 'pending' AND t.created_at < NOW() - INTERVAL '${pendingHours} hours'`
  );

  for (const tx of stalePending) {
    const existing = await queryOne(
      `SELECT id FROM alerts WHERE entity = 'transfer' AND entity_id = $1 AND alert_type = 'pending_transfer' AND is_read = false`,
      [tx.id]
    );
    if (!existing) {
      await query(
        `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
         VALUES ('pending_transfer', 'warning', 'transfer', $1, $2, $3, $4)`,
        [tx.id, `Pending Transfer #${tx.transfer_number}`,
         `Transfer #${tx.transfer_number} has been pending for over ${pendingHours}h. Amount: ₱${parseFloat(tx.transfer_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} (${tx.source_name} → ${tx.destination_name})`,
         JSON.stringify({ transferNumber: tx.transfer_number, amount: tx.transfer_amount })]
      );
      alertsCreated++;
    }
  }

  // 4. Large transaction alerts
  const largeTxSetting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'large_transaction_threshold'");
  const largeThreshold = parseFloat(largeTxSetting?.value || '50000');

  const largeTxns = await query(
    `SELECT t.id, t.transaction_number, t.amount, tt.name as type_name, a.name as account_name
     FROM transactions t
     JOIN transaction_types tt ON t.transaction_type_id = tt.id
     JOIN accounts a ON t.account_id = a.id
     WHERE t.amount >= $1 AND t.status = 'completed'
     AND t.created_at > NOW() - INTERVAL '24 hours'`, [largeThreshold]
  );

  for (const tx of largeTxns) {
    const existing = await queryOne(
      `SELECT id FROM alerts WHERE entity = 'transaction' AND entity_id = $1 AND alert_type = 'large_transaction' AND is_read = false`,
      [tx.id]
    );
    if (!existing) {
      await query(
        `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
         VALUES ('large_transaction', 'info', 'transaction', $1, $2, $3, $4)`,
        [tx.id, `Large Transaction: ${tx.type_name}`,
         `Transaction #${tx.transaction_number} on ${tx.account_name}: ₱${parseFloat(tx.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`,
         JSON.stringify({ transactionNumber: tx.transaction_number, amount: tx.amount })]
      );
      alertsCreated++;
    }
  }

  // 5. Reconciliation overdue alerts
  const reconPeriodSetting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'reconciliation_period_days'");
  const reconDays = parseInt(reconPeriodSetting?.value || '30');

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
    const existing = await queryOne(
      `SELECT id FROM alerts WHERE entity = 'account' AND entity_id = $1 AND alert_type = 'reconciliation_overdue' AND is_read = false`,
      [acct.id]
    );
    if (!existing) {
      await query(
        `INSERT INTO alerts (alert_type, severity, entity, entity_id, title, message, data)
         VALUES ('reconciliation_overdue', 'warning', 'account', $1, $2, $3, $4)`,
        [acct.id, `Reconciliation Overdue: ${acct.name}`,
         `Account "${acct.name}" hasn't been reconciled in over ${reconDays} days`,
         JSON.stringify({ daysSince: acct.days_since })]
      );
      alertsCreated++;
    }
  }

  return alertsCreated;
}
