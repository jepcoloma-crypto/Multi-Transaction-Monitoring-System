import { Router, Request, Response, NextFunction } from 'express';
import { queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { ownerClause } from '../middleware/scope';
import { createError } from '../middleware/error';
import { auditLedger } from '../services/ledgerAudit';
import { loadScopedLedger, loadLedgerForAccounts, loadLedgerRowsBySource } from '../services/ledgerQuery';
import { strategyFor, verifyShape } from '../services/correctionStrategy';
import { simulateCorrection } from '../services/correctionPreview';
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

    const strategy = strategyFor(sourceType);
    if (!strategy) throw createError(400, `Unknown source type: ${sourceType}`);
    if (!strategy.addressable) {
      throw createError(400, 'Direct balance adjustments carry no source record and cannot be previewed');
    }

    const table = SOURCE_TABLES[sourceType];
    if (table) {
      const exists = await queryOne(`SELECT 1 AS present FROM ${table} WHERE id = $1`, [sourceId]);
      if (!exists) throw createError(404, `No ${sourceType} found with that id`);
    }

    const rows = await loadLedgerRowsBySource(sourceType, sourceId);
    const observed = {
      rowCount: rows.length,
      accountIds: [...new Set(rows.map((r: LedgerRowRef) => r.account_id))],
      entryTypes: [...new Set(rows.map((r: LedgerRowRef) => r.entry_type))],
    };
    const shape = verifyShape(strategy, observed);

    const { accounts, entries } = await loadLedgerForAccounts(observed.accountIds);
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

export default router;
