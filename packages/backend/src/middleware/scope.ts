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

/**
 * The single test for "does this identity hold this permission".
 *
 * Deliberately a pure function over the two lists rather than something that
 * reads a Request: the login response has to compute head-office visibility
 * before any token exists, and a second copy of this rule there would let the
 * branch badge claim "All branches" on a page that is quietly scoped.
 */
export function hasPermission(roles: string[], permissions: string[], permission: string): boolean {
  return roles.includes('administrator') || roles.includes(permission) || permissions.includes(permission);
}

export function canSeeAll(req: Request, permission: string): boolean {
  return hasPermission(req.user?.roles || [], req.user?.permissions || [], permission);
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

function accountsInBranch(placeholder: string): string {
  return `(SELECT id FROM accounts WHERE branch_id = ${placeholder})`;
}

function scopePredicate(alias: string, link: AccountLink, placeholder: string): string {
  if (link === 'self') return `${alias}.branch_id = ANY(${placeholder})`;
  if (link === 'transfer') {
    const scope = accountScope(placeholder);
    // Either side, because each branch must reconcile its own half of a
    // transfer that crosses between them.
    return `(${alias}.source_account_id IN ${scope} OR ${alias}.destination_account_id IN ${scope})`;
  }
  return `${alias}.account_id IN ${accountScope(placeholder)}`;
}

function filterPredicate(alias: string, link: AccountLink, placeholder: string): string {
  if (link === 'self') return `${alias}.branch_id = ${placeholder}`;
  // Source only. A transfer belongs to the branch that funded it, which is
  // also the branch charged its fee, and one row has to resolve to exactly
  // one branch or the per-branch subtotals it is grouped into would count
  // every cross-branch transfer twice.
  if (link === 'transfer') return `${alias}.source_account_id IN ${accountsInBranch(placeholder)}`;
  return `${alias}.account_id IN ${accountsInBranch(placeholder)}`;
}

/**
 * Builds the row-level branch predicate for a query.
 *
 * The branch is resolved from `accounts` rather than stored on child tables
 * so that a transaction can never disagree with its account about which
 * branch it belongs to.
 *
 * Two predicates can be returned, and they are not interchangeable. The first
 * answers "which branches may this caller see" and binds an array; the second
 * (`branchFilter`) answers "which branch did this caller name" and binds a
 * scalar. Head office sees every branch, so without the second the filter
 * would vanish for exactly the callers who use it.
 */
export function branchClause(
  req: Request,
  alias: string,
  permission: string,
  paramIndex: number,
  link: AccountLink = 'account',
  branchFilter: string | null = null,
): { clause: string | null; params: any[]; paramIndex: number } {
  const clauses: string[] = [];
  const params: any[] = [];
  let pi = paramIndex;

  if (!canSeeEveryBranch(req, permission)) {
    clauses.push(scopePredicate(alias, link, `$${pi++}`));
    params.push(requireBranches(req));
  }

  if (branchFilter) {
    clauses.push(filterPredicate(alias, link, `$${pi++}`));
    params.push(branchFilter);
  }

  if (clauses.length === 0) return { clause: null, params: [], paramIndex: pi };
  return { clause: clauses.join(' AND '), params, paramIndex: pi };
}

/**
 * Resolves the branch a report was asked to show, or null for "no filter".
 *
 * The predicate this feeds into `branchClause` is ANDed with the row scope
 * every report already applies, so it can only ever remove rows: this is a
 * report-shaping decision, not an access decision. It answers 404 rather than
 * letting an unknown or foreign branch fall through as an empty result,
 * because an empty report and one scoped past what the caller may see must
 * not be the same sentence -- and because a scoped caller should not be able
 * to confirm a branch exists either way.
 *
 * Scoped with `accounts.read_all` because that is the dimension the filter
 * acts on: it constrains `accounts.branch_id`, which is where every report
 * resolves a row's branch from.
 */
export async function resolveBranchFilter(req: Request, requested: unknown): Promise<string | null> {
  const value = typeof requested === 'string' ? requested.trim() : '';
  if (!value) return null;

  if (!canSeeEveryBranch(req, 'accounts.read_all')) {
    if (!requireBranches(req).includes(value)) {
      throw createError(404, 'Branch not found');
    }
    return value;
  }

  const exists = await queryOne<{ id: string }>('SELECT id FROM branches WHERE id = $1', [value]);
  if (!exists) throw createError(404, 'Branch not found');
  return value;
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
 * Checks the caller may place an account in `branchId`.
 *
 * Head office may name any branch; anyone else only one of their own, which
 * is what stops a branch user from pulling a foreign account in or pushing
 * theirs out to a branch they have no business assigning to. The branch is
 * looked up as well so a stale id from an open form is a sentence rather
 * than a foreign-key violation.
 */
export async function assertBranchAssignable(req: Request, branchId: string): Promise<void> {
  const branchIds = req.user?.branchIds ?? [];
  const headOffice = canSeeAll(req, 'branches.read_all');

  if (!headOffice) {
    if (branchIds.length === 0) {
      throw createError(403, 'No branch is assigned to your account');
    }
    if (!branchIds.includes(branchId)) {
      throw createError(403, 'You cannot assign an account to that branch');
    }
  }

  const exists = await queryOne<{ id: string }>(
    'SELECT id FROM branches WHERE id = $1',
    [branchId],
  );
  if (!exists) throw createError(400, 'Branch not found');
}

/**
 * Resolves which branch a newly created account belongs to.
 *
 * `branchId` may come from the request, but only from within the caller's own
 * branches; head office (`branches.read_all`) may name any. Omitted, it falls
 * back to the caller's first branch, so an account can never be created
 * outside every branch -- which the NOT NULL on `accounts.branch_id` would
 * otherwise surface as a 500 instead of a sentence.
 *
 * Separate from assertBranchAssignable because an omitted value means
 * different things on each path: "your first branch" when creating, "leave it
 * where it is" when updating.
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

  await assertBranchAssignable(req, branchId);
  return branchId;
}
