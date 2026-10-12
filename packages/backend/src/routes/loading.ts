import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { branchClause, assertBranch } from '../middleware/scope';
import { assertOpenShift } from '../middleware/shiftGate';
import { updateAccountBalance, lockAccounts } from '../services/balance';
import { loadingSaleLegs } from '../services/loadingPosting';
import { manilaDayAtCurrentTime } from '../services/manilaTime';
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
    const scope = branchClause(req, 'lt', 'loading.read_all', pi);
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
      pi = scope.paramIndex;
    }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM loading_transactions lt ${wc}`, params);

    const txns = await query(
      `SELECT lt.*, lp.name as product_name, lp.cost_price, lp.selling_price, a.name as account_name, u.username as created_by_username
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
    if (endDate) { conds.push(`lt.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    const scope = branchClause(req, 'lt', 'loading.read_all', pi);
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

    const { accountId, productId, customerNumber, quantity, paymentMethod, referenceNumber, notes, transactionDate } = req.body;
    if (!accountId || !productId || !customerNumber) throw createError(400, 'Account, product, and customer number are required');

    // The day asked for, carrying the time it is recorded at — read from
    // Manila's clock rather than this host's UTC+3. One value feeds both the
    // row and the shift gate, so the date stored and the date checked cannot
    // drift apart.
    const bookedAt = transactionDate ? manilaDayAtCurrentTime(String(transactionDate)) : null;
    if (transactionDate && !bookedAt) throw createError(400, 'Invalid transaction date');

    const product = await client.query('SELECT * FROM loading_products WHERE id = $1 AND is_active = true', [productId]);
    if (!product.rows[0]) throw createError(404, 'Product not found');

    const acct = await client.query('SELECT id, name, current_balance, status, created_by FROM accounts WHERE id = $1', [accountId]);
    if (!acct.rows[0]) throw createError(404, 'Account not found');
    // Loading deducts cost from this account, so it must be the caller's.
    await assertBranch(req, accountId, 'loading.write_all', 'Account not found');
    if (acct.rows[0].status !== 'active') throw createError(400, 'Account is not active');
    // Loading deducts from the account at once — there is no pending state to
    // defer the shift check to (D17). It carries no type, so it is always
    // gated, and on the day being booked below.
    await assertOpenShift(accountId, undefined, { eventDate: bookedAt });

    const qty = parseInt(quantity || '1');
    // Everything a cash load sale does to the two pools — the channel's
    // deduction and the drawer's increase — is decided in loadingSaleLegs, the
    // same pure function the entry preview reads, so the figure an operator is
    // shown before saving is the figure this commit posts. The drawer leg is
    // the half that was missing: the selling price is physical cash the customer
    // handed over, and until now only the cost side was ever booked, which is
    // why Cash on hand under-reported load sales by exactly their retail value.
    const legs = loadingSaleLegs({
      unitCost: product.rows[0].cost_price,
      unitPrice: product.rows[0].selling_price,
      quantity: qty,
      paymentMethod: paymentMethod || 'cash',
      fees: { providerConvenienceFee: product.rows[0].provider_convenience_fee },
    });
    const totalCost = parseFloat(product.rows[0].cost_price) * qty;
    const totalRevenue = parseFloat(product.rows[0].selling_price) * qty;
    const profit = legs.margin;
    const providerConvenienceFee = parseFloat(product.rows[0].provider_convenience_fee || '0') * qty;
    const companyAdditionalCharge = parseFloat(product.rows[0].company_additional_charge || '0');
    const totalBalanceDeduction = legs.channelDeduction;

    // When the account paid is itself the drawer, cost and selling price move on
    // one balance and there is no second leg to write — the same guard
    // resolveDrawerLeg applies to a cash movement booked straight onto cash.
    const drawer = legs.drawerIncrease > 0
      ? await client.query(
          `SELECT a.id FROM accounts a
           JOIN account_types t ON t.id = a.account_type_id
           WHERE t.code = 'cash' AND a.status <> 'closed'
             AND a.branch_id = (SELECT branch_id FROM accounts WHERE id = $1)
           ORDER BY a.created_at ASC
           LIMIT 1`,
          [accountId]
        )
      : null;
    const drawerId = drawer && drawer.rows[0] ? drawer.rows[0].id : null;
    // The drawer is credited, so it can only gain; refusing to post one leg
    // while quietly dropping the other is how a drawer drifts out of step with
    // the statements meant to explain it.
    const postDrawerLeg = drawerId !== null && legs.drawerIncrease > 0;
    if (legs.drawerIncrease > 0 && !postDrawerLeg) {
      throw createError(400, 'This branch has no cash account to take the money from');
    }

    // Both accounts are locked before anything is written, in sorted id order —
    // the same order lockAccounts gives every other path that holds more than
    // one account, so a concurrent load sale or cash movement can never deadlock
    // against this one by locking the same pair the other way. The balance is
    // read after the lock, so the check below sees the figure this transaction
    // is about to move.
    await lockAccounts(client, postDrawerLeg ? [accountId, drawerId] : [accountId]);
    const lockedBalance = await client.query('SELECT CAST(current_balance AS NUMERIC(15,2)) AS current_balance FROM accounts WHERE id = $1', [accountId]);
    if (parseFloat(lockedBalance.rows[0].current_balance) < totalBalanceDeduction) throw createError(400, 'Insufficient balance for loading purchase');

    const txNum = await client.query("SELECT nextval('loading_transactions_transaction_number_seq') as nextval");
    const txDate = bookedAt;
    const loadingTx = (await client.query(
      `INSERT INTO loading_transactions (transaction_number, account_id, product_id, customer_number, quantity,
       unit_cost, unit_price, total_cost, total_revenue, profit, provider_convenience_fee, company_additional_charge,
       payment_method, reference_number, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE($16::timestamptz, NOW())) RETURNING *`,
      [txNum.rows[0].nextval, accountId, productId, customerNumber, qty,
       parseFloat(product.rows[0].cost_price), parseFloat(product.rows[0].selling_price),
       totalCost, totalRevenue, profit,
       providerConvenienceFee, companyAdditionalCharge,
       paymentMethod || 'cash', referenceNumber || null, req.user!.userId, txDate]
    )).rows[0];

    // Channel leg: cost plus the provider's convenience fee leaves the balance
    // that bought the load.
    const newBalance = await updateAccountBalance(accountId, totalBalanceDeduction, 'debit', client);
    await client.query(
      `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, 'loading', $2, 'debit', $3, $4, $5, COALESCE($6::timestamptz, NOW()))`,
      [accountId, loadingTx.id, totalBalanceDeduction, newBalance,
       `Loading sale to ${customerNumber}: ${product.rows[0].name}${providerConvenienceFee > 0 ? ` (incl. ₱${providerConvenienceFee} conv. fee)` : ''}`,
       txDate]
    );

    // Drawer leg: the selling price is physical cash the customer handed over,
    // so it is credited to the branch's cash account. This is the half load
    // sales never booked — Cash on hand was short by exactly the retail value
    // of every cash sale. It carries the same 'loading' source as the channel
    // leg, so both rows trace back to the one sale.
    if (postDrawerLeg) {
      const drawerBalance = await updateAccountBalance(drawerId, legs.drawerIncrease, 'credit', client);
      await client.query(
        `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
         VALUES ($1, 'loading', $2, 'credit', $3, $4, $5, COALESCE($6::timestamptz, NOW()))`,
        [drawerId, loadingTx.id, legs.drawerIncrease, drawerBalance,
         `Cash from loading sale to ${customerNumber}: ${product.rows[0].name} (selling price, incl. ₱${legs.margin} margin)`,
         txDate]
      );
    }

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'loading.created', entity: 'loading_transaction', entityId: loadingTx.id, ipAddress: req.ip,
      newData: postDrawerLeg ? { drawerLeg: legs.drawerIncrease, channelDeduction: totalBalanceDeduction, margin: legs.margin } : undefined });

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

router.delete('/:id', authorize('loading.delete'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const loadingTx = (await client.query('SELECT * FROM loading_transactions WHERE id = $1', [req.params.id])).rows[0];
    if (!loadingTx) throw createError(404, 'Loading transaction not found');
    await assertBranch(req, loadingTx?.account_id, 'loading.write_all', 'Loading transaction not found');
    if (loadingTx.status === 'reversed') throw createError(400, 'Reversed loading transactions cannot be deleted');

    const entryAmount = parseFloat(loadingTx.total_cost) + parseFloat(loadingTx.provider_convenience_fee || '0');

    // The drawer's half of a cash sale, found by the source link rather than by
    // amount and date: it carries the sale's id, and a search keyed on figures
    // would take the first row that happened to match them.
    const drawerRow = (await client.query(
      `SELECT id, account_id, amount FROM ledger_entries
       WHERE source_type = 'loading' AND source_id = $1 AND entry_type = 'credit'`,
      [req.params.id]
    )).rows[0];

    // Restore account balance for completed loading transactions
    if (loadingTx.status === 'completed') {
      // Unwinding a settled loading transaction puts money back, so it is
      // gated like the sale it undoes; a draft restores nothing (D17).
      //
      // Held to the date the sale carries, because the ledger row removed
      // below is stamped with it — a shift open for another day would never
      // see that removal in its expected closing.
      await assertOpenShift(loadingTx.account_id, undefined, { eventDate: loadingTx.created_at });
      await client.query(
        `UPDATE accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2`,
        [entryAmount, loadingTx.account_id]
      );
      // The selling price goes back out of the till it went into. Left behind,
      // a deleted cash sale would strand its drawer leg and count the drawer
      // short by the retail value of a sale the books no longer show.
      if (drawerRow) {
        await client.query(
          `UPDATE accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
          [drawerRow.amount, drawerRow.account_id]
        );
      }
    }

    await client.query(
      `DELETE FROM ledger_entries WHERE account_id = $1 AND entry_type = 'debit' AND amount = $2 AND entry_date = $3`,
      [loadingTx.account_id, entryAmount, loadingTx.created_at]
    );
    if (drawerRow) {
      await client.query(`DELETE FROM ledger_entries WHERE id = $1`, [drawerRow.id]);
    }

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
