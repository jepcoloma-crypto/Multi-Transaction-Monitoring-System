import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { branchClause } from '../middleware/scope';
import { buildCashStatement, bucketFor, BUCKET_LABELS } from '../services/cashManagement';
import type { BranchBalance, CashBucket, LedgerFlowRow } from '../services/cashManagement';

const router = Router();

router.use(authenticate);

const parseDate = (value: unknown, field: string): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw createError(400, `${field} must be a valid date`);
  return parsed;
};

const num = (value: unknown): number => {
  const parsed = parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
};

// Read-only. Nothing here writes a balance, a ledger row or a status — the
// statement is a projection of rows that already exist, so it can be recomputed
// as often as anyone refreshes it without leaving anything behind.
//
// The cash position answers where the company's money physically is and how it
// moved, bucketed into sources and uses. It deliberately does not try to
// reproduce the income report's earnings: fee income is not a separate credit
// in the ledger, so a statement that included it would stop tying to the
// balance it exists to explain.
router.get('/statement', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const start = parseDate(req.query.startDate, 'startDate');
    const end = parseDate(req.query.endDate, 'endDate');
    const branchFilter = req.query.branchId ? String(req.query.branchId) : null;

    const branchParams: any[] = [];
    const branchConds: string[] = [];
    const branchScope = branchClause(req, 'a', 'reports.read', 1, 'self');
    if (branchScope.clause) {
      branchConds.push(branchScope.clause);
      branchParams.push(...branchScope.params);
    }
    if (branchFilter) {
      branchConds.push(`b.id = $${branchParams.length + 1}`);
      branchParams.push(branchFilter);
    }

    const branchRows = await query<{ id: string; code: string; name: string; opening: string; current: string }>(
      `SELECT b.id, b.code, b.name,
              COALESCE(SUM(a.opening_balance), 0) AS opening,
              COALESCE(SUM(a.current_balance), 0) AS current
       FROM branches b
       JOIN accounts a ON a.branch_id = b.id
       ${branchConds.length ? `WHERE ${branchConds.join(' AND ')}` : ''}
       GROUP BY b.id, b.code, b.name
       ORDER BY b.code`,
      branchParams,
    );

    // Opening balance at the start of the window, not the accounts' original
    // opening balance: everything posted before the window already moved them.
    // With no start date the window is all of history and nothing precedes it.
    const priorNet = new Map<string, number>();
    if (start) {
      const priorParams: any[] = [start.toISOString()];
      const priorConds = [`l.entry_date < $1`];
      const priorScope = branchClause(req, 'l', 'reports.read', 2, 'account');
      if (priorScope.clause) {
        priorConds.push(priorScope.clause);
        priorParams.push(...priorScope.params);
      }
      if (branchFilter) {
        priorConds.push(`a.branch_id = $${priorParams.length + 1}`);
        priorParams.push(branchFilter);
      }
      const priorRows = await query<{ branch_id: string; net: string }>(
        `SELECT a.branch_id,
                COALESCE(SUM(CASE WHEN l.entry_type = 'credit' THEN l.amount ELSE -l.amount END), 0) AS net
         FROM ledger_entries l
         JOIN accounts a ON a.id = l.account_id
         WHERE ${priorConds.join(' AND ')}
         GROUP BY a.branch_id`,
        priorParams,
      );
      for (const row of priorRows) priorNet.set(row.branch_id, num(row.net));
    }

    const flowParams: any[] = [];
    const flowConds: string[] = [];
    if (start) {
      flowConds.push(`l.entry_date >= $${flowParams.length + 1}`);
      flowParams.push(start.toISOString());
    }
    if (end) {
      flowConds.push(`l.entry_date < ($${flowParams.length + 1}::date + INTERVAL '1 day')`);
      flowParams.push(end.toISOString().slice(0, 10));
    }
    const flowScope = branchClause(req, 'l', 'reports.read', flowParams.length + 1, 'account');
    if (flowScope.clause) {
      flowConds.push(flowScope.clause);
      flowParams.push(...flowScope.params);
    }
    if (branchFilter) {
      flowConds.push(`a.branch_id = $${flowParams.length + 1}`);
      flowParams.push(branchFilter);
    }

    const flowRows = await query<LedgerFlowRow & { branch_id: string }>(
      `SELECT a.branch_id, l.entry_type, l.amount, l.source_type, tt.code AS txn_code
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
       ${flowConds.length ? `WHERE ${flowConds.join(' AND ')}` : ''}`,
      flowParams,
    );

    const branches: BranchBalance[] = branchRows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      opening: num(row.opening) + (priorNet.get(row.id) || 0),
      current: row.current,
    }));

    const statement = buildCashStatement(flowRows, branches);

    res.json({
      success: true,
      data: {
        period: {
          startDate: start ? start.toISOString().slice(0, 10) : null,
          endDate: end ? end.toISOString().slice(0, 10) : null,
        },
        ...statement,
      },
    });
  } catch (error) {
    next(error);
  }
});

// The rows behind one line of the statement.
//
// Bucketing happens in TypeScript against the same bucketFor the aggregate
// uses rather than in a SQL CASE that would have to be kept in step with it:
// a drill-down that disagreed with the figure it exists to explain would be
// worse than no drill-down. The window is therefore fetched and filtered here,
// bounded by a limit so a wide period cannot pull the whole ledger into memory.
const DRILL_FETCH_LIMIT = 2000;
const DRILL_RETURN_LIMIT = 200;

router.get('/statement/drill', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucket = String(req.query.bucket || '') as CashBucket;
    if (!(bucket in BUCKET_LABELS)) throw createError(400, 'Unknown bucket');

    const direction = req.query.direction === 'debit' ? 'debit' : 'credit';
    const start = parseDate(req.query.startDate, 'startDate');
    const end = parseDate(req.query.endDate, 'endDate');
    const branchFilter = req.query.branchId ? String(req.query.branchId) : null;

    const params: any[] = [];
    const conds: string[] = [];
    if (start) {
      conds.push(`l.entry_date >= $${params.length + 1}`);
      params.push(start.toISOString());
    }
    if (end) {
      conds.push(`l.entry_date < ($${params.length + 1}::date + INTERVAL '1 day')`);
      params.push(end.toISOString().slice(0, 10));
    }
    const scope = branchClause(req, 'l', 'reports.read', params.length + 1, 'account');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }
    if (branchFilter) {
      conds.push(`a.branch_id = $${params.length + 1}`);
      params.push(branchFilter);
    }

    const rows = await query<any>(
      `SELECT l.id, l.entry_date, l.entry_type, l.amount, l.balance_after, l.source_type,
              l.reference_number, l.description, l.account_id,
              a.name AS account_name, b.code AS branch_code,
              t.transaction_number, t.payee, tt.code AS txn_code
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       JOIN branches b ON b.id = a.branch_id
       LEFT JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
       ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY l.entry_date DESC
       LIMIT ${DRILL_FETCH_LIMIT}`,
      params,
    );

    const matches = rows
      .filter((row) => row.entry_type === direction && bucketFor(row.source_type, row.txn_code) === bucket)
      .slice(0, DRILL_RETURN_LIMIT);

    res.json({
      success: true,
      data: {
        bucket,
        label: BUCKET_LABELS[bucket],
        direction,
        total: matches.reduce((sum, row) => sum + num(row.amount), 0),
        truncated: rows.length >= DRILL_FETCH_LIMIT,
        rows: matches,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Operating expenses awaiting a second person. Mirrors /transactions/owner-funds/pending
// so the approval queue reads the same way, but kept separate because owner
// funds and expenses are different decisions with different approver rules and
// one combined list would make the existing screen ambiguous.
router.get('/expenses/pending', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === 'rejected' ? 'rejected' : 'pending';

    const params: any[] = [status];
    const conds = [`t.status = $1`];
    const scope = branchClause(req, 't', 'transactions.read_all', params.length + 1, 'account');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }

    const rows = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.net_amount, t.status, t.transaction_date,
              t.description, t.notes, t.reference_number, t.payee, t.created_at,
              t.rejection_reason, t.created_by, t.approved_by,
              tc.code AS category_code, tc.name AS category_name,
              a.name AS account_name, a.current_balance, b.code AS branch_code, b.name AS branch_name,
              u.username AS requested_by_username,
              au.username AS approved_by_username,
              ru.username AS rejected_by_username
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       JOIN accounts a ON a.id = t.account_id
       JOIN branches b ON b.id = a.branch_id
       LEFT JOIN transaction_categories tc ON tc.id = t.transaction_category_id
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users au ON au.id = t.approved_by
       LEFT JOIN users ru ON ru.id = t.rejected_by
       WHERE tt.code = 'operating_expense' AND ${conds.join(' AND ')}
       ORDER BY t.created_at ASC`,
      params,
    );

    res.json({ success: true, data: { data: rows } });
  } catch (error) {
    next(error);
  }
});

export default router;
