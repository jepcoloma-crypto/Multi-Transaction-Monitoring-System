import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { generateAlerts } from '../services/alerts';
import { PaginatedResponse } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;
    const isRead = req.query.isRead as string;

    const conds: string[] = [];
    const params: any[] = [];
    let pi = 1;
    if (isRead !== undefined) { conds.push(`a.is_read = $${pi++}`); params.push(isRead === 'true'); }
    const wc = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM alerts a ${wc}`, params);

    const alerts = await query(
      `SELECT a.* FROM alerts a ${wc} ORDER BY a.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    const unreadCount = await queryOne<{ count: string }>('SELECT COUNT(*) as count FROM alerts WHERE is_read = false');

    res.json({ success: true, data: { data: alerts, pagination: { page, limit, total: parseInt(countResult?.count || '0'), totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit) }, unreadCount: parseInt(unreadCount?.count || '0') } });
  } catch (error) { next(error); }
});

router.post('/generate', authorize('accounts.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const created = await generateAlerts();
    res.json({ success: true, data: { alertsCreated: created } });
  } catch (error) { next(error); }
});

router.put('/read-all', authorize('accounts.read'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await query('UPDATE alerts SET is_read = true WHERE is_read = false');
    res.json({ success: true, message: 'All alerts marked as read' });
  } catch (error) { next(error); }
});

router.put('/:id/read', authorize('accounts.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await queryOne('UPDATE alerts SET is_read = true WHERE id = $1 RETURNING id', [req.params.id]);
    res.json({ success: true, message: 'Alert marked as read' });
  } catch (error) { next(error); }
});

export default router;
