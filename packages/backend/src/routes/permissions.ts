import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', authorize('users.read', 'administrator'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await query(
      'SELECT id, name, description, created_at FROM permissions ORDER BY name'
    );

    res.json({ success: true, data: permissions });
  } catch (error) {
    next(error);
  }
});

export default router;
