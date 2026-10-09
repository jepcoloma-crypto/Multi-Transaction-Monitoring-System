import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { branchClause, canSeeAll, resolveBranchFilter } from '../middleware/scope';
import { buildCashStatement, bucketFor, BUCKET_LABELS, toCashRecordRow, cashRecordsCsv, cashExpenseTotal } from '../services/cashManagement';
import { drawerMovements, drawerBalance, drawerMovementRows } from '../services/drawerQuery';
import { classifyVariance, expectedClosing, netMovement, VARIANCE_LABELS, countDetailError, normalizeCountDetail, varianceReasonError, VARIANCE_REASONS, DENOMINATIONS } from '../services/shifts';
import { parseManilaDateTime, parseDateKey, manilaDateKey, entryDateBounds } from '../services/manilaTime';
import { expenseApprovalThreshold } from '../services/settings';
import type { BranchBalance, CashBucket, LedgerFlowRow, CashRecordRaw } from '../services/cashManagement';

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

    const flowBounds = entryDateBounds('l', 1, start, end);
    const flowConds = [...flowBounds.conds];
    const flowParams: any[] = [...flowBounds.params];
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
    const drawerRow = await queryOne<{ balance: string; account_names: string | null }>(
      `SELECT COALESCE(SUM(a.current_balance), 0) AS balance,
              string_agg(DISTINCT a.name, ', ' ORDER BY a.name) AS account_names
       FROM branches b
       JOIN accounts a ON a.branch_id = b.id
       JOIN account_types t ON t.id = a.account_type_id
       WHERE ${drawerConds.join(' AND ')}`,
      branchParams,
    );

    // What is still owed, counted from the beginning of the books up to the
    // end of the period rather than across it.
    //
    // Across the window would be wrong in the one case this figure exists for:
    // a loan taken in September and untouched in October reads ₱0 owed under an
    // October period, which is precisely when the operator wants to know it.
    // Ending where the period ends keeps it true for any period, and still
    // answers "what do I owe now" whenever the period reaches today — with no
    // end date it runs to the end of the ledger. The upper bound is the same
    // `entryDateBounds` the flow above uses, so the two cannot drift apart.
    const borrowBounds = entryDateBounds('l', 1, null, end);
    const borrowConds = [`tt.code IN ('loan_received', 'loan_repayment')`, ...borrowBounds.conds];
    const borrowParams: any[] = [...borrowBounds.params];
    const borrowScope = branchClause(req, 'l', 'accounts.read_all', borrowParams.length + 1, 'account');
    if (borrowScope.clause) {
      borrowConds.push(borrowScope.clause);
      borrowParams.push(...borrowScope.params);
    }
    if (branchFilter) {
      borrowConds.push(`a.branch_id = $${borrowParams.length + 1}`);
      borrowParams.push(branchFilter);
    }
    const borrowRow = await queryOne<{ outstanding: string }>(
      `SELECT COALESCE(SUM(CASE WHEN l.entry_type = 'credit' THEN l.amount ELSE -l.amount END), 0) AS outstanding
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
       WHERE ${borrowConds.join(' AND ')}`,
      borrowParams,
    );

    res.json({
      success: true,
      data: {
        period: {
          // The Manila day the operator picked, read back in Manila. Slicing
          // the instant would print the UTC day — one day early for both ends —
          // so a report filed under the wrong period would look perfectly
          // well-formed while naming a range it never ran.
          startDate: start ? manilaDateKey(start) : null,
          endDate: end ? manilaDateKey(end) : null,
        },
        ...statement,
        drawer: num(drawerRow?.balance),
        // The accounts that figure sums. The drawer is one number under two
        // names — the account holding the cash and the line totalling it — and
        // a reader who does not know that sees two pots holding the same peso.
        drawerAccounts: drawerRow?.account_names ?? '',
        // Borrowed money still outstanding. Deliberately beside the drawer
        // figure rather than inside `statement.totals`: a liability is not part
        // of the opening-plus-sources-minus-uses identity, and folding it in
        // would break the tie-out the statement exists to satisfy.
        borrowingsOutstanding: num(borrowRow?.outstanding),
        // Served beside the drawer figure for the same reason: the expense form
        // on this page has to say what the books will do, and the create route
        // decides that from this number. The operator role holds no
        // settings.read, so this is the one place the form can read it from.
        expenseApprovalThreshold: await expenseApprovalThreshold(),
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

    const periodBounds = entryDateBounds('l', 1, start, end);
    const conds = [...periodBounds.conds];
    const params: any[] = [...periodBounds.params];
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
      const movements = await drawerMovements(row.branch_id, row.opened_at, now);
      const expected = expectedClosing(row.opening_float, movements);
      const balance = await drawerBalance(row.branch_id);
      data.push({
        ...row,
        live: {
          movementCount: movements.length,
          cashIn: netMovement(movements.filter((m) => m.entry_type === 'credit')),
          // Magnitude, not the signed net: the banner prints its own "−" and
          // formatCurrency adds another for a negative, giving "−-₱1,500".
          cashOut: Math.abs(netMovement(movements.filter((m) => m.entry_type === 'debit'))),
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

    // The vocabulary rides along with the shift data rather than being copied
    // into the client: a reason list the server would reject is worse than no
    // list at all, and one maintained in two places is a list maintained in
    // one place badly.
    res.json({
      success: true,
      data: { shifts: data, drawers, denominations: DENOMINATIONS, varianceReasons: VARIANCE_REASONS },
    });
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

    // Both checks run before anything is written, so a close that would have
    // been refused leaves the shift open rather than half-recorded.
    const countDetail = normalizeCountDetail(body.countDetail);
    const detailProblem = countDetailError(body.countDetail, countedClosing);
    if (detailProblem) throw createError(400, detailProblem);

    const movements = await drawerMovements(shift.branch_id, shift.opened_at, new Date());
    const report = classifyVariance(shift.opening_float, movements, countedClosing);
    const balance = await drawerBalance(shift.branch_id);

    const notes = body.notes ? String(body.notes).trim() || null : null;
    const reasonProblem = varianceReasonError(report.variance, body.varianceReason, notes);
    if (reasonProblem) throw createError(400, reasonProblem);
    // A balanced shift owes no explanation and stores none: a reason beside a
    // zero variance would read as an incident nobody had.
    const reason = report.status === 'balanced' ? null : String(body.varianceReason ?? '').trim();

    // Guarded on status so two people closing at once cannot both write: the
    // second finds no open row and is refused.
    const updated = await queryOne<any>(
      `UPDATE shifts
       SET status = 'closed', counted_closing = $1, expected_closing = $2, variance = $3,
           closed_at = NOW(), closed_by = $4, notes = COALESCE($5, notes),
           count_detail = $6, variance_reason = $7, updated_at = NOW()
       WHERE id = $8 AND status = 'open'
       RETURNING *, shift_date::text AS shift_date`,
      [
        report.counted, report.expected, report.variance,
        req.user!.userId, notes,
        countDetail === null ? null : JSON.stringify(countDetail),
        reason, shift.id,
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

// Shifts that closed short or over and nobody has answered for yet. D14 calls
// a discrepancy an event needing investigation; this is the list of the ones
// still waiting for it, so a shortage cannot quietly disappear into history
// simply because a later shift balanced.
router.get('/variances', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conds: string[] = [`s.status = 'closed'`, `s.variance IS NOT NULL`, `s.variance <> 0`, `s.variance_resolved_at IS NULL`];
    const params: any[] = [];
    const scope = branchClause(req, 's', 'branches.read_all', 1, 'self');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }

    const rows = await query<any>(
      `SELECT s.id, s.branch_id, s.shift_date::text AS shift_date, s.variance,
              s.counted_closing, s.expected_closing, s.variance_reason, s.notes,
              s.closed_at, b.code AS branch_code, b.name AS branch_name,
              cu.username AS closed_by_username
       FROM shifts s
       JOIN branches b ON b.id = s.branch_id
       LEFT JOIN users cu ON cu.id = s.closed_by
       WHERE ${conds.join(' AND ')}
       ORDER BY s.closed_at DESC
       LIMIT 100`,
      params,
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Recording that a variance has been looked into. It moves no money and
// changes no count — the columns it touches are the only ones here that may be
// written after the shift locks, because an enquiry into a shortage is a fact
// about the enquiry rather than a correction of the drawer. Administrator-only
// for the same reason a reconciliation adjustment is: the shortage happened
// under whoever closed the shift, and they are not the one who gets to say it
// has been dealt with.
router.post('/shifts/:id/variance/resolve', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(req.user!.roles || []).includes('administrator')) {
      return next(createError(403, 'Only administrators can close a variance'));
    }

    const shift = await queryOne<any>(
      `SELECT s.*, s.shift_date::text AS shift_date FROM shifts s WHERE s.id = $1`,
      [req.params.id],
    );
    if (!shift) throw createError(404, 'Shift not found');
    await assertShiftBranch(req, shift.branch_id, 'Shift not found');

    if (shift.status !== 'closed') throw createError(400, 'This shift is still open, so it has no variance to close');
    if (Number(shift.variance) === 0) throw createError(400, 'This shift balanced, so there is no variance to close');
    if (shift.variance_resolved_at) throw createError(409, 'This variance has already been closed');

    // Guarded on variance_resolved_at rather than on a status field: the row
    // is otherwise immutable, and the second administrator to click finds no
    // open variance rather than a second resolution to write.
    const updated = await queryOne<any>(
      `UPDATE shifts
       SET variance_resolved_at = NOW(), variance_resolved_by = $1, updated_at = NOW()
       WHERE id = $2 AND variance_resolved_at IS NULL
       RETURNING *`,
      [req.user!.userId, shift.id],
    );
    if (!updated) throw createError(409, 'This variance was already closed by someone else');

    res.json({ success: true, data: { ...updated, resolved_by_username: req.user!.username } });
  } catch (error) {
    next(error);
  }
});

router.get('/shifts/:id/movements', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shift = await queryOne<any>('SELECT *, shift_date::text AS shift_date FROM shifts WHERE id = $1', [req.params.id]);
    if (!shift) throw createError(404, 'Shift not found');
    await assertShiftBranch(req, shift.branch_id, 'Shift not found');

    const rows = await drawerMovementRows(shift.branch_id, shift.opened_at, shift.closed_at);

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

// Every ledger row that touched a branch's cash accounts, newest first. The
// drawer's full history — the list behind "Total on the books" and "Cash on
// hand", in the order the balance moved.
//
// Ordered by the same day each row files under — the transaction's business
// date where one exists, the posting instant otherwise — so a back-dated entry
// sits where its date says it does and the order matches the dates printed.
//
// No period. A register of what has been recorded is a point-in-time question
// and needs no window; the period-shaped cash analysis stays the position
// statement in Reports (D18). What narrows this list is the branch, the class
// and a search — never a date.
//
// The whole scoped population is read once and classified in code with
// `bucketFor`, the same function the position statement totals by. A second
// SQL copy of that classification could disagree with the statement's totals,
// and the type filter is only ever as trustworthy as the totals it slices. The
// population is the branch's cash rows — the same set `/statement` already
// reads unbounded — so reading it whole costs what that page already pays.
router.get('/records', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchFilter = await resolveBranchFilter(req, req.query.branchId);
    const typeFilter = req.query.type ? String(req.query.type) : null;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

    if (typeFilter && !Object.prototype.hasOwnProperty.call(BUCKET_LABELS, typeFilter)) {
      throw createError(400, 'Unknown cash record type');
    }

    const conds: string[] = [`ct.code = 'cash'`];
    const params: any[] = [];

    // Scoped on the ledger row's own account, the same link the shift movements
    // endpoint uses — the drawer is the branch's cash accounts, not one wallet.
    const scope = branchClause(req, 'l', 'accounts.read_all', 1, 'account');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }
    if (branchFilter) {
      conds.push(`a.branch_id = $${params.length + 1}`);
      params.push(branchFilter);
    }
    if (search) {
      // COALESCE so a NULL description cannot blank the row: a search hits if
      // any of its named fields does, and every field is compared as text.
      conds.push(`(COALESCE(l.description, '') ILIKE $${params.length + 1}
                   OR COALESCE(l.reference_number, '') ILIKE $${params.length + 1}
                   OR COALESCE(t.payee, '') ILIKE $${params.length + 1}
                   OR CAST(t.transaction_number AS TEXT) ILIKE $${params.length + 1})`);
      params.push(`%${search}%`);
    }

    const rows = await query<CashRecordRaw>(
      `SELECT l.id, l.entry_date, l.entry_type, l.amount, l.balance_after,
              l.source_type, l.reference_number, l.description,
              a.name AS account_name, b.code AS branch_code, b.name AS branch_name,
              t.id AS transaction_id, t.transaction_number, t.payee, t.payment_method, t.transaction_date,
              tt.code AS txn_code, u.username AS created_by_username
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       JOIN account_types ct ON ct.id = a.account_type_id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN transaction_types tt ON tt.id = t.transaction_type_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE ${conds.join(' AND ')}
       ORDER BY COALESCE(t.transaction_date, l.entry_date) DESC, l.id DESC`,
      params,
    );

    const all = rows.map(toCashRecordRow);

    // The classes offered are built from this population, so a dropdown can
    // never offer a class that yields nothing or hide one that yields rows.
    const classCounts = new Map<CashBucket, number>();
    for (const row of all) classCounts.set(row.bucket, (classCounts.get(row.bucket) || 0) + 1);
    const classes = [...classCounts.entries()]
      .map(([bucket, count]) => ({ bucket, label: BUCKET_LABELS[bucket], count }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const filtered = typeFilter ? all.filter((row) => row.bucket === typeFilter) : all;
    const total = filtered.length;
    const records = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    if (format === 'csv') {
      // The export carries the whole filtered register, not the page: a file
      // that held one screen of rows under a header naming the branch would be
      // the printed-scope problem again.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="cash-records.csv"');
      return res.send(cashRecordsCsv(filtered));
    }

    res.json({
      success: true,
      data: {
        records,
        classes,
        // Over `filtered`, never `records`: the page is a slice, so a total
        // taken here would read as the register's while describing one screen.
        totals: { cashExpenses: cashExpenseTotal(filtered) },
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) { next(error); }
});

export default router;
