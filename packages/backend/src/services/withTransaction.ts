// A borrowed connection, held for exactly one unit of work.
//
// Two failures have already shown up in routes that hand-rolled this: a client
// taken from the pool and released on no path at all, and a write issued
// through the pool while a transaction was open on the client beside it. The
// first retires a connection for good on every call; the second commits half a
// change that the surrounding ROLLBACK then undoes the other half of. Neither
// is a coding mistake so much as a shape that invites one — there is a BEGIN
// here, a COMMIT there, and whatever sits between them is easy to reach for the
// familiar pool query out of habit.
//
// So the shape lives in one place. Everything between acquire and return runs
// inside the transaction, everything after runs outside it, and release happens
// whether the work succeeded, threw, or threw again while being wound back.

import type { PoolClient } from 'pg';
import { getClient } from '../database/connection';

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  acquire: () => Promise<PoolClient> = getClient,
): Promise<T> {
  const client = await acquire();

  try {
    // Owed by this helper rather than by each caller: the shape is only safe if
    // BEGIN is always here, and a route that forgets it still compiles, still
    // returns the right rows, and still reports no error — while every statement
    // commits on its own and the ROLLBACK below quietly does nothing.
    await client.query('BEGIN');

    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Best effort, and deliberately swallowed: if the connection is why we are
    // unwinding then the ROLLBACK may well fail too, and masking the original
    // fault with a second one would hide the only useful half of it. The
    // `finally` below still releases either way.
    try {
      await client.query('ROLLBACK');
    } catch {
      // nothing further to do — the work is already abandoned
    }
    throw error;
  } finally {
    client.release();
  }
}
