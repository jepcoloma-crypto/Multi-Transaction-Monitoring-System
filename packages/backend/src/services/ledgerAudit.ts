// Pure ledger integrity audit — no database, no network, no Prisma, so the same
// computation can back the report endpoint, the correction-module commit gate and
// unit tests alike (AGENTS.md architecture rule 1).

export interface LedgerAuditAccount {
  id: string;
  name: string;
  status: string;
  opening_balance: number | string;
  current_balance: number | string;
}

export interface LedgerAuditEntry {
  id: string;
  account_id: string;
  entry_type: string;
  amount: number | string;
  balance_after: number | string;
  source_id: string | null;
  created_at: Date | string;
}

export interface AccountAudit {
  id: string;
  name: string;
  status: string;
  openingBalance: number;
  netMovement: number;
  expectedBalance: number;
  currentBalance: number;
  gap: number;
  entryCount: number;
  chainBreaks: number;
  negativeBalances: number;
  unlinkedEntries: number;
  lastLedgerBalance: number | null;
  issues: string[];
  reconciled: boolean;
  /**
   * The bar a *write* gate asks: after this write the books still balance —
   * gap 0, chain intact, last row ends at the account's balance.
   *
   * `reconciled` also counts historical negative-balance rows, which is right
   * for the integrity report but wrong for a commit gate: a negative row
   * already in the books cannot be un-written, so refusing on it refuses every
   * future write to that account forever (Revolving Fund: gap 0, chain intact,
   * still refused with "gap 0"). History stays in `reconciled`; a gate reads
   * `balanced`.
   */
  balanced: boolean;
}

export interface LedgerAuditSummary {
  totalAccounts: number;
  reconciled: number;
  mismatched: number;
  totalGap: number;
  brokenChainLinks: number;
  negativeBalances: number;
}

export interface LedgerAuditResult {
  accounts: AccountAudit[];
  summary: LedgerAuditSummary;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const toNumber = (v: number | string): number => (typeof v === 'number' ? v : parseFloat(v));
const toMillis = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

export const toCents = (v: number | string): number => Math.round(toNumber(v) * 100);
export const fromCents = (c: number): number => round2(c / 100);

// Ledger rows are read in write order (created_at, then id) — not date order —
// so every consumer of the chain walks it identically.
export const compareWriteOrder = (a: LedgerAuditEntry, b: LedgerAuditEntry): number =>
  toMillis(a.created_at) - toMillis(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function auditAccount(account: LedgerAuditAccount, entries: LedgerAuditEntry[]): AccountAudit {
  const opening = round2(toNumber(account.opening_balance));
  const actual = round2(toNumber(account.current_balance));

  const sorted = [...entries].sort(compareWriteOrder);

  let netCents = 0;
  let negatives = 0;
  let unlinked = 0;
  let chainBreaks = 0;

  sorted.forEach((entry, i) => {
    const amountCents = toCents(entry.amount);
    netCents += entry.entry_type === 'credit' ? amountCents : -amountCents;
    if (toNumber(entry.balance_after) < 0) negatives += 1;
    if (entry.source_id === null || entry.source_id === undefined) unlinked += 1;
    if (i === 0) return;
    const previous = toCents(sorted[i - 1].balance_after);
    const signed = entry.entry_type === 'credit' ? amountCents : -amountCents;
    if (toCents(entry.balance_after) !== previous + signed) chainBreaks += 1;
  });

  const net = round2(netCents / 100);
  const expected = round2(opening + net);
  const gap = round2(expected - actual);
  const last = sorted.length === 0 ? null : round2(toNumber(sorted[sorted.length - 1].balance_after));

  const issues: string[] = [];
  if (gap !== 0) issues.push(`balance gap of ${gap.toFixed(2)}`);
  if (chainBreaks > 0) issues.push(`${chainBreaks} broken chain link(s)`);
  if (negatives > 0) issues.push(`${negatives} negative balance(s)`);
  if (last !== null && last !== actual) issues.push(`last ledger row ${last.toFixed(2)} differs from balance ${actual.toFixed(2)}`);

  // What this write would be judged on: the three structural checks only.
  // A negative row in the history does not unbalance the books.
  const balanced = gap === 0 && chainBreaks === 0 && (last === null || last === actual);

  return {
    id: account.id,
    name: account.name,
    status: account.status,
    openingBalance: opening,
    netMovement: net,
    expectedBalance: expected,
    currentBalance: actual,
    gap,
    entryCount: sorted.length,
    chainBreaks,
    negativeBalances: negatives,
    unlinkedEntries: unlinked,
    lastLedgerBalance: last,
    issues,
    reconciled: issues.length === 0,
    balanced,
  };
}

/**
 * The accounts that fail the write gate, each named with the structural
 * reason it fails — the message the old gate wished it could print instead of
 * `(gap 0)`, which was true and useless at the same time.
 */
export function unbalancedAfter(accounts: AccountAudit[]): string[] {
  return accounts.filter((a) => !a.balanced).map((a) => {
    const reasons: string[] = [];
    if (a.gap !== 0) reasons.push(`gap ${a.gap}`);
    if (a.chainBreaks > 0) reasons.push(`${a.chainBreaks} broken chain link(s)`);
    if (a.lastLedgerBalance !== null && a.lastLedgerBalance !== a.currentBalance) {
      reasons.push(`last row ${a.lastLedgerBalance.toFixed(2)} vs balance ${a.currentBalance.toFixed(2)}`);
    }
    return `${a.name} (${reasons.join(', ') || 'out of balance'})`;
  });
}

export function auditLedger(accounts: LedgerAuditAccount[], entries: LedgerAuditEntry[]): LedgerAuditResult {
  const byAccount = new Map<string, LedgerAuditEntry[]>();
  for (const entry of entries) {
    const bucket = byAccount.get(entry.account_id);
    if (bucket) bucket.push(entry);
    else byAccount.set(entry.account_id, [entry]);
  }

  const audited = accounts.map((account) => auditAccount(account, byAccount.get(account.id) || []));

  return {
    accounts: audited,
    summary: {
      totalAccounts: audited.length,
      reconciled: audited.filter((a) => a.reconciled).length,
      mismatched: audited.filter((a) => !a.reconciled).length,
      totalGap: round2(audited.reduce((sum, a) => sum + a.gap, 0)),
      brokenChainLinks: audited.reduce((sum, a) => sum + a.chainBreaks, 0),
      negativeBalances: audited.reduce((sum, a) => sum + a.negativeBalances, 0),
    },
  };
}
