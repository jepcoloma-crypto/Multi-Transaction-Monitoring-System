import { describe, it, expect } from 'vitest';
import { hasOpenGap } from './gapFixQueue';

describe('hasOpenGap', () => {
  it('offers an account whose balance the ledger cannot explain', () => {
    expect(hasOpenGap({ gap: 150 })).toBe(true);
    expect(hasOpenGap({ gap: -3729 })).toBe(true);
  });

  it('withholds an account whose books already balance', () => {
    expect(hasOpenGap({ gap: 0 })).toBe(false);
  });

  it('withholds history the fix cannot move: negative rows and no gap', () => {
    // Revolving Fund on 2026-11-01: 134 negative rows, gap 0, chain intact.
    // A proposal on it is refused server-side, so the queue never offers it —
    // and the integrity report still shows it, because that page asks a
    // different question.
    const revolvingFund = { gap: 0, negativeBalances: 134, reconciled: false };
    expect(hasOpenGap(revolvingFund)).toBe(false);
  });

  it('reads only the gap, so a worse history cannot hide a real gap', () => {
    // Chain breaks and negatives do not close the balance disagreement; the
    // account still needs the queue, and the issues column says why a gap fix
    // alone may not settle it.
    const broken = { gap: 200, chainBreaks: 3, negativeBalances: 12 };
    expect(hasOpenGap(broken)).toBe(true);
  });
});
