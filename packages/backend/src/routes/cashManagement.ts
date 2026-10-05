import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { branchClause, canSeeAll } from '../middleware/scope';
import { buildCashStatement, bucketFor, BUCKET_LABELS } from '../services/cashManagement';
import { classifyVariance, expectedClosing, netMovement, VARIANCE_LABELS } from '../services/shifts';
import { parseManilaDateTime, parseDateKey, manilaDateKey } from '../services/manilaTime';
import type { BranchBalance, CashBucket, LedgerFlowRow } from '../services/cashManagement';
import type { ShiftMovement } from '../services/shifts';

const router = Router();

router.use(authenticate);

const parseDate = (value: unknown, field: string): Date | null => {
  if (value === undefined || value === null || value === '') return null;
  // A calendar day the operator picked, read in Manila rather than in this
  // host's UTC+3 — taken locally, the window would open five hours before the
  // day it names and quietly drop the last transactions of the day.
  const parsed = parseManilaDateTime(String(value));
  if (!parsed) throw createError(400, `${field} must be a valid date`);
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
    const branchScope = branchClause(req, 'a', 'accounts.read_all', 1, 'self');
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
      const priorScope = branchClause(req, 'l', 'accounts.read_all', 2, 'account');
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
    const flowScope = branchClause(req, 'l', 'accounts.read_all', flowParams.length + 1, 'account');
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

    // The drawer's own figure, deliberately outside `totals`.
    //
    // `totals.current` adds every account balance in scope — wallets, banks and
    // cash alike — which is what the company has on the books, not what any
    // branch could count out of a drawer. Reporting only that under the name
    // "cash on hand" is how the page came to call ₱122,372 the branch's cash
    // while the cash accounts held nothing. Two figures, two names, never
    // summed (design D14).
    const drawerConds = [`t.code = 'cash'`, ...branchConds];
    const drawerRow = await queryOne<{ balance: string }>(
      `SELECT COALESCE(SUM(a.current_balance), 0) AS balance
       FROM branches b
       JOIN accounts a ON a.branch_id = b.id
       JOIN account_types t ON t.id = a.account_type_id
       WHERE ${drawerConds.join(' AND ')}`,
      branchParams,
    );

    res.json({
      success: true,
      data: {
        period: {
          startDate: start ? start.toISOString().slice(0, 10) : null,
          endDate: end ? end.toISOString().slice(0, 10) : null,
        },
        ...statement,
        drawer: num(drawerRow?.balance),
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
    const scope = branchClause(req, 'l', 'accounts.read_all', params.length + 1, 'account');
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

// --- Shifts ---------------------------------------------------------------
//
// Opening and closing record what was counted. Neither writes a balance and
// neither writes a ledger row: the expected figure is arithmetic over movements
// that already exist, so a discrepancy stays an event to investigate instead of
// a balance somebody adjusted away (design D14).
//
// Permissions are the existing vocabulary — reports.read to look, transactions
// to open and close — so no new permission row is needed. Neither endpoint
// moves money, so neither carries an approval gate of its own.

const round2 = (n: number): number => Math.round(n * 100) / 100;

// A shift belongs to a branch directly rather than reaching it through an
// account, so assertBranch — which resolves a branch from account ids — cannot
// be used for it. Head office may act on any branch; anyone else only on one of
// their own, and 404 rather than 403 so a caller cannot use the response to
// prove a branch exists outside their own.
async function assertShiftBranch(req: Request, branchId: string, notFoundMessage: string): Promise<void> {
  if (!branchId) throw createError(400, 'Branch is required');
  if (!canSeeAll(req, 'branches.read_all')) {
    const branchIds = req.user?.branchIds ?? [];
    if (branchIds.length === 0) throw createError(403, 'No branch is assigned to your account');
    if (!branchIds.includes(branchId)) throw createError(404, notFoundMessage);
  }
  const exists = await queryOne<{ id: string }>('SELECT id FROM branches WHERE id = $1', [branchId]);
  if (!exists) throw createError(404, notFoundMessage);
}

// The drawer's own movements inside a window. Keyed on the branch's cash-type
// accounts rather than on one named account, because the drawer is the branch's
// physical cash whether or not it happens to be split across two of them — and
// anything that touched physical cash has to be in the count.
async function drawerMovements(branchId: string, from: Date, to: Date): Promise<ShiftMovement[]> {
  return query<ShiftMovement>(
    `SELECT l.entry_type, l.amount
     FROM ledger_entries l
     JOIN accounts a ON a.id = l.account_id
     JOIN account_types ct ON ct.id = a.account_type_id
     WHERE ct.code = 'cash' AND a.branch_id = $1
       AND l.entry_date >= $2 AND l.entry_date < $3`,
    [branchId, from.toISOString(), to.toISOString()],
  );
}

async function drawerBalance(branchId: string): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `SELECT COALESCE(SUM(a.current_balance), 0) AS balance
     FROM accounts a
     JOIN account_types t ON t.id = a.account_type_id
     WHERE t.code = 'cash' AND a.branch_id = $1`,
    [branchId],
  );
  return num(row?.balance);
}

router.get('/shifts', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : null;
    const branchFilter = req.query.branchId ? String(req.query.branchId) : null;

    const params: any[] = [];
    const conds: string[] = [];
    const scope = branchClause(req, 's', 'branches.read_all', 1, 'self');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }
    if (status) {
      conds.push(`s.status = $${params.length + 1}`);
      params.push(status);
    }
    if (branchFilter) {
      conds.push(`s.branch_id = $${params.length + 1}`);
      params.push(branchFilter);
    }

    // shift_date is re-cast after `s.*` so node-postgres's parsed DATE — local
    // midnight in this host's UTC+3 — is replaced by the day it names. The
    // later column wins in the row object, which is why it is written last.
    const rows = await query<any>(
      `SELECT s.*, s.shift_date::text AS shift_date, b.code AS branch_code, b.name AS branch_name,
              ou.username AS opened_by_username, cu.username AS closed_by_username
       FROM shifts s
       JOIN branches b ON b.id = s.branch_id
       LEFT JOIN users ou ON ou.id = s.opened_by
       LEFT JOIN users cu ON cu.id = s.closed_by
       ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY s.opened_at DESC
       LIMIT 200`,
      params,
    );

    // An open shift's expected figure is not known until it closes, so it is
    // computed live for the banner. A closed one carries its own.
    const now = new Date();
    const data = [];
    for (const row of rows) {
      if (row.status !== 'open') {
        data.push({ ...row, live: null });
        continue;
      }
      const movements = await drawerMovements(row.branch_id, new Date(row.opened_at), now);
      const expected = expectedClosing(row.opening_float, movements);
      const balance = await drawerBalance(row.branch_id);
      data.push({
        ...row,
        live: {
          movementCount: movements.length,
          cashIn: netMovement(movements.filter((m) => m.entry_type === 'credit')),
          cashOut: netMovement(movements.filter((m) => m.entry_type === 'debit')),
          netMovement: netMovement(movements),
          expected,
          drawerBalance: balance,
          drawerDifference: round2(expected - balance),
        },
      });
    }

    const accountScope = branchClause(req, 'a', 'accounts.read_all', 1, 'self');
    const drawerConds = [`t.code = 'cash'`];
    const drawerParams: any[] = [];
    if (accountScope.clause) {
      drawerConds.push(accountScope.clause);
      drawerParams.push(...accountScope.params);
    }
    if (branchFilter) {
      drawerConds.push(`a.branch_id = $${drawerParams.length + 1}`);
      drawerParams.push(branchFilter);
    }
    const drawerRows = await query<{ branch_id: string; balance: string }>(
      `SELECT a.branch_id, COALESCE(SUM(a.current_balance), 0) AS balance
       FROM accounts a
       JOIN account_types t ON t.id = a.account_type_id
       WHERE ${drawerConds.join(' AND ')}
       GROUP BY a.branch_id`,
      drawerParams,
    );

    // Returned for branches with no open shift as well as those with one: the
    // operator needs to know what the books say before entering what they
    // count, and the two are shown side by side rather than merged. If the
    // counted float were prefilled from this figure it could never disagree
    // with it, and the cross-check would have nothing to catch (design D16).
    const drawers = drawerRows.map((row) => ({ branchId: row.branch_id, balance: num(row.balance) }));

    res.json({ success: true, data: { shifts: data, drawers } });
  } catch (error) {
    next(error);
  }
});

router.post('/shifts/open', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body || {};
    const branchId = String(body.branchId || '');
    await assertShiftBranch(req, branchId, 'Branch not found');

    const openingFloat = parseFloat(String(body.openingFloat ?? ''));
    if (!Number.isFinite(openingFloat)) throw createError(400, 'Opening float must be a number');
    if (openingFloat < 0) throw createError(400, 'Opening float cannot be negative');

    // The day the shift covers is the operator's to state, so every movement
    // recorded under it has a date to be held to (D17). Refused if it is not a
    // real calendar day, and refused if it is ahead of Manila's today: a shift
    // for tomorrow would accept tomorrow's transactions today, which is the
    // drawer counting money before it exists.
    const shiftDate = String(body.shiftDate ?? '').trim();
    if (!parseDateKey(shiftDate)) {
      throw createError(400, 'Shift date is required, as a valid date (YYYY-MM-DD)');
    }
    const today = manilaDateKey();
    if (shiftDate > today) {
      throw createError(400, `Shift date cannot be in the future — today is ${today}`);
    }

    let shift;
    try {
      shift = await queryOne(
        `INSERT INTO shifts (branch_id, shift_date, opening_float, opened_by, notes)
         VALUES ($1, $2::date, $3, $4, $5)
         RETURNING *, shift_date::text AS shift_date`,
        [
          branchId, shiftDate, round2(openingFloat), req.user!.userId,
          body.notes ? String(body.notes).trim() || null : null,
        ],
      );
    } catch (err: any) {
      // The partial unique index is the real guard. Checked here as well so the
      // refusal is a sentence instead of a foreign-key style error, but the
      // index is what makes it hold when two terminals open at once.
      if (err?.code === '23505') throw createError(409, 'This branch already has an open shift');
      throw err;
    }

    res.status(201).json({ success: true, data: shift });
  } catch (error) {
    next(error);
  }
});

router.post('/shifts/:id/close', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shift = await queryOne<any>('SELECT *, shift_date::text AS shift_date FROM shifts WHERE id = $1', [req.params.id]);
    if (!shift) throw createError(404, 'Shift not found');
    await assertShiftBranch(req, shift.branch_id, 'Shift not found');
    if (shift.status !== 'open') throw createError(400, 'This shift is already closed');

    const body = req.body || {};
    const countedClosing = parseFloat(String(body.countedClosing ?? ''));
    if (!Number.isFinite(countedClosing)) throw createError(400, 'Counted closing cash must be a number');
    if (countedClosing < 0) throw createError(400, 'Counted closing cash cannot be negative');

    const movements = await drawerMovements(shift.branch_id, new Date(shift.opened_at), new Date());
    const report = classifyVariance(shift.opening_float, movements, countedClosing);
    const balance = await drawerBalance(shift.branch_id);

    // Guarded on status so two people closing at once cannot both write: the
    // second finds no open row and is refused.
    const updated = await queryOne<any>(
      `UPDATE shifts
       SET status = 'closed', counted_closing = $1, expected_closing = $2, variance = $3,
           closed_at = NOW(), closed_by = $4, notes = COALESCE($5, notes), updated_at = NOW()
       WHERE id = $6 AND status = 'open'
       RETURNING *, shift_date::text AS shift_date`,
      [
        report.counted, report.expected, report.variance,
        req.user!.userId, body.notes ? String(body.notes).trim() || null : null, shift.id,
      ],
    );
    if (!updated) throw createError(409, 'This shift was already closed by someone else');

    res.json({
      success: true,
      data: {
        ...updated,
        varianceLabel: VARIANCE_LABELS[report.status],
        // The second reading. Expected comes from the counted float plus
        // movements; this is what the books say the drawer holds. They are
        // derived from different things precisely so they can disagree, and a
        // non-zero difference is the signal that the float or the movements are
        // wrong (design D16).
        drawerBalance: balance,
        drawerDifference: round2(report.expected - balance),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/shifts/:id/movements', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shift = await queryOne<any>('SELECT *, shift_date::text AS shift_date FROM shifts WHERE id = $1', [req.params.id]);
    if (!shift) throw createError(404, 'Shift not found');
    await assertShiftBranch(req, shift.branch_id, 'Shift not found');

    const from = new Date(shift.opened_at);
    const to = shift.closed_at ? new Date(shift.closed_at) : new Date();

    const rows = await query<any>(
      `SELECT l.id, l.entry_date, l.entry_type, l.amount, l.balance_after, l.source_type,
              l.reference_number, l.description, a.name AS account_name,
              t.transaction_number, t.payee, tt.code AS txn_code
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       JOIN account_types ct ON ct.id = a.account_type_id
       LEFT JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
       WHERE ct.code = 'cash' AND a.branch_id = $1
         AND l.entry_date >= $2 AND l.entry_date < $3
       ORDER BY l.entry_date, l.id`,
      [shift.branch_id, from.toISOString(), to.toISOString()],
    );

    res.json({
      success: true,
      data: {
        shift,
        netMovement: netMovement(rows),
        expected: expectedClosing(shift.opening_float, rows),
        rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
