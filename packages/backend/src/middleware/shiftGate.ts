import { queryOne } from '../database/connection';
import { createError } from './error';
import { eventDateKey, manilaDateKey } from '../services/manilaTime';

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
  shift(branchId: string): Promise<{ id: string; shift_date: string } | null>;
};

export type ShiftOptions = {
  /**
   * The Manila day the movement belongs to, as an instant or the string it was
   * typed as.
   *
   * Omitted when the action carries no date of its own — reversing, correcting
   * and adjusting charges happen *now*, and are checked against the shift that
   * is open now rather than against a calendar day (see where the comparison is
   * made, and why that is the same drawer). Settling does pass one: the row it
   * settles is already dated. Creating, loading and transferring pass the date
   * the operator entered, and two days are refused: one the shift predates, and
   * one that has not come yet.
   */
  eventDate?: Date | string | null;
  lookups?: ShiftLookups;
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
    // `::text` rather than letting node-postgres parse the DATE: its default
    // lands on local midnight, and this host is UTC+3, so reading it back as a
    // Date would name the wrong day.
    return queryOne<{ id: string; shift_date: string }>(
      `SELECT id, shift_date::text AS shift_date FROM shifts WHERE branch_id = $1 AND status = 'open' LIMIT 1`,
      [branchId],
    );
  },
};

/**
 * Refuses unless the account's branch currently has an open shift — and, when
 * the caller supplies a day, one open for that day.
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
  options: ShiftOptions = {},
): Promise<void> {
  if (typeCode && UNGATED_TYPES.has(typeCode)) return;

  const { eventDate = null, lookups = liveLookups } = options;

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

  // The second half of D17, and it answers two different questions depending on
  // whether a day was supplied.
  //
  // No day was supplied, so nothing is being asserted and the row is stamped
  // with the instant it is posted — and a shift's window *is* that same span,
  // from when it opened to when it closes (`drawerQuery`: "a shift is a
  // physical span", and the window reads `created_at`, not `entry_date`). The
  // row therefore lands inside the shift that is open now by construction, and
  // that shift's expected closing counts it. Requiring its label to read today
  // would only refuse a branch standing at its own open drawer because the
  // shift was opened yesterday and not yet closed — nothing would be reopened
  // by letting it work, because an open shift has no count until it closes.
  //
  // A day *was* supplied — a form field, or the row a settlement settles — so an
  // operator is asserting a business day, and two of them are impossible: one
  // before the shift opened, and one that has not come yet. A day before it
  // files the movement under a day with no shift, which is what a missed day
  // *is*: that is why one may be opened retroactively, by an administrator
  // only, rather than folded into the next. A future day files it under a
  // drawer nobody can count yet — the open-shift form refuses a future date for
  // the same reason. Anything between the two is the shift's own span or later,
  // and is counted by whichever shift is open, which is the whole point above.
  //
  // Both keys are Manila, so a shift opened at 01:00 and a transaction typed
  // the previous evening compare as the days the operator sees rather than the
  // days UTC or the server happens to name.
  if (eventDate === undefined || eventDate === null) return;

  const bookedOn = eventDateKey(eventDate);

  if (bookedOn < shift.shift_date) {
    throw createError(
      409,
      `Dated ${bookedOn}, but the open shift for branch ${account.code} is ${shift.shift_date} — ` +
        'record it under an open shift for that date, or change the date to match',
    );
  }

  const today = manilaDateKey();
  if (bookedOn > today) {
    throw createError(
      409,
      `Dated ${bookedOn}, which has not come yet — record money movements on the day they happen`,
    );
  }
}
