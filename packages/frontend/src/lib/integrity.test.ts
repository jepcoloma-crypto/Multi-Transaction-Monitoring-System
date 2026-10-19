import { describe, it, expect } from 'vitest';
import {
  fixerFor,
  totalFindings,
  firstDisagreeing,
  directionLabel,
  type IntegrityReport,
  type IntegrityCheck,
} from './integrity';

// The bridge from a finding to a correction is the part of this feature that can
// do damage, so it is the part worth testing directly (design IC2). A finding
// reports a disagreement and cannot say which side is wrong; the page must
// therefore name a tool only where an existing correction path can justify one,
// and refuse to name one otherwise. Guessing here would move money with output
// indistinguishable from a correct fix.

const check = (id: string, status: IntegrityCheck['status'], findings: number = 0): IntegrityCheck => ({
  id,
  title: id,
  states: `${id} asserts something`,
  status,
  checked: 10,
  summary: `${id} summary`,
  findings: Array.from({ length: findings }, (_, i) => ({
    transactionNumber: i + 1,
    referenceNumber: null,
    direction: 'in',
    amount: 100,
    fee: 10,
    expected: 10,
    actual: 0,
    detail: 'x',
  })),
});

const report = (checks: IntegrityCheck[], clean = false): IntegrityReport => ({
  checks,
  ranAt: '2026-10-19T00:00:00.000Z',
  movements: 40,
  clean,
});

describe('fixerFor', () => {
  it('sends a misplaced fee to the re-post, which owns moving a fee', () => {
    expect(fixerFor('fee-placement')?.href).toBe('/fee-audit');
    expect(fixerFor('till-income')?.href).toBe('/fee-audit');
  });

  it('sends a stale record to the amount correction, which owns that', () => {
    expect(fixerFor('net-amount')?.href).toBe('/amount-corrections');
  });

  it('names no tool at all for a check it does not know — refusing to guess is the point', () => {
    // An unknown check has an unknown cause. Offering a fixer here would be the
    // same error as the one that produced the ₱20: a confident answer to a
    // question nobody had actually answered.
    expect(fixerFor('something-new')).toBeNull();
    expect(fixerFor('')).toBeNull();
  });
});

describe('totalFindings', () => {
  it('sums the findings across every check', () => {
    expect(totalFindings(report([check('a', 'pass'), check('b', 'findings', 2), check('c', 'findings', 3)]))).toBe(5);
  });

  it('is zero on a clean book', () => {
    expect(totalFindings(report([check('a', 'pass'), check('b', 'pass')]))).toBe(0);
  });
});

describe('firstDisagreeing', () => {
  it('opens the first check that disagrees, so the reader lands on the finding', () => {
    expect(firstDisagreeing(report([check('a', 'pass'), check('b', 'findings', 1), check('c', 'findings', 1)]))).toBe('b');
  });

  it('opens nothing when every check held', () => {
    expect(firstDisagreeing(report([check('a', 'pass'), check('b', 'pass')], true))).toBeNull();
  });
});

describe('directionLabel', () => {
  it('names the movement the way the counter does', () => {
    expect(directionLabel('in')).toBe('Cash-In');
    expect(directionLabel('out')).toBe('Cash-Out');
    expect(directionLabel('adjustment')).toBe('Adjustment');
  });

  it('falls back rather than printing nothing', () => {
    expect(directionLabel(null)).toBe('Movement');
    expect(directionLabel('transfer')).toBe('Movement');
  });
});
