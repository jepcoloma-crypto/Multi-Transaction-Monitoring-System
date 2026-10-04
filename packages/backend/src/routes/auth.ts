import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { query, queryOne } from '../database/connection';
import { createError } from '../middleware/error';
import { authenticate } from '../middleware/auth';
import { hasPermission } from '../middleware/scope';
import { JwtPayload } from '../types';
import { createAuditLog } from '../services/audit';
import { blacklistToken } from '../services/tokenBlacklist';

const router = Router();

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw createError(400, 'Username and password are required');
    }

    const user = await queryOne<{ id: string; email: string; username: string; password_hash: string; first_name: string; last_name: string; is_active: boolean; avatar_url: string | null }>(
      'SELECT id, email, username, password_hash, first_name, last_name, is_active, avatar_url FROM users WHERE username = $1',
      [username]
    );

    if (!user) {
      throw createError(401, 'Invalid credentials');
    }

    if (!user.is_active) {
      throw createError(403, 'Account is deactivated');
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      throw createError(401, 'Invalid credentials');
    }

    const roles = await query<{ name: string }>(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    );

    const roleNames = roles.map(r => r.name);

    const permissions = await query<{ name: string }>(
      `SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    );
    const permissionNames = permissions.map(p => p.name);

    // Branches ride along with the login payload because AuthContext caches
    // this user object in localStorage and never re-reads /auth/me, so this
    // is the only place the header can learn them without an extra request
    // on every page load.
    const branches = await query<{ id: string; code: string; name: string }>(
      `SELECT b.id, b.code, b.name
       FROM branches b
       JOIN user_branches ub ON ub.branch_id = b.id
       WHERE ub.user_id = $1
       ORDER BY b.name`,
      [user.id],
    );

    // Evaluated with the same predicate the scoping middleware uses, so the
    // badge can never advertise a wider view than the queries return.
    const canSeeAllBranches = hasPermission(roleNames, permissionNames, 'branches.read_all');

    const tokenPayload: JwtPayload = {
      userId: user.id,
      email: user.email,
      username: user.username,
      roles: roleNames,
      permissions: permissionNames,
    };

    const accessToken = jwt.sign(tokenPayload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn as any,
    });

    const refreshToken = jwt.sign(tokenPayload, config.jwt.secret, {
      expiresIn: config.jwt.refreshExpiresIn as any,
    });

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    await createAuditLog({
      userId: user.id,
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          roles: roleNames,
          avatarUrl: user.avatar_url || null,
          branches,
          canSeeAllBranches,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.user!.token!;

    const decoded = jwt.decode(token) as JwtPayload;
    if (decoded) {
      const payload = decoded as any;
      const expiresAt = new Date(payload.exp * 1000);
      await blacklistToken(token, req.user!.userId, expiresAt);
    }

    await createAuditLog({
      userId: req.user!.userId,
      action: 'auth.logout',
      entity: 'user',
      entityId: req.user!.userId,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw createError(400, 'Refresh token is required');
    }

    const blacklisted = await (await import('../services/tokenBlacklist')).isTokenBlacklisted(refreshToken);
    if (blacklisted) {
      throw createError(401, 'Refresh token has been revoked');
    }

    const decoded = jwt.verify(refreshToken, config.jwt.secret) as JwtPayload;

    const roles = await query<{ name: string }>(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [decoded.userId]
    );
    const permissions = await query<{ name: string }>(
      `SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`,
      [decoded.userId]
    );

    const newAccessToken = jwt.sign(
      {
        userId: decoded.userId,
        email: decoded.email,
        username: decoded.username,
        roles: roles.map(r => r.name),
        permissions: permissions.map(p => p.name),
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as any }
    );

    res.json({
      success: true,
      data: { accessToken: newAccessToken },
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return next(createError(401, 'Refresh token expired'));
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(createError(401, 'Invalid refresh token'));
    }
    next(error);
  }
});

router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne<{ id: string; email: string; username: string; first_name: string; last_name: string; avatar_url: string | null }>(
      'SELECT id, email, username, first_name, last_name, avatar_url FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (!user) {
      throw createError(404, 'User not found');
    }

    const roles = await query<{ name: string }>(
      `SELECT r.name FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    );

    const roleNames = roles.map(r => r.name);
    const branchIds = req.user!.branchIds ?? [];
    const branches = branchIds.length === 0
      ? []
      : await query<{ id: string; code: string; name: string }>(
          `SELECT id, code, name FROM branches WHERE id = ANY($1) ORDER BY name`,
          [branchIds],
        );

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        roles: roleNames,
        avatarUrl: user.avatar_url || null,
        branches,
        // From the token rather than a fresh query: roles and permissions
        // come from the same place, so the flag cannot describe a
        // combination that never existed. Login already reports it from
        // source, which is where the client takes it from.
        canSeeAllBranches: hasPermission(req.user!.roles, req.user!.permissions ?? [], 'branches.read_all'),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
