import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();
router.use(authenticate);

const round2 = (n: number) => Math.round(n * 100) / 100;

router.get('/', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string;
    const accountId = req.query.accountId as string;

    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (status) { conds.push(`r.status = $${pi++}`); params.push(status); }
    if (accountId) { conds.push(`r.account_id = $${pi++}`); params.push(accountId); }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM reconciliations r ${wc}`, params);

    const recons = await query(
      `SELECT r.*, a.name as account_name, u.email as reconciled_by_email
       FROM reconciliations r JOIN accounts a ON r.account_id = a.id
       LEFT JOIN users u ON r.reconciled_by = u.id
       ${wc} ORDER BY r.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: { data: recons, pagination: { page, limit, total: parseInt(countResult?.count || '0'), totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit) } } });
  } catch (error) { next(error); }
});

router.get('/:id', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recon = await queryOne(
      `SELECT r.*, a.name as account_name, u.email as reconciled_by_email
       FROM reconciliations r JOIN accounts a ON r.account_id = a.id
       LEFT JOIN users u ON r.reconciled_by = u.id WHERE r.id = $1`, [req.params.id]
    );
    if (!recon) throw createError(404, 'Reconciliation not found');

    const items = await query('SELECT * FROM reconciliation_items WHERE reconciliation_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ success: true, data: { ...recon, items } });
  } catch (error) { next(error); }
});

router.post('/', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, actualBalance, notes } = req.body;
    if (!accountId || actualBalance === undefined) throw createError(400, 'Account and actual balance are required');

    const account = await queryOne('SELECT id, name, current_balance FROM accounts WHERE id = $1', [accountId]);
    if (!account) throw createError(404, 'Account not found');

    const expected = parseFloat(account.current_balance);
    const actual = parseFloat(actualBalance);
    const variance = actual - expected;

    const recon = await queryOne(
      `INSERT INTO reconciliations (account_id, expected_balance, actual_balance, variance, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [accountId, expected, actual, variance, Math.abs(variance) < 0.01 ? 'matched' : 'variance', notes || null]
    );

    await createAuditLog({ userId: req.user!.userId, action: 'reconciliation.created', entity: 'reconciliation', entityId: recon!.id, ipAddress: req.ip,
      newData: { accountName: account.name, expected, actual, variance } });

    res.status(201).json({ success: true, data: recon });
  } catch (error) { next(error); }
});

router.post('/:id/adjust', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  if (!(req.user!.roles || []).includes('administrator')) {
    return next(createError(403, 'Only administrators can apply a reconciliation adjustment'));
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const recon = (await client.query('SELECT * FROM reconciliations WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!recon) throw createError(404, 'Reconciliation not found');

    const { adjustmentAmount, reason } = req.body;
    if (!adjustmentAmount || !reason) throw createError(400, 'Adjustment amount and reason are required');

    const adjAmount = parseFloat(adjustmentAmount);
    if (!Number.isFinite(adjAmount) || adjAmount === 0) {
      throw createError(400, 'Adjustment amount must be a non-zero number');
    }

    const acct = (await client.query(
      'SELECT current_balance, opening_balance FROM accounts WHERE id = $1 FOR UPDATE',
      [recon.account_id]
    )).rows[0];
    const currentBalance = round2(parseFloat(acct.current_balance));

    const prevRow = (await client.query(
      'SELECT balance_after FROM ledger_entries WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [recon.account_id]
    )).rows[0];
    const prevBalance = prevRow
      ? round2(parseFloat(prevRow.balance_after))
      : round2(parseFloat(acct.opening_balance || '0'));

    // Layering an adjustment onto a ledger/balance disagreement would bury the
    // original discrepancy under a second one, so it is refused outright.
    if (prevBalance !== currentBalance) {
      throw createError(409, `Ledger and balance disagree (ledger ${prevBalance.toFixed(2)}, balance ${currentBalance.toFixed(2)}) — reconcile the imbalance before applying an adjustment`);
    }

    const newBalance = round2(prevBalance + adjAmount);
    if (newBalance < 0) throw createError(400, 'Adjustment would take the account below zero');

    await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [newBalance, recon.account_id]);

    const entryType = adjAmount >= 0 ? 'credit' : 'debit';
    await client.query(
      `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, 'reconciliation', $2, $3, $4, $5, $6, NOW())`,
      [recon.account_id, recon.id, entryType, Math.abs(adjAmount), newBalance, `Reconciliation adjustment: ${reason}`]
    );

    const newVariance = round2(parseFloat(recon.actual_balance) - newBalance);
    await client.query(
      `UPDATE reconciliations SET actual_balance = $1, variance = $2, status = 'adjusted', reconciled_by = $3, reconciled_at = NOW(), updated_at = NOW() WHERE id = $4`,
      [recon.actual_balance, newVariance, req.user!.userId, req.params.id]
    );

    await client.query('COMMIT');

    await createAuditLog({ userId: req.user!.userId, action: 'reconciliation.adjusted', entity: 'reconciliation', entityId: req.params.id, ipAddress: req.ip,
      newData: { adjustment: adjAmount, reason, prevBalance, newBalance, variance: newVariance } });

    res.json({ success: true, message: 'Adjustment applied' });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

router.post('/:id/complete', authorize('reconciliation.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const recon = await queryOne('SELECT * FROM reconciliations WHERE id = $1', [req.params.id]);
    if (!recon) throw createError(404, 'Reconciliation not found');
    if (recon.status === 'reconciled') throw createError(400, 'Already reconciled');

    const updated = await queryOne(
      `UPDATE reconciliations SET status = 'reconciled', reconciled_by = $1, reconciled_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user!.userId, req.params.id]
    );

    await createAuditLog({ userId: req.user!.userId, action: 'reconciliation.completed', entity: 'reconciliation', entityId: req.params.id, ipAddress: req.ip });
    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

export default router;
