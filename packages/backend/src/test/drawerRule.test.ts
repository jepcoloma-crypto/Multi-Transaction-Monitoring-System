import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerFlagSql, splitCashRows } from '../services/drawerQuery';

// The balance half of the drawer's two questions (the header of drawerQuery
// states both). Movements ask "did physical cash move" and answer with every
// cash account; balances ask "what does the till hold" and answer with the
// Drawer — a branch's oldest OPEN cash account, the very account
// `resolveDrawerLeg` writes to. These tests pin that answer where every cash
// figure reads it: the SQL expression itself, and the reducer that adds up
// what the SQL classifies.

test('the drawer predicate is the posting route\'s rule, word for word', () => {
  // A snapshot of the one rule: open before order, order within a branch, one
  // winner. If any clause moves here, the account a movement lands on and the
  // account a report counts have started being decided differently — which is
  // the drift this expression exists to make impossible.
  assert.equal(
    drawerFlagSql('a'),
    "a.status <> 'closed' AND ROW_NUMBER() OVER (PARTITION BY a.branch_id, a.status <> 'closed' ORDER BY a.created_at ASC) = 1"
  );
});

test('the predicate honours the alias it is given', () => {
  assert.ok(drawerFlagSql('acct').startsWith('acct.status <> \'closed\''));
  assert.ok(drawerFlagSql('acct').includes('PARTITION BY acct.branch_id'));
});

test('cash splits into the till and the frozen line, partitioning every peso', () => {
  const split = splitCashRows([
    { name: 'Revolving Fund', balance: '117249.00', is_drawer: true },
    { name: 'Legacy (frozen)', balance: '20000.00', is_drawer: false },
    { name: 'Revolving Fund', balance: '0.00', is_drawer: true },
  ]);

  assert.equal(split.drawer, 117249, 'the till counts only its Drawer');
  assert.equal(split.frozen, 20000, 'frozen legacy cash is reported beside it, never inside it');
  assert.equal(
    split.drawer + split.frozen,
    137249,
    'the halves reconcile to every cash peso in scope (D14)'
  );
  assert.equal(split.drawerAccounts, 'Revolving Fund');
  assert.equal(split.frozenAccounts, 'Legacy (frozen)');
});

test('account names come back distinct and alphabetical, like the old aggregation', () => {
  const split = splitCashRows([
    { name: 'Till B', balance: 10, is_drawer: true },
    { name: 'Till A', balance: 20, is_drawer: true },
    { name: 'Till B', balance: 5, is_drawer: true },
  ]);

  assert.equal(split.drawerAccounts, 'Till A, Till B');
  assert.equal(split.drawer, 35);
});

test('balances are summed in cents, so fractional totals do not drift', () => {
  // 0.1 + 0.2 in binary floats is 0.30000000000000004; a figure a shift
  // closes against has to come back as 0.3.
  const split = splitCashRows([
    { name: 'Till', balance: '0.10', is_drawer: true },
    { name: 'Till', balance: '0.20', is_drawer: true },
  ]);

  assert.equal(split.drawer, 0.3);
});

test('an unparseable balance counts as nothing rather than poisoning the figure', () => {
  const split = splitCashRows([
    { name: 'Till', balance: 'not a number', is_drawer: true },
    { name: 'Legacy', balance: 'bad', is_drawer: false },
  ]);

  assert.equal(split.drawer, 0);
  assert.equal(split.frozen, 0);
  assert.equal(split.drawerAccounts, 'Till');
});

test('a scope with no cash accounts reports two empty halves, not a crash', () => {
  const split = splitCashRows([]);

  assert.deepEqual(split, { drawer: 0, drawerAccounts: '', frozen: 0, frozenAccounts: '' });
});
