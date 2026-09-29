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
const toCents = (v: number | string): number => Math.round(toNumber(v) * 100);
const toMillis = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

const byWriteOrder = (a: LedgerAuditEntry, b: LedgerAuditEntry): number =>
  toMillis(a.created_at) - toMillis(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function auditAccount(account: LedgerAuditAccount, entries: LedgerAuditEntry[]): AccountAudit {
  const opening = round2(toNumber(account.opening_balance));
  const actual = round2(toNumber(account.current_balance));

  const sorted = [...entries].sort(byWriteOrder);

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
  };
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
