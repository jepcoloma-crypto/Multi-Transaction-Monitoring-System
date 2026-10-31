import { describe, it } from 'node:test';
import assert from 'node:assert';
import { claimGate } from '../services/cashClaim';

const OPENER = 'shift-opener';
const OTHER = 'someone-else';

describe('claimGate — who may confirm cash receipt (C2)', () => {
  it('lets the duty operator (opener of the branch\'s open shift) claim', () => {
    assert.strictEqual(claimGate({ roles: ['operator'], userId: OPENER, shiftOpenerId: OPENER }), true);
  });

  it('refuses another operator — they did not take the cash', () => {
    assert.strictEqual(claimGate({ roles: ['operator'], userId: OTHER, shiftOpenerId: OPENER }), false);
  });

  it('refuses an operator when no shift is open', () => {
    assert.strictEqual(claimGate({ roles: ['operator'], userId: OTHER, shiftOpenerId: null }), false);
  });

  it('refuses an auditor — reading the books is not receiving cash', () => {
    assert.strictEqual(claimGate({ roles: ['auditor'], userId: OTHER, shiftOpenerId: OPENER }), false);
  });

  it('lets an administrator claim regardless of the shift', () => {
    assert.strictEqual(claimGate({ roles: ['administrator'], userId: OTHER, shiftOpenerId: OPENER }), true);
    assert.strictEqual(claimGate({ roles: ['administrator'], userId: OTHER, shiftOpenerId: null }), true);
  });

  it('lets a manager claim regardless of the shift', () => {
    assert.strictEqual(claimGate({ roles: ['manager'], userId: OTHER, shiftOpenerId: OPENER }), true);
    assert.strictEqual(claimGate({ roles: ['manager'], userId: OTHER, shiftOpenerId: null }), true);
  });

  it('treats a blank user id as nobody, not as a match', () => {
    assert.strictEqual(claimGate({ roles: ['operator'], userId: '', shiftOpenerId: '' }), false);
  });
});
