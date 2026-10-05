import { queryOne } from '../database/connection';
import { createError } from './error';

// D17 — a branch with no open shift may not move money.
//
// Deliberately a sibling of `assertBranch` rather than part of it. That
// function returns early for `*_write_all` holders (scope.ts), who are exactly
// the people who must still be refused: the drawer's physical state is not a
// permission. It is also called by routes that move no money — reject among
// them — which must stay ungated.
//
// Not cached either. A shift closed a second ago has to read as closed now.

// Funding the drawer is how a shift gets its float, so funding cannot depend on
// one already being open. Everything else a branch does, does.
const UNGATED_TYPES = new Set(['owner_funding', 'owner_return']);

/**
 * The two rows the decision rests on, as a pair so tests can supply their own.
 * They are separate because they are separate questions: which branch owns this
 * account, and is that branch's drawer open — and because an exempt type has to
 * be able to answer without asking either.
 */
export type ShiftLookups = {
  account(accountId: string): Promise<{ branch_id: string; code: string } | null>;
  shift(branchId: string): Promise<{ id: string } | null>;
};

const liveLookups: ShiftLookups = {
  async account(accountId) {
    return queryOne<{ branch_id: string; code: string }>(
      `SELECT a.branch_id, b.code
         FROM accounts a
         JOIN branches b ON b.id = a.branch_id
        WHERE a.id = $1`,
      [accountId],
    );
  },
  async shift(branchId) {
    return queryOne<{ id: string }>(
      `SELECT id FROM shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
      [branchId],
    );
  },
};

/**
 * Refuses unless the account's branch currently has an open shift.
 *
 * `typeCode` is optional and only ever passed by transaction routes: supply it
 * and owner fund movements pass through, because those are the owner's money
 * arriving rather than the branch operating. Transfers and loading have no type
 * and are therefore always gated.
 *
 * Runs after `assertBranch`, so a scoped caller is already known to be allowed
 * before being told the branch is shut — and it answers 404 for a missing
 * account for the same reason `assertBranch` does, so a response cannot be used
 * to prove an account exists.
 */
export async function assertOpenShift(
  accountId: string,
  typeCode?: string | null,
  lookups: ShiftLookups = liveLookups,
): Promise<void> {
  if (typeCode && UNGATED_TYPES.has(typeCode)) return;

  const account = await lookups.account(accountId);
  if (!account) throw createError(404, 'Account not found');

  const shift = await lookups.shift(account.branch_id);
  if (!shift) {
    // 409, not 400 or 403: the request is well-formed and authorized and it is
    // the world that disagrees. The message carries the remedy, because
    // "open a shift" is useless advice if you do not know which branch.
    throw createError(
      409,
      `No open shift for branch ${account.code} — open a shift before recording money movements`,
    );
  }
}
