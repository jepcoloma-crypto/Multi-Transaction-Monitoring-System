import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';

const router = Router();

router.use(authenticate);

router.get('/', authorize('users.read', 'administrator'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await query(
      `SELECT r.id, r.name, r.description, r.created_at,
              COALESCE(ARRAY_AGG(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') as permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       GROUP BY r.id
       ORDER BY r.name`
    );

    res.json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authorize('users.read', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await queryOne(
      `SELECT r.id, r.name, r.description, r.created_at,
              COALESCE(ARRAY_AGG(p.name) FILTER (WHERE p.name IS NOT NULL), '{}') as permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON r.id = rp.role_id
       LEFT JOIN permissions p ON rp.permission_id = p.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [req.params.id]
    );

    if (!role) {
      throw createError(404, 'Role not found');
    }

    res.json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
});

router.post('/', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, permissionIds } = req.body;

    if (!name) {
      throw createError(400, 'Role name is required');
    }

    const existing = await queryOne('SELECT id FROM roles WHERE name = $1', [name]);
    if (existing) {
      throw createError(409, 'Role name already exists');
    }

    const role = await queryOne(
      'INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING id, name, description, created_at',
      [name, description || null]
    );

    if (permissionIds && Array.isArray(permissionIds) && permissionIds.length > 0) {
      for (const permissionId of permissionIds) {
        await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [role!.id, permissionId]);
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'role.created',
      entity: 'role',
      entityId: role!.id,
      ipAddress: req.ip,
      newData: { name, description },
    });

    res.status(201).json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, permissionIds } = req.body;
    const roleId = req.params.id;

    const existing = await queryOne('SELECT id, name, description FROM roles WHERE id = $1', [roleId]);
    if (!existing) {
      throw createError(404, 'Role not found');
    }

    if (name && name !== existing.name) {
      const nameCheck = await queryOne('SELECT id FROM roles WHERE name = $1 AND id != $2', [name, roleId]);
      if (nameCheck) {
        throw createError(409, 'Role name already exists');
      }
    }

    const role = await queryOne(
      'UPDATE roles SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING id, name, description, created_at',
      [name || existing.name, description !== undefined ? description : existing.description, roleId]
    );

    if (permissionIds && Array.isArray(permissionIds)) {
      await query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      for (const permissionId of permissionIds) {
        await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [roleId, permissionId]);
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'role.updated',
      entity: 'role',
      entityId: roleId,
      ipAddress: req.ip,
      oldData: { name: existing.name, description: existing.description },
      newData: { name: role!.name, description: role!.description },
    });

    res.json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('users.write', 'administrator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roleId = req.params.id;

    const existing = await queryOne('SELECT id, name FROM roles WHERE id = $1', [roleId]);
    if (!existing) {
      throw createError(404, 'Role not found');
    }

    const userCount = await queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM user_roles WHERE role_id = $1',
      [roleId]
    );

    if (userCount && parseInt(userCount.count) > 0) {
      throw createError(400, 'Cannot delete role assigned to users');
    }

    await query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    await query('DELETE FROM roles WHERE id = $1', [roleId]);

    await createAuditLog({
      userId: req.user!.userId,
      action: 'role.deleted',
      entity: 'role',
      entityId: roleId,
      ipAddress: req.ip,
      oldData: { name: existing.name },
    });

    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    next(error);
  }
});

export default router;
