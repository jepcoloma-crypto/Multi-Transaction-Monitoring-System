// What "you have already entered this reference" means, and when it does not.
//
// A reference number identifies an event — the receipt, the terminal slip, the
// biller's own transaction id — and the same event entered twice on one account
// on one day is a double submission. Counted twice it becomes money that never
// moved, so creation and the administrator's edit both ask this before writing.
//
// It is deliberately narrower than "a reference may appear once", because the
// two repeats already in the data are legitimate and a plain UNIQUE index would
// have refused both. Each is a reversal and its re-entry: the original was
// reversed, then the corrected version was recorded carrying the same number,
// because the number belongs to the event and the event did not change. Refusing
// that would push an operator to invent a new number for a real transaction.
//
// So the number stays taken only while another row still stands under it:
// same account, same Manila day, and a status that is not 'reversed'. A reversed
// row has been undone, and the reference is free for the entry that replaces it.

import { createError } from '../middleware/error';
import { eventDateKey, parseDateKey } from './manilaTime';

// The pool and an open transaction's client both answer this shape, so the
// check runs on the caller's connection — inside the same BEGIN as the write it
// is guarding, rather than on a separate connection that cannot see it.
export interface ReferenceDb {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export interface ReferenceCheck {
  accountId: string;
  /** What the row is about to store: blank and absent both mean "no reference". */
  referenceNumber: unknown;
  /** The instant the row will carry, for the day it should be read in. */
  eventDate?: Date | string | null;
  /** A row being edited, which is allowed to keep the reference it already has. */
  excludeId?: string;
}

export async function assertReferenceIsNew(db: ReferenceDb, check: ReferenceCheck): Promise<void> {
  const reference = typeof check.referenceNumber === 'string' ? check.referenceNumber.trim() : '';
  if (reference === '') return;

  // The day window is built here rather than left to the database, so the
  // boundary is Manila whatever the session's zone happens to be — the server
  // and the database disagree about time zones on this deployment, which is
  // why every other day comparison in the cash path goes through this module.
  // The Philippines has no daylight saving, so a day is a fixed 24 hours and
  // the end can simply be one day on.
  const dayKey = eventDateKey(check.eventDate ?? null);
  const dayStart = parseDateKey(dayKey);
  // Unreachable: eventDateKey only ever returns a key this same module
  // validates. Skipping rather than throwing keeps an impossible date from
  // becoming the reason a real transaction is refused.
  if (!dayStart) return;
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const params: any[] = [check.accountId, dayStart.toISOString(), dayEnd.toISOString(), reference];
  const exclude = check.excludeId
    ? ` AND t.id <> $${(params.push(check.excludeId), params.length)}`
    : '';

  const existing = (await db.query(
    `SELECT t.transaction_number, t.status
     FROM transactions t
     WHERE t.account_id = $1
       AND t.transaction_date >= $2 AND t.transaction_date < $3
       AND UPPER(t.reference_number) = UPPER($4)
       AND t.status IS DISTINCT FROM 'reversed'${exclude}
     ORDER BY t.transaction_date
     LIMIT 1`,
    params,
  )).rows[0];

  if (!existing) return;

  // The advice has to match what an operator can actually do with the row they
  // just found: a pending entry is theirs to correct, a completed one has to go
  // through a reversal.
  const remedy = existing.status === 'pending'
    ? 'Edit or cancel that entry, or correct the reference you just gave.'
    : 'If this is the same event recorded again, reverse the original first.';

  throw createError(409,
    `Reference ${reference} is already recorded on this account as TX #${existing.transaction_number} ` +
    `(${existing.status}) for ${dayKey}. ${remedy}`);
}
