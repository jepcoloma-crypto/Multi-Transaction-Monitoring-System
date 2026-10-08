import { describe, it, expect } from 'vitest';
import { denomQty, tallyCents, tallyUsed, denomSubtotalPesos, tallyPesos } from './tally';
import type { Denomination } from './tally';

const DENOMS: Denomination[] = [
  { label: '1000', cents: 100_000 },
  { label: '500', cents: 50_000 },
  { label: '100', cents: 10_000 },
  { label: '20', cents: 2_000 },
  { label: '1', cents: 100 },
  { label: '0.25', cents: 25 },
];

describe('denomQty', () => {
  it('reads a whole number of pieces', () => {
    expect(denomQty({ '100': '12' }, '100')).toBe(12);
  });

  it('treats an empty box as a box not yet filled, not an error', () => {
    expect(denomQty({}, '100')).toBe(0);
    expect(denomQty({ '100': '' }, '100')).toBe(0);
    expect(denomQty({ '100': '0' }, '100')).toBe(0);
    expect(denomQty({ '100': 'abc' }, '100')).toBe(0);
  });
});

describe('tallyCents', () => {
  it('adds each denomination rather than the float it would rather be', () => {
    // 2 x 1000 + 3 x 20 + 4 x 0.25 is 2061.00. Summed as pesos the quarter is
    // the piece that drifts; summed in centavos it cannot.
    const counts = { '1000': '2', '20': '3', '0.25': '4' };

    expect(tallyCents(DENOMS, counts)).toBe(200_000 + 6_000 + 100);
  });

  it('does not turn a grid nobody filled in into a count of nothing', () => {
    expect(tallyCents(DENOMS, {})).toBe(0);
    expect(tallyCents([], { '1000': '5' })).toBe(0);
  });

  it('keeps boxes the sheet does not list out of the total', () => {
    expect(tallyCents(DENOMS, { '3': '9' })).toBe(0);
  });
});

describe('tallyUsed', () => {
  it('is false until a single piece has been entered', () => {
    expect(tallyUsed(DENOMS, {})).toBe(false);
    expect(tallyUsed(DENOMS, { '1000': '' })).toBe(false);
    expect(tallyUsed(DENOMS, { '1000': '0' })).toBe(false);
  });

  it('lets one piece make the grid the count', () => {
    expect(tallyUsed(DENOMS, { '1': '1' })).toBe(true);
  });
});

describe('the display unit', () => {
  it('reports a hundred notes as the hundred thousand pesos they are', () => {
    // The arithmetic is centavos; the screen is pesos. Getting this wrong by a
    // factor of a hundred puts 10,040,000.00 in front of an operator counting
    // 100,400.00, and every figure beside it would look wrong without any of
    // them being the one that is.
    expect(tallyCents(DENOMS, { '1000': '100', '100': '4' })).toBe(10_040_000);
    expect(tallyPesos(DENOMS, { '1000': '100', '100': '4' })).toBe(100_400);
  });

  it('prints one quarter as the fraction of a peso it is', () => {
    expect(denomSubtotalPesos({ label: '0.25', cents: 25 }, 4)).toBe(1);
    expect(denomSubtotalPesos({ label: '1000', cents: 100_000 }, 3)).toBe(3000);
  });
});
