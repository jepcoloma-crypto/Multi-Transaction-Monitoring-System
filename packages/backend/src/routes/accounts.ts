import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { canSeeAll, ownerClause, assertOwner } from '../middleware/scope';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { PaginatedResponse } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search as string;
    const status = req.query.status as string;
    const providerId = req.query.providerId as string;
    const typeId = req.query.typeId as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(a.name ILIKE $${paramIndex} OR a.owner ILIKE $${paramIndex} OR a.masked_account_number ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (status) {
      conditions.push(`a.status = $${paramIndex++}`);
      params.push(status);
    }
    if (providerId) {
      conditions.push(`a.provider_id = $${paramIndex++}`);
      params.push(providerId);
    }
    if (typeId) {
      conditions.push(`a.account_type_id = $${paramIndex++}`);
      params.push(typeId);
    }
    const scope = ownerClause(req, 'a', 'accounts.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM accounts a ${whereClause}`,
      params
    );

    const accounts = await query(
      `SELECT a.*, p.name as provider_name, p.code as provider_code, p.type as provider_type,
              at.name as type_name, at.code as type_code, u.email as created_by_email
       FROM accounts a
       JOIN providers p ON a.provider_id = p.id
       JOIN account_types at ON a.account_type_id = at.id
       LEFT JOIN users u ON a.created_by = u.id
       ${whereClause}
       ORDER BY a.name
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: accounts,
      pagination: {
        page,
        limit,
        total: parseInt(countResult?.count || '0'),
        totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit),
      },
    };

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await queryOne<{
      total_accounts: string;
      total_balance: string;
      active_accounts: string;
      low_balance_count: string;
    }>(
      `SELECT
        COUNT(*) as total_accounts,
        COALESCE(SUM(current_balance), 0) as total_balance,
        COUNT(*) FILTER (WHERE status = 'active') as active_accounts,
        COUNT(*) FILTER (WHERE current_balance <= minimum_balance AND status = 'active') as low_balance_count
       FROM accounts${canSeeAll(req, 'accounts.read_all') ? '' : ` WHERE created_by = $1`}`,
      canSeeAll(req, 'accounts.read_all') ? [] : [req.user!.userId]
    );

    const byProvider = await query(
      `SELECT p.name as provider_name, p.code as provider_code,
              COUNT(a.id) as account_count,
              COALESCE(SUM(a.current_balance), 0) as total_balance
       FROM providers p
       LEFT JOIN accounts a ON p.id = a.provider_id AND a.status = 'active'${canSeeAll(req, 'accounts.read_all') ? '' : ' AND a.created_by = $1'}
       GROUP BY p.id, p.name, p.code
       HAVING COUNT(a.id) > 0
       ORDER BY total_balance DESC`,
      canSeeAll(req, 'accounts.read_all') ? [] : [req.user!.userId]
    );

    const byType = await query(
      `SELECT at.name as type_name, at.code as type_code,
              COUNT(a.id) as account_count,
              COALESCE(SUM(a.current_balance), 0) as total_balance
       FROM account_types at
       LEFT JOIN accounts a ON at.id = a.account_type_id AND a.status = 'active'${canSeeAll(req, 'accounts.read_all') ? '' : ' AND a.created_by = $1'}
       GROUP BY at.id, at.name, at.code
       HAVING COUNT(a.id) > 0
       ORDER BY total_balance DESC`,
      canSeeAll(req, 'accounts.read_all') ? [] : [req.user!.userId]
    );

    res.json({
      success: true,
      data: {
        summary: {
          totalAccounts: parseInt(summary?.total_accounts || '0'),
          totalBalance: parseFloat(summary?.total_balance || '0'),
          activeAccounts: parseInt(summary?.active_accounts || '0'),
          lowBalanceCount: parseInt(summary?.low_balance_count || '0'),
        },
        byProvider,
        byType,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await queryOne(
      `SELECT a.*, p.name as provider_name, p.code as provider_code, p.type as provider_type,
              at.name as type_name, at.code as type_code,
              u.email as created_by_email
       FROM accounts a
       JOIN providers p ON a.provider_id = p.id
       JOIN account_types at ON a.account_type_id = at.id
       LEFT JOIN users u ON a.created_by = u.id
       WHERE a.id = $1`,
      [req.params.id]
    );

    if (!account) {
      throw createError(404, 'Account not found');
    }
    assertOwner(req, account, 'accounts.read_all', 'Account not found');

    res.json({ success: true, data: account });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('accounts.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name, providerId, accountTypeId, maskedAccountNumber,
      accountReference, owner, purpose, openingBalance,
      minimumBalance, targetBalance, notes,
    } = req.body;

    if (!name || !providerId || !accountTypeId || !String(maskedAccountNumber || '').trim()) {
      throw createError(400, 'Name, provider, account type, and masked account number are required');
    }

    const provider = await queryOne('SELECT id, name FROM providers WHERE id = $1 AND is_active = true', [providerId]);
    if (!provider) {
      throw createError(400, 'Invalid or inactive provider');
    }

    const accountType = await queryOne('SELECT id FROM account_types WHERE id = $1', [accountTypeId]);
    if (!accountType) {
      throw createError(400, 'Invalid account type');
    }

    const balance = parseFloat(openingBalance || '0');
    if (balance < 0) {
      throw createError(400, 'Opening balance cannot be negative');
    }

    const account = await queryOne(
      `INSERT INTO accounts (name, provider_id, account_type_id, masked_account_number,
       account_reference, owner, purpose, opening_balance, current_balance,
       minimum_balance, target_balance, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        name, providerId, accountTypeId, maskedAccountNumber || null,
        accountReference || null, owner || null, purpose || null,
        balance, balance,
        parseFloat(minimumBalance || '0'), parseFloat(targetBalance || '0'),
        notes || null, req.user!.userId,
      ]
    );

    if (balance > 0) {
      await query(
        'INSERT INTO account_balance_history (account_id, balance, recorded_by) VALUES ($1, $2, $3)',
        [account!.id, balance, req.user!.userId]
      );
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'account.created',
      entity: 'account',
      entityId: account!.id,
      ipAddress: req.ip,
      newData: { name, provider: provider.name, openingBalance: balance },
    });

    res.status(201).json({ success: true, data: account });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('accounts.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = req.params.id;
    const existing = await queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (!existing) {
      throw createError(404, 'Account not found');
    }
    assertOwner(req, existing, 'accounts.write_all', 'Account not found');

    if (existing.status === 'closed') {
      throw createError(400, 'Cannot modify a closed account');
    }

    const {
      name, providerId, accountTypeId, maskedAccountNumber, accountReference, owner, purpose,
      minimumBalance, targetBalance, status, notes, currentBalance,
    } = req.body;

    if (maskedAccountNumber !== undefined && !String(maskedAccountNumber ?? '').trim()) {
      throw createError(400, 'Masked account number is required');
    }

    if (providerId) {
      const provider = await queryOne('SELECT id FROM providers WHERE id = $1 AND is_active = true', [providerId]);
      if (!provider) throw createError(400, 'Invalid or inactive provider');
    }
    if (accountTypeId) {
      const accountType = await queryOne('SELECT id FROM account_types WHERE id = $1', [accountTypeId]);
      if (!accountType) throw createError(400, 'Invalid account type');
    }

    let newBalance: number | null = null;
    if (currentBalance !== undefined && currentBalance !== null && currentBalance !== '') {
      if (!req.user!.roles.includes('administrator')) {
        throw createError(403, 'Only administrators can edit account balances');
      }
      const parsed = parseFloat(currentBalance);
      if (isNaN(parsed)) throw createError(400, 'Balance must be a valid number');
      newBalance = parsed;
    }

    const updated = await queryOne(
      `UPDATE accounts SET
        name = COALESCE($1, name),
        masked_account_number = COALESCE($2, masked_account_number),
        account_reference = COALESCE($3, account_reference),
        owner = COALESCE($4, owner),
        purpose = COALESCE($5, purpose),
        minimum_balance = COALESCE($6, minimum_balance),
        target_balance = COALESCE($7, target_balance),
        status = COALESCE($8, status),
        notes = COALESCE($9, notes),
        provider_id = COALESCE($12, provider_id),
        account_type_id = COALESCE($13, account_type_id),
        current_balance = COALESCE($11, current_balance),
        updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [
        name || existing.name,
        maskedAccountNumber !== undefined ? maskedAccountNumber : existing.masked_account_number,
        accountReference !== undefined ? accountReference : existing.account_reference,
        owner !== undefined ? owner : existing.owner,
        purpose !== undefined ? purpose : existing.purpose,
        minimumBalance !== undefined ? minimumBalance : existing.minimum_balance,
        targetBalance !== undefined ? targetBalance : existing.target_balance,
        status || existing.status,
        notes !== undefined ? notes : existing.notes,
        accountId,
        newBalance,
        providerId || null,
        accountTypeId || null,
      ]
    );

    if (newBalance !== null && parseFloat(existing.current_balance) !== newBalance) {
      await query(
        'INSERT INTO account_balance_history (account_id, balance, recorded_by) VALUES ($1, $2, $3)',
        [accountId, newBalance, req.user!.userId]
      );
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'account.updated',
      entity: 'account',
      entityId: accountId,
      ipAddress: req.ip,
      oldData: { name: existing.name, status: existing.status, balance: existing.current_balance, providerId: existing.provider_id, accountTypeId: existing.account_type_id },
      newData: { name: updated!.name, status: updated!.status, balance: updated!.current_balance, providerId: updated!.provider_id, accountTypeId: updated!.account_type_id },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/balance-history', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await queryOne<{ created_by: string | null }>(
      'SELECT created_by FROM accounts WHERE id = $1',
      [req.params.id]
    );
    assertOwner(req, account, 'accounts.read_all', 'Account not found');

    const history = await query(
      `SELECT abh.*, u.email as recorded_by_email
       FROM account_balance_history abh
       LEFT JOIN users u ON abh.recorded_by = u.id
       WHERE abh.account_id = $1
       ORDER BY abh.recorded_at DESC
       LIMIT 100`,
      [req.params.id]
    );

    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('accounts.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await queryOne<{ id: string; name: string; status: string; created_by: string | null }>(
      'SELECT id, name, status, created_by FROM accounts WHERE id = $1', [req.params.id]
    );
    if (!account) throw createError(404, 'Account not found');
    assertOwner(req, account, 'accounts.write_all', 'Account not found');

    const usage = await queryOne<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM transactions WHERE account_id = $1) +
         (SELECT COUNT(*) FROM transfers WHERE source_account_id = $1 OR destination_account_id = $1) +
         (SELECT COUNT(*) FROM loading_transactions WHERE account_id = $1) +
         (SELECT COUNT(*) FROM ledger_entries WHERE account_id = $1) +
         (SELECT COUNT(*) FROM reconciliations WHERE account_id = $1)
       ) as count`,
      [req.params.id]
    );
    if (parseInt(usage?.count || '0') > 0) {
      throw createError(400, 'Account has linked transactions and cannot be deleted — set its status to closed instead');
    }

    await queryOne('DELETE FROM accounts WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'account.deleted',
      entity: 'account',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: account.name, status: account.status },
    });

    res.json({ success: true, data: { message: 'Account deleted' } });
  } catch (error) {
    next(error);
  }
});

export default router;
