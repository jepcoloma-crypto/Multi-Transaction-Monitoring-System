// Pure correction strategy table — no database, no network, so the preview
// endpoint, the commit gate and unit tests all agree on what correcting a
// given source record has to touch.

export type CorrectionSource = 'transaction' | 'transfer' | 'loading' | 'reconciliation' | 'adjustment';

export interface CorrectionStrategy {
  source: CorrectionSource;
  ledgerRows: number;
  accounts: number;
  crossAccount: boolean;
  bidirectional: boolean;
  addressable: boolean;
  label: string;
}

export const CORRECTION_STRATEGY: Record<CorrectionSource, CorrectionStrategy> = {
  transaction: {
    source: 'transaction',
    ledgerRows: 1,
    accounts: 1,
    crossAccount: false,
    bidirectional: false,
    addressable: true,
    label: 'Single-account transaction',
  },
  loading: {
    source: 'loading',
    ledgerRows: 1,
    accounts: 1,
    crossAccount: false,
    bidirectional: false,
    addressable: true,
    label: 'Single-account loading entry',
  },
  reconciliation: {
    source: 'reconciliation',
    ledgerRows: 1,
    accounts: 1,
    crossAccount: false,
    bidirectional: false,
    addressable: true,
    label: 'Single-account reconciliation adjustment',
  },
  adjustment: {
    source: 'adjustment',
    ledgerRows: 1,
    accounts: 1,
    crossAccount: false,
    bidirectional: false,
    addressable: false,
    label: 'Direct balance adjustment (no source record to correct)',
  },
  transfer: {
    source: 'transfer',
    ledgerRows: 2,
    accounts: 2,
    crossAccount: true,
    bidirectional: true,
    addressable: true,
    label: 'Two-account transfer: source debit and destination credit',
  },
};

export function strategyFor(source: string): CorrectionStrategy | null {
  return Object.prototype.hasOwnProperty.call(CORRECTION_STRATEGY, source)
    ? CORRECTION_STRATEGY[source as CorrectionSource]
    : null;
}

export interface ObservedShape {
  rowCount: number;
  accountIds: string[];
  entryTypes: string[];
}

export interface ShapeVerdict {
  ok: boolean;
  problems: string[];
}

// A correction must never be planned against a record that owns a different
// number of ledger rows than its strategy promises — a partially-linked
// transfer is exactly how one account gets corrected and the other doesn't.
export function verifyShape(strategy: CorrectionStrategy, observed: ObservedShape): ShapeVerdict {
  const problems: string[] = [];

  if (observed.rowCount === 0) {
    problems.push('no ledger rows are linked to this record');
  } else if (observed.rowCount !== strategy.ledgerRows) {
    problems.push(`expected ${strategy.ledgerRows} ledger row(s) for a ${strategy.source} but found ${observed.rowCount}`);
  }

  if (observed.accountIds.length !== strategy.accounts) {
    problems.push(`expected ${strategy.accounts} account(s) for a ${strategy.source} but found ${observed.accountIds.length}`);
  }

  if (strategy.bidirectional) {
    const hasCredit = observed.entryTypes.includes('credit');
    const hasDebit = observed.entryTypes.includes('debit');
    if (!(hasCredit && hasDebit)) {
      problems.push('a transfer must own one credit row and one debit row');
    }
  }

  if (observed.rowCount > 0 && observed.rowCount !== observed.accountIds.length && !strategy.crossAccount) {
    problems.push('a single-account source must not own more than one row per account');
  }

  return { ok: problems.length === 0, problems };
}
