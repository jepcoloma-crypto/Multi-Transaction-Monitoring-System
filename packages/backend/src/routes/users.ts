import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { PaginatedResponse } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', authorize('users.read', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search as string;

    let whereClause = '';
    const params: any[] = [];

    if (search) {
      whereClause = `WHERE u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1`;
      params.push(`%${search}%`);
    }

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM users u ${whereClause}`,
      params
    );

    const users = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.last_login_at, u.created_at, u.updated_at,
              COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       ${whereClause}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: users,
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

router.get('/:id', authorize('users.read', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.last_login_at, u.created_at, u.updated_at,
              COALESCE(ARRAY_AGG(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') as roles
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.params.id]
    );

    if (!user) {
      throw createError(404, 'User not found');
    }

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, username, password, firstName, lastName, roleIds } = req.body;

    if (!email || !username || !password || !firstName || !lastName) {
      throw createError(400, 'Email, username, password, first name, and last name are required');
    }

    if (password.length < 8) {
      throw createError(400, 'Password must be at least 8 characters');
    }

    const existingEmail = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existingEmail) {
      throw createError(409, 'Email already exists');
    }

    const existingUsername = await queryOne('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUsername) {
      throw createError(409, 'Username already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await queryOne(
      `INSERT INTO users (email, username, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, username, first_name, last_name, is_active, created_at`,
      [email, username, passwordHash, firstName, lastName]
    );

    if (roleIds && Array.isArray(roleIds) && roleIds.length > 0) {
      for (const roleId of roleIds) {
        await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user!.id, roleId]);
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'user.created',
      entity: 'user',
      entityId: user!.id,
      ipAddress: req.ip,
      newData: { email, username, firstName, lastName },
    });

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, isActive, roleIds } = req.body;
    const userId = req.params.id;

    const existing = await queryOne('SELECT id, first_name, last_name, is_active FROM users WHERE id = $1', [userId]);
    if (!existing) {
      throw createError(404, 'User not found');
    }

    const user = await queryOne(
      `UPDATE users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
       is_active = COALESCE($3, is_active), updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, first_name, last_name, is_active, created_at, updated_at`,
      [firstName || existing.first_name, lastName || existing.last_name, isActive, userId]
    );

    if (roleIds && Array.isArray(roleIds)) {
      await query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const roleId of roleIds) {
        await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleId]);
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'user.updated',
      entity: 'user',
      entityId: userId,
      ipAddress: req.ip,
      oldData: { firstName: existing.first_name, lastName: existing.last_name, isActive: existing.is_active },
      newData: { firstName: user!.first_name, lastName: user!.last_name, isActive: user!.is_active },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id;

    if (userId === req.user!.userId) {
      throw createError(400, 'Cannot delete your own account');
    }

    const existing = await queryOne('SELECT id, email, is_active FROM users WHERE id = $1', [userId]);
    if (!existing) {
      throw createError(404, 'User not found');
    }

    if (!existing.is_active) {
      throw createError(400, 'User is already deactivated');
    }

    await query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [userId]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'user.deactivated',
      entity: 'user',
      entityId: userId,
      ipAddress: req.ip,
      oldData: { email: existing.email, isActive: existing.is_active },
      newData: { isActive: false },
    });

    res.json({ success: true, message: 'User deactivated' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/change-password', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.id;
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      throw createError(400, 'New password must be at least 8 characters');
    }

    const isSelf = userId === req.user!.userId;

    if (isSelf) {
      if (!currentPassword) {
        throw createError(400, 'Current password is required');
      }
      const user = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
      if (!user) {
        throw createError(404, 'User not found');
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        throw createError(401, 'Current password is incorrect');
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, userId]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'user.password_changed',
      entity: 'user',
      entityId: userId,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Password updated' });
  } catch (error) {
    next(error);
  }
});

export default router;
