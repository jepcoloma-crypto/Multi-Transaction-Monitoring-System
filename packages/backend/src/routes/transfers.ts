import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { PaginatedResponse } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', authorize('transfers.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string;
    const accountId = req.query.accountId as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let pi = 1;

    if (status) { conditions.push(`t.status = $${pi++}`); params.push(status); }
    if (accountId) { conditions.push(`(t.source_account_id = $${pi} OR t.destination_account_id = $${pi})`); params.push(accountId); pi++; }

    const wc = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM transfers t ${wc}`, params);

    const transfers = await query(
      `SELECT t.*, sa.name as source_name, da.name as destination_name,
              sa.masked_account_number as source_masked, da.masked_account_number as dest_masked,
              u1.email as created_by_email, u2.email as approved_by_email
       FROM transfers t
       JOIN accounts sa ON t.source_account_id = sa.id
       JOIN accounts da ON t.destination_account_id = da.id
       LEFT JOIN users u1 ON t.created_by = u1.id
       LEFT JOIN users u2 ON t.approved_by = u2.id
       ${wc} ORDER BY t.transfer_date DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: { data: transfers, pagination: { page, limit, total: parseInt(countResult?.count || '0'), totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit) } } });
  } catch (error) { next(error); }
});

router.get('/summary', authorize('transfers.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const conds = ["t.status = 'completed'"];
    const params: any[] = [];
    let pi = 1;
    if (startDate) { conds.push(`t.transfer_date >= $${pi++}`); params.push(startDate); }
    if (endDate) { conds.push(`t.transfer_date <= $${pi++}`); params.push(endDate); }
    const wc = `WHERE ${conds.join(' AND ')}`;

    const summary = await queryOne(
      `SELECT COUNT(*) as total, COALESCE(SUM(transfer_amount), 0) as total_amount,
              COALESCE(SUM(transfer_fee), 0) as total_fees
       FROM transfers t ${wc}`, params
    );

    res.json({ success: true, data: { totalTransfers: parseInt(summary?.total || '0'), totalAmount: parseFloat(summary?.total_amount || '0'), totalFees: parseFloat(summary?.total_fees || '0') } });
  } catch (error) { next(error); }
});

router.get('/:id', authorize('transfers.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transfer = await queryOne(
      `SELECT t.*, sa.name as source_name, da.name as destination_name, sa.masked_account_number as source_masked, da.masked_account_number as dest_masked,
              u1.email as created_by_email, u2.email as approved_by_email
       FROM transfers t JOIN accounts sa ON t.source_account_id = sa.id JOIN accounts da ON t.destination_account_id = da.id
       LEFT JOIN users u1 ON t.created_by = u1.id LEFT JOIN users u2 ON t.approved_by = u2.id WHERE t.id = $1`, [req.params.id]
    );
    if (!transfer) throw createError(404, 'Transfer not found');

    const entries = await query(`SELECT * FROM transfer_entries WHERE transfer_id = $1 ORDER BY created_at`, [req.params.id]);
    res.json({ success: true, data: { ...transfer, entries } });
  } catch (error) { next(error); }
});

router.post('/', authorize('transfers.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { sourceAccountId, destinationAccountId, transferAmount, transferFee, purpose, notes, transferDate, feeDeductedFromAmount } = req.body;

    if (!sourceAccountId || !destinationAccountId) throw createError(400, 'Source and destination accounts are required');
    if (sourceAccountId === destinationAccountId) throw createError(400, 'Source and destination must be different');

    const srcAmount = parseFloat(transferAmount);
    const fee = parseFloat(transferFee || '0');
    if (isNaN(srcAmount) || srcAmount <= 0) throw createError(400, 'Transfer amount must be greater than zero');
    if (isNaN(fee) || fee < 0) throw createError(400, 'Fee cannot be negative');

    const feeDeducted = feeDeductedFromAmount === true;

    const srcAcct = await client.query('SELECT id, name, current_balance, status FROM accounts WHERE id = $1 FOR UPDATE', [sourceAccountId]);
    if (!srcAcct.rows[0]) throw createError(404, 'Source account not found');
    if (srcAcct.rows[0].status !== 'active') throw createError(400, 'Source account is not active');

    const dstAcct = await client.query('SELECT id, name, status FROM accounts WHERE id = $1 FOR UPDATE', [destinationAccountId]);
    if (!dstAcct.rows[0]) throw createError(404, 'Destination account not found');
    if (dstAcct.rows[0].status !== 'active') throw createError(400, 'Destination account is not active');

    let totalDeduction: number;
    let destinationAmount: number;

    if (feeDeducted && fee > 0) {
      destinationAmount = srcAmount - fee;
      totalDeduction = destinationAmount;
    } else {
      destinationAmount = srcAmount;
      totalDeduction = srcAmount;
    }

    if (parseFloat(srcAcct.rows[0].current_balance) < totalDeduction) throw createError(400, 'Insufficient balance');

    // Create transfer record
    const txNum = await client.query("SELECT nextval('transfers_transfer_number_seq') as nextval");
    const transfer = (await client.query(
      `INSERT INTO transfers (transfer_number, source_account_id, destination_account_id, transfer_amount, transfer_fee,
       total_source_deduction, destination_amount, purpose, status, transfer_date, created_by, notes, fee_deducted_from_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9, $10, $11, $12) RETURNING *`,
      [txNum.rows[0].nextval, sourceAccountId, destinationAccountId, srcAmount, fee, totalDeduction, destinationAmount, purpose || null, transferDate || new Date(), req.user!.userId, notes || null, feeDeducted]
    )).rows[0];

    // Debit source
    const srcBalance = parseFloat(srcAcct.rows[0].current_balance) - totalDeduction;
    await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [srcBalance, sourceAccountId]);

    const srcLedger = (await client.query(
      `INSERT INTO ledger_entries (account_id, transfer_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, $2, 'debit', $3, $4, $5, $6) RETURNING id`,
      [sourceAccountId, transfer.id, totalDeduction, srcBalance, `Transfer to ${dstAcct.rows[0].name}: ${purpose || ''}`, transferDate || new Date()]
    )).rows[0];

    await client.query(
      `INSERT INTO transfer_entries (transfer_id, account_id, entry_type, entry_category, amount, balance_after, ledger_entry_id)
       VALUES ($1, $2, 'debit', 'transfer_out', $3, $4, $5)`,
      [transfer.id, sourceAccountId, totalDeduction, srcBalance, srcLedger.id]
    );

    // Credit destination
    const dstBalance = parseFloat((await client.query('SELECT current_balance FROM accounts WHERE id = $1', [destinationAccountId])).rows[0].current_balance) + destinationAmount;
    await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [dstBalance, destinationAccountId]);

    const dstLedger = (await client.query(
      `INSERT INTO ledger_entries (account_id, transfer_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, $2, 'credit', $3, $4, $5, $6) RETURNING id`,
      [destinationAccountId, transfer.id, destinationAmount, dstBalance, `Transfer from ${srcAcct.rows[0].name}: ${purpose || ''}`, transferDate || new Date()]
    )).rows[0];

    await client.query(
      `INSERT INTO transfer_entries (transfer_id, account_id, entry_type, entry_category, amount, balance_after, ledger_entry_id)
       VALUES ($1, $2, 'credit', 'transfer_in', $3, $4, $5)`,
      [transfer.id, destinationAccountId, destinationAmount, dstBalance, dstLedger.id]
    );

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'transfer.created', entity: 'transfer', entityId: transfer.id, ipAddress: req.ip,
      newData: { source: srcAcct.rows[0].name, destination: dstAcct.rows[0].name, amount: srcAmount, fee } });

    res.status(201).json({ success: true, data: transfer });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/:id/approve', authorize('transfers.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transfer = await queryOne('SELECT * FROM transfers WHERE id = $1', [req.params.id]);
    if (!transfer) throw createError(404, 'Transfer not found');
    if (transfer.status !== 'pending') throw createError(400, 'Only pending transfers can be approved');

    const updated = await queryOne(
      `UPDATE transfers SET status = 'completed', approved_by = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user!.userId, req.params.id]
    );

    await createAuditLog({ userId: req.user!.userId, action: 'transfer.approved', entity: 'transfer', entityId: req.params.id, ipAddress: req.ip });

    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

export default router;
