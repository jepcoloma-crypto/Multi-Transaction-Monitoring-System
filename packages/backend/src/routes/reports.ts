import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { canSeeAll, ownerClause, assertOwner } from '../middleware/scope';
import { auditLedger } from '../services/ledgerAudit';
import { buildReversalReport, reversalReason } from '../services/reversalReport';
import { buildIncomeReport, buildIncomeDetail, type IncomeReport } from '../services/incomeReport';
import { statementReversal } from '../services/statementReversal';
import { loadScopedLedger } from '../services/ledgerQuery';

const router = Router();
router.use(authenticate);

const round2 = (n: number) => Math.round(n * 100) / 100;

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

    const conds: string[] = ['le.account_id = $1'];
    const params: any[] = [accountId];
    let pi = 2;
    if (startDate) { conds.push(`le.entry_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`le.entry_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const account = await queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
    assertOwner(req, account, 'accounts.read_all', 'Account not found');
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
    const scope = ownerClause(req, 'a', 'accounts.read_all', 1);
    const { accounts, entries } = await loadScopedLedger(scope);

    res.json({ success: true, data: auditLedger(accounts, entries) });
  } catch (error) { next(error); }
});

router.get('/transaction-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, accountId, typeId } = req.query;
    const conds: string[] = [`t.status NOT IN ($1, 'pending', 'rejected')`];
    const params: any[] = ['reversed'];
    let pi = 2;
    if (startDate) { conds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (accountId) { conds.push(`t.account_id = $${pi++}`); params.push(accountId); }
    if (typeId) { conds.push(`t.transaction_type_id = $${pi++}`); params.push(typeId); }
    const scope = ownerClause(req, 't', 'transactions.read_all', pi);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const transactions = await query(
      `SELECT t.*, tt.name as type_name, tt.direction, tc.name as category_name, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
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
    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`t.transfer_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`t.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (status) { conds.push(`t.status = $${pi++}`); params.push(status); }
    const scope = ownerClause(req, 't', 'transfers.read_all', pi);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const transfers = await query(
      `SELECT t.*, sa.name as source_name, da.name as destination_name
       FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id JOIN accounts da ON t.destination_account_id = da.id
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
    const conds: string[] = ["lt.status = 'completed'"];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (providerId) { conds.push(`lp.provider_id = $${pi++}`); params.push(providerId); }
    const scope = ownerClause(req, 'lt', 'loading.read_all', pi);
    if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const sales = await query(
      `SELECT lt.*, lp.name as product_name, lp.cost_price, lp.selling_price, p.name as provider_name, a.name as account_name
       FROM loading_transactions lt
       JOIN loading_products lp ON lt.product_id = lp.id
       JOIN providers p ON lp.provider_id = p.id
       JOIN accounts a ON lt.account_id = a.id
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
    const seeAllAccounts = canSeeAll(req, 'accounts.read_all');
    const seeAllTransactions = canSeeAll(req, 'transactions.read_all');
    const seeAllTransfers = canSeeAll(req, 'transfers.read_all');
    const seeAllLoading = canSeeAll(req, 'loading.read_all');
    const uid = req.user!.userId;

    const accountSummary = await queryOne(
      `SELECT COUNT(*) as count, COALESCE(SUM(current_balance), 0) as total_balance FROM accounts WHERE status = 'active'${seeAllAccounts ? '' : ' AND created_by = $1'}`,
      seeAllAccounts ? [] : [uid]
    );
    const txSummary = await queryOne(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
              COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       WHERE t.status != 'reversed'${seeAllTransactions ? '' : ' AND t.created_by = $1'}`,
      seeAllTransactions ? [] : [uid]
    );
    const transferSummary = await queryOne(
      `SELECT COUNT(*) as count, COALESCE(SUM(transfer_amount), 0) as total_amount, COALESCE(SUM(transfer_fee), 0) as total_fees FROM transfers WHERE status = 'completed'${seeAllTransfers ? '' : ' AND created_by = $1'}`,
      seeAllTransfers ? [] : [uid]
    );
    const loadingSummary = await queryOne(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_revenue), 0) as revenue, COALESCE(SUM(profit), 0) as profit FROM loading_transactions WHERE status = 'completed'${seeAllLoading ? '' : ' AND created_by = $1'}`,
      seeAllLoading ? [] : [uid]
    );
    const reconSummary = await queryOne(
      `SELECT COUNT(*) as count, SUM(CASE WHEN status = 'reconciled' THEN 1 ELSE 0 END) as reconciled FROM reconciliations${seeAllAccounts ? '' : ' WHERE account_id IN (SELECT id FROM accounts WHERE created_by = $1)'}`,
      seeAllAccounts ? [] : [uid]
    );

    res.json({
      success: true, data: {
        accounts: { count: parseInt(accountSummary?.count || '0'), totalBalance: parseFloat(accountSummary?.total_balance || '0') },
        transactions: { count: parseInt(txSummary?.count || '0'), totalIn: parseFloat(txSummary?.total_in || '0'), totalOut: parseFloat(txSummary?.total_out || '0') },
        transfers: { count: parseInt(transferSummary?.count || '0'), totalAmount: parseFloat(transferSummary?.total_amount || '0'), totalFees: parseFloat(transferSummary?.total_fees || '0') },
        loading: { count: parseInt(loadingSummary?.count || '0'), totalRevenue: parseFloat(loadingSummary?.revenue || '0'), totalProfit: parseFloat(loadingSummary?.profit || '0') },
        reconciliation: { total: parseInt(reconSummary?.count || '0'), reconciled: parseInt(reconSummary?.reconciled || '0') }
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
    const scope = ownerClause(req, 'a', 'accounts.read_all', pi);
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

type ReversalFilters = { startDate?: unknown; endDate?: unknown; accountId?: unknown };

const reversalScope = (req: Request, { startDate, endDate, accountId }: ReversalFilters) => {
  const reversals: string[] = [`t.status = 'reversed'`];
  const reversalParams: any[] = [];
  let ri = 1;
  if (startDate) { reversals.push(`rev.created_at >= $${ri++}`); reversalParams.push(startDate); }
  if (endDate) { reversals.push(`rev.created_at < ($${ri++}::date + INTERVAL '1 day')`); reversalParams.push(endDate); }
  if (accountId) { reversals.push(`t.account_id = $${ri++}`); reversalParams.push(accountId); }
  const reversalScopeClause = ownerClause(req, 't', 'transactions.read_all', ri);
  if (reversalScopeClause.clause) { reversals.push(reversalScopeClause.clause); reversalParams.push(...reversalScopeClause.params); }

  const requests: string[] = [`pr.entity_type = 'transaction'`];
  const requestParams: any[] = [];
  let qi = 1;
  if (startDate) { requests.push(`pr.created_at >= $${qi++}`); requestParams.push(startDate); }
  if (endDate) { requests.push(`pr.created_at < ($${qi++}::date + INTERVAL '1 day')`); requestParams.push(endDate); }
  if (accountId) { requests.push(`t.account_id = $${qi++}`); requestParams.push(accountId); }
  const requestScopeClause = ownerClause(req, 't', 'transactions.read_all', qi);
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
              a.name AS account_name, pr.status, pr.reversal_amount, pr.reason,
              requester.username AS requested_by, approver.username AS approved_by,
              pr.created_at, pr.updated_at
       FROM pending_reversals pr
       JOIN transactions t ON t.id = pr.entity_id
       JOIN accounts a ON a.id = pr.account_id
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
    });
    res.json({ success: true, data: report });
  } catch (error) { next(error); }
});

type IncomeFilters = { startDate?: unknown; endDate?: unknown; accountId?: unknown };

// Three income sources on three tables, each with its own date column and its
// own read scope, so each is aggregated inside the join it belongs to. Accounts
// drive the rows: an account with no activity in the period still appears, with
// zeros, because a per-account report that silently drops accounts reads as
// data loss. Every subquery scopes on its own permission, so this can never
// reveal more than the individual reports already would.
const loadIncomeReport = async (req: Request, filters: IncomeFilters): Promise<IncomeReport> => {
  const { startDate, endDate, accountId } = filters;
  const params: any[] = [];
  let pi = 1;

  const txnConds: string[] = [`t.status IN ('completed', 'reversed')`];
  if (startDate) { txnConds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { txnConds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const txnScope = ownerClause(req, 't', 'transactions.read_all', pi);
  if (txnScope.clause) { txnConds.push(txnScope.clause); params.push(...txnScope.params); pi = txnScope.paramIndex; }

  const trfConds: string[] = [`tr.status = 'completed'`];
  if (startDate) { trfConds.push(`tr.transfer_date >= $${pi++}`); params.push(startDate); }
  if (endDate) { trfConds.push(`tr.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const trfScope = ownerClause(req, 'tr', 'transfers.read_all', pi);
  if (trfScope.clause) { trfConds.push(trfScope.clause); params.push(...trfScope.params); pi = trfScope.paramIndex; }

  const ldConds: string[] = [`lt.status = 'completed'`];
  if (startDate) { ldConds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
  if (endDate) { ldConds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
  const ldScope = ownerClause(req, 'lt', 'loading.read_all', pi);
  if (ldScope.clause) { ldConds.push(ldScope.clause); params.push(...ldScope.params); pi = ldScope.paramIndex; }

  const accountConds: string[] = [];
  if (accountId) { accountConds.push(`a.id = $${pi++}`); params.push(accountId); }
  const accountScope = ownerClause(req, 'a', 'accounts.read_all', pi);
  if (accountScope.clause) { accountConds.push(accountScope.clause); params.push(...accountScope.params); pi = accountScope.paramIndex; }
  const accountWhere = accountConds.length > 0 ? `WHERE ${accountConds.join(' AND ')}` : '';

  const rows = await query(
    `SELECT a.id AS account_id,
            a.name AS account_name,
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
     LEFT JOIN providers p ON p.id = a.provider_id
     LEFT JOIN account_types typ ON typ.id = a.account_type_id
     LEFT JOIN (
       SELECT t.account_id,
              COUNT(*) FILTER (WHERE t.status = 'completed') AS cnt,
              COALESCE(SUM(COALESCE(t.fee, 0)) FILTER (WHERE t.status = 'completed'), 0) AS fees,
              COALESCE(SUM(chg.total) FILTER (WHERE t.status = 'completed'), 0) AS charges,
              COALESCE(SUM(COALESCE(t.fee, 0) + chg.total) FILTER (WHERE t.status = 'reversed'), 0) AS excluded
       FROM transactions t
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

router.get('/income-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await loadIncomeReport(req, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      accountId: req.query.accountId,
    });
    res.json({ success: true, data: report });
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
): { conds: string[]; params: any[] } => {
  const conds: string[] = [];
  const params: any[] = [];
  let pi = firstParam;
  if (filters.startDate) { conds.push(`${dateColumn} >= $${pi++}`); params.push(filters.startDate); }
  if (filters.endDate) { conds.push(`${dateColumn} < ($${pi++}::date + INTERVAL '1 day')`); params.push(filters.endDate); }
  const scope = ownerClause(req, alias, permission, pi);
  if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
  return { conds, params };
};

router.get('/income-detail', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId) return res.status(400).json({ success: false, error: { message: 'accountId is required' } });

    const account = await queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
    assertOwner(req, account, 'accounts.read_all', 'Account not found');

    const filters = { startDate, endDate };

    const cashScope = detailScope(req, 't', 'transactions.read_all', 't.transaction_date', filters, 2);
    const cashConds = ['t.account_id = $1', `t.status IN ('completed', 'reversed')`, ...cashScope.conds];
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

    // Only source-side transfers appear: the parent row charges the transfer
    // fee to the funding account, so listing the receiving side as well would
    // put rows in the tab that contributed nothing to the figure it totals.
    const trfScope = detailScope(req, 'tr', 'transfers.read_all', 'tr.transfer_date', filters, 2);
    const trfConds = ['tr.source_account_id = $1', `tr.status = 'completed'`, ...trfScope.conds];
    const transfers = await query(
      `SELECT tr.id, tr.transfer_number, tr.transfer_reference, tr.transfer_date,
              da.name AS destination_name, tr.transfer_amount, tr.transfer_fee
       FROM transfers tr
       JOIN accounts da ON da.id = tr.destination_account_id
       WHERE ${trfConds.join(' AND ')}
       ORDER BY tr.transfer_date DESC`,
      [accountId, ...trfScope.params]
    );

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

type ExportColumn = { header: string; key: string };

const csvCell = (value: unknown): string => {
  const normalized = value instanceof Date ? value.toISOString() : value ?? '';
  return `"${String(normalized).replace(/"/g, '""')}"`;
};

router.get('/export/:type', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = req.params;
    const { startDate, endDate, format, accountId, typeId, status, providerId } = req.query;
    const fmt = format === 'csv' ? 'csv' : 'json';

    let data: any[] = [];
    let columns: ExportColumn[] = [];
    let csvTotals: Record<string, unknown> | null = null;

    if (type === 'reversal' || type === 'reversals') {
      const report = await loadReversalReport(req, { startDate, endDate, accountId });
      data = report.reversals.map((r) => ({
        transaction_number: r.transactionNumber,
        type_name: r.typeName,
        direction: r.direction,
        account_name: r.accountName,
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
      const scope = ownerClause(req, 't', 'transactions.read_all', pi);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT t.transaction_number, tt.name as type_name, tt.direction, a.name as account_name,
                t.amount, t.fee, tc.name as category_name, t.reference_number, t.description, t.status,
                t.transaction_date, u.username as created_by
         FROM transactions t
         JOIN transaction_types tt ON t.transaction_type_id = tt.id
         LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
         JOIN accounts a ON t.account_id = a.id
         LEFT JOIN users u ON t.created_by = u.id ${wc} ORDER BY t.transaction_date DESC`, params
      );
      columns = [
        { header: 'Number', key: 'transaction_number' },
        { header: 'Type', key: 'type_name' },
        { header: 'Direction', key: 'direction' },
        { header: 'Account', key: 'account_name' },
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
      const scope = ownerClause(req, 't', 'transfers.read_all', pi);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      data = await query(
        `SELECT t.transfer_number, sa.name as source_name, da.name as destination_name,
                t.transfer_amount, t.transfer_fee, t.status, t.purpose, t.transfer_date, u.username as created_by
         FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id
         JOIN accounts da ON t.destination_account_id = da.id LEFT JOIN users u ON t.created_by = u.id
         ${wc} ORDER BY t.transfer_date DESC`, params
      );
      columns = [
        { header: 'Number', key: 'transfer_number' },
        { header: 'Source', key: 'source_name' },
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
      const scope = ownerClause(req, 'lt', 'loading.read_all', pi);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT lt.transaction_number, lp.name as product_name, lt.customer_number, lt.quantity,
                lt.total_cost, lt.total_revenue, lt.profit, a.name as account_name, lt.status, lt.created_at
         FROM loading_transactions lt JOIN loading_products lp ON lt.product_id = lp.id
         JOIN accounts a ON lt.account_id = a.id
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
        { header: 'Status', key: 'status' },
        { header: 'Date', key: 'created_at' },
      ];
    } else if (type === 'income') {
      const report = await loadIncomeReport(req, { startDate, endDate, accountId });
      data = report.rows.map((r) => ({
        account_name: r.accountName,
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
        { header: 'Provider', key: 'provider_name' },
        { header: 'Type', key: 'account_type' },
        { header: 'Transactions', key: 'transaction_count' },
        { header: 'Transaction Fees', key: 'transaction_fees' },
        { header: 'Additional Charges', key: 'additional_charges' },
        { header: 'Transfers', key: 'transfer_count' },
        { header: 'Transfer Fees', key: 'transfer_fees' },
        { header: 'Fee Income', key: 'fee_income' },
        { header: 'Loadings', key: 'loading_count' },
        { header: 'Loading Revenue', key: 'loading_revenue' },
        { header: 'Loading Cost', key: 'loading_cost' },
        { header: 'Loading Margin', key: 'loading_margin' },
        { header: 'Total Income', key: 'total_income' },
        { header: 'Reversed (Excluded)', key: 'reversed_excluded' },
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
      const account = await queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
      assertOwner(req, account, 'accounts.read_all', 'Account not found');
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
    } else {
      return res.status(400).json({ success: false, error: { message: 'Invalid export type. Use: transactions, transfers, loading, ledger, reversals' } });
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
