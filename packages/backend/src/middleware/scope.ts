import type { Request } from 'express';
import { createError } from './error';
import { query, queryOne } from '../database/connection';

/**
 * How a row reaches an account, which is the only table that carries
 * `branch_id`.
 *
 * Passed explicitly rather than inferred because the alias says nothing: `t`
 * is used for transactions in one query and transfers in the next.
 *
 *  - `'self'`     the row is an accounts row
 *  - `'account'`  the row carries `account_id` (the default)
 *  - `'transfer'` the row carries source and destination account ids
 */
export type AccountLink = 'self' | 'account' | 'transfer';

export function canSeeAll(req: Request, permission: string): boolean {
  const roles = req.user?.roles || [];
  const permissions = req.user?.permissions || [];
  return roles.includes('administrator') || roles.includes(permission) || permissions.includes(permission);
}

/**
 * Whether this caller sees every branch.
 *
 * Two permissions can grant it. The entity's own `*_read_all` used to mean
 * "ignore created_by" and now means "ignore every branch"; and
 * `branches.read_all`, which exists so head-office visibility can be granted
 * without handing over four separate entity permissions. Testing only the
 * entity permission would leave `branches.read_all` inert for everybody who
 * is not already an administrator -- granting it would do nothing.
 */
function canSeeEveryBranch(req: Request, permission: string): boolean {
  return canSeeAll(req, permission) || canSeeAll(req, 'branches.read_all');
}

/**
 * Branches the caller may see.
 *
 * An empty set is a misconfiguration, not "all branches". Falling through to
 * an unscoped query there would quietly hand a branch user the entire
 * company, so it fails closed with a message that says what is wrong.
 */
function requireBranches(req: Request): string[] {
  const branchIds = req.user?.branchIds ?? [];
  if (branchIds.length === 0) {
    throw createError(403, 'No branch is assigned to your account');
  }
  return branchIds;
}

function accountScope(placeholder: string): string {
  return `(SELECT id FROM accounts WHERE branch_id = ANY(${placeholder}))`;
}

/**
 * Builds the row-level branch predicate for a query.
 *
 * The branch is resolved from `accounts` rather than stored on child tables
 * so that a transaction can never disagree with its account about which
 * branch it belongs to.
 */
export function branchClause(
  req: Request,
  alias: string,
  permission: string,
  paramIndex: number,
  link: AccountLink = 'account',
): { clause: string | null; params: any[]; paramIndex: number } {
  if (canSeeEveryBranch(req, permission)) {
    return { clause: null, params: [], paramIndex };
  }

  const branchIds = requireBranches(req);
  const placeholder = `$${paramIndex}`;

  let clause: string;
  if (link === 'self') {
    clause = `${alias}.branch_id = ANY(${placeholder})`;
  } else if (link === 'transfer') {
    const scope = accountScope(placeholder);
    // Either side, because each branch must reconcile its own half of a
    // transfer that crosses between them.
    clause = `(${alias}.source_account_id IN ${scope} OR ${alias}.destination_account_id IN ${scope})`;
  } else {
    clause = `${alias}.account_id IN ${accountScope(placeholder)}`;
  }

  return { clause, params: [branchIds], paramIndex: paramIndex + 1 };
}

/**
 * Asserts the caller may act on records belonging to these accounts.
 *
 * Account ids are supplied by the caller instead of read off the record:
 * accounts need no lookup but a transaction does, and a transfer straddles
 * two. Naming them keeps the decision at this boundary rather than letting a
 * future SELECT quietly decide it by omitting a column.
 *
 * Answers 404 rather than 403 so a caller cannot use the response to prove
 * that an account exists outside their branches.
 */
export async function assertBranch(
  req: Request,
  accountIds: string | string[] | null | undefined,
  permission: string,
  notFoundMessage: string,
): Promise<void> {
  const ids = [
    ...new Set(
      (Array.isArray(accountIds) ? accountIds : [accountIds]).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  if (ids.length === 0) throw createError(404, notFoundMessage);
  if (canSeeEveryBranch(req, permission)) return;

  const branchIds = requireBranches(req);
  const rows = await query<{ branch_id: string }>(
    'SELECT branch_id FROM accounts WHERE id = ANY($1) AND branch_id IS NOT NULL',
    [ids],
  );
  if (!rows.some(r => branchIds.includes(r.branch_id))) {
    throw createError(404, notFoundMessage);
  }
}

/**
 * Resolves which branch a newly created account belongs to.
 *
 * `branchId` may come from the request, but only from within the caller's own
 * branches; head office (`branches.read_all`) may name any. Omitted, it falls
 * back to the caller's first branch, so an account can never be created
 * outside every branch -- which the NOT NULL on `accounts.branch_id` would
 * otherwise surface as a 500 instead of a sentence.
 */
export async function resolveNewAccountBranch(
  req: Request,
  requested: string | null | undefined,
): Promise<string> {
  const branchIds = req.user?.branchIds ?? [];
  const headOffice = canSeeAll(req, 'branches.read_all');

  if (!headOffice && branchIds.length === 0) {
    throw createError(403, 'No branch is assigned to your account');
  }

  const branchId = requested || branchIds[0];
  if (!branchId) throw createError(400, 'Branch is required');
  if (!headOffice && !branchIds.includes(branchId)) {
    throw createError(403, 'You cannot create an account in that branch');
  }

  const exists = await queryOne<{ id: string }>(
    'SELECT id FROM branches WHERE id = $1',
    [branchId],
  );
  if (!exists) throw createError(400, 'Branch not found');

  return branchId;
}
