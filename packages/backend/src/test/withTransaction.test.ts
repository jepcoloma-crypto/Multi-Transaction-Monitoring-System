import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { withTransaction } from '../services/withTransaction';

// The borrowed connection, recorded rather than real. Ordering is the whole
// mechanism here — BEGIN has to come first, COMMIT only on success, ROLLBACK
// only on failure, release always — and none of it is observable from a route
// that returned the right rows.
interface Fake {
  client: PoolClient;
  calls: string[];
  released: number;
}

function fakeClient(onQuery?: (text: string) => void): Fake {
  const calls: string[] = [];
  const fake: Fake = {
    calls,
    released: 0,
    client: {
      async query(text: string) {
        calls.push(text);
        onQuery?.(text);
      },
      release() {
        fake.released += 1;
      },
    } as unknown as PoolClient,
  };
  return fake;
}

const borrow =
  (fake: Fake) =>
  (): Promise<PoolClient> =>
    Promise.resolve(fake.client);

test('the work sits between BEGIN and COMMIT, and the connection comes back', async () => {
  const fake = fakeClient();

  const result = await withTransaction(async (client) => {
    fake.calls.push('work');
    await client.query('UPDATE transactions SET status = $1');
    return 'reverse-1';
  }, borrow(fake));

  assert.deepEqual(fake.calls, ['BEGIN', 'work', 'UPDATE transactions SET status = $1', 'COMMIT']);
  assert.equal(fake.released, 1);
  assert.equal(result, 'reverse-1');
});

test('BEGIN is always first, because everything else still looks right without it', async () => {
  // Not hypothetical. An earlier draft of this helper issued COMMIT and ROLLBACK
  // but no BEGIN: it compiled, the route returned the correct rows, every other
  // assertion in the suite passed — and each statement had already committed on
  // its own, so the ROLLBACK that followed quietly did nothing. Silent, and
  // indistinguishable from working.
  const fake = fakeClient();

  await withTransaction(async () => 1, borrow(fake));

  assert.equal(fake.calls[0], 'BEGIN');
});

test('the work is handed the connection that commits it', async () => {
  // The defect this whole file exists for: a transaction open on one connection
  // while the write that answers to it went through the pool beside it, where
  // it committed immediately and could not be rolled back at all.
  const fake = fakeClient();
  let handed: PoolClient | undefined;

  await withTransaction(async (client) => {
    handed = client;
    return 1;
  }, borrow(fake));

  assert.equal(handed, fake.client);
});

test('a failure rolls back, never commits, and keeps its own error', async () => {
  const fake = fakeClient();
  const fault = new Error('balance update failed');

  await assert.rejects(
    () =>
      withTransaction(async () => {
        throw fault;
      }, borrow(fake)),
    (err: unknown) => err === fault,
    'the original fault should reach the caller unwrapped',
  );

  assert.deepEqual(fake.calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(fake.released, 1);
});

test('a connection too broken to roll back still reports the real fault', async () => {
  // If the connection is why we are unwinding, the ROLLBACK is the statement
  // most likely to fail as well — and swallowing the first error to surface the
  // second would hand the operator a complaint about ROLLBACK instead of the
  // constraint or the bad row that caused it.
  const fake = fakeClient((text) => {
    if (text === 'ROLLBACK') throw new Error('connection terminated');
  });
  const fault = new Error('value too long for column reference_number');

  await assert.rejects(
    () =>
      withTransaction(async () => {
        throw fault;
      }, borrow(fake)),
    (err: unknown) => err === fault,
  );

  assert.equal(fake.released, 1, 'release must happen even when the rollback failed too');
});

test('a failed COMMIT releases the connection and says so', async () => {
  const fake = fakeClient((text) => {
    if (text === 'COMMIT') throw new Error('server closed the connection unexpectedly');
  });

  await assert.rejects(
    () => withTransaction(async () => 1, borrow(fake)),
    /server closed the connection unexpectedly/,
  );

  assert.equal(fake.released, 1, 'a connection left held after a failed commit is the original leak');
});

test('release happens exactly once on every path', async () => {
  const ok = fakeClient();
  await withTransaction(async () => 1, borrow(ok));
  assert.equal(ok.released, 1);

  const failed = fakeClient();
  await assert.rejects(
    () =>
      withTransaction(async () => {
        throw new Error('x');
      }, borrow(failed)),
  );
  assert.equal(failed.released, 1);
});
