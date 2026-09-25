import type { Request } from 'express';
import { createError } from './error';

export function canSeeAll(req: Request, permission: string): boolean {
  const roles = req.user?.roles || [];
  const permissions = req.user?.permissions || [];
  return roles.includes('administrator') || roles.includes(permission) || permissions.includes(permission);
}

export function ownerClause(
  req: Request,
  alias: string,
  permission: string,
  paramIndex: number,
): { clause: string | null; params: any[]; paramIndex: number } {
  if (canSeeAll(req, permission)) {
    return { clause: null, params: [], paramIndex };
  }
  return {
    clause: `${alias}.created_by = $${paramIndex}`,
    params: [req.user!.userId],
    paramIndex: paramIndex + 1,
  };
}

export function assertOwner(
  req: Request,
  record: { created_by?: string | null } | null | undefined,
  permission: string,
  notFoundMessage: string,
): void {
  if (!record) throw createError(404, notFoundMessage);
  if (canSeeAll(req, permission)) return;
  if (record.created_by !== req.user!.userId) throw createError(404, notFoundMessage);
}
