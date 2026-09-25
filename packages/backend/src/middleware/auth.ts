import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { JwtPayload } from '../types';
import { createError } from './error';
import { isTokenBlacklisted } from '../services/tokenBlacklist';

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

    req.user = { ...decoded, token };
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
