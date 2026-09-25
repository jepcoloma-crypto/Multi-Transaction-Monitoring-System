import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { ownerClause, assertOwner } from '../middleware/scope';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { PaginatedResponse } from '../types';

const router = Router();
router.use(authenticate);

// Products
router.get('/products', authorize('loading.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const providerId = req.query.providerId as string;
    let sql = `SELECT lp.*, p.name as provider_name FROM loading_products lp JOIN providers p ON lp.provider_id = p.id WHERE lp.is_active = true`;
    const params: any[] = [];
    if (providerId) { sql += ` AND lp.provider_id = $1`; params.push(providerId); }
    sql += ' ORDER BY lp.name';
    const products = await query(sql, params);
    res.json({ success: true, data: products });
  } catch (error) { next(error); }
});

router.post('/products', authorize('loading.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, providerId, costPrice, sellingPrice, denomination, providerConvenienceFee, companyAdditionalCharge, notes } = req.body;
    if (!name || !providerId || costPrice === undefined || sellingPrice === undefined) throw createError(400, 'Name, provider, cost price, and selling price are required');

    const product = await queryOne(
      `INSERT INTO loading_products (name, provider_id, cost_price, selling_price, denomination, provider_convenience_fee, company_additional_charge, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, providerId, parseFloat(costPrice), parseFloat(sellingPrice), denomination ? parseFloat(denomination) : null,
       parseFloat(providerConvenienceFee || '0'), parseFloat(companyAdditionalCharge || '0'), notes || null]
    );

    await createAuditLog({ userId: req.user!.userId, action: 'loading_product.created', entity: 'loading_product', entityId: product!.id, ipAddress: req.ip });
    res.status(201).json({ success: true, data: product });
  } catch (error) { next(error); }
});

router.put('/products/:id', authorize('loading.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, costPrice, sellingPrice, denomination, providerConvenienceFee, companyAdditionalCharge, isActive, notes } = req.body;
    const product = await queryOne('SELECT * FROM loading_products WHERE id = $1', [req.params.id]);
    if (!product) throw createError(404, 'Product not found');

    const updated = await queryOne(
      `UPDATE loading_products SET name = COALESCE($1, name), cost_price = COALESCE($2, cost_price),
       selling_price = COALESCE($3, selling_price), denomination = COALESCE($4, denomination),
       provider_convenience_fee = COALESCE($5, provider_convenience_fee),
       company_additional_charge = COALESCE($6, company_additional_charge),
       is_active = COALESCE($7, is_active), notes = COALESCE($8, notes), updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [name || product.name, costPrice !== undefined ? parseFloat(costPrice) : product.cost_price,
       sellingPrice !== undefined ? parseFloat(sellingPrice) : product.selling_price,
       denomination !== undefined ? (denomination ? parseFloat(denomination) : null) : product.denomination,
       providerConvenienceFee !== undefined ? parseFloat(providerConvenienceFee) : product.provider_convenience_fee,
       companyAdditionalCharge !== undefined ? parseFloat(companyAdditionalCharge) : product.company_additional_charge,
       isActive, notes !== undefined ? notes : product.notes, req.params.id]
    );

    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

// Transactions
router.get('/', authorize('loading.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const accountId = req.query.accountId as string;
    const productId = req.query.productId as string;

    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (accountId) { conds.push(`lt.account_id = $${pi++}`); params.push(accountId); }
    if (productId) { conds.push(`lt.product_id = $${pi++}`); params.push(productId); }
    const scope = ownerClause(req, 'lt', 'loading.read_all', pi);
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
      pi = scope.paramIndex;
    }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM loading_transactions lt ${wc}`, params);

    const txns = await query(
      `SELECT lt.*, lp.name as product_name, lp.cost_price, lp.selling_price, a.name as account_name, u.email as created_by_email
       FROM loading_transactions lt JOIN loading_products lp ON lt.product_id = lp.id
       JOIN accounts a ON lt.account_id = a.id LEFT JOIN users u ON lt.created_by = u.id
       ${wc} ORDER BY lt.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: { data: txns, pagination: { page, limit, total: parseInt(countResult?.count || '0'), totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit) } } });
  } catch (error) { next(error); }
});

router.get('/summary', authorize('loading.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const conds = ["lt.status = 'completed'"];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`lt.created_at >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`lt.created_at <= $${pi++}`); params.push(endDate); }
    const scope = ownerClause(req, 'lt', 'loading.read_all', pi);
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
      pi = scope.paramIndex;
    }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const summary = await queryOne(
      `SELECT COUNT(*) as total, COALESCE(SUM(total_revenue), 0) as total_revenue,
              COALESCE(SUM(total_cost), 0) as total_cost, COALESCE(SUM(profit), 0) as total_profit,
              COALESCE(SUM(provider_convenience_fee), 0) as total_convenience_fees,
              COALESCE(SUM(company_additional_charge), 0) as total_company_charges
       FROM loading_transactions lt ${wc}`, params
    );

    const byProvider = await query(
      `SELECT p.name as provider_name, COUNT(*) as count, COALESCE(SUM(lt.profit), 0) as profit
       FROM loading_transactions lt JOIN loading_products lp ON lt.product_id = lp.id
       JOIN providers p ON lp.provider_id = p.id ${wc} GROUP BY p.id, p.name ORDER BY profit DESC`, params
    );

    res.json({ success: true, data: {
      summary: { totalSales: parseInt(summary?.total || '0'), totalRevenue: parseFloat(summary?.total_revenue || '0'), totalCost: parseFloat(summary?.total_cost || '0'), totalProfit: parseFloat(summary?.total_profit || '0'), totalConvenienceFees: parseFloat(summary?.total_convenience_fees || '0'), totalCompanyCharges: parseFloat(summary?.total_company_charges || '0') },
      byProvider
    }});
  } catch (error) { next(error); }
});

router.post('/', authorize('loading.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { accountId, productId, customerNumber, quantity, paymentMethod, referenceNumber, notes } = req.body;
    if (!accountId || !productId || !customerNumber) throw createError(400, 'Account, product, and customer number are required');

    const product = await client.query('SELECT * FROM loading_products WHERE id = $1 AND is_active = true', [productId]);
    if (!product.rows[0]) throw createError(404, 'Product not found');

    const acct = await client.query('SELECT id, name, current_balance, status, created_by FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!acct.rows[0]) throw createError(404, 'Account not found');
    if (acct.rows[0].status !== 'active') throw createError(400, 'Account is not active');

    const qty = parseInt(quantity || '1');
    const unitCost = parseFloat(product.rows[0].cost_price);
    const unitPrice = parseFloat(product.rows[0].selling_price);
    const totalCost = unitCost * qty;
    const totalRevenue = unitPrice * qty;
    const profit = totalRevenue - totalCost;
    const providerConvenienceFee = parseFloat(product.rows[0].provider_convenience_fee || '0') * qty;
    const companyAdditionalCharge = parseFloat(product.rows[0].company_additional_charge || '0');
    const totalCustomerCharge = providerConvenienceFee + companyAdditionalCharge;
    const totalBalanceDeduction = totalCost + providerConvenienceFee;

    if (parseFloat(acct.rows[0].current_balance) < totalBalanceDeduction) throw createError(400, 'Insufficient balance for loading purchase');

    const txNum = await client.query("SELECT nextval('loading_transactions_transaction_number_seq') as nextval");
    const loadingTx = (await client.query(
      `INSERT INTO loading_transactions (transaction_number, account_id, product_id, customer_number, quantity,
       unit_cost, unit_price, total_cost, total_revenue, profit, provider_convenience_fee, company_additional_charge,
       payment_method, reference_number, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [txNum.rows[0].nextval, accountId, productId, customerNumber, qty, unitCost, unitPrice, totalCost, totalRevenue, profit,
       providerConvenienceFee, companyAdditionalCharge,
       paymentMethod || 'cash', referenceNumber || null, req.user!.userId]
    )).rows[0];

    // Deduct from account: cost + provider convenience fee
    const newBalance = parseFloat(acct.rows[0].current_balance) - totalBalanceDeduction;
    await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, accountId]);

    await client.query(
      `INSERT INTO ledger_entries (account_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, 'debit', $2, $3, $4, NOW())`,
      [accountId, totalBalanceDeduction, newBalance, `Loading sale to ${customerNumber}: ${product.rows[0].name}${providerConvenienceFee > 0 ? ` (incl. ₱${providerConvenienceFee} conv. fee)` : ''}`]
    );

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'loading.created', entity: 'loading_transaction', entityId: loadingTx.id, ipAddress: req.ip });

    res.status(201).json({ success: true, data: loadingTx });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

router.delete('/products/:id', authorize('loading.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await queryOne<{ id: string; name: string }>('SELECT id, name FROM loading_products WHERE id = $1', [req.params.id]);
    if (!product) throw createError(404, 'Product not found');

    const usage = await queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM loading_transactions WHERE product_id = $1', [req.params.id]
    );
    if (parseInt(usage?.count || '0') > 0) {
      throw createError(400, 'Product has loading history — deactivate it instead of deleting');
    }

    await queryOne('DELETE FROM loading_products WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId, action: 'loading_product.deleted', entity: 'loading_product',
      entityId: req.params.id, ipAddress: req.ip, oldData: { name: product.name },
    });

    res.json({ success: true, data: { message: 'Product deleted' } });
  } catch (error) { next(error); }
});

router.delete('/:id', authorize('loading.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const loadingTx = (await client.query('SELECT * FROM loading_transactions WHERE id = $1', [req.params.id])).rows[0];
    if (!loadingTx) throw createError(404, 'Loading transaction not found');
    assertOwner(req, loadingTx, 'loading.write_all', 'Loading transaction not found');
    if (loadingTx.status === 'reversed') throw createError(400, 'Reversed loading transactions cannot be deleted');

    const entryAmount = parseFloat(loadingTx.total_cost) + parseFloat(loadingTx.provider_convenience_fee || '0');
    await client.query(
      `DELETE FROM ledger_entries WHERE account_id = $1 AND entry_type = 'debit' AND amount = $2 AND entry_date = $3`,
      [loadingTx.account_id, entryAmount, loadingTx.created_at]
    );

    await client.query('DELETE FROM loading_transactions WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId, action: 'loading.deleted', entity: 'loading_transaction',
      entityId: req.params.id, ipAddress: req.ip,
      oldData: { transactionNumber: loadingTx.transaction_number, amount: entryAmount, status: loadingTx.status },
    });

    res.json({ success: true, data: { message: 'Loading transaction deleted' } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

export default router;
