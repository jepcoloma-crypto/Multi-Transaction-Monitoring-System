// One source of truth for cleaning the database. Both the CLI
// (database/clean.ts) and the admin API endpoint (routes/backup.ts) call into
// here, so the plan the dry run prints, the backup that runs first, and the
// TRUNCATE that commit applies cannot drift apart.
//
// "Clean" empties the operational history while keeping the configuration
// that took real work to set up. It truncates the transactional tables and
// zeroes every account's balances — opening and current together — because
// the reports baseline on opening_balance: Sources & Uses sums it per branch,
// the account statement starts its running total from it, and the balance
// reconciliation audits against it. Keeping a non-zero opening with an empty
// ledger would leave every report showing money that no longer exists.
// It deliberately KEEPS users, branches, accounts, providers, transaction
// types/categories, loading products, additional charge types, fees/tiers,
// roles/permissions and system settings — most of that exists only in the
// live database and in no migration, so a wipe that touched it could not be
// undone by re-running migrations. The pre-clean balances themselves are in
// the backup that always runs first.

import { pool } from '../database/connection';
import { config } from '../config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// Every table the clean empties. Reference/config tables are absent on
// purpose. Kept in one place so the dry-run plan and the TRUNCATE agree.
export const DATA_TABLES = [
  'transactions',
  'ledger_entries',
  'transfer_entries',
  'transfers',
  'loading_transactions',
  'gap_fixes',
  'reconciliations',
  'reconciliation_items',
  'statement_matches',
  'bank_statements',
  'account_balance_history',
  'pending_reversals',
  'shifts',
  'alerts',
  'audit_logs',
  'token_blacklist',
];

// Tracking tables are neither data nor config to restore — leave them be.
const TRACKING_TABLES = ['_migrations', '_seeds'];

// Same directory and format the existing admin backup route uses, so a
// clean-made backup shows up in the admin's backup list and is restorable
// through the same /backup/restore endpoint.
export const BACKUP_DIR = path.join(process.cwd(), 'backups');

export interface CleanPlan {
  tables: { name: string; rows: number }[];
  totalRows: number;
  keptTables: string[];
  openShifts: number;
  // Accounts that would actually change — a balance to zero or an opening to
  // clear — so the dry run can show the money impact, not just row counts.
  accountsToZero: number;
  balanceToZero: number;
}

export async function openShiftCount(): Promise<number> {
  const rows = await pool.query(`SELECT count(*)::int AS n FROM shifts WHERE status = 'open'`);
  return rows.rows[0].n;
}

async function existingTables(): Promise<string[]> {
  const rows = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  return rows.rows.map((r: any) => r.tablename);
}

// The dry run: what a clean would empty, what it would keep, and whether
// anyone is mid-till. Read-only — this is what the admin sees before deciding.
export async function describePlan(): Promise<CleanPlan> {
  const present = new Set(await existingTables());

  const tables: { name: string; rows: number }[] = [];
  for (const name of DATA_TABLES) {
    if (!present.has(name)) continue;
    const counted = await pool.query(`SELECT count(*)::int AS n FROM "${name}"`);
    tables.push({ name, rows: counted.rows[0].n });
  }

  const keptTables = [...present].filter(
    (t) => !DATA_TABLES.includes(t) && !TRACKING_TABLES.includes(t)
  );

  // Money impact of the balance zeroing: how many accounts carry a balance
  // today and the total it wipes — the figure on the books right now, which
  // is what an admin is deciding to give up (the backup keeps it regardless).
  const money = await pool.query(
    `SELECT count(*)::int AS accounts,
            COALESCE(SUM(current_balance), 0) AS amount
     FROM accounts
     WHERE opening_balance <> 0 OR current_balance <> 0`
  );

  return {
    tables,
    totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
    keptTables,
    openShifts: await openShiftCount(),
    accountsToZero: money.rows[0].accounts,
    balanceToZero: Math.round(Number(money.rows[0].amount) * 100) / 100,
  };
}

export interface BackupFile {
  filename: string;
  filepath: string;
  size: number;
}

// Back up before anything is cleaned. Plain-SQL pg_dump to the shared backups
// directory, verified by exit code and a non-trivial size — the same bar the
// existing backup route holds itself to.
//
// `filename` overrides the default timestamped name. Only the scheduled
// backup uses it (backupScheduler.ts names its file for the Manila day, so a
// rerun of the same day cannot produce a second dump); every other caller
// wants the timestamp. A supplied name is validated rather than trusted —
// this function builds a path from it.
export async function takeBackup(filename?: string): Promise<BackupFile> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = filename ?? `backup_${timestamp}.sql`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(name)) {
    throw new Error(`Invalid backup filename: ${JSON.stringify(filename)}`);
  }
  const filepath = path.join(BACKUP_DIR, name);

  const conn = [
    '-h', config.db.host,
    '-p', String(config.db.port),
    '-U', config.db.user,
    '-d', config.db.name,
  ];

  try {
    await execFileAsync(
      'pg_dump',
      [...conn, '--no-owner', '--no-acl', '--clean', '--if-exists', '-Fp', '-f', filepath],
      { env: { ...process.env, PGPASSWORD: config.db.password } }
    );
  } catch (error: any) {
    throw new Error(`Backup failed (pg_dump exit ${error.code ?? '?'}): ${error.stderr || error.message}`);
  }

  const stats = fs.statSync(filepath);
  if (stats.size < 1024) {
    throw new Error(`Backup is only ${stats.size} bytes — refusing to treat that as a real backup.`);
  }

  return { filename: name, filepath, size: stats.size };
}

export interface CleanResult {
  truncated: string[];
  accountsZeroed: number;
}

// The clean itself: one TRUNCATE of the data tables (no CASCADE — the kept
// config tables reference these only as children, never as parents, so
// nothing outside the list depends on it), then every balance to zero in one
// UPDATE so opening and current can never disagree with each other or with
// the now-empty ledger. Runs in a single transaction so a failure leaves the
// books untouched.
export async function cleanData(): Promise<CleanResult> {
  const present = new Set(await existingTables());
  const toTruncate = DATA_TABLES.filter((t) => present.has(t));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE TABLE ${toTruncate.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`
    );
    const reset = await client.query(
      `UPDATE accounts SET opening_balance = 0, current_balance = 0, updated_at = NOW()`
    );
    await client.query('COMMIT');
    return { truncated: toTruncate, accountsZeroed: reset.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
