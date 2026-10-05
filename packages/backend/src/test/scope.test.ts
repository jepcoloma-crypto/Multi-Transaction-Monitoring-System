import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { branchClause, canSeeAll, resolveBranchFilter } from '../middleware/scope';

const asRequest = (user: Record<string, unknown>): Request => ({ user } as unknown as Request);

const headOffice = asRequest({
  userId: 'u-admin',
  roles: ['administrator'],
  permissions: ['branches.read_all'],
  branchIds: ['br-main'],
});

// A plain branch user: neither an administrator nor a holder of any
// `*_read_all`. Exactly the shape an operator has once migration 033 has
// withdrawn the grants those roles used to carry.
const branchUser = asRequest({
  userId: 'u-op',
  roles: ['operator'],
  permissions: ['transactions.read'],
  branchIds: ['br-a', 'br-b'],
});

test('an administrator gets no row filter, and no placeholder is consumed', () => {
  const scope = branchClause(headOffice, 't', 'accounts.read_all', 4);

  assert.equal(scope.clause, null);
  assert.deepEqual(scope.params, []);
  // A filter that disappears must not burn a $n either, or every later
  // placeholder in a query that appends conditions by index would shift.
  assert.equal(scope.paramIndex, 4);
});

test('a transaction is scoped through the branch of its account', () => {
  const scope = branchClause(branchUser, 't', 'transactions.read_all', 3);

  assert.equal(
    scope.clause,
    't.account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($3))',
  );
  // Both branches, as an array: user-to-branch is many-to-many, so the
  // predicate is ANY, not equality.
  assert.deepEqual(scope.params, [['br-a', 'br-b']]);
  assert.equal(scope.paramIndex, 4);
});

test('an accounts row is scoped directly rather than through a subquery', () => {
  const scope = branchClause(branchUser, 'a', 'accounts.read_all', 1, 'self');

  assert.equal(scope.clause, 'a.branch_id = ANY($1)');
  assert.equal(scope.paramIndex, 2);
});

test('a transfer matches on either side, reusing one branch parameter', () => {
  const scope = branchClause(branchUser, 't', 'transfers.read_all', 1, 'transfer');

  assert.equal(
    scope.clause,
    '(t.source_account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($1)) '
    + 'OR t.destination_account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($1)))',
  );
  // The placeholder appears twice but is bound once. Pushing the array twice
  // would desynchronise every parameter after it.
  assert.deepEqual(scope.params, [['br-a', 'br-b']]);
  assert.equal(scope.paramIndex, 2);
});

test('the default link targets account_id, which transfers do not have', () => {
  // Documents why the link argument exists: `t` is used for transactions in
  // one query and transfers in the next, so the alias cannot decide. Left on
  // the default, a transfers query would emit a column that fails at runtime
  // rather than a message anyone can act on.
  const scope = branchClause(branchUser, 't', 'transfers.read_all', 1);

  assert.equal(scope.clause, 't.account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($1))');
});

test('a user with no branch is refused instead of shown everything', () => {
  const noBranch = asRequest({
    userId: 'u-none',
    roles: ['operator'],
    permissions: ['transactions.read'],
    branchIds: [],
  });

  assert.throws(
    () => branchClause(noBranch, 't', 'transactions.read_all', 1),
    (err: any) => err.statusCode === 403
      && err.message === 'No branch is assigned to your account',
  );
});

test('an absent branch list is refused, never read as all branches', () => {
  // The dangerous failure mode: `undefined` silently matching every row.
  const missing = asRequest({
    userId: 'u-missing',
    roles: ['operator'],
    permissions: ['transactions.read'],
  });

  assert.throws(() => branchClause(missing, 't', 'transactions.read_all', 1), /No branch/);
});

test('branches.read_all opens every branch without the administrator role', () => {
  const auditor = asRequest({
    userId: 'u-audit',
    roles: ['auditor'],
    permissions: ['branches.read_all'],
    branchIds: ['br-main'],
  });

  const scope = branchClause(auditor, 't', 'transactions.read_all', 2);

  // Checking only the entity permission would make this grant inert for
  // anyone who is not already an administrator, so granting it would do
  // nothing at all.
  assert.equal(scope.clause, null);
  assert.equal(scope.paramIndex, 2);
  assert.equal(canSeeAll(auditor, 'branches.read_all'), true);
});

test('reading transactions does not unlock accounts', () => {
  assert.equal(canSeeAll(branchUser, 'accounts.read_all'), false);
  assert.equal(canSeeAll(branchUser, 'transactions.read'), true);
  assert.equal(canSeeAll(branchUser, 'branches.read_all'), false);
});

test('a branch user is filtered on every entity they lack read_all for', () => {
  // The scenario migration 033 exists to produce: after `accounts.read_all`
  // is withdrawn from the operator role, an operator must be branch-scoped
  // on accounts too, not only on transactions.
  for (const permission of ['accounts.read_all', 'transfers.read_all', 'loading.read_all']) {
    const scope = branchClause(branchUser, 't', permission, 1);
    assert.notEqual(scope.clause, null, `${permission} should still be scoped`);
    assert.deepEqual(scope.params, [['br-a', 'br-b']]);
  }
});

// --- The report branch filter -------------------------------------------
//
// A second predicate, not a narrower form of the first: the scope binds an
// array of every branch the caller may see and disappears entirely for head
// office, while the filter binds one named branch and is the only thing that
// still narrows a caller who already sees everything.

test('a named branch binds a scalar beside the scope, in order', () => {
  const scope = branchClause(branchUser, 't', 'transactions.read_all', 3, 'account', 'br-b');

  assert.equal(
    scope.clause,
    't.account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($3)) '
    + 'AND t.account_id IN (SELECT id FROM accounts WHERE branch_id = $4)',
  );
  assert.deepEqual(scope.params, [['br-a', 'br-b'], 'br-b']);
  assert.equal(scope.paramIndex, 5);
});

test('a named branch still narrows head office, who has no row scope', () => {
  // The whole reason this is a separate predicate. Read as part of the scope
  // it would vanish for exactly the callers who use it, and the picker would
  // do nothing for the people who can see every branch.
  const scope = branchClause(headOffice, 't', 'accounts.read_all', 4, 'account', 'br-b');

  assert.equal(scope.clause, 't.account_id IN (SELECT id FROM accounts WHERE branch_id = $4)');
  assert.deepEqual(scope.params, ['br-b']);
  assert.equal(scope.paramIndex, 5);
});

test('an accounts row compares the branch directly rather than ANY', () => {
  const scope = branchClause(headOffice, 'a', 'accounts.read_all', 1, 'self', 'br-a');

  assert.equal(scope.clause, 'a.branch_id = $1');
  assert.deepEqual(scope.params, ['br-a']);
});

test('a named transfer branch is the source side only', () => {
  // Deliberately not the either-side predicate the scope uses. One row has to
  // resolve to exactly one branch, or the per-branch subtotals it is grouped
  // into would count every cross-branch transfer twice.
  const scope = branchClause(branchUser, 't', 'transfers.read_all', 1, 'transfer', 'br-b');

  assert.equal(
    scope.clause,
    '(t.source_account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($1)) '
    + 'OR t.destination_account_id IN (SELECT id FROM accounts WHERE branch_id = ANY($1))) '
    + 'AND t.source_account_id IN (SELECT id FROM accounts WHERE branch_id = $2)',
  );
  assert.deepEqual(scope.params, [['br-a', 'br-b'], 'br-b']);
  assert.equal(scope.paramIndex, 3);
});

test('no named branch leaves the scope byte-for-byte as it was', () => {
  // The filter is optional, so every existing call site must be unaffected --
  // including the ones that pass nothing at all.
  const left = branchClause(branchUser, 't', 'transactions.read_all', 1, 'account', null);
  const right = branchClause(branchUser, 't', 'transactions.read_all', 1);

  assert.deepEqual(left, right);
});

test('resolveBranchFilter returns null when no branch was named', async () => {
  // Emptiness belongs to the resolver, which every route calls before
  // branchClause does: a whitespace value reaching the SQL builder would
  // bind `branch_id = '   '` and report an empty page rather than no filter.
  assert.equal(await resolveBranchFilter(branchUser, undefined), null);
  assert.equal(await resolveBranchFilter(branchUser, ''), null);
  assert.equal(await resolveBranchFilter(branchUser, '   '), null);
});

// The resolver is the one place a requested branch becomes a bound
// parameter, so what it is handed has to be shaped like the uuid column it
// lands on. The `br-a` fixtures above are only ever written into SQL text and
// never executed, which is why they stay as they are.
const MAIN_ID = '239c3926-3745-4e4e-b73a-63c9fe8c8a17';
const RM_ID = 'f8af5291-1f3b-4b72-a411-40498bd82e88';

const mainScopedUser = asRequest({
  userId: 'u-op-main',
  roles: ['operator'],
  permissions: ['transactions.read'],
  branchIds: [MAIN_ID],
});

test('resolveBranchFilter accepts one of the caller own branches without asking the database', async () => {
  assert.equal(await resolveBranchFilter(mainScopedUser, MAIN_ID), MAIN_ID);
});

test('resolveBranchFilter refuses a branch outside the caller scope with 404', async () => {
  // 404 and not 403, matching assertBranch: an empty result and a branch the
  // caller may not see must not look alike, and the caller must not be able
  // to tell an existing foreign branch from one that was never created.
  await assert.rejects(
    () => resolveBranchFilter(mainScopedUser, RM_ID),
    (err: any) => err.statusCode === 404 && err.message === 'Branch not found',
  );
});

test('resolveBranchFilter does not soften a caller with no branches', async () => {
  const noBranch = asRequest({
    userId: 'u-none',
    roles: ['operator'],
    permissions: ['transactions.read'],
    branchIds: [],
  });

  await assert.rejects(
    () => resolveBranchFilter(noBranch, MAIN_ID),
    (err: any) => err.statusCode === 403,
  );
});

test('a value that is not a UUID is a missing branch, not a database error', async () => {
  // Head office would otherwise bind it to a `uuid` column and surface
  // invalid input syntax as a 500. Rejected before any query, so this
  // asserts the shape check by running without a database to fail against.
  await assert.rejects(
    () => resolveBranchFilter(headOffice, 'not-a-branch'),
    (err: any) => err.statusCode === 404 && err.message === 'Branch not found',
  );
  await assert.rejects(
    () => resolveBranchFilter(headOffice, '239c3926-3745-4e4e-b73a'),
    (err: any) => err.statusCode === 404,
  );
});
