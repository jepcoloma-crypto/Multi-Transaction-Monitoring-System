import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';

const router = Router();

router.use(authenticate);

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const types = await query('SELECT * FROM account_types ORDER BY name');
    res.json({ success: true, data: types });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = await queryOne('SELECT * FROM account_types WHERE id = $1', [req.params.id]);
    if (!type) {
      throw createError(404, 'Account type not found');
    }
    res.json({ success: true, data: type });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('accounts.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, code, description } = req.body;
    if (!name || !code) {
      throw createError(400, 'Name and code are required');
    }

    const existing = await queryOne('SELECT id FROM account_types WHERE code = $1', [code]);
    if (existing) {
      throw createError(409, 'Account type code already exists');
    }

    const type = await queryOne(
      'INSERT INTO account_types (name, code, description) VALUES ($1, $2, $3) RETURNING *',
      [name, code, description || null]
    );

    res.status(201).json({ success: true, data: type });
  } catch (error) {
    next(error);
  }
});

export default router;
