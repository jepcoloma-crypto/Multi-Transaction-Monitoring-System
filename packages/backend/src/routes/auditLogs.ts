import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { PaginatedResponse } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', authorize('audit_logs.read', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;

    const userId = req.query.userId as string;
    const action = req.query.action as string;
    const entity = req.query.entity as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (userId) {
      conditions.push(`al.user_id = $${paramIndex++}`);
      params.push(userId);
    }
    if (action) {
      conditions.push(`al.action = $${paramIndex++}`);
      params.push(action);
    }
    if (entity) {
      conditions.push(`al.entity = $${paramIndex++}`);
      params.push(entity);
    }
    if (startDate) {
      conditions.push(`al.created_at >= $${paramIndex++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`al.created_at <= $${paramIndex++}`);
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM audit_logs al ${whereClause}`,
      params
    );

    const logs = await query(
      `SELECT al.id, al.user_id, al.action, al.entity, al.entity_id, al.ip_address,
              al.old_data, al.new_data, al.reason, al.created_at,
              u.email as user_email, u.first_name, u.last_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: logs,
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

export default router;
