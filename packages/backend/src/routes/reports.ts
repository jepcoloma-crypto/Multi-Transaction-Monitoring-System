import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { canSeeAll, ownerClause, assertOwner } from '../middleware/scope';

const router = Router();
router.use(authenticate);

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
      `SELECT le.*, t.transaction_number, tt.name as type_name, tt.direction
       FROM ledger_entries le
       LEFT JOIN transactions t ON le.transaction_id = t.id
       LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
       ${wc} ORDER BY le.entry_date ASC`, params
    );

    let runningBalance = entries.length > 0 ? parseFloat(entries[0].balance_after) - (entries[0].entry_type === 'credit' ? parseFloat(entries[0].amount) : -parseFloat(entries[0].amount)) : 0;
    const statement = entries.map((e: any) => {
      runningBalance = parseFloat(e.balance_after);
      return { ...e, running_balance: runningBalance };
    });

    const moneyIn = entries.filter((e: any) => e.entry_type === 'credit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0);
    const moneyOut = entries.filter((e: any) => e.entry_type === 'debit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0);

    res.json({
      success: true, data: {
        account, entries: statement, summary: { totalIn: moneyIn, totalOut: moneyOut, netMovement: moneyIn - moneyOut, entryCount: entries.length }
      }
    });
  } catch (error) { next(error); }
});

router.get('/transaction-report', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate, accountId, typeId } = req.query;
    const conds: string[] = ['t.status != $1'];
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

router.get('/export/:type', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = req.params;
    const { startDate, endDate, format } = req.query;
    const fmt = format === 'csv' ? 'csv' : 'json';

    let data: any[] = [];
    let headers: string[] = [];

    if (type === 'transactions') {
      const conds: string[] = ['t.status != $1'];
      const params: any[] = ['reversed'];
      let pi = 2;
      if (startDate) { conds.push(`t.transaction_date >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`t.transaction_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      const scope = ownerClause(req, 't', 'transactions.read_all', pi);
      if (scope.clause) { conds.push(scope.clause); params.push(...scope.params); pi = scope.paramIndex; }
      const wc = `WHERE ${conds.join(' AND ')}`;
      data = await query(
        `SELECT t.id, t.transaction_number, tt.name as type_name, tt.direction, a.name as account_name,
                t.amount, t.fee, tc.name as category_name, t.reference_number, t.description, t.status,
                t.transaction_date, u.email as created_by_email
         FROM transactions t
         JOIN transaction_types tt ON t.transaction_type_id = tt.id
         LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
         JOIN accounts a ON t.account_id = a.id
         LEFT JOIN users u ON t.created_by = u.id ${wc} ORDER BY t.transaction_date DESC`, params
      );
      headers = ['Number', 'Type', 'Direction', 'Account', 'Amount', 'Fee', 'Category', 'Reference', 'Description', 'Status', 'Date', 'Created By'];
    } else if (type === 'transfers') {
      const seeAll = canSeeAll(req, 'transfers.read_all');
      data = await query(
        `SELECT t.transfer_number, sa.name as source_name, da.name as destination_name,
                t.transfer_amount, t.transfer_fee, t.status, t.purpose, t.transfer_date, u.email as created_by_email
         FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id
         JOIN accounts da ON t.destination_account_id = da.id LEFT JOIN users u ON t.created_by = u.id
         ${seeAll ? '' : 'WHERE t.created_by = $1'} ORDER BY t.transfer_date DESC`,
        seeAll ? [] : [req.user!.userId]
      );
      headers = ['Number', 'Source', 'Destination', 'Amount', 'Fee', 'Status', 'Purpose', 'Date', 'Created By'];
    } else if (type === 'loading') {
      const seeAll = canSeeAll(req, 'loading.read_all');
      data = await query(
        `SELECT lt.transaction_number, lp.name as product_name, lt.customer_number, lt.quantity,
                lt.total_cost, lt.total_revenue, lt.profit, a.name as account_name, lt.status, lt.created_at
         FROM loading_transactions lt JOIN loading_products lp ON lt.product_id = lp.id
         JOIN accounts a ON lt.account_id = a.id
         ${seeAll ? '' : 'WHERE lt.created_by = $1'} ORDER BY lt.created_at DESC`,
        seeAll ? [] : [req.user!.userId]
      );
      headers = ['Number', 'Product', 'Customer', 'Qty', 'Cost', 'Revenue', 'Profit', 'Account', 'Status', 'Date'];
    } else if (type === 'ledger') {
      const accountId = req.query.accountId as string;
      const seeAll = canSeeAll(req, 'accounts.read_all');
      if (accountId) {
        const account = await queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
        assertOwner(req, account, 'accounts.read_all', 'Account not found');
      }
      const conds: string[] = [];
      const params: any[] = [];
      let pi = 1;
      if (accountId) { conds.push(`le.account_id = $${pi++}`); params.push(accountId); }
      if (startDate) { conds.push(`le.entry_date >= $${pi++}`); params.push(startDate); }
      if (endDate) { conds.push(`le.entry_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
      if (!seeAll) { conds.push(`a.created_by = $${pi++}`); params.push(req.user!.userId); }
      const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      data = await query(
        `SELECT le.id, a.name as account_name, le.entry_type, le.amount,
                CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE 0 END as credit,
                CASE WHEN le.entry_type = 'debit' THEN le.amount ELSE 0 END as debit,
                le.balance_after, le.description, le.entry_date
         FROM ledger_entries le JOIN accounts a ON le.account_id = a.id
         ${wc} ORDER BY le.entry_date ASC`, params
      );
      headers = ['ID', 'Account', 'Type', 'Credit', 'Debit', 'Balance', 'Description', 'Date'];
    } else {
      return res.status(400).json({ success: false, error: { message: 'Invalid export type. Use: transactions, transfers, loading, ledger' } });
    }

    if (fmt === 'csv') {
      const csvRows = [headers.join(',')];
      data.forEach((row: any) => {
        const vals = Object.values(row).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`);
        csvRows.push(vals.join(','));
      });
      // Add totals row for ledger export
      if (type === 'ledger' && data.length > 0) {
        const totalCredit = data.reduce((sum: number, r: any) => sum + parseFloat(r.credit || '0'), 0);
        const totalDebit = data.reduce((sum: number, r: any) => sum + parseFloat(r.debit || '0'), 0);
        const lastBalance = data[data.length - 1].balance_after;
        csvRows.push(`"","","TOTAL","${totalCredit.toFixed(2)}","${totalDebit.toFixed(2)}","","","${lastBalance}"`);
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${type}_export.csv"`);
      return res.send(csvRows.join('\n'));
    }

    res.json({ success: true, data, headers });
  } catch (error) { next(error); }
});

export default router;
