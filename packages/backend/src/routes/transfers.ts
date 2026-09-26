import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { canSeeAll, ownerClause, assertOwner } from '../middleware/scope';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { lookupProviderCharge } from '../services/providerCharge';
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
    const scope = ownerClause(req, 't', 'transfers.read_all', pi);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      pi = scope.paramIndex;
    }

    const wc = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM transfers t ${wc}`, params);

    const transfers = await query(
      `SELECT t.*, sa.name as source_name, da.name as destination_name,
              sa.masked_account_number as source_masked, da.masked_account_number as dest_masked,
              u1.email as created_by_email, u1.username as created_by_username, u2.email as approved_by_email
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
    if (endDate) { conds.push(`t.transfer_date < ($${pi++}::date + INTERVAL '1 day')`); params.push(endDate); }
    const scope = ownerClause(req, 't', 'transfers.read_all', pi);
    if (scope.clause) {
      conds.push(scope.clause);
      params.push(...scope.params);
      pi = scope.paramIndex;
    }
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
    assertOwner(req, transfer, 'transfers.read_all', 'Transfer not found');

    const entries = await query(`SELECT * FROM transfer_entries WHERE transfer_id = $1 ORDER BY created_at`, [req.params.id]);
    res.json({ success: true, data: { ...transfer, entries } });
  } catch (error) { next(error); }
});

async function moveTransferFunds(
  client: Awaited<ReturnType<typeof getClient>>,
  transfer: any,
  srcAcct: any,
  dstAcct: any
): Promise<void> {
  const totalDeduction = parseFloat(transfer.total_source_deduction);
  const destinationAmount = parseFloat(transfer.destination_amount);
  const charge = parseFloat(transfer.transfer_fee) || 0;

  const srcBalance = parseFloat(srcAcct.current_balance) - totalDeduction;
  if (srcBalance < -0.000001) throw createError(400, 'Insufficient balance for transfer amount plus service charge');
  await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2',
    [srcBalance.toFixed(2), transfer.source_account_id]);

  const srcDesc = `Transfer to ${dstAcct.name}: ${transfer.purpose || ''}` + (charge > 0 ? ` (incl. ${charge.toFixed(2)} service charge)` : '');
  const srcLedger = (await client.query(
    `INSERT INTO ledger_entries (account_id, transfer_id, entry_type, amount, balance_after, description, entry_date)
     VALUES ($1, $2, 'debit', $3, $4, $5, $6) RETURNING id`,
    [transfer.source_account_id, transfer.id, totalDeduction, srcBalance, srcDesc, transfer.transfer_date]
  )).rows[0];
  await client.query(
    `INSERT INTO transfer_entries (transfer_id, account_id, entry_type, entry_category, amount, balance_after, ledger_entry_id)
     VALUES ($1, $2, 'debit', 'transfer_out', $3, $4, $5)`,
    [transfer.id, transfer.source_account_id, totalDeduction, srcBalance, srcLedger.id]
  );

  const dstBalance = parseFloat((await client.query('SELECT current_balance FROM accounts WHERE id = $1', [transfer.destination_account_id])).rows[0].current_balance) + destinationAmount;
  await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2',
    [dstBalance.toFixed(2), transfer.destination_account_id]);

  const dstLedger = (await client.query(
    `INSERT INTO ledger_entries (account_id, transfer_id, entry_type, amount, balance_after, description, entry_date)
     VALUES ($1, $2, 'credit', $3, $4, $5, $6) RETURNING id`,
    [transfer.destination_account_id, transfer.id, destinationAmount, dstBalance, `Transfer from ${srcAcct.name}: ${transfer.purpose || ''}`, transfer.transfer_date]
  )).rows[0];
  await client.query(
    `INSERT INTO transfer_entries (transfer_id, account_id, entry_type, entry_category, amount, balance_after, ledger_entry_id)
     VALUES ($1, $2, 'credit', 'transfer_in', $3, $4, $5)`,
    [transfer.id, transfer.destination_account_id, destinationAmount, dstBalance, dstLedger.id]
  );
}

router.post('/', authorize('transfers.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { sourceAccountId, destinationAccountId, transferAmount, serviceCharge, transferFee, manualCharge, purpose, notes, transferDate } = req.body;

    if (!sourceAccountId || !destinationAccountId) throw createError(400, 'Source and destination accounts are required');
    if (sourceAccountId === destinationAccountId) throw createError(400, 'Source and destination must be different');

    const srcAmount = parseFloat(transferAmount);
    const clientCharge = parseFloat((serviceCharge ?? transferFee) || '0');
    if (isNaN(srcAmount) || srcAmount <= 0) throw createError(400, 'Transfer amount must be greater than zero');
    if (isNaN(clientCharge) || clientCharge < 0) throw createError(400, 'Service charge cannot be negative');

    const srcAcct = await client.query('SELECT id, name, provider_id, current_balance, status, created_by FROM accounts WHERE id = $1 FOR UPDATE', [sourceAccountId]);
    if (!srcAcct.rows[0]) throw createError(404, 'Source account not found');
    if (srcAcct.rows[0].status !== 'active') throw createError(400, 'Source account is not active');

    const dstAcct = await client.query('SELECT id, name, provider_id, status, created_by FROM accounts WHERE id = $1 FOR UPDATE', [destinationAccountId]);
    if (!dstAcct.rows[0]) throw createError(404, 'Destination account not found');
    if (dstAcct.rows[0].status !== 'active') throw createError(400, 'Destination account is not active');

    let charge = clientCharge;
    if (manualCharge !== true) {
      const rule = await lookupProviderCharge(srcAcct.rows[0].provider_id, dstAcct.rows[0].provider_id);
      if (rule) charge = parseFloat(rule.charge_amount);
    }

    const destinationAmount = srcAmount;
    const totalDeduction = srcAmount + charge;

    if (parseFloat(srcAcct.rows[0].current_balance) < totalDeduction) throw createError(400, 'Insufficient balance for transfer amount plus service charge');

    // Create transfer record
    const txNum = await client.query("SELECT nextval('transfers_transfer_number_seq') as nextval");
    const isAdminCreator = (req.user!.roles || []).includes('administrator');
    const transfer = (await client.query(
      `INSERT INTO transfers (transfer_number, source_account_id, destination_account_id, transfer_amount, transfer_fee,
       total_source_deduction, destination_amount, purpose, status, transfer_date, created_by, notes, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [txNum.rows[0].nextval, sourceAccountId, destinationAccountId, srcAmount, charge, totalDeduction, destinationAmount, purpose || null,
       isAdminCreator ? 'completed' : 'pending', transferDate || new Date(), req.user!.userId, notes || null, isAdminCreator ? new Date() : null]
    )).rows[0];

    if (isAdminCreator) {
      await moveTransferFunds(client, transfer, srcAcct.rows[0], dstAcct.rows[0]);
    }

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'transfer.created', entity: 'transfer', entityId: transfer.id, ipAddress: req.ip,
      newData: { source: srcAcct.rows[0].name, destination: dstAcct.rows[0].name, amount: srcAmount, serviceCharge: charge } });

    res.status(201).json({ success: true, data: transfer });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

router.post('/:id/approve', authorize('transfers.approve'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const transfer = (await client.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!transfer) throw createError(404, 'Transfer not found');
    if (transfer.status !== 'pending') throw createError(400, 'Only pending transfers can be approved');
    if (transfer.created_by === req.user!.userId) throw createError(400, 'You cannot approve your own transfer');

    const accounts = (await client.query(
      `SELECT id, name, current_balance, status FROM accounts WHERE id IN ($1, $2) FOR UPDATE`,
      [transfer.source_account_id, transfer.destination_account_id]
    )).rows;
    const srcAcct = accounts.find((a: any) => a.id === transfer.source_account_id);
    const dstAcct = accounts.find((a: any) => a.id === transfer.destination_account_id);
    if (!srcAcct || !dstAcct) throw createError(404, 'Transfer account not found');
    if (srcAcct.status !== 'active') throw createError(400, 'Source account is not active');

    await moveTransferFunds(client, transfer, srcAcct, dstAcct);

    const updated = (await client.query(
      `UPDATE transfers SET status = 'completed', approved_by = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user!.userId, req.params.id]
    )).rows[0];

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId, action: 'transfer.approved', entity: 'transfer', entityId: req.params.id, ipAddress: req.ip,
      newData: { amount: parseFloat(transfer.transfer_amount), totalDeduction: parseFloat(transfer.total_source_deduction) },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.post('/:id/reject', authorize('transfers.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw createError(400, 'Rejection reason is required');

    const transfer = await queryOne('SELECT * FROM transfers WHERE id = $1', [req.params.id]);
    if (!transfer) throw createError(404, 'Transfer not found');
    if (transfer.status !== 'pending') throw createError(400, 'Only pending transfers can be rejected');
    if (transfer.created_by === req.user!.userId) throw createError(400, 'You cannot reject your own transfer');

    const updated = await queryOne(
      `UPDATE transfers SET status = 'rejected', failure_reason = $1, rejected_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [reason, req.user!.userId, req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId, action: 'transfer.rejected', entity: 'transfer', entityId: req.params.id, ipAddress: req.ip,
      oldData: { status: 'pending' }, newData: { reason },
    });

    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

router.delete('/:id', authorize('transfers.delete'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const transfer = (await client.query('SELECT * FROM transfers WHERE id = $1', [req.params.id])).rows[0];
    if (!transfer) throw createError(404, 'Transfer not found');
    assertOwner(req, transfer, 'transfers.write_all', 'Transfer not found');
    if (transfer.status === 'reversed') throw createError(400, 'Reversed transfers cannot be deleted — its reversal is already recorded');

    const movesFunds = !['draft', 'pending', 'failed', 'rejected'].includes(transfer.status);

    if (movesFunds) {
      const accounts = (await client.query(
        `SELECT id, current_balance FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
        [transfer.source_account_id, transfer.destination_account_id]
      )).rows;
      const source = accounts.find((a: any) => a.id === transfer.source_account_id);
      const destination = accounts.find((a: any) => a.id === transfer.destination_account_id);
      if (!source || !destination) throw createError(404, 'Transfer account not found');

      const destinationAmount = parseFloat(transfer.destination_amount);
      const destinationNewBalance = parseFloat(destination.current_balance) - destinationAmount;
      if (destinationNewBalance < -0.000001) {
        throw createError(400, 'Deletion would make the destination account balance negative — reverse the transfer instead');
      }

      const sourceNewBalance = parseFloat(source.current_balance) + parseFloat(transfer.total_source_deduction);
      await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2',
        [sourceNewBalance.toFixed(2), transfer.source_account_id]);
      await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2',
        [destinationNewBalance.toFixed(2), transfer.destination_account_id]);
      await client.query('DELETE FROM ledger_entries WHERE transfer_id = $1', [req.params.id]);
    }

    await client.query('DELETE FROM transfers WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transfer.deleted',
      entity: 'transfer',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { transferNumber: transfer.transfer_number, amount: parseFloat(transfer.transfer_amount), status: transfer.status },
    });

    res.json({ success: true, data: { message: 'Transfer deleted' } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

export default router;
