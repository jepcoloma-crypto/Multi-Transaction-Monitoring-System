import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { branchClause, canSeeAll } from '../middleware/scope';

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
