import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../database/connection';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/types', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const types = await query('SELECT * FROM transaction_types WHERE is_active = true ORDER BY direction, name');
    res.json({ success: true, data: types });
  } catch (error) {
    next(error);
  }
});

router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const typeId = req.query.typeId as string;
    let sql = `SELECT tc.*, tt.name as type_name, tt.code as type_code, tt.direction
               FROM transaction_categories tc
               JOIN transaction_types tt ON tc.transaction_type_id = tt.id
               WHERE tc.is_active = true`;
    const params: any[] = [];

    if (typeId) {
      sql += ' AND tc.transaction_type_id = $1';
      params.push(typeId);
    }
    sql += ' ORDER BY tc.name';

    const categories = await query(sql, params);
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

export default router;
