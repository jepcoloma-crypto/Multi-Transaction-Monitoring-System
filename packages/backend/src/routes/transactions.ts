import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { canSeeAll, ownerClause, assertOwner } from '../middleware/scope';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { processTransaction, updateAccountBalance, createLedgerEntry } from '../services/balance';
import { calculateTieredFee } from '../services/feeCalc';
import { PaginatedResponse } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const accountId = req.query.accountId as string;
    const typeId = req.query.typeId as string;
    const status = req.query.status as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const search = req.query.search as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (accountId) { conditions.push(`t.account_id = $${paramIndex++}`); params.push(accountId); }
    if (typeId) { conditions.push(`t.transaction_type_id = $${paramIndex++}`); params.push(typeId); }
    if (status) { conditions.push(`t.status = $${paramIndex++}`); params.push(status); }
    if (startDate) { conditions.push(`t.transaction_date >= $${paramIndex++}`); params.push(startDate); }
    if (endDate) { conditions.push(`t.transaction_date < ($${paramIndex++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (req.query.minAmount) { conditions.push(`t.amount >= $${paramIndex++}`); params.push(parseFloat(req.query.minAmount as string)); }
    if (req.query.maxAmount) { conditions.push(`t.amount <= $${paramIndex++}`); params.push(parseFloat(req.query.maxAmount as string)); }
    if (search) {
      conditions.push(`(t.reference_number ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex} OR t.customer_name ILIKE $${paramIndex} OR CAST(t.transaction_number AS TEXT) ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    const scope = ownerClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM transactions t ${whereClause}`,
      params
    );

    const transactions = await query(
      `SELECT t.*, tt.name as type_name, tt.code as type_code, tt.direction,
              tc.name as category_name, a.name as account_name,
              u1.username as created_by_username, u2.email as approved_by_email
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN users u1 ON t.created_by = u1.id
       LEFT JOIN users u2 ON t.approved_by = u2.id
       ${whereClause}
       ORDER BY t.transaction_date DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: transactions,
      pagination: {
        page, limit,
        total: parseInt(countResult?.count || '0'),
        totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit),
      },
    };

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const accountId = req.query.accountId as string;

    const conditions: string[] = ["t.status = 'completed'"];
    const params: any[] = [];
    let paramIndex = 1;

    if (startDate) { conditions.push(`t.transaction_date >= $${paramIndex++}`); params.push(startDate); }
    if (endDate) { conditions.push(`t.transaction_date < ($${paramIndex++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (accountId) { conditions.push(`t.account_id = $${paramIndex++}`); params.push(accountId); }
    const scope = ownerClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const summary = await queryOne(
      `SELECT
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_money_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_money_out,
        COALESCE(SUM(COALESCE(t.fee, 0)), 0) as total_fees,
        COUNT(*) as transaction_count
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${whereClause}`,
      params
    );

    const byType = await query(
      `SELECT tt.name as type_name, tt.direction, COUNT(*) as count, COALESCE(SUM(t.amount + chg.total), 0) as total_amount
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${whereClause}
       GROUP BY tt.id, tt.name, tt.direction
       ORDER BY total_amount DESC`,
      params
    );

    res.json({
      success: true,
      data: {
        summary: {
          totalMoneyIn: parseFloat(summary?.total_money_in || '0'),
          totalMoneyOut: parseFloat(summary?.total_money_out || '0'),
          totalFees: parseFloat(summary?.total_fees || '0'),
          transactionCount: parseInt(summary?.transaction_count || '0'),
          netMovement: parseFloat(summary?.total_money_in || '0') - parseFloat(summary?.total_money_out || '0'),
        },
        byType,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/today', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayParams: any[] = [today];
    let todayWhere = `WHERE DATE(t.transaction_date) = $1`;
    if (!canSeeAll(req, 'transactions.read_all')) {
      todayWhere += ` AND t.created_by = $2`;
      todayParams.push(req.user!.userId);
    }
    const summary = await queryOne(
      `SELECT
        COUNT(*) as transaction_count,
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as money_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as money_out,
        COALESCE(SUM(COALESCE(t.fee, 0)), 0) as fees_collected,
        COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_count,
        COUNT(CASE WHEN t.status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN t.status = 'reversed' THEN 1 END) as reversed_count
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${todayWhere}`,
      todayParams
    );

    res.json({
      success: true,
      data: {
        today: {
          transactionCount: parseInt(summary?.transaction_count || '0'),
          moneyIn: parseFloat(summary?.money_in || '0'),
          moneyOut: parseFloat(summary?.money_out || '0'),
          feesCollected: parseFloat(summary?.fees_collected || '0'),
          completedCount: parseInt(summary?.completed_count || '0'),
          pendingCount: parseInt(summary?.pending_count || '0'),
          reversedCount: parseInt(summary?.reversed_count || '0'),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/by-customer-name', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.query.name as string;
    if (!name) throw createError(400, 'Customer name is required');

    const seeAll = canSeeAll(req, 'transactions.read_all');
    const nameParams: any[] = [`%${name}%`];
    const nameSummaryParams: any[] = [`%${name}%`];
    let listWhere = `WHERE t.customer_name ILIKE $1`;
    let summaryWhere = `WHERE t.customer_name ILIKE $1 AND t.status = 'completed'`;
    if (!seeAll) {
      listWhere += ` AND t.created_by = $2`;
      summaryWhere += ` AND t.created_by = $2`;
      nameParams.push(req.user!.userId);
      nameSummaryParams.push(req.user!.userId);
    }

    const transactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges, t.customer_name, t.customer_id,
              tt.name as type_name, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       ${listWhere}
       ORDER BY t.transaction_date DESC`,
      nameParams
    );

    const summary = await queryOne(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out,
        COALESCE(SUM(COALESCE(t.fee, 0)), 0) as total_fees
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${summaryWhere}`,
      nameSummaryParams
    );

    res.json({
      success: true,
      data: {
        customerName: name,
        transactions,
        summary: {
          totalTransactions: parseInt(summary?.total_count || '0'),
          totalMoneyIn: parseFloat(summary?.total_in || '0'),
          totalMoneyOut: parseFloat(summary?.total_out || '0'),
          totalFees: parseFloat(summary?.total_fees || '0'),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transaction = await queryOne(
      `SELECT t.*, tt.name as type_name, tt.code as type_code, tt.direction,
              tc.name as category_name, a.name as account_name,
              u1.username as created_by_username, u2.email as approved_by_email
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN users u1 ON t.created_by = u1.id
       LEFT JOIN users u2 ON t.approved_by = u2.id
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (!transaction) {
      throw createError(404, 'Transaction not found');
    }
    assertOwner(req, transaction, 'transactions.read_all', 'Transaction not found');

    const ledgerEntries = await query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY entry_date`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...transaction, ledgerEntries } });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const {
      accountId, transactionTypeId, transactionCategoryId, feeRuleId, amount, fee, manualFee,
      referenceNumber, externalReference, transactionDate, description,
      customerName, customerContact, status, feeAddedToBalance, additionalCharges, notes, customerId,
    } = req.body;

    let resolvedTypeId = transactionTypeId;
    let resolvedCategoryId = transactionCategoryId || null;

    if (feeRuleId) {
      const feeRule = await queryOne<{ transaction_type_id: string; transaction_category_id: string | null }>(
        'SELECT transaction_type_id, transaction_category_id FROM transaction_fees WHERE id = $1',
        [feeRuleId]
      );
      if (!feeRule) throw createError(404, 'Fee rule not found');
      resolvedTypeId = feeRule.transaction_type_id;
      resolvedCategoryId = feeRule.transaction_category_id;
    }

    if (!accountId || !resolvedTypeId || amount === undefined) {
      throw createError(400, 'Account, transaction type (or fee rule), and amount are required');
    }

    const amountNum = parseFloat(amount);
    if (amountNum < 0) throw createError(400, 'Amount cannot be negative');

    let feeNum = parseFloat(fee || '0');
    if (feeNum < 0) throw createError(400, 'Fee cannot be negative');

    const feeConfigs = await query<{ id: string; fee_type: string; fee_value: number; min_fee: number; max_fee: number | null; calculation_method: string }>(
      `SELECT id, fee_type, fee_value, min_fee, max_fee, calculation_method FROM transaction_fees
       WHERE transaction_type_id = $1 AND is_active = true
       AND (transaction_category_id IS NULL OR transaction_category_id = $2)`,
      [resolvedTypeId, resolvedCategoryId]
    );
    if (feeConfigs.length > 0 && !manualFee) {
      const feeTiers = await query<any>(
        'SELECT * FROM transaction_fee_tiers WHERE fee_id = ANY($1::uuid[]) ORDER BY min_amount',
        [feeConfigs.map((f) => f.id)]
      );
      let totalFee = 0;
      for (const fc of feeConfigs) {
        const configTiers = feeTiers.filter((t: any) => t.fee_id === fc.id);
        const tierResult = calculateTieredFee(fc, configTiers, amountNum);
        let calcFee: number;
        if (tierResult !== null) {
          calcFee = tierResult;
        } else if (fc.fee_type === 'percentage') {
          calcFee = (amountNum * Number(fc.fee_value)) / 100;
        } else {
          calcFee = Number(fc.fee_value);
        }
        if (fc.min_fee && calcFee < Number(fc.min_fee)) calcFee = Number(fc.min_fee);
        if (fc.max_fee && calcFee > Number(fc.max_fee)) calcFee = Number(fc.max_fee);
        totalFee += calcFee;
      }
      feeNum = Math.round(totalFee * 100) / 100;
    }
    feeNum = Math.ceil(feeNum - 1e-9);

    const account = await queryOne('SELECT id, name, status, created_by FROM accounts WHERE id = $1', [accountId]);
    if (!account) throw createError(404, 'Account not found');
    if (account.status === 'closed') throw createError(400, 'Cannot add transactions to a closed account');

    const txType = await queryOne<{ id: string; direction: string }>(
      'SELECT id, direction FROM transaction_types WHERE id = $1', [resolvedTypeId]
    );
    if (!txType) throw createError(404, 'Transaction type not found');

    const deductFee = feeAddedToBalance === false && feeNum > 0;
    if (deductFee && amountNum < feeNum) {
      throw createError(400, 'Fee cannot exceed the transaction amount when deducted from transaction amount');
    }
    const netAmount = deductFee ? Math.round((amountNum - feeNum) * 100) / 100 : amountNum;
    const totalCharges = (additionalCharges || []).reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);
    const totalAmount = netAmount + totalCharges;
    const entryType = txType.direction === 'in' || txType.direction === 'adjustment' ? 'credit' : 'debit';

    if (entryType === 'debit') {
      const balance = await queryOne<{ current_balance: string }>(
        'SELECT current_balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]
      );
      if (parseFloat(balance?.current_balance || '0') < totalAmount) {
        throw createError(400, 'Insufficient balance');
      }
    }

    const txNumber = await queryOne<{ nextval: string }>("SELECT nextval('transactions_transaction_number_seq') as nextval");

    const transaction = await queryOne(
      `INSERT INTO transactions (transaction_number, account_id, transaction_type_id, transaction_category_id,
       amount, fee, net_amount, reference_number, external_reference, transaction_date, description,
       customer_name, customer_contact, status, created_by, fee_added_to_balance, additional_charges, notes, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        txNumber!.nextval, accountId, resolvedTypeId, resolvedCategoryId,
        amountNum, feeNum, netAmount, referenceNumber || null, externalReference || null,
        transactionDate || new Date(), description || null,
        customerName || null, customerContact || null, status || 'completed', req.user!.userId,
        feeAddedToBalance !== false, JSON.stringify(additionalCharges || []), notes || null, customerId || null,
      ]
    );

    const { newBalance } = await processTransaction(
      accountId, resolvedTypeId, totalAmount, feeNum, entryType as 'debit' | 'credit',
      transaction!.id, referenceNumber, description, new Date(transactionDate || Date.now()), client,
      feeAddedToBalance !== false
    );

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.created',
      entity: 'transaction',
      entityId: transaction!.id,
      ipAddress: req.ip,
      newData: { accountName: account.name, amount: amountNum, direction: txType.direction, newBalance },
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.patch('/:id/charges', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const { additionalCharges } = req.body;
    if (!Array.isArray(additionalCharges)) {
      throw createError(400, 'additionalCharges must be an array');
    }

    await client.query('BEGIN');

    const originalRes = await client.query(
      `SELECT t.id, t.created_by, t.account_id, t.additional_charges, t.status, t.reference_number, tt.direction
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    const original = originalRes.rows[0];
    if (!original) throw createError(404, 'Transaction not found');
    assertOwner(req, original, 'transactions.write_all', 'Transaction not found');

    const chargeTotal = (charges: any): number =>
      Math.round(
        (Array.isArray(charges) ? charges : []).reduce(
          (sum: number, c: any) => sum + (parseFloat(c?.amount) || 0), 0
        ) * 100
      ) / 100;

    const oldTotal = chargeTotal(original.additional_charges);
    const newTotal = chargeTotal(additionalCharges);
    const delta = Math.round((newTotal - oldTotal) * 100) / 100;

    if (delta !== 0 && original.status !== 'reversed') {
      const creditLike = original.direction === 'in' || original.direction === 'adjustment';
      const entryType: 'debit' | 'credit' = delta > 0
        ? (creditLike ? 'credit' : 'debit')
        : (creditLike ? 'debit' : 'credit');
      const amount = Math.abs(delta);

      let newBalance: number;
      try {
        newBalance = await updateAccountBalance(original.account_id, amount, entryType, client);
      } catch (err: any) {
        if (err?.message === 'Insufficient balance') throw createError(400, 'Insufficient balance for charge adjustment');
        throw err;
      }

      await createLedgerEntry(
        original.account_id,
        entryType,
        amount,
        newBalance,
        original.id,
        null,
        original.reference_number,
        `Additional charges updated: ${oldTotal.toFixed(2)} -> ${newTotal.toFixed(2)}`,
        new Date(),
        client
      );
    }

    const updated = await client.query(
      `UPDATE transactions SET additional_charges = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [JSON.stringify(additionalCharges), req.params.id]
    );

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.charges_updated',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { additionalCharges, oldTotal, newTotal, delta },
    });

    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.patch('/:id/notes', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body;
    const transaction = await queryOne('SELECT id, created_by FROM transactions WHERE id = $1', [req.params.id]);
    assertOwner(req, transaction, 'transactions.write_all', 'Transaction not found');

    const updated = await queryOne(
      `UPDATE transactions SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [notes || null, req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.notes_updated',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { notes },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reverse', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const original = await queryOne(
      `SELECT t.*, tt.direction FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!original) throw createError(404, 'Transaction not found');
    assertOwner(req, original, 'transactions.write_all', 'Transaction not found');
    if (original.status === 'reversed') throw createError(400, 'Transaction already reversed');

    const txType = await queryOne<{ code: string }>(
      'SELECT code FROM transaction_types WHERE id = $1', [original.transaction_type_id]
    );
    if (txType?.code === 'adjustment_in' || txType?.code === 'adjustment_out') {
      throw createError(400, 'Adjustment transactions cannot be reversed');
    }

    const { reason } = req.body;

    const originalCharges = original.additional_charges || [];
    const totalOriginalAmount = parseFloat(original.net_amount || original.amount) + originalCharges.reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);

    await client.query(
      `UPDATE transactions SET status = 'reversed', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    const reverseEntryType = original.direction === 'in' ? 'debit' : 'credit';
    const reverseTypeId = await queryOne<{ id: string }>(
      `SELECT id FROM transaction_types WHERE code = $1`,
      [original.direction === 'in' ? 'adjustment_out' : 'adjustment_in']
    );

    const reverseTx = await queryOne(
      `INSERT INTO transactions (account_id, transaction_type_id, amount, fee, net_amount,
       reference_number, transaction_date, description, status, created_by)
       VALUES ($1, $2, $3, 0, $3, $4, NOW(), $5, 'completed', $6)
       RETURNING *`,
      [
        original.account_id, reverseTypeId!.id, original.amount,
        `REV-${original.transaction_number}`, `Reversal: ${reason || original.description || 'Transaction reversal'}`,
        req.user!.userId,
      ]
    );

    await processTransaction(
      original.account_id, reverseTypeId!.id, totalOriginalAmount, 0,
      reverseEntryType as 'debit' | 'credit', reverseTx!.id,
      `REV-${original.transaction_number}`, `Reversal: ${reason || 'Transaction reversal'}`,
      new Date(), client
    );

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.reversed',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { originalNumber: original.transaction_number, reason },
    });

    res.json({ success: true, data: reverseTx });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.delete('/:id', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const original = await client.query(
      `SELECT t.id, t.transaction_number, t.amount, t.status, t.account_id, t.created_by FROM transactions t WHERE t.id = $1`,
      [req.params.id]
    );
    const transaction = original.rows[0];
    assertOwner(req, transaction, 'transactions.write_all', 'Transaction not found');
    if (transaction.status === 'reversed') {
      throw createError(400, 'Reversed transactions cannot be deleted — its reversal is already recorded');
    }

    const account = await client.query(
      'SELECT id FROM accounts WHERE id = $1',
      [transaction.account_id]
    );
    if (!account.rows[0]) throw createError(404, 'Account not found');

    await client.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [req.params.id]);
    await client.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.deleted',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { transactionNumber: transaction.transaction_number, amount: parseFloat(transaction.amount), status: transaction.status },
    });

    res.json({ success: true, data: { message: 'Transaction deleted' } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

export default router;
