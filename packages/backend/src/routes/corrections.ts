import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { ownerClause } from '../middleware/scope';
import { createError } from '../middleware/error';
import { auditLedger } from '../services/ledgerAudit';
import { loadScopedLedger, loadLedgerRowsBySource } from '../services/ledgerQuery';
import { strategyFor, verifyShape } from '../services/correctionStrategy';
import { simulateCorrection } from '../services/correctionPreview';
import { validateTierA, TIER_A_FIELDS } from '../services/correctionFields';
import { updateAccountBalance } from '../services/balance';
import { createAuditLog } from '../services/audit';
import type { Simulation } from '../services/correctionPreview';
import type { LedgerRowRef } from '../services/ledgerQuery';

const router = Router();
router.use(authenticate);

const SOURCE_TABLES: Record<string, string> = {
  transaction: 'transactions',
  transfer: 'transfers',
  loading: 'loading_transactions',
  reconciliation: 'reconciliations',
};

const TABLES_WITH_UPDATED_AT = new Set(['transactions', 'transfers', 'loading_transactions']);

const ENTRY_COLUMNS =
  'le.account_id, le.id, le.entry_type, le.amount, le.balance_after, le.source_id, le.created_at';
const ACCOUNT_COLUMNS = 'a.id, a.name, a.status, a.opening_balance, a.current_balance';

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw createError(400, 'reason is required');
  return reason.trim();
}

function requireSource(sourceType: string, sourceId: string): string {
  const strategy = strategyFor(sourceType);
  if (!strategy) throw createError(400, `Unknown source type: ${sourceType}`);
  if (!strategy.addressable) {
    throw createError(400, 'Direct balance adjustments carry no source record to correct');
  }
  const table = SOURCE_TABLES[sourceType];
  if (!table) throw createError(400, `Unknown source type: ${sourceType}`);
  return table;
}

function pick(row: any, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c, row[c]]));
}

function observedShape(rows: LedgerRowRef[]) {
  return {
    rowCount: rows.length,
    accountIds: [...new Set(rows.map((r) => r.account_id))],
    entryTypes: [...new Set(rows.map((r) => r.entry_type))],
  };
}

router.get('/audit', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scope = ownerClause(req, 'a', 'accounts.read_all', 1);
    const { accounts, entries } = await loadScopedLedger(scope);
    res.json({ success: true, data: auditLedger(accounts, entries) });
  } catch (error) { next(error); }
});

router.post('/preview', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceType, sourceId, amounts } = req.body || {};
    if (!sourceType || !sourceId) throw createError(400, 'sourceType and sourceId are required');

    const table = requireSource(sourceType, sourceId);
    const exists = await queryOne(`SELECT 1 AS present FROM ${table} WHERE id = $1`, [sourceId]);
    if (!exists) throw createError(404, `No ${sourceType} found with that id`);

    const rows = await loadLedgerRowsBySource(sourceType, sourceId);
    const strategy = strategyFor(sourceType)!;
    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);

    const { accounts, entries } = await loadAccountsAndEntries(observed.accountIds);
    const before = auditLedger(accounts, entries);

    let simulation: Simulation | null = null;
    if (amounts !== undefined && amounts !== null) {
      if (!shape.ok) throw createError(409, `Cannot preview: ${shape.problems.join('; ')}`);
      simulation = simulateCorrection(accounts, entries, rows, amounts);
    }

    const safeToCorrect =
      shape.ok &&
      simulation !== null &&
      simulation.problems.length === 0 &&
      simulation.affectedAccountsAfter.every((a) => a.reconciled);

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        strategy,
        shape,
        ledgerRows: rows,
        before: before.accounts,
        simulation,
        safeToCorrect,
      },
    });
  } catch (error) { next(error); }
});

// Tier A: metadata only. No ledger row, no balance, nothing numeric — so it is
// a single guarded UPDATE with a whitelist deciding which columns are reachable.
router.patch('/:sourceType/:sourceId', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceType, sourceId } = req.params;
    const table = requireSource(sourceType, sourceId);
    if (!TIER_A_FIELDS[sourceType]) {
      throw createError(400, `No metadata fields are correctable for ${sourceType}`);
    }
    const reason = requireReason(req.body?.reason);

    const record = await queryOne(`SELECT * FROM ${table} WHERE id = $1`, [sourceId]);
    if (!record) throw createError(404, `No ${sourceType} found with that id`);

    const { columns, values } = validateTierA(sourceType, req.body?.fields);
    const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
    if (TABLES_WITH_UPDATED_AT.has(table)) assignments.push('updated_at = NOW()');

    await query(
      `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $${values.length + 1}`,
      [...values, sourceId]
    );

    const updated = await queryOne(`SELECT * FROM ${table} WHERE id = $1`, [sourceId]);

    await createAuditLog({
      userId: req.user!.userId,
      action: `${sourceType}.metadata_corrected`,
      entity: sourceType,
      entityId: sourceId,
      ipAddress: req.ip,
      reason,
      oldData: pick(record, columns),
      newData: pick(updated, columns),
    });

    res.json({ success: true, data: { changed: pick(updated, columns) } });
  } catch (error) { next(error); }
});

// Tier B: an amount correction that moves money. One transaction per call, the
// affected accounts locked in id order so a two-sided correction cannot
// deadlock, and the result re-audited inside the transaction before COMMIT —
// the preview says it is safe, the gate checks it actually was.
router.post('/:sourceType/:sourceId/apply', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  const { sourceType, sourceId } = req.params;
  let started = false;
  const client = await getClient();

  try {
    const table = requireSource(sourceType, sourceId);
    const reason = requireReason(req.body?.reason);
    const amounts = req.body?.amounts;
    if (amounts === undefined || amounts === null) throw createError(400, 'amounts is required');

    const exists = await queryOne(`SELECT 1 AS present FROM ${table} WHERE id = $1`, [sourceId]);
    if (!exists) throw createError(404, `No ${sourceType} found with that id`);

    const strategy = strategyFor(sourceType)!;
    await client.query('BEGIN');
    started = true;

    const rows: LedgerRowRef[] = (await client.query(
      `SELECT le.id, le.account_id, le.entry_type, le.amount, le.balance_after, le.created_at
       FROM ledger_entries le
       WHERE le.source_type = $1 AND le.source_id = $2
       ORDER BY le.created_at, le.id`,
      [sourceType, sourceId]
    )).rows;

    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);
    if (!shape.ok) throw createError(409, `Cannot correct: ${shape.problems.join('; ')}`);

    const accountIds = observed.accountIds;
    await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [accountIds]);

    const { accounts, entries } = await loadAccountsAndEntries(accountIds, client);
    const simulation = simulateCorrection(accounts, entries, rows, amounts);

    if (simulation.problems.length > 0) {
      throw createError(409, `Refusing to correct: ${simulation.problems.join('; ')}`);
    }
    if (simulation.corrections.length === 0) {
      throw createError(400, 'Those amounts do not change anything');
    }
    if (!simulation.affectedAccountsAfter.every((a) => a.reconciled)) {
      const bad = simulation.affectedAccountsAfter.filter((a) => !a.reconciled).map((a) => a.name);
      throw createError(409, `Refusing to correct — ${bad.join(', ')} would not reconcile`);
    }

    for (const correction of simulation.corrections) {
      const newBalance = await updateAccountBalance(
        correction.accountId, correction.amount, correction.entryType, client
      );
      await client.query(
        `INSERT INTO ledger_entries
           (account_id, transaction_id, transfer_id, source_type, source_id,
            entry_type, amount, balance_after, reference_number, description, entry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NOW())`,
        [
          correction.accountId,
          sourceType === 'transaction' ? sourceId : null,
          sourceType === 'transfer' ? sourceId : null,
          sourceType,
          sourceId,
          correction.entryType,
          correction.amount,
          newBalance,
          `Correction: ${reason}`,
        ]
      );
    }

    const verdict = await auditInside(client, accountIds);
    if (!verdict.accounts.every((a) => a.reconciled)) {
      const bad = verdict.accounts.filter((a) => !a.reconciled).map((a) => `${a.name} (gap ${a.gap})`);
      throw createError(409, `Refusing to commit — ${bad.join(', ')} did not reconcile after correction`);
    }

    await client.query('COMMIT');
    started = false;

    await createAuditLog({
      userId: req.user!.userId,
      action: `${sourceType}.amount_corrected`,
      entity: sourceType,
      entityId: sourceId,
      ipAddress: req.ip,
      reason,
      oldData: { amounts: simulation.changes.map((c) => ({ ledgerId: c.ledgerId, amount: c.fromAmount })) },
      newData: { amounts: simulation.changes.map((c) => ({ ledgerId: c.ledgerId, amount: c.toAmount })) },
    });

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        applied: simulation.corrections,
        balances: simulation.balances,
        after: verdict.accounts,
      },
    });
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

const ACCOUNTS_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ANY($1) ORDER BY a.name, a.id`;
const ACCOUNT_ENTRIES_SQL = `SELECT ${ENTRY_COLUMNS} FROM ledger_entries le WHERE le.account_id = ANY($1) ORDER BY le.created_at, le.id`;

interface LoadedLedger {
  accounts: any[];
  entries: any[];
}

// Reads through the transaction client when one is supplied, so the gate checks
// the same uncommitted state the correction is about to write.
async function loadAccountsAndEntries(accountIds: string[], client?: any): Promise<LoadedLedger> {
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

async function auditInside(client: any, accountIds: string[]) {
  const { accounts, entries } = await loadAccountsAndEntries(accountIds, client);
  return auditLedger(accounts, entries);
}

export default router;
