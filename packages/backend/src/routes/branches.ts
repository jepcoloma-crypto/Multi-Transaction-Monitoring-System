import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { canSeeAll } from '../middleware/scope';
import { createAuditLog } from '../services/audit';

const router = Router();

router.use(authenticate);

// Counts are what make this an answer rather than a list: the first question
// anyone setting up a second branch asks is whether the split has actually
// happened yet. User counts are active-only, because deactivated accounts
// still hold membership they can no longer exercise.
const BRANCH_SELECT = `
  SELECT b.id, b.code, b.name, b.status, b.created_at, b.updated_at,
         (SELECT count(*) FROM accounts a WHERE a.branch_id = b.id)::int AS account_count,
         (SELECT count(*) FROM user_branches ub
            JOIN users u ON u.id = ub.user_id AND u.is_active = true
           WHERE ub.branch_id = b.id)::int AS user_count
  FROM branches b`;

// Branches are never deleted: accounts and user_branches reference them, and
// removing one would either cascade away assignments or strand accounts in a
// branch nobody can name. Deactivation is how a branch is retired.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Scoped like every other read. A branch user is offered only their own
    // branches so the account form cannot present one that
    // resolveNewAccountBranch would then refuse; head office sees all,
    // because it is the role that manages them.
    const headOffice = canSeeAll(req, 'branches.read_all');
    const branchIds = req.user!.branchIds ?? [];

    if (!headOffice && branchIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const branches = headOffice
      ? await query(`${BRANCH_SELECT} ORDER BY b.name`)
      : await query(`${BRANCH_SELECT} WHERE b.id = ANY($1) ORDER BY b.name`, [branchIds]);

    res.json({ success: true, data: branches });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, name, status } = req.body;
    if (!code || !name) {
      throw createError(400, 'Code and name are required');
    }

    const branchCode = String(code).trim().toUpperCase();
    const branchName = String(name).trim();
    if (branchCode.length > 20) throw createError(400, 'Code must be 20 characters or fewer');
    if (branchName.length > 100) throw createError(400, 'Name must be 100 characters or fewer');
    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      throw createError(400, 'Status must be active or inactive');
    }

    const existing = await queryOne('SELECT id FROM branches WHERE code = $1', [branchCode]);
    if (existing) throw createError(409, 'Branch code already exists');

    const branch = await queryOne(
      `INSERT INTO branches (code, name, status) VALUES ($1, $2, COALESCE($3, 'active')) RETURNING *`,
      [branchCode, branchName, status || null],
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'branch.created',
      entity: 'branch',
      entityId: branch!.id,
      ipAddress: req.ip,
      newData: { code: branchCode, name: branchName, status: status || 'active' },
    });

    res.status(201).json({ success: true, data: branch });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branch = await queryOne<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM branches WHERE id = $1',
      [req.params.id],
    );
    if (!branch) throw createError(404, 'Branch not found');

    const { name, status } = req.body;
    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      throw createError(400, 'Status must be active or inactive');
    }
    if (name !== undefined && !String(name).trim()) {
      throw createError(400, 'Name cannot be empty');
    }

    const updated = await queryOne(
      `UPDATE branches
       SET name = $1, status = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [
        name !== undefined ? String(name).trim() : branch.name,
        status !== undefined ? status : branch.status,
        req.params.id,
      ],
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'branch.updated',
      entity: 'branch',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: branch.name, status: branch.status },
      newData: { name: updated!.name, status: updated!.status },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

export default router;
