import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { JwtPayload } from '../types';
import { createError } from './error';
import { isTokenBlacklisted } from '../services/tokenBlacklist';
import { query } from '../database/connection';

async function loadBranchIds(userId: string): Promise<string[]> {
  const rows = await query<{ branch_id: string }>(
    'SELECT branch_id FROM user_branches WHERE user_id = $1',
    [userId]
  );
  return rows.map(r => r.branch_id);
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & { token?: string };
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(createError(401, 'Authentication required'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

    const blacklisted = await isTokenBlacklisted(token);
    if (blacklisted) {
      return next(createError(401, 'Token has been revoked'));
    }

    // Branch membership is read here rather than trusted from the token so
    // that moving a user between branches takes effect on their next request
    // instead of at their next login.
    const branchIds = await loadBranchIds(decoded.userId);

    req.user = { ...decoded, branchIds, token };
    next();
  } catch (error) {
    return next(createError(401, 'Invalid or expired token'));
  }
}

export function authorize(...requiredPermissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(createError(401, 'Authentication required'));
    }

    const hasPermission = requiredPermissions.every(
      p => req.user!.roles.includes('administrator')
        || req.user!.roles.includes(p)
        || (req.user!.permissions ?? []).includes(p)
    );

    if (!hasPermission) {
      return next(createError(403, 'Insufficient permissions'));
    }

    next();
  };
}
