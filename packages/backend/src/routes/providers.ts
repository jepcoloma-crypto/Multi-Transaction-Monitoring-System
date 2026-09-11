import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();

router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = req.query.type as string;
    let sql = 'SELECT * FROM providers';
    const params: any[] = [];

    if (type) {
      sql += ' WHERE type = $1';
      params.push(type);
    }
    sql += ' ORDER BY name';

    const providers = await query(sql, params);
    res.json({ success: true, data: providers });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = await queryOne('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (!provider) {
      throw createError(404, 'Provider not found');
    }
    res.json({ success: true, data: provider });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('accounts.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, code, type, notes } = req.body;
    if (!name || !code || !type) {
      throw createError(400, 'Name, code, and type are required');
    }

    const existing = await queryOne('SELECT id FROM providers WHERE code = $1', [code]);
    if (existing) {
      throw createError(409, 'Provider code already exists');
    }

    const provider = await queryOne(
      'INSERT INTO providers (name, code, type, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, code, type, notes || null]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider.created',
      entity: 'provider',
      entityId: provider!.id,
      ipAddress: req.ip,
      newData: { name, code, type },
    });

    res.status(201).json({ success: true, data: provider });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('accounts.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, code, type, isActive, notes } = req.body;
    const provider = await queryOne('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (!provider) {
      throw createError(404, 'Provider not found');
    }

    const updated = await queryOne(
      `UPDATE providers SET name = COALESCE($1, name), code = COALESCE($2, code),
       type = COALESCE($3, type), is_active = COALESCE($4, is_active),
       notes = COALESCE($5, notes), updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [name || provider.name, code || provider.code, type || provider.type, isActive, notes !== undefined ? notes : provider.notes, req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider.updated',
      entity: 'provider',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: provider.name, code: provider.code },
      newData: { name: updated!.name, code: updated!.code },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('accounts.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = await queryOne('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (!provider) {
      throw createError(404, 'Provider not found');
    }

    const accountCount = await queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM accounts WHERE provider_id = $1',
      [req.params.id]
    );
    if (accountCount && parseInt(accountCount.count) > 0) {
      throw createError(400, 'Cannot delete provider with associated accounts');
    }

    await query('DELETE FROM providers WHERE id = $1', [req.params.id]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'provider.deleted',
      entity: 'provider',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { name: provider.name, code: provider.code },
    });

    res.json({ success: true, message: 'Provider deleted' });
  } catch (error) {
    next(error);
  }
});

export default router;
