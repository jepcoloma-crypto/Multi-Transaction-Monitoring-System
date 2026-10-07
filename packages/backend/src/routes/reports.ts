import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import type { AccountLink } from '../middleware/scope';
import { branchClause, assertBranch, resolveBranchFilter } from '../middleware/scope';
import { auditLedger } from '../services/ledgerAudit';
import { buildReversalReport, reversalReason } from '../services/reversalReport';
import { buildIncomeReport, buildIncomeDetail, type IncomeReport } from '../services/incomeReport';
import { buildExpenseReport, buildExpenseDetail, type ExpenseReport, type ExpenseDetail } from '../services/expenseReport';
import { statementReversal } from '../services/statementReversal';
import { loadScopedLedger } from '../services/ledgerQuery';
import { drawerMovements } from '../services/drawerQuery';
import { netMovement } from '../services/shifts';
import { buildShiftReport } from '../services/shiftReport';

const router = Router();
router.use(authenticate);

const round2 = (n: number) => Math.round(n * 100) / 100;

// One branch's share of every consolidated figure (D20). Built by folding the
// grouped rows of five queries into a single map, so the totals above it are
// that same list summed — never a second query over the same rows.
interface ConsolidatedBranch {
  branchId: string | null;
  branchName: string;
  accounts: { count: number; totalBalance: number };
  transactions: { count: number; totalIn: number; totalOut: number };
  transfers: { count: number; totalAmount: number; totalFees: number };
  loading: { count: number; totalRevenue: number; totalProfit: number };
  reconciliation: { total: number; reconciled: number };
}

// Where a reversal leaves its trail: the compensating entry, the request that
// authorised it and the audit entry a direct administrator reversal writes
// instead. Every query that has to say why a transaction is reversed joins the
// same three, because reading only one of them reports blanks for the reversals
// that were never requested. Guarded on t.status so a row that is not reversed
// costs a boolean test rather than three index probes.
const REVERSAL_TRAIL_JOINS = `
  LEFT JOIN LATERAL (
    SELECT r.id, r.reference_number, r.transaction_number, r.amount, r.created_at, r.description
    FROM transactions r
    WHERE t.status = 'reversed'
      AND r.reference_number = 'REV-' || t.transaction_number::text
      AND r.status = 'completed'
      AND r.description LIKE 'Reversal:%'
    ORDER BY r.created_at ASC
    LIMIT 1
  ) rev ON true
  LEFT JOIN LATERAL (
    SELECT p.status, p.reason, p.requested_by, p.approved_by, p.created_at, p.updated_at
    FROM pending_reversals p
    WHERE t.status = 'reversed'
      AND p.entity_type = 'transaction' AND p.entity_id = t.id
    ORDER BY (p.status = 'approved') DESC, p.created_at DESC
    LIMIT 1
  ) pr ON true
  LEFT JOIN LATERAL (
    SELECT al.user_id, al.new_data->>'reason' AS reason
    FROM audit_logs al
    WHERE t.status = 'reversed'
      AND al.entity_id = t.id::text AND al.action = 'transaction.reversed'
    ORDER BY al.created_at DESC
    LIMIT 1
  ) audit ON true
`;

router.get('/account-statement', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId) return res.status(400).json({ success: false, error: { message: 'accountId is required' } });
    // Here the account is the filter, so a branch narrows the account lookup
    // rather than the entry query: a branch/account pair that contradicts
    // itself must be an error, never a statement with no rows in it.
    const branchId = await resolveBranchFilter(req, req.query.branchId);

    const conds: string[] = ['le.account_id = $1'];
    const params: any[] = [accountId];
    let pi = 2;
    if (startDate) { conds.push(`le.entry_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`le.entry_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const account = await queryOne(
      `SELECT * FROM accounts WHERE id = $1${branchId ? ' AND branch_id = $2' : ''}`,
      branchId ? [accountId, branchId] : [accountId],
    );
    await assertBranch(req, account?.id, 'accounts.read_all', 'Account not found');
    const entries = await query(
      `SELECT le.id, le.entry_type, le.amount, le.balance_after, le.reference_number,
              le.description, le.entry_date, le.created_at, le.transaction_id, le.transfer_id,
              le.source_type, le.source_id,
              t.transaction_number, t.status AS transaction_status, t.customer_name, t.customer_contact,
              t.fee, t.net_amount, t.additional_charges, t.payment_method, t.notes,
              t.reference_number AS transaction_reference, t.description AS transaction_description,
              t.transaction_date, t.created_at AS transaction_created_at,
              tt.name AS type_name, tt.code AS type_code, tt.direction,
              tr.status AS transfer_status, tr.transfer_number, tr.transfer_reference,
              tr.purpose AS transfer_purpose, tr.transfer_amount, tr.transfer_fee,
              ltx.transaction_number AS loading_number,
              sa.name AS source_account_name, da.name AS destination_account_name,
              pr.reason AS reversal_request_reason, audit.reason AS reversal_audit_reason,
              rev.description AS reversal_entry_description,
              rev.reference_number AS reversal_reference,
              reverses_of.id AS reverses_id,
              reverses_of.transaction_number AS reverses_number,
              reverses_type.name AS reverses_type_name
       FROM ledger_entries le
       LEFT JOIN transactions t ON le.transaction_id = t.id
       LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transfers tr ON le.transfer_id = tr.id
       LEFT JOIN accounts sa ON tr.source_account_id = sa.id
       LEFT JOIN accounts da ON tr.destination_account_id = da.id
       LEFT JOIN loading_transactions ltx
         ON ltx.id = le.source_id AND le.source_type = 'loading'
       LEFT JOIN transactions reverses_of
         ON reverses_of.transaction_number = substring(le.reference_number from '^REV-([0-9]+)$')::int
       LEFT JOIN transaction_types reverses_type ON reverses_type.id = reverses_of.transaction_type_id
       ${REVERSAL_TRAIL_JOINS}
       ${wc} ORDER BY le.created_at ASC, le.id ASC`, params
    );

    const moneyIn = entries.filter((e: any) => e.entry_type === 'credit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0);
    const moneyOut = entries.filter((e: any) => e.entry_type === 'debit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0);

    let running = entries.length > 0
      ? parseFloat(entries[0].balance_after) - (entries[0].entry_type === 'credit' ? parseFloat(entries[0].amount) : -parseFloat(entries[0].amount))
      : parseFloat(account.opening_balance || '0');
    const openingBalance = running;
    const statement = entries.map((e: any) => {
      const {
        reversal_request_reason, reversal_audit_reason, reversal_entry_description,
        reverses_id, reverses_number, reverses_type_name, ...entry
      } = e;
      running = parseFloat(e.balance_after);
      const charges = Array.isArray(e.additional_charges)
        ? e.additional_charges.reduce((s: number, c: any) => s + (parseFloat(c?.amount) || 0), 0)
        : 0;
      const rev = statementReversal({
        reference_number: e.reference_number,
        description: e.description,
        transaction_id: e.transaction_id,
        transaction_number: e.transaction_number,
        transaction_reference: e.transaction_reference,
        transaction_status: e.transaction_status,
        transfer_id: e.transfer_id,
        transfer_status: e.transfer_status,
        transfer_reference: e.transfer_reference,
        loading_number: e.loading_number,
        type_name: e.type_name,
        reversal_request_reason,
        reversal_audit_reason,
        reversal_entry_description,
        reverses_id,
        reverses_number,
        reverses_type_name,
      });
      const entrySource = e.source_type ?? (e.transaction_id ? 'transaction'
        : e.transfer_id ? 'transfer'
        : /^loading\b/i.test(e.description || '') ? 'loading'
        : 'adjustment');
      // An amount correction appends a delta row but deliberately keeps the
      // source record's type and id on it, so without this the row reads as an
      // ordinary transfer, transaction or loading entry — the same numbers and
      // badge as the row it corrects. The prefix is the only durable marker:
      // ledger_entries has no correction column and its reference_number is
      // left NULL, and this is the string corrections.ts writes on every row.
      const isCorrection = /^Correction:/.test(e.description || '');
      return {
        ...entry,
        is_correction: isCorrection,
        reversal_reason: rev.reason,
        is_compensating: rev.isCompensating,
        reversal_resolves_to: rev.resolvesTo,
        reversal_of_number: rev.ofNumber,
        statement_status: rev.status,
        running_balance: running,
        charges_total: charges,
        entry_source: entrySource,
        display_name: rev.label ?? (e.transaction_number
          ? `${e.type_name || 'Transaction'} #${e.transaction_number}`
          : e.transfer_id
            ? `Transfer ${e.transfer_number ? `#${e.transfer_number} ` : ''}${e.source_account_name || '?'} → ${e.destination_account_name || '?'}`
            : e.description || 'Adjustment'),
        type_display: isCorrection ? 'Correction'
          : rev.typeDisplay ?? (entrySource ? entrySource.charAt(0).toUpperCase() + entrySource.slice(1) : e.entry_type),
        reference_display: rev.referenceDisplay,
        number_display: rev.numberDisplay,
      };
    });

    const lastBalance = entries.length > 0 ? parseFloat(entries[entries.length - 1].balance_after) : null;
    const currentBalance = parseFloat(account.current_balance);
    const reconciled = lastBalance !== null
      ? lastBalance === currentBalance
      : openingBalance === currentBalance;

    res.json({
      success: true, data: {
        account,
        entries: statement,
        openingBalance,
        closingBalance: lastBalance ?? currentBalance,
        reconciled,
        reconciliationGap: round2((lastBalance ?? currentBalance) - currentBalance),
        summary: {
          totalIn: moneyIn,
          totalOut: moneyOut,
          netMovement: moneyIn - moneyOut,
          entryCount: entries.length,
          openingBalance,
          closingBalance: lastBalance ?? currentBalance,
          currentBalance,
        },
      }
    });
  } catch (error) { next(error); }
});

router.get('/balance-reconciliation', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const scope = branchClause(req, 'a', 'accounts.read_all', 1, 'self', branchId);
    const { accounts, entries } = await loadScopedLedger(scope);

    res.json({ success: true, data: auditLedger(accounts, entries) });
  } catch (error) { next(error); }
});

router.get('/transaction-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, accountId, typeId } = req.query;
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const conds: string[] = [`t.status NOT IN ($1, 'pending', 'rejected')`];
    const params: any[] = ['reversed'];
    let pi = 2;
    if (startDate) { conds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (accountId) { conds.push(`t.account_id = $${pi++}`); params.push(accountId); }
    if (typeId) { conds.push(`t.transaction_type_id = $${pi++}`); params.push(typeId); }
    const scope = branchClause(req, 't', 'transactions.read_all', pi, 'account', branchId);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const transactions = await query(
      `SELECT t.*, tt.name as type_name, tt.direction, tc.name as category_name, a.name as account_name,
              a.branch_id, b.name as branch_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN branches b ON b.id = a.branch_id
       ${wc} ORDER BY t.transaction_date DESC`, params
    );

    const summary = await queryOne(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
              COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out,
              COALESCE(SUM(CASE WHEN tt.direction = 'adjustment' THEN t.amount + chg.total ELSE 0 END), 0) as total_adjustments
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${wc}`, params
    );

    res.json({ success: true, data: { transactions, summary: { count: parseInt(summary?.count || '0'), totalIn: parseFloat(summary?.total_in || '0'), totalOut: parseFloat(summary?.total_out || '0'), totalAdjustments: parseFloat(summary?.total_adjustments || '0') } } });
  } catch (error) { next(error); }
});

router.get('/transfer-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, status } = req.query;
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`t.transfer_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`t.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (status) { conds.push(`t.status = $${pi++}`); params.push(status); }
    const scope = branchClause(req, 't', 'transfers.read_all', pi, 'transfer', branchId);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const transfers = await query(
      `SELECT t.*, sa.name as source_name, da.name as destination_name,
              sa.branch_id, sb.name as branch_name
       FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id JOIN accounts da ON t.destination_account_id = da.id
       LEFT JOIN branches sb ON sb.id = sa.branch_id
       ${wc} ORDER BY t.transfer_date DESC`, params
    );

    const summary = await queryOne(
      `SELECT COUNT(*) as count, COALESCE(SUM(transfer_amount), 0) as total_amount,
              COALESCE(SUM(transfer_fee), 0) as total_fees
       FROM transfers t ${wc}`, params
    );

    res.json({ success: true, data: { transfers, summary: { count: parseInt(summary?.count || '0'), totalAmount: parseFloat(summary?.total_amount || '0'), totalFees: parseFloat(summary?.total_fees || '0') } } });
  } catch (error) { next(error); }
});

router.get('/loading-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, providerId } = req.query;
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const conds: string[] = ["lt.status = 'completed'"];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (providerId) { conds.push(`lp.provider_id = $${pi++}`); params.push(providerId); }
    const scope = branchClause(req, 'lt', 'loading.read_all', pi, 'account', branchId);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const sales = await query(
      `SELECT lt.*, lp.name as product_name, lp.cost_price, lp.selling_price, p.name as provider_name, a.name as account_name,
              a.branch_id, b.name as branch_name
       FROM loading_transactions lt
       JOIN loading_products lp ON lt.product_id = lp.id
       JOIN providers p ON lp.provider_id = p.id
       JOIN accounts a ON lt.account_id = a.id
       LEFT JOIN branches b ON b.id = a.branch_id
       ${wc} ORDER BY lt.created_at DESC`, params
    );

    const summary = await queryOne(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_revenue), 0) as total_revenue,
              COALESCE(SUM(total_cost), 0) as total_cost, COALESCE(SUM(profit), 0) as total_profit,
              COALESCE(SUM(quantity), 0) as total_quantity
       FROM loading_transactions lt
       JOIN loading_products lp ON lt.product_id = lp.id
       ${wc}`, params
    );

    const byProvider = await query(
      `SELECT p.name as provider_name, COUNT(*) as count, COALESCE(SUM(lt.profit), 0) as profit
       FROM loading_transactions lt
       JOIN loading_products lp ON lt.product_id = lp.id
       JOIN providers p ON lp.provider_id = p.id
       ${wc} GROUP BY p.id, p.name ORDER BY profit DESC`, params
    );

    res.json({ success: true, data: { sales, summary: { count: parseInt(summary?.count || '0'), totalRevenue: parseFloat(summary?.total_revenue || '0'), totalCost: parseFloat(summary?.total_cost || '0'), totalProfit: parseFloat(summary?.total_profit || '0'), totalQuantity: parseInt(summary?.total_quantity || '0') }, byProvider } });
  } catch (error) { next(error); }
});

router.get('/consolidated', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Five figures, each asked once and grouped by branch (D20).
    //
    // The grand total is summed from those same groups rather than queried a
    // second time: a total computed separately from the subtotals that sit
    // under it is two implementations of one number, and the two are then
    // free to disagree about the same rows. An empty branch produces no group
    // at all, so its figures come out as zero — the same answer the flat query
    // gave it.
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const accountScope = branchClause(req, 'accounts', 'accounts.read_all', 1, 'self', branchId);
    const txScope = branchClause(req, 't', 'transactions.read_all', 1, 'account', branchId);
    const transferScope = branchClause(req, 'transfers', 'transfers.read_all', 1, 'transfer', branchId);
    const loadingScope = branchClause(req, 'loading_transactions', 'loading.read_all', 1, 'account', branchId);
    const reconScope = branchClause(req, 'reconciliations', 'accounts.read_all', 1, 'account', branchId);

    // LEFT JOINs throughout: an orphaned row belongs to no branch and must
    // still be counted once, under a null branch, rather than quietly leaving
    // the total it has always been part of.
    const accountRows = await query<any>(
      `SELECT accounts.branch_id, b.name AS branch_name,
              COUNT(*) AS count, COALESCE(SUM(accounts.current_balance), 0) AS total_balance
       FROM accounts
       LEFT JOIN branches b ON b.id = accounts.branch_id
       WHERE accounts.status = 'active'${accountScope.clause ? ` AND ${accountScope.clause}` : ''}
       GROUP BY accounts.branch_id, b.name`,
      accountScope.params
    );
    const txRows = await query<any>(
      `SELECT a.branch_id, b.name AS branch_name,
              COUNT(*) as count,
              COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
              COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       WHERE t.status != 'reversed'${txScope.clause ? ` AND ${txScope.clause}` : ''}
       GROUP BY a.branch_id, b.name`,
      txScope.params
    );
    const transferRows = await query<any>(
      `SELECT sa.branch_id, b.name AS branch_name,
              COUNT(*) as count,
              COALESCE(SUM(transfers.transfer_amount), 0) as total_amount,
              COALESCE(SUM(transfers.transfer_fee), 0) as total_fees
       FROM transfers
       LEFT JOIN accounts sa ON sa.id = transfers.source_account_id
       LEFT JOIN branches b ON b.id = sa.branch_id
       WHERE transfers.status = 'completed'${transferScope.clause ? ` AND ${transferScope.clause}` : ''}
       GROUP BY sa.branch_id, b.name`,
      transferScope.params
    );
    const loadingRows = await query<any>(
      `SELECT a.branch_id, b.name AS branch_name,
              COUNT(*) as count,
              COALESCE(SUM(loading_transactions.total_revenue), 0) as revenue,
              COALESCE(SUM(loading_transactions.profit), 0) as profit
       FROM loading_transactions
       LEFT JOIN accounts a ON a.id = loading_transactions.account_id
       LEFT JOIN branches b ON b.id = a.branch_id
       WHERE loading_transactions.status = 'completed'${loadingScope.clause ? ` AND ${loadingScope.clause}` : ''}
       GROUP BY a.branch_id, b.name`,
      loadingScope.params
    );
    const reconRows = await query<any>(
      `SELECT a.branch_id, b.name AS branch_name,
              COUNT(*) as count,
              SUM(CASE WHEN reconciliations.status = 'reconciled' THEN 1 ELSE 0 END) as reconciled
       FROM reconciliations
       LEFT JOIN accounts a ON a.id = reconciliations.account_id
       LEFT JOIN branches b ON b.id = a.branch_id
       ${reconScope.clause ? `WHERE ${reconScope.clause}` : ''}
       GROUP BY a.branch_id, b.name`,
      reconScope.params
    );

    const groups = new Map<string, ConsolidatedBranch>();
    const groupOf = (id: unknown, name: unknown): ConsolidatedBranch => {
      const branchKey = id == null ? '' : String(id);
      const found = groups.get(branchKey);
      if (found) return found;
      const created: ConsolidatedBranch = {
        branchId: branchKey || null,
        branchName: (name as string | null) || 'Unassigned branch',
        accounts: { count: 0, totalBalance: 0 },
        transactions: { count: 0, totalIn: 0, totalOut: 0 },
        transfers: { count: 0, totalAmount: 0, totalFees: 0 },
        loading: { count: 0, totalRevenue: 0, totalProfit: 0 },
        reconciliation: { total: 0, reconciled: 0 },
      };
      groups.set(branchKey, created);
      return created;
    };
    const num = (value: unknown): number => {
      const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    for (const row of accountRows) {
      const g = groupOf(row.branch_id, row.branch_name);
      g.accounts.count += num(row.count);
      g.accounts.totalBalance += num(row.total_balance);
    }
    for (const row of txRows) {
      const g = groupOf(row.branch_id, row.branch_name);
      g.transactions.count += num(row.count);
      g.transactions.totalIn += num(row.total_in);
      g.transactions.totalOut += num(row.total_out);
    }
    for (const row of transferRows) {
      const g = groupOf(row.branch_id, row.branch_name);
      g.transfers.count += num(row.count);
      g.transfers.totalAmount += num(row.total_amount);
      g.transfers.totalFees += num(row.total_fees);
    }
    for (const row of loadingRows) {
      const g = groupOf(row.branch_id, row.branch_name);
      g.loading.count += num(row.count);
      g.loading.totalRevenue += num(row.revenue);
      g.loading.totalProfit += num(row.profit);
    }
    for (const row of reconRows) {
      const g = groupOf(row.branch_id, row.branch_name);
      g.reconciliation.total += num(row.count);
      g.reconciliation.reconciled += num(row.reconciled);
    }

    const byBranch = [...groups.values()].sort((a, b) => a.branchName.localeCompare(b.branchName));
    const sum = (pick: (b: ConsolidatedBranch) => number): number =>
      byBranch.reduce((acc, b) => acc + pick(b), 0);

    res.json({
      success: true, data: {
        accounts: {
          count: sum(b => b.accounts.count),
          totalBalance: byBranch.reduce((acc, b) => acc + b.accounts.totalBalance, 0),
        },
        transactions: {
          count: sum(b => b.transactions.count),
          totalIn: byBranch.reduce((acc, b) => acc + b.transactions.totalIn, 0),
          totalOut: byBranch.reduce((acc, b) => acc + b.transactions.totalOut, 0),
        },
        transfers: {
          count: sum(b => b.transfers.count),
          totalAmount: byBranch.reduce((acc, b) => acc + b.transfers.totalAmount, 0),
          totalFees: byBranch.reduce((acc, b) => acc + b.transfers.totalFees, 0),
        },
        loading: {
          count: sum(b => b.loading.count),
          totalRevenue: byBranch.reduce((acc, b) => acc + b.loading.totalRevenue, 0),
          totalProfit: byBranch.reduce((acc, b) => acc + b.loading.totalProfit, 0),
        },
        reconciliation: {
          total: sum(b => b.reconciliation.total),
          reconciled: byBranch.reduce((acc, b) => acc + b.reconciliation.reconciled, 0),
        },
        byBranch,
      }
    });
  } catch (error) { next(error); }
});

router.get('/balance-trends', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, days } = req.query;
    const d = parseInt(days as string) || 30;
    const conds: string[] = [`le.entry_date >= NOW() - INTERVAL '${d} days'`];
    const params: any[] = [];
    let pi = 1;
    if (accountId) { conds.push(`le.account_id = $${pi++}`); params.push(accountId); }
    const scope = branchClause(req, 'a', 'accounts.read_all', pi, 'self');
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const trends = await query(
      `SELECT DATE(le.entry_date) as date, le.account_id, a.name as account_name,
              SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE 0 END) as credits,
              SUM(CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE 0 END) as debits,
              MAX(le.balance_after) as closing_balance
       FROM ledger_entries le
       JOIN accounts a ON le.account_id = a.id
       ${wc} GROUP BY DATE(le.entry_date), le.account_id, a.name ORDER BY date ASC`, params
    );

    res.json({ success: true, data: trends });
  } catch (error) { next(error); }
});

type ReversalFilters = { startDate?: unknown; endDate?: unknown; accountId?: unknown; branchId?: string | null };

const reversalScope = (req: Request, { startDate, endDate, accountId, branchId }: ReversalFilters) => {
  const reversals: string[] = [`t.status = 'reversed'`];
  const reversalParams: any[] = [];
  let ri = 1;
  if (startDate) { reversals.push(`rev.created_at >= $${ri++}`); reversalParams.push(startDate); }
  if (endDate) { reversals.push(`rev.created_at < ($${ri++}::date + INTERVAL '1 day')`); reversalParams.push(endDate); }
  if (accountId) { reversals.push(`t.account_id = $${ri++}`); reversalParams.push(accountId); }
  const reversalScopeClause = branchClause(req, 't', 'transactions.read_all', ri, 'account', branchId ?? null);
  if (reversalScopeClause.clause) { reversals.push(reversalScopeClause.clause); reversalParams.push(...reversalScopeClause.params); }

  const requests: string[] = [`pr.entity_type = 'transaction'`];
  const requestParams: any[] = [];
  let qi = 1;
  if (startDate) { requests.push(`pr.created_at >= $${qi++}`); requestParams.push(startDate); }
  if (endDate) { requests.push(`pr.created_at < ($${qi++}::date + INTERVAL '1 day')`); requestParams.push(endDate); }
  if (accountId) { requests.push(`t.account_id = $${qi++}`); requestParams.push(accountId); }
  const requestScopeClause = branchClause(req, 't', 'transactions.read_all', qi, 'account', branchId ?? null);
  if (requestScopeClause.clause) { requests.push(requestScopeClause.clause); requestParams.push(...requestScopeClause.params); }

  return {
    reversalWhere: `WHERE ${reversals.join(' AND ')}`,
    reversalParams,
    requestWhere: `WHERE ${requests.join(' AND ')}`,
    requestParams,
  };
};

const loadReversalReport = async (req: Request, filters: ReversalFilters) => {
  const { reversalWhere, reversalParams, requestWhere, requestParams } = reversalScope(req, filters);

  const reversalRows = await query(
    `SELECT t.id, t.transaction_number, t.amount, t.net_amount, t.additional_charges,
              t.reference_number, t.description, t.transaction_date,
              tt.name AS type_name, tt.direction, a.name AS account_name,
              a.branch_id, b.name AS branch_name,
              creator.username AS created_by,
              rev.id AS reversal_id, rev.transaction_number AS reversal_number,
              rev.amount AS reversal_amount, rev.created_at AS reversed_at,
              rev.description AS reversal_description,
              le.entry_type AS reversal_entry_type, le.amount AS ledger_amount,
              le.balance_after AS ledger_balance_after,
              orig_le.entry_type AS original_entry_type,
              pr.status AS request_status, pr.reason AS reason,
              requester.username AS requested_by, approver.username AS approved_by,
              actor.username AS audit_actor, audit.reason AS audit_reason,
              pr.created_at AS requested_at, pr.updated_at AS decided_at
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN users creator ON creator.id = t.created_by
       ${REVERSAL_TRAIL_JOINS}
       LEFT JOIN LATERAL (
         SELECT le2.entry_type, le2.amount, le2.balance_after
         FROM ledger_entries le2
         WHERE le2.reference_number = 'REV-' || t.transaction_number::text
         ORDER BY le2.created_at ASC
         LIMIT 1
       ) le ON true
       LEFT JOIN LATERAL (
         SELECT o.entry_type
         FROM ledger_entries o
         WHERE t.status = 'reversed' AND o.transaction_id = t.id
         ORDER BY o.created_at ASC, o.id ASC
         LIMIT 1
       ) orig_le ON true
       LEFT JOIN users requester ON requester.id = pr.requested_by
       LEFT JOIN users approver ON approver.id = pr.approved_by
       LEFT JOIN users actor ON actor.id::text = audit.user_id::text
       ${reversalWhere}
       ORDER BY t.transaction_date DESC, t.transaction_number DESC`,
    reversalParams
  );

  const requestRows = await query(
    `SELECT pr.id, pr.entity_type, pr.entity_id, t.transaction_number,
              a.name AS account_name, a.branch_id, b.name AS branch_name,
              pr.status, pr.reversal_amount, pr.reason,
              requester.username AS requested_by, approver.username AS approved_by,
              pr.created_at, pr.updated_at
       FROM pending_reversals pr
       JOIN transactions t ON t.id = pr.entity_id
       JOIN accounts a ON a.id = pr.account_id
       LEFT JOIN branches b ON b.id = a.branch_id
       LEFT JOIN users requester ON requester.id = pr.requested_by
       LEFT JOIN users approver ON approver.id = pr.approved_by
       ${requestWhere}
       ORDER BY pr.created_at DESC, pr.id DESC`,
    requestParams
  );

  return buildReversalReport(reversalRows, requestRows);
};

router.get('/reversal-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await loadReversalReport(req, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      accountId: req.query.accountId,
      branchId: await resolveBranchFilter(req, req.query.branchId),
    });
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});

type ShiftFilters = { startDate?: unknown; endDate?: unknown; branchId?: string | null; status?: unknown; varianceOnly?: boolean };

// One row per shift with the drawer's own movements inside its window. The
// window is the shift's opened_at to its closed_at — never the report's date
// range — because a shift's expected figure is arithmetic over what moved while
// it was open, and widening the window to the period would fold the next shift's
// takings into the count.
//
// Scopes on `branches.read_all` rather than the transaction-level scopes: a
// shift belongs to a branch directly, so there is no account to resolve it
// through, and the branch predicate is the only thing standing between a query
// string and every branch's drawer.
const loadShiftReport = async (req: Request, filters: ShiftFilters) => {
  const { startDate, endDate, branchId, varianceOnly } = filters;
  const conds: string[] = [];
  const params: any[] = [];
  let pi = 1;
  if (startDate) { conds.push(`s.shift_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { conds.push(`s.shift_date <= $${pi++}`); params.push(endDate); }
  // `open` and `closed` are the report's own shape; anything else is left
  // unfiltered rather than treated as a wildcard, so a mistyped value returns
  // every shift instead of silently none.
  if (filters.status === 'open' || filters.status === 'closed') {
    conds.push(`s.status = $${pi++}`);
    params.push(filters.status);
  }
  const scope = branchClause(req, 's', 'branches.read_all', pi, 'self', branchId ?? null);
  if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }

  const rows = await query<any>(
    `SELECT s.id, s.branch_id, s.shift_date::text AS shift_date, s.status,
            s.opening_float, s.counted_closing, s.expected_closing, s.variance,
            s.opened_at, s.closed_at, s.notes,
            b.code AS branch_code, b.name AS branch_name,
            ou.username AS opened_by_username, cu.username AS closed_by_username
     FROM shifts s
     JOIN branches b ON b.id = s.branch_id
     LEFT JOIN users ou ON ou.id = s.opened_by
     LEFT JOIN users cu ON cu.id = s.closed_by
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY s.shift_date DESC, s.opened_at DESC`,
    params,
  );

  // A shift's cash in and out is the only figure this report computes rather
  // than reads off the row, and it is computed per shift because the window is
  // the shift's own. The settled closing figures stay untouched.
  const sources = await Promise.all(rows.map(async (row) => {
    const movements = await drawerMovements(row.branch_id, row.opened_at, row.closed_at);
    return {
      ...row,
      cash_in: movements.filter((m) => m.entry_type === 'credit').reduce((sum, m) => sum + netMovement([m]), 0),
      // `netMovement` is a net and so signed: a debit nets negative. Cash out
      // is reported as a magnitude instead, because every renderer prints its
      // own sign — the summary card reads "paid out …", the table colours the
      // cell red — and -1500 would reach them as "paid out -₱1,500".
      cash_out: Math.abs(
        movements.filter((m) => m.entry_type === 'debit').reduce((sum, m) => sum + netMovement([m]), 0),
      ),
    };
  }));

  // Filtered before the summary is built, so a variance-only run's totals
  // describe the shifts on screen rather than every shift in the period.
  const filtered = varianceOnly
    ? sources.filter((s) => s.status === 'closed' && Math.abs(round2(Number(s.variance ?? 0))) > 0)
    : sources;

  return buildShiftReport(filtered);
};

router.get('/shift-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await loadShiftReport(req, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      branchId: await resolveBranchFilter(req, req.query.branchId),
      status: req.query.status,
      varianceOnly: req.query.varianceOnly === '1' || req.query.varianceOnly === 'true',
    });
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});



type IncomeFilters = { startDate?: unknown; endDate?: unknown; accountId?: unknown; branchId?: string | null };

// Three income sources on three tables, each with its own date column and its
// own read scope, so each is aggregated inside the join it belongs to. Accounts
// drive the rows: an account with no activity in the period still appears, with
// zeros, because a per-account report that silently drops accounts reads as
// data loss. Every subquery scopes on its own permission, so this can never
// reveal more than the individual reports already would.
const loadIncomeReport = async (req: Request, filters: IncomeFilters): Promise<IncomeReport> => {
  const { startDate, endDate, accountId, branchId } = filters;
  const params: any[] = [];
  let pi = 1;

  // Provider charges are the company's own cost, not a customer transaction,
  // so they must stay out of the TXNS column. Filtering on direction would be
  // wrong here: an ordinary Cash-Out is direction 'out' and is exactly the
  // customer activity this count exists to report. The type code is the only
  // thing that separates the two — see migration 032.
  const txnConds: string[] = [`t.status IN ('completed', 'reversed')`, `tt.code <> 'expense'`];
  if (startDate) { txnConds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { txnConds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const txnScope = branchClause(req, 't', 'transactions.read_all', pi);
  if (txnScope.clause) { txnConds.push(txnScope.clause); params.push(...txnScope.params); pi = txnScope.paramIndex; }

  const trfConds: string[] = [`tr.status = 'completed'`];
  if (startDate) { trfConds.push(`tr.transfer_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { trfConds.push(`tr.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const trfScope = branchClause(req, 'tr', 'transfers.read_all', pi, 'transfer');
  if (trfScope.clause) { trfConds.push(trfScope.clause); params.push(...trfScope.params); pi = trfScope.paramIndex; }

  const ldConds: string[] = [`lt.status = 'completed'`];
  if (startDate) { ldConds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
  if (endDate) { ldConds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const ldScope = branchClause(req, 'lt', 'loading.read_all', pi);
  if (ldScope.clause) { ldConds.push(ldScope.clause); params.push(...ldScope.params); pi = ldScope.paramIndex; }

  const accountConds: string[] = [];
  if (accountId) { accountConds.push(`a.id = $${pi++}`); params.push(accountId); }
  // The branch belongs on the account condition alone. The three subqueries
  // above are uncorrelated aggregates keyed by account and joined to `a`, so
  // they only ever reach a row the account scope has already admitted; adding
  // the branch to them as well would filter the same rows twice under two
  // different placeholder sequences for no change in the result.
  const accountScope = branchClause(req, 'a', 'accounts.read_all', pi, 'self', branchId ?? null);
  if (accountScope.clause) { accountConds.push(accountScope.clause); params.push(...accountScope.params); pi = accountScope.paramIndex; }
  const accountWhere = accountConds.length > 0 ? `WHERE ${accountConds.join(' AND ')}` : '';

  const rows = await query(
    `SELECT a.id AS account_id,
            a.name AS account_name,
            a.branch_id,
            br.name AS branch_name,
            p.name AS provider_name,
            typ.name AS account_type,
            txn.cnt AS txn_count,
            txn.fees AS txn_fees,
            txn.charges AS additional_charges,
            txn.excluded AS reversed_excluded,
            trf.cnt AS transfer_count,
            trf.fees AS transfer_fees,
            ld.cnt AS load_count,
            ld.revenue AS load_revenue,
            ld.cost AS load_cost,
            ld.margin AS load_margin
     FROM accounts a
     LEFT JOIN branches br ON br.id = a.branch_id
     LEFT JOIN providers p ON p.id = a.provider_id
     LEFT JOIN account_types typ ON typ.id = a.account_type_id
     LEFT JOIN (
       SELECT t.account_id,
              COUNT(*) FILTER (WHERE t.status = 'completed') AS cnt,
              COALESCE(SUM(COALESCE(t.fee, 0)) FILTER (WHERE t.status = 'completed'), 0) AS fees,
              COALESCE(SUM(chg.total) FILTER (WHERE t.status = 'completed'), 0) AS charges,
              COALESCE(SUM(COALESCE(t.fee, 0) + chg.total) FILTER (WHERE t.status = 'reversed'), 0) AS excluded
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       WHERE ${txnConds.join(' AND ')}
       GROUP BY t.account_id
     ) txn ON txn.account_id = a.id
     LEFT JOIN (
       SELECT tr.source_account_id AS account_id,
              COUNT(*) AS cnt,
              COALESCE(SUM(tr.transfer_fee), 0) AS fees
       FROM transfers tr
       WHERE ${trfConds.join(' AND ')}
       GROUP BY tr.source_account_id
     ) trf ON trf.account_id = a.id
     LEFT JOIN (
       SELECT lt.account_id,
              COUNT(*) AS cnt,
              COALESCE(SUM(lt.total_revenue), 0) AS revenue,
              COALESCE(SUM(lt.total_cost), 0) AS cost,
              COALESCE(SUM(lt.profit), 0) AS margin
       FROM loading_transactions lt
       WHERE ${ldConds.join(' AND ')}
       GROUP BY lt.account_id
     ) ld ON ld.account_id = a.id
     ${accountWhere}
     ORDER BY a.name`,
    params
  );

  return buildIncomeReport(rows);
};

// The expense report reads the same transfers table, the same transfer_date
// column and the same transfers.read_all scope as the transfer component of the
// income report, so the service charge cannot come out as one figure here and
// another there. Accounts still drive the rows: an account that sent no
// transfer in the period appears with zeros rather than vanishing, because a
// per-account report that silently drops accounts reads as data loss.
const loadExpenseReport = async (req: Request, filters: IncomeFilters): Promise<ExpenseReport> => {
  const { startDate, endDate, accountId, branchId } = filters;
  const params: any[] = [];
  let pi = 1;

  const trfConds: string[] = [`tr.status = 'completed'`];
  if (startDate) { trfConds.push(`tr.transfer_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { trfConds.push(`tr.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const trfScope = branchClause(req, 'tr', 'transfers.read_all', pi, 'transfer');
  if (trfScope.clause) { trfConds.push(trfScope.clause); params.push(...trfScope.params); pi = trfScope.paramIndex; }

  // Provider charges are ordinary transactions typed `expense` (migration 032),
  // so they carry their own scope and their own date window. Built after the
  // transfers and before the account filter purely so the $n placeholders line
  // up with the order the subqueries appear in the SQL below.
  const pchgConds: string[] = [`tt.code = 'expense'`, `t.status = 'completed'`];
  if (startDate) { pchgConds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { pchgConds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const pchgScope = branchClause(req, 't', 'transactions.read_all', pi);
  if (pchgScope.clause) { pchgConds.push(pchgScope.clause); params.push(...pchgScope.params); pi = pchgScope.paramIndex; }

  // Operating expenses are ordinary transactions typed `operating_expense`
  // (migration 034), so they take their own scope and window in the same
  // order as the two components above. The placeholder numbering only lines up
  // because conditions are built in the order the subqueries appear in the SQL.
  const opexConds: string[] = [`tt.code = 'operating_expense'`, `t.status = 'completed'`];
  if (startDate) { opexConds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { opexConds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const opexScope = branchClause(req, 't', 'transactions.read_all', pi);
  if (opexScope.clause) { opexConds.push(opexScope.clause); params.push(...opexScope.params); pi = opexScope.paramIndex; }

  const accountConds: string[] = [];
  if (accountId) { accountConds.push(`a.id = $${pi++}`); params.push(accountId); }
  // Same as loadIncomeReport: the account condition is where the branch
  // belongs, because the components above are uncorrelated aggregates that
  // only reach accounts this condition admits.
  const accountScope = branchClause(req, 'a', 'accounts.read_all', pi, 'self', branchId ?? null);
  if (accountScope.clause) { accountConds.push(accountScope.clause); params.push(...accountScope.params); pi = accountScope.paramIndex; }
  const accountWhere = accountConds.length > 0 ? `WHERE ${accountConds.join(' AND ')}` : '';

  const rows = await query(
    `SELECT a.id AS account_id,
            a.name AS account_name,
            a.branch_id,
            br.name AS branch_name,
            p.name AS provider_name,
            typ.name AS account_type,
            trf.cnt AS transfer_count,
            trf.fees AS transfer_service_fee,
            pchg.charges AS provider_charges,
            opex.expenses AS operating_expenses
     FROM accounts a
     LEFT JOIN branches br ON br.id = a.branch_id
     LEFT JOIN providers p ON p.id = a.provider_id
     LEFT JOIN account_types typ ON typ.id = a.account_type_id
     LEFT JOIN (
       SELECT tr.source_account_id AS account_id,
              COUNT(*) AS cnt,
              COALESCE(SUM(tr.transfer_fee), 0) AS fees
       FROM transfers tr
       WHERE ${trfConds.join(' AND ')}
       GROUP BY tr.source_account_id
     ) trf ON trf.account_id = a.id
     LEFT JOIN (
       SELECT t.account_id,
              COALESCE(SUM(t.amount), 0) AS charges
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       WHERE ${pchgConds.join(' AND ')}
       GROUP BY t.account_id
     ) pchg ON pchg.account_id = a.id
     LEFT JOIN (
       SELECT t.account_id,
              COALESCE(SUM(t.amount), 0) AS expenses
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       WHERE ${opexConds.join(' AND ')}
       GROUP BY t.account_id
     ) opex ON opex.account_id = a.id
     ${accountWhere}
     ORDER BY a.name`,
    params
  );

  return buildExpenseReport(rows);
};

router.get('/expense-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await loadExpenseReport(req, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      accountId: req.query.accountId,
      branchId: await resolveBranchFilter(req, req.query.branchId),
    });
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});

router.get('/income-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await loadIncomeReport(req, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      accountId: req.query.accountId,
      branchId: await resolveBranchFilter(req, req.query.branchId),
    });
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});

interface ShiftActivityBranch {
  branchId: string;
  branchName: string;
  shiftDate: string;
  income: IncomeReport['summary'];
  expense: ExpenseReport['summary'];
}

// Income and expense for the business day an open shift belongs to.
//
// The period is derived from the shift, never asked for. Cash Management is a
// live position and may not carry a date filter of its own (D18), so the only
// window it can honestly name is the one its own shift already defines — the
// same `shift_date` every transaction in that branch is already held to.
//
// Both figures come from the same two loaders behind the Income and Expense
// report, called once per open shift with that shift's date. Reusing them
// rather than restating their conditions keeps the panel and the report the
// same query instead of two readings of one rule, which is the only way a
// figure shown in two places can be trusted in either. A branch with no open
// shift contributes nothing and says so by being absent, because inventing a
// window for it would be inventing a period the books never had.
router.get('/shift-activity', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchFilter = await resolveBranchFilter(req, req.query.branchId);

    const params: any[] = [];
    const conds = [`s.status = 'open'`];
    const scope = branchClause(req, 's', 'branches.read_all', 1, 'self');
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
    }
    if (branchFilter) {
      conds.push(`s.branch_id = $${params.length + 1}`);
      params.push(branchFilter);
    }

    // shift_date is re-cast after `s.*` so node-postgres's parsed DATE — local
    // midnight in this host's UTC+3 — is replaced by the day it names. The
    // later column wins in the row object, which is why it is written last.
    const shifts = await query<{ branch_id: string; branch_name: string; shift_date: string }>(
      `SELECT s.branch_id, s.shift_date::text AS shift_date, b.name AS branch_name
       FROM shifts s
       JOIN branches b ON b.id = s.branch_id
       WHERE ${conds.join(' AND ')}
       ORDER BY b.code`,
      params,
    );

    const branches: ShiftActivityBranch[] = [];
    for (const shift of shifts) {
      const [income, expense] = await Promise.all([
        loadIncomeReport(req, { startDate: shift.shift_date, endDate: shift.shift_date, branchId: shift.branch_id }),
        loadExpenseReport(req, { startDate: shift.shift_date, endDate: shift.shift_date, branchId: shift.branch_id }),
      ]);
      branches.push({
        branchId: shift.branch_id,
        branchName: shift.branch_name,
        shiftDate: shift.shift_date,
        income: income.summary,
        expense: expense.summary,
      });
    }

    const totals = branches.reduce(
      (acc, branch) => ({
        txnFees: acc.txnFees + branch.income.txnFees,
        loadMargin: acc.loadMargin + branch.income.loadMargin,
        totalIncome: acc.totalIncome + branch.income.totalIncome,
        serviceFees: acc.serviceFees + branch.expense.serviceFees,
        providerCharges: acc.providerCharges + branch.expense.providerCharges,
        operatingExpenses: acc.operatingExpenses + branch.expense.operatingExpenses,
        totalExpense: acc.totalExpense + branch.expense.totalExpense,
      }),
      {
        txnFees: 0, loadMargin: 0, totalIncome: 0,
        serviceFees: 0, providerCharges: 0, operatingExpenses: 0, totalExpense: 0,
      },
    );

    res.json({
      success: true,
      data: {
        // Branches may hold their shift on different days, so the dates are
        // reported as the set they are rather than one label that would be
        // false for every branch outside the first.
        shiftDates: [...new Set(branches.map((branch) => branch.shiftDate))].sort(),
        branches,
        totals: {
          income: {
            txnFees: round2(totals.txnFees),
            loadMargin: round2(totals.loadMargin),
            total: round2(totals.totalIncome),
          },
          expense: {
            serviceFees: round2(totals.serviceFees),
            providerCharges: round2(totals.providerCharges),
            operatingExpenses: round2(totals.operatingExpenses),
            total: round2(totals.totalExpense),
          },
          net: round2(totals.totalIncome - totals.totalExpense),
        },
      },
    });
  } catch (error) { next(error); }
});

// The drill-down behind one account row runs against the same three tables,
// the same three date columns and the same three read scopes as the aggregate
// above it. A tab assembled from different conditions would disagree with the
// figure it exists to explain, so the conditions are built the same way here
// rather than reinterpreted.
const detailScope = (
  req: Request,
  alias: string,
  permission: string,
  dateColumn: string,
  filters: IncomeFilters,
  firstParam: number,
  link: AccountLink = 'account',
): { conds: string[]; params: any[] } => {
  const conds: string[] = [];
  const params: any[] = [];
  let pi = firstParam;
  if (filters.startDate) { conds.push(`${dateColumn} >= $${pi++}`); params.push(filters.startDate); }
  if (filters.endDate) { conds.push(`${dateColumn} < ($${pi++}::date + INTERVAL '1 day')`); params.push(filters.endDate); }
  const scope = branchClause(req, alias, permission, pi, link);
  if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
  return { conds, params };
};

// The source side of one account's completed transfers, read by both report
// drills. The expense drill-down and the income drill-down's Transfers tab
// show exactly these rows because they are one query: a second copy written
// for one of them could drift on its date column, its status filter or its
// read scope and start disagreeing with the figure it exists to explain.
//
// Only source-side rows appear. The fee is charged to the funding account, so
// a receiving row contributes nothing to the total either drill-down totals.
const loadTransfersDetail = async (
  req: Request,
  accountId: unknown,
  filters: IncomeFilters,
): Promise<any[]> => {
  const scope = detailScope(req, 'tr', 'transfers.read_all', 'tr.transfer_date', filters, 2, 'transfer');
  const conds = ['tr.source_account_id = $1', `tr.status = 'completed'`, ...scope.conds];
  return query(
    `SELECT tr.id, tr.transfer_number, tr.transfer_reference, tr.transfer_date,
            da.name AS destination_name, tr.transfer_amount, tr.transfer_fee
     FROM transfers tr
     JOIN accounts da ON da.id = tr.destination_account_id
     WHERE ${conds.join(' AND ')}
     ORDER BY tr.transfer_date DESC`,
    [accountId, ...scope.params]
  );
};

// The other half of /expense-detail: the provider charges, which are ordinary
// transactions typed `expense` (migration 032). Written beside
// loadTransfersDetail and shaped the same way — one account, one scope, one
// date window — so the two panels behind a single total are filtered by
// exactly the same rules and neither can silently cover a different period
// than the other. The origin transaction is joined in so the operator sees
// which cash movement provoked the charge rather than a bare number.
const loadExpenseChargesDetail = async (
  req: Request,
  accountId: unknown,
  filters: IncomeFilters,
): Promise<any[]> => {
  const scope = detailScope(req, 't', 'transactions.read_all', 't.transaction_date', filters, 2);
  const conds = ['t.account_id = $1', `t.status = 'completed'`, `tt.code = 'expense'`, ...scope.conds];
  return query(
    `SELECT t.id, t.transaction_number, t.transaction_date, t.description, t.amount,
            origin.transaction_number AS linked_transaction_number
     FROM transactions t
     JOIN transaction_types tt ON tt.id = t.transaction_type_id
     LEFT JOIN transactions origin ON origin.id = t.linked_transaction_id
     WHERE ${conds.join(' AND ')}
     ORDER BY t.transaction_date DESC`,
    [accountId, ...scope.params]
  );
};

// The third panel behind an expense total: operating expenses paid out of the
// account, also ordinary transactions but typed `operating_expense` (migration
// 034). Same account, same scope and same date window as the two loaders above
// for the same reason — the panels are meant to add up to the figure they sit
// under, and they cannot if each is filtered by different rules. `payee` is
// selected because an expense is read as much by who was paid as by what for.
const loadExpenseOperatingDetail = async (
  req: Request,
  accountId: unknown,
  filters: IncomeFilters,
): Promise<any[]> => {
  const scope = detailScope(req, 't', 'transactions.read_all', 't.transaction_date', filters, 2);
  const conds = ['t.account_id = $1', `t.status = 'completed'`, `tt.code = 'operating_expense'`, ...scope.conds];
  return query(
    `SELECT t.id, t.transaction_number, t.transaction_date, t.description, t.payee, t.amount
     FROM transactions t
     JOIN transaction_types tt ON tt.id = t.transaction_type_id
     WHERE ${conds.join(' AND ')}
     ORDER BY t.transaction_date DESC`,
    [accountId, ...scope.params]
  );
};

router.get('/income-detail', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId) return res.status(400).json({ success: false, error: { message: 'accountId is required' } });

    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const account = await queryOne(
      `SELECT * FROM accounts WHERE id = $1${branchId ? ' AND branch_id = $2' : ''}`,
      branchId ? [accountId, branchId] : [accountId],
    );
    await assertBranch(req, account?.id, 'accounts.read_all', 'Account not found');

    const filters = { startDate, endDate };

    const cashScope = detailScope(req, 't', 'transactions.read_all', 't.transaction_date', filters, 2);
    // Same exclusion as loadIncomeReport's TXNS column: provider charges are
    // the company's own cost, and listing them here would put a row in the
    // income drill-down that the income total above it never counted.
    const cashConds = ['t.account_id = $1', `t.status IN ('completed', 'reversed')`, `tt.code <> 'expense'`, ...cashScope.conds];
    const cash = await query(
      `SELECT t.id, t.transaction_number, t.reference_number, t.transaction_date,
              tt.name AS type_name, tt.direction, t.description, t.status,
              t.amount, t.fee, chg.total AS charges
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       WHERE ${cashConds.join(' AND ')}
       ORDER BY t.transaction_date DESC`,
      [accountId, ...cashScope.params]
    );

    const transfers = await loadTransfersDetail(req, accountId, filters);

    const ldScope = detailScope(req, 'lt', 'loading.read_all', 'lt.created_at', filters, 2);
    const ldConds = ['lt.account_id = $1', `lt.status = 'completed'`, ...ldScope.conds];
    const loading = await query(
      `SELECT lt.id, lt.transaction_number, lt.created_at, lp.name AS product_name,
              lt.customer_number, lt.quantity, lt.total_revenue, lt.total_cost, lt.profit
       FROM loading_transactions lt
       JOIN loading_products lp ON lp.id = lt.product_id
       WHERE ${ldConds.join(' AND ')}
       ORDER BY lt.created_at DESC`,
      [accountId, ...ldScope.params]
    );

    res.json({ success: true, data: buildIncomeDetail({ cash, loading, transfers }) });
  } catch (error) { next(error); }
});

// The transfers, provider charges and operating expenses behind one account's
// expense row. Three queries rather than one because the three come from
// different tables and shapes, but all are fetched so the drill-down can
// account for the whole of the total it sits under — a panel listing only
// transfers would reconcile with the service-fees column while leaving the
// other components unexplained, and an unexplained remainder is
// indistinguishable from an error.
router.get('/expense-detail', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId) return res.status(400).json({ success: false, error: { message: 'accountId is required' } });

    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const account = await queryOne(
      `SELECT * FROM accounts WHERE id = $1${branchId ? ' AND branch_id = $2' : ''}`,
      branchId ? [accountId, branchId] : [accountId],
    );
    await assertBranch(req, account?.id, 'accounts.read_all', 'Account not found');

    const filters = { startDate, endDate };
    const [transfers, charges, operating] = await Promise.all([
      loadTransfersDetail(req, accountId, filters),
      loadExpenseChargesDetail(req, accountId, filters),
      loadExpenseOperatingDetail(req, accountId, filters),
    ]);
    res.json({ success: true, data: buildExpenseDetail({ transfers, charges, operating }) });
  } catch (error) { next(error); }
});

type ExportColumn = { header: string; key: string };

const csvCell = (value: unknown): string => {
  const normalized = value instanceof Date ? value.toISOString() : value ?? '';
  return `"${String(normalized).replace(/"/g, '""')}"`;
};

router.get('/export/:type', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = req.params;
    const { startDate, endDate, format, accountId, typeId, status, providerId } = req.query;
    const branchId = await resolveBranchFilter(req, req.query.branchId);
    const fmt = format === 'csv' ? 'csv' : 'json';

    let data: any[] = [];
    let columns: ExportColumn[] = [];
    let csvTotals: Record<string, unknown> | null = null;

    if (type === 'reversal' || type === 'reversals') {
      const report = await loadReversalReport(req, { startDate, endDate, accountId, branchId });
      data = report.reversals.map((r) => ({
        transaction_number: r.transactionNumber,
        type_name: r.typeName,
        direction: r.direction,
        account_name: r.accountName,
        branch_name: r.branchName ?? '',
        original_entry_type: r.originalEntryType,
        original_amount: r.originalTotal.toFixed(2),
        charges_amount: r.chargesAmount.toFixed(2),
        reversal_entry_type: r.reversalEntryType,
        reversed_amount: r.reversedAmount === null ? '' : r.reversedAmount.toFixed(2),
        reason: r.reason,
        requested_by: r.requestedBy,
        approved_by: r.approvedBy,
        reversed_by: r.reversedBy,
        reversal_number: r.reversalNumber,
        reversed_at: r.reversedAt,
        request_status: r.requestStatus ?? 'direct',
      }));
      columns = [
        { header: 'Number', key: 'transaction_number' },
        { header: 'Type', key: 'type_name' },
        { header: 'Direction', key: 'direction' },
        { header: 'Account', key: 'account_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Original Side', key: 'original_entry_type' },
        { header: 'Original Amount', key: 'original_amount' },
        { header: 'Charges', key: 'charges_amount' },
        { header: 'Reversal Side', key: 'reversal_entry_type' },
        { header: 'Reversed Amount', key: 'reversed_amount' },
        { header: 'Reason', key: 'reason' },
        { header: 'Requested By', key: 'requested_by' },
        { header: 'Approved By', key: 'approved_by' },
        { header: 'Reversed By', key: 'reversed_by' },
        { header: 'Reversal #', key: 'reversal_number' },
        { header: 'Reversed On', key: 'reversed_at' },
        { header: 'Request Status', key: 'request_status' },
      ];
      if (data.length > 0) {
        csvTotals = {
          transaction_number: 'TOTAL',
          original_amount: report.summary.originalTotal.toFixed(2),
          reversed_amount: report.summary.reversedTotal.toFixed(2),
        };
      }
    } else if (type === 'transaction' || type === 'transactions') {
      const conds: string[] = [`t.status NOT IN ($1, 'pending', 'rejected')`];
      const params: any[] = ['reversed'];
      let pi = 2;
      if (startDate) { conds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      if (accountId) { conds.push(`t.account_id = $${pi++}`); params.push(accountId); }
      if (typeId) { conds.push(`t.transaction_type_id = $${pi++}`); params.push(typeId); }
      const scope = branchClause(req, 't', 'transactions.read_all', pi, 'account', branchId);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT t.transaction_number, tt.name as type_name, tt.direction, a.name as account_name,
                b.name as branch_name,
                t.amount, t.fee, tc.name as category_name, t.reference_number, t.description, t.status,
                t.transaction_date, u.username as created_by
         FROM transactions t
         JOIN transaction_types tt ON t.transaction_type_id = tt.id
         LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
         JOIN accounts a ON t.account_id = a.id
         LEFT JOIN branches b ON b.id = a.branch_id
         LEFT JOIN users u ON t.created_by = u.id ${wc} ORDER BY t.transaction_date DESC`, params
      );
      columns = [
        { header: 'Number', key: 'transaction_number' },
        { header: 'Type', key: 'type_name' },
        { header: 'Direction', key: 'direction' },
        { header: 'Account', key: 'account_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Amount', key: 'amount' },
        { header: 'Fee', key: 'fee' },
        { header: 'Category', key: 'category_name' },
        { header: 'Reference', key: 'reference_number' },
        { header: 'Description', key: 'description' },
        { header: 'Status', key: 'status' },
        { header: 'Date', key: 'transaction_date' },
        { header: 'Created By', key: 'created_by' },
      ];
    } else if (type === 'transfer' || type === 'transfers') {
      const conds: string[] = [];
      const params: any[] = [];
      let pi = 1;
      if (startDate) { conds.push(`t.transfer_date >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`t.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      if (status) { conds.push(`t.status = $${pi++}`); params.push(status); }
      const scope = branchClause(req, 't', 'transfers.read_all', pi, 'transfer', branchId);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      data = await query(
        `SELECT t.transfer_number, sa.name as source_name, da.name as destination_name,
                sb.name as branch_name,
                t.transfer_amount, t.transfer_fee, t.status, t.purpose, t.transfer_date, u.username as created_by
         FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id
         JOIN accounts da ON t.destination_account_id = da.id LEFT JOIN users u ON t.created_by = u.id
         LEFT JOIN branches sb ON sb.id = sa.branch_id
         ${wc} ORDER BY t.transfer_date DESC`, params
      );
      columns = [
        { header: 'Number', key: 'transfer_number' },
        { header: 'Source', key: 'source_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Destination', key: 'destination_name' },
        { header: 'Amount', key: 'transfer_amount' },
        { header: 'Fee', key: 'transfer_fee' },
        { header: 'Status', key: 'status' },
        { header: 'Purpose', key: 'purpose' },
        { header: 'Date', key: 'transfer_date' },
        { header: 'Created By', key: 'created_by' },
      ];
    } else if (type === 'loading') {
      const conds: string[] = [`lt.status = 'completed'`];
      const params: any[] = [];
      let pi = 1;
      if (startDate) { conds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      if (providerId) { conds.push(`lp.provider_id = $${pi++}`); params.push(providerId); }
      const scope = branchClause(req, 'lt', 'loading.read_all', pi, 'account', branchId);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT lt.transaction_number, lp.name as product_name, lt.customer_number, lt.quantity,
                lt.total_cost, lt.total_revenue, lt.profit, a.name as account_name, b.name as branch_name,
                lt.status, lt.created_at
         FROM loading_transactions lt JOIN loading_products lp ON lt.product_id = lp.id
         JOIN accounts a ON lt.account_id = a.id
         LEFT JOIN branches b ON b.id = a.branch_id
         ${wc} ORDER BY lt.created_at DESC`, params
      );
      columns = [
        { header: 'Number', key: 'transaction_number' },
        { header: 'Product', key: 'product_name' },
        { header: 'Customer', key: 'customer_number' },
        { header: 'Qty', key: 'quantity' },
        { header: 'Cost', key: 'total_cost' },
        { header: 'Revenue', key: 'total_revenue' },
        { header: 'Profit', key: 'profit' },
        { header: 'Account', key: 'account_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Status', key: 'status' },
        { header: 'Date', key: 'created_at' },
      ];
    } else if (type === 'expense') {
      const report = await loadExpenseReport(req, { startDate, endDate, accountId, branchId });
      data = report.rows.map((r) => ({
        account_name: r.accountName,
        branch_name: r.branchName ?? '',
        provider_name: r.providerName ?? '',
        account_type: r.accountType ?? '',
        transfer_count: r.transferCount,
        service_fees: r.serviceFees.toFixed(2),
        provider_charges: r.providerCharges.toFixed(2),
        operating_expenses: r.operatingExpenses.toFixed(2),
        total_expense: r.totalExpense.toFixed(2),
      }));
      columns = [
        { header: 'Account', key: 'account_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Provider', key: 'provider_name' },
        { header: 'Type', key: 'account_type' },
        { header: 'Transfers', key: 'transfer_count' },
        { header: 'Service Fees', key: 'service_fees' },
        { header: 'Provider Charges', key: 'provider_charges' },
        { header: 'Operating Expenses', key: 'operating_expenses' },
        { header: 'Total Expense', key: 'total_expense' },
      ];
      csvTotals = { account_name: `TOTAL (${report.summary.accounts} accounts)` };
      if (report.summary.transferCount) csvTotals.transfer_count = report.summary.transferCount;
      if (report.summary.serviceFees) csvTotals.service_fees = report.summary.serviceFees.toFixed(2);
      if (report.summary.providerCharges) csvTotals.provider_charges = report.summary.providerCharges.toFixed(2);
      if (report.summary.operatingExpenses) csvTotals.operating_expenses = report.summary.operatingExpenses.toFixed(2);
      if (report.summary.totalExpense) csvTotals.total_expense = report.summary.totalExpense.toFixed(2);
    } else if (type === 'income') {
      const report = await loadIncomeReport(req, { startDate, endDate, accountId, branchId });
      data = report.rows.map((r) => ({
        account_name: r.accountName,
        branch_name: r.branchName ?? '',
        provider_name: r.providerName ?? '',
        account_type: r.accountType ?? '',
        transaction_count: r.txnCount,
        transaction_fees: r.txnFees.toFixed(2),
        additional_charges: r.additionalCharges.toFixed(2),
        transfer_count: r.transferCount,
        transfer_fees: r.transferFees.toFixed(2),
        fee_income: r.feeIncome.toFixed(2),
        loading_count: r.loadCount,
        loading_revenue: r.loadRevenue.toFixed(2),
        loading_cost: r.loadCost.toFixed(2),
        loading_margin: r.loadMargin.toFixed(2),
        total_income: r.totalIncome.toFixed(2),
        reversed_excluded: r.reversedExcluded.toFixed(2),
      }));
      columns = [
        { header: 'Account', key: 'account_name' },
        { header: 'Branch', key: 'branch_name' },
        { header: 'Provider', key: 'provider_name' },
        { header: 'Type', key: 'account_type' },
        { header: 'Transactions', key: 'transaction_count' },
        { header: 'Transaction Fees', key: 'transaction_fees' },
        { header: 'Additional Charges', key: 'additional_charges' },
        { header: 'Transfers', key: 'transfer_count' },
        { header: 'Fee Income', key: 'fee_income' },
        { header: 'Loadings', key: 'loading_count' },
        { header: 'Loading Revenue', key: 'loading_revenue' },
        { header: 'Loading Cost', key: 'loading_cost' },
        { header: 'Loading Margin', key: 'loading_margin' },
        { header: 'Total Income', key: 'total_income' },
        { header: 'Reversed (Excluded)', key: 'reversed_excluded' },
        { header: 'Transfer Fees (Expense)', key: 'transfer_fees' },
      ];
      if (data.length > 0) {
        csvTotals = {
          account_name: 'TOTAL',
          transaction_fees: report.summary.txnFees.toFixed(2),
          additional_charges: report.summary.additionalCharges.toFixed(2),
          transfer_fees: report.summary.transferFees.toFixed(2),
          fee_income: report.summary.feeIncome.toFixed(2),
          loading_revenue: report.summary.loadRevenue.toFixed(2),
          loading_cost: report.summary.loadCost.toFixed(2),
          loading_margin: report.summary.loadMargin.toFixed(2),
          total_income: report.summary.totalIncome.toFixed(2),
          reversed_excluded: report.summary.reversedExcluded.toFixed(2),
        };
      }
    } else if (type === 'ledger') {
      if (!accountId) {
        return res.status(400).json({ success: false, error: { message: 'Select an account to export the account statement.' } });
      }
      const account = await queryOne(
        `SELECT * FROM accounts WHERE id = $1${branchId ? ' AND branch_id = $2' : ''}`,
        branchId ? [accountId, branchId] : [accountId],
      );
      await assertBranch(req, account?.id, 'accounts.read_all', 'Account not found');
      const conds: string[] = ['le.account_id = $1'];
      const params: any[] = [accountId];
      let pi = 2;
      if (startDate) { conds.push(`le.entry_date >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`le.entry_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT le.id, a.name as account_name, le.entry_type,
                CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE 0 END as credit,
                CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE 0 END as debit,
                le.balance_after, le.description, le.entry_date
         FROM ledger_entries le JOIN accounts a ON le.account_id = a.id
         ${wc} ORDER BY le.created_at ASC, le.id ASC`, params
      );
      columns = [
        { header: 'ID', key: 'id' },
        { header: 'Account', key: 'account_name' },
        { header: 'Type', key: 'entry_type' },
        { header: 'Credit', key: 'credit' },
        { header: 'Debit', key: 'debit' },
        { header: 'Balance', key: 'balance_after' },
        { header: 'Description', key: 'description' },
        { header: 'Date', key: 'entry_date' },
      ];
    } else if (type === 'shift' || type === 'shifts') {
      const report = await loadShiftReport(req, {
        startDate,
        endDate,
        branchId,
        status: req.query.status,
        varianceOnly: req.query.varianceOnly === '1' || req.query.varianceOnly === 'true',
      });
      data = report.shifts.map((s) => ({
        shift_date: s.shiftDate,
        branch: s.branchName ? `${s.branchName} (${s.branchCode})` : '',
        status: s.status,
        opened_by: s.openedByUsername,
        opened_at: s.openedAt,
        closed_by: s.closedByUsername,
        closed_at: s.closedAt,
        opening_float: s.openingFloat.toFixed(2),
        cash_in: s.cashIn.toFixed(2),
        cash_out: s.cashOut.toFixed(2),
        expected_closing: s.expectedClosing === null ? '' : s.expectedClosing.toFixed(2),
        counted_closing: s.countedClosing === null ? '' : s.countedClosing.toFixed(2),
        variance: s.variance === null ? '' : s.variance.toFixed(2),
        notes: s.notes ?? '',
      }));
      columns = [
        { header: 'Shift Date', key: 'shift_date' },
        { header: 'Branch', key: 'branch' },
        { header: 'Status', key: 'status' },
        { header: 'Opened By', key: 'opened_by' },
        { header: 'Opened At', key: 'opened_at' },
        { header: 'Closed By', key: 'closed_by' },
        { header: 'Closed At', key: 'closed_at' },
        { header: 'Opening Float', key: 'opening_float' },
        { header: 'Cash In', key: 'cash_in' },
        { header: 'Cash Out', key: 'cash_out' },
        { header: 'Expected Closing', key: 'expected_closing' },
        { header: 'Counted Closing', key: 'counted_closing' },
        { header: 'Variance', key: 'variance' },
        { header: 'Notes', key: 'notes' },
      ];
      if (data.length > 0) {
        csvTotals = {
          shift_date: 'TOTAL',
          opening_float: report.summary.totalOpeningFloat.toFixed(2),
          cash_in: report.summary.totalCashIn.toFixed(2),
          cash_out: report.summary.totalCashOut.toFixed(2),
          expected_closing: report.summary.totalExpected.toFixed(2),
          counted_closing: report.summary.totalCounted.toFixed(2),
          variance: report.summary.totalVariance.toFixed(2),
        };
      }
    } else {
      return res.status(400).json({ success: false, error: { message: 'Invalid export type. Use: transactions, transfers, loading, ledger, reversals, shifts' } });
    }

    if (fmt === 'csv') {
      const csvRows = [columns.map(c => c.header).join(',')];
      data.forEach((row: any) => csvRows.push(columns.map(c => csvCell(row[c.key])).join(',')));
      if (type === 'ledger' && data.length > 0) {
        const totalCredit = data.reduce((sum: number, r: any) => sum + parseFloat(r.credit || '0'), 0);
        const totalDebit = data.reduce((sum: number, r: any) => sum + parseFloat(r.debit || '0'), 0);
        const lastBalance = data[data.length - 1].balance_after;
        const totals: Record<string, unknown> = {
          entry_type: 'TOTAL',
          credit: totalCredit.toFixed(2),
          debit: totalDebit.toFixed(2),
          balance_after: lastBalance,
        };
        csvRows.push(columns.map(c => csvCell(totals[c.key] ?? '')).join(','));
      }
      if (csvTotals) {
        const reversalTotals = csvTotals;
        csvRows.push(columns.map(c => csvCell(reversalTotals[c.key] ?? '')).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_export.csv"`);
      return res.send('\uFEFF' + csvRows.join('\r\n'));
    }

    res.json({ success: true, data, headers: columns.map(c => c.header) });
  } catch (error) { next(error); }
});

export default router;
