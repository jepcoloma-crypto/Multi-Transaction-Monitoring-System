import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCustomerName, rejoinCustomerName, distinctContacts } from '../services/customerTransfer';

test('the last token is the surname', async () => {
  assert.deepEqual(splitCustomerName('REY PAWAL'), { firstName: 'REY', lastName: 'PAWAL' });
  assert.deepEqual(
    splitCustomerName('MARIA ROSARIO VALENCIA'),
    { firstName: 'MARIA ROSARIO', lastName: 'VALENCIA' },
    'a middle name stays with the given name, the way these names read',
  );
});

test('a name that ends in an initial keeps the initial', async () => {
  // The split does not pretend to know a surname the operator never typed.
  // Recording "B." is what was written down; inventing BAUTISTA is not.
  assert.deepEqual(splitCustomerName('DONNA B.'), { firstName: 'DONNA', lastName: 'B.' });
  assert.deepEqual(splitCustomerName('JOY ANTHONY V.'), { firstName: 'JOY ANTHONY', lastName: 'V.' });
});

test('a single token has no surname to give', async () => {
  // Left empty rather than guessed, so the refusal reaches the operator's
  // review instead of quietly producing a customer called SANTOS / SANTOS.
  assert.deepEqual(splitCustomerName('BERNARDO'), { firstName: 'BERNARDO', lastName: '' });
  assert.deepEqual(splitCustomerName('   '), { firstName: '', lastName: '' });
  assert.deepEqual(splitCustomerName(''), { firstName: '', lastName: '' });
});

test('extra spacing is collapsed, and nothing else is edited', async () => {
  assert.deepEqual(splitCustomerName('  REY   PAWAL '), { firstName: 'REY', lastName: 'PAWAL' });
  assert.deepEqual(
    splitCustomerName('rey pawal'),
    { firstName: 'rey', lastName: 'pawal' },
    'the operator typed it that way; folding the case would silently rewrite identity data',
  );
});

test('the halves join back to the name the transaction carries', async () => {
  // The registered-customer view matches on first_name || ' ' || last_name,
  // so any split that does not round-trip would hide that customer's history.
  for (const name of ['REY PAWAL', 'MARIA ROSARIO VALENCIA', "DONNA B.", 'JOY ANTHONY V.']) {
    assert.equal(rejoinCustomerName(splitCustomerName(name)), name);
  }
});

test('a single token also joins back to itself', async () => {
  assert.equal(rejoinCustomerName(splitCustomerName('BERNARDO')), 'BERNARDO');
});

test('a contact list keeps its order and drops repeats and blanks', async () => {
  // Newest first, so the head of the list is what the tab already shows.
  assert.deepEqual(
    distinctContacts(['09813155479', '09360956245', '09813155479', null, '  ', '09360956245']),
    ['09813155479', '09360956245'],
  );
  assert.deepEqual(distinctContacts([]), []);
  assert.deepEqual(distinctContacts(null), [], 'a non-array is no contacts, not an error');
});
