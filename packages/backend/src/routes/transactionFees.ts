import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();
router.use(authenticate);

const FEE_SELECT = `tf.*, tt.name as type_name, tt.code as type_code, tt.direction,
  tc.id as category_id, tc.name as category_name, tc.code as category_code`;

const FEE_FROM = `transaction_fees tf
  JOIN transaction_types tt ON tf.transaction_type_id = tt.id
  LEFT JOIN transaction_categories tc ON tf.transaction_category_id = tc.id`;

router.get('/', authorize('transactions.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const fees = await query(
      `SELECT ${FEE_SELECT} FROM ${FEE_FROM} ORDER BY tt.direction, tt.name, tf.name`
    );
    const feeIds = fees.map((f: any) => f.id);
    const tiers = feeIds.length > 0
      ? await query(`SELECT * FROM transaction_fee_tiers WHERE fee_id = ANY($1::uuid[]) ORDER BY min_amount`, [feeIds])
      : [];
    const feesWithTiers = fees.map((f: any) => ({
      ...f,
      tiers: tiers.filter((t: any) => t.fee_id === f.id),
    }));
    res.json({ success: true, data: feesWithTiers });
  } catch (error) { next(error); }
});

router.get('/calculate/:typeId', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categoryId = req.query.categoryId as string;
    const amount = parseFloat(req.query.amount as string) || 0;
    const params: any[] = [req.params.typeId];
    let sql = `SELECT * FROM transaction_fees WHERE transaction_type_id = $1 AND is_active = true`;
    if (categoryId) {
      sql += ` AND (transaction_category_id IS NULL OR transaction_category_id = $2)`;
      params.push(categoryId);
    }
    sql += ' ORDER BY fee_value DESC';
    const fees = await query(sql, params);

    const feesWithTiers = await Promise.all(fees.map(async (fee: any) => {
      const tiers = await query(
        'SELECT * FROM transaction_fee_tiers WHERE fee_id = $1 ORDER BY min_amount',
        [fee.id]
      );
      let calculatedFee = fee.fee_value;
      if (fee.fee_type === 'flat_per_step') {
        const baseAmount = parseFloat(fee.base_amount) || 0;
        const stepAmount = parseFloat(fee.step_amount) || 1;
        const stepFee = parseFloat(fee.step_fee) || 0;
        if (amount > baseAmount) {
          const steps = Math.ceil((amount - baseAmount) / stepAmount);
          calculatedFee = parseFloat(fee.fee_value) + (steps * stepFee);
        } else {
          calculatedFee = parseFloat(fee.fee_value);
        }
      } else if (tiers.length > 0) {
        let matchedTier = tiers.find((tier: any) =>
          amount >= parseFloat(tier.min_amount) &&
          (tier.max_amount === null || amount <= parseFloat(tier.max_amount))
        );
        if (!matchedTier && amount >= parseFloat(tiers[0].min_amount)) {
          matchedTier =
            tiers.find((tier: any) => amount < parseFloat(tier.min_amount)) ||
            tiers.filter((tier: any) => amount >= parseFloat(tier.min_amount)).pop();
        }
        if (matchedTier) {
          calculatedFee = matchedTier.fee_type === 'percentage'
            ? (amount * parseFloat(matchedTier.fee_value) / 100)
            : parseFloat(matchedTier.fee_value);
        }
      }
      if (fee.min_fee && calculatedFee < fee.min_fee) calculatedFee = fee.min_fee;
      if (fee.max_fee && calculatedFee > fee.max_fee) calculatedFee = fee.max_fee;
      calculatedFee = Math.round(calculatedFee * 100) / 100;
      return { ...fee, calculatedFee, tiers };
    }));

    res.json({ success: true, data: feesWithTiers });
  } catch (error) { next(error); }
});

router.get('/:id', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fee = await queryOne(
      `SELECT ${FEE_SELECT} FROM ${FEE_FROM} WHERE tf.id = $1`,
      [req.params.id]
    );
    if (!fee) throw createError(404, 'Fee configuration not found');
    res.json({ success: true, data: fee });
  } catch (error) { next(error); }
});

router.post('/', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const { transactionTypeId, transactionCategoryId, name, feeType, feeValue, minFee, maxFee, description, tiers, baseAmount, stepAmount, stepFee } = req.body;

    if (!transactionTypeId || !name || feeValue === undefined) {
      throw createError(400, 'Transaction type, name, and fee value are required');
    }

    if (!['fixed', 'percentage'].includes(feeType)) {
      throw createError(400, 'Fee type must be "fixed" or "percentage"');
    }

    if (feeType === 'percentage' && (feeValue < 0 || feeValue > 100)) {
      throw createError(400, 'Percentage fee must be between 0 and 100');
    }

    const txType = await queryOne('SELECT id FROM transaction_types WHERE id = $1', [transactionTypeId]);
    if (!txType) throw createError(404, 'Transaction type not found');

    if (transactionCategoryId) {
      const cat = await queryOne('SELECT id FROM transaction_categories WHERE id = $1 AND transaction_type_id = $2', [transactionCategoryId, transactionTypeId]);
      if (!cat) throw createError(404, 'Category not found for this transaction type');
    }

    await client.query('BEGIN');

    const fee = (await client.query(
      `INSERT INTO transaction_fees (transaction_type_id, transaction_category_id, name, fee_type, fee_value, min_fee, max_fee, description, base_amount, step_amount, step_fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [transactionTypeId, transactionCategoryId || null, name, feeType || 'fixed', parseFloat(feeValue), parseFloat(minFee || '0'), maxFee ? parseFloat(maxFee) : null, description || null, parseFloat(baseAmount || '0'), parseFloat(stepAmount || '0'), parseFloat(stepFee || '0')]
    )).rows[0];

    if (tiers && Array.isArray(tiers) && tiers.length > 0) {
      for (const tier of tiers) {
        await client.query(
          `INSERT INTO transaction_fee_tiers (fee_id, min_amount, max_amount, fee_value, fee_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [fee.id, parseFloat(tier.minAmount), tier.maxAmount ? parseFloat(tier.maxAmount) : null, parseFloat(tier.feeValue), tier.feeType || 'fixed']
        );
      }
    }

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId, action: 'fee.created', entity: 'transaction_fee',
      entityId: fee.id, ipAddress: req.ip, newData: { name, feeType, feeValue, tiersCount: tiers?.length || 0 },
    });

    res.status(201).json({ success: true, data: fee });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.put('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const { transactionCategoryId, name, feeType, feeValue, minFee, maxFee, isActive, description, tiers, baseAmount, stepAmount, stepFee } = req.body;

    const existing = await queryOne('SELECT * FROM transaction_fees WHERE id = $1', [req.params.id]);
    if (!existing) throw createError(404, 'Fee configuration not found');

    if (feeType && !['fixed', 'percentage', 'flat_per_step'].includes(feeType)) {
      throw createError(400, 'Fee type must be "fixed", "percentage", or "flat_per_step"');
    }

    if (feeType === 'percentage' && feeValue !== undefined && (feeValue < 0 || feeValue > 100)) {
      throw createError(400, 'Percentage fee must be between 0 and 100');
    }

    await client.query('BEGIN');

    const fee = (await client.query(
      `UPDATE transaction_fees SET
        transaction_category_id = $1,
        name = COALESCE($2, name), fee_type = COALESCE($3, fee_type),
        fee_value = COALESCE($4, fee_value), min_fee = COALESCE($5, min_fee),
        max_fee = $6, is_active = COALESCE($7, is_active),
        description = $8, updated_at = NOW(),
        base_amount = $9, step_amount = $10, step_fee = $11
       WHERE id = $12 RETURNING *`,
      [
        transactionCategoryId !== undefined ? transactionCategoryId : existing.transaction_category_id,
        name || existing.name, feeType || existing.fee_type,
        feeValue !== undefined ? parseFloat(feeValue) : existing.fee_value,
        minFee !== undefined ? parseFloat(minFee) : existing.min_fee,
        maxFee !== undefined ? (maxFee ? parseFloat(maxFee) : null) : existing.max_fee,
        isActive, description !== undefined ? description : existing.description,
        baseAmount !== undefined ? parseFloat(baseAmount) : (existing.base_amount || 0),
        stepAmount !== undefined ? parseFloat(stepAmount) : (existing.step_amount || 0),
        stepFee !== undefined ? parseFloat(stepFee) : (existing.step_fee || 0),
        req.params.id,
      ]
    )).rows[0];

    if (tiers && Array.isArray(tiers)) {
      await client.query('DELETE FROM transaction_fee_tiers WHERE fee_id = $1', [req.params.id]);
      for (const tier of tiers) {
        await client.query(
          `INSERT INTO transaction_fee_tiers (fee_id, min_amount, max_amount, fee_value, fee_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, parseFloat(tier.minAmount), tier.maxAmount ? parseFloat(tier.maxAmount) : null, parseFloat(tier.feeValue), tier.feeType || 'fixed']
        );
      }
    }

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId, action: 'fee.updated', entity: 'transaction_fee',
      entityId: req.params.id, ipAddress: req.ip,
    });

    res.json({ success: true, data: fee });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.delete('/:id', authorize('settings.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fee = await queryOne('SELECT id FROM transaction_fees WHERE id = $1', [req.params.id]);
    if (!fee) throw createError(404, 'Fee configuration not found');

    await query('DELETE FROM transaction_fees WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId, action: 'fee.deleted', entity: 'transaction_fee',
      entityId: req.params.id, ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Fee configuration deleted' });
  } catch (error) { next(error); }
});

export default router;
