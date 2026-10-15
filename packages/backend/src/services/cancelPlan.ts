// Pure planning for a cancellation — the figures the approval queue previews
// and the figures the apply path writes come from here, one arithmetic source.
// The rule §34's fee re-post defect burned in: what the preview shows an
// administrator is what the approval will post, or the preview is lying.
//
// No database, no network: records, rows and accounts in, the plan out — which
// is what lets the preview route and the commit path call the same function.

import { unwindDrawerLeg } from './cashManagement';
import type { RecordedLedgerRow } from './cashManagement';

export interface CancelRow {
  id?: string;
  account_id: string;
  entry_type: string;
  amount: number | string;
}

export interface CancelAccount {
  id: string;
  name: string;
  status?: string;
  current_balance: number | string;
}

// One account's stake in the cancellation: where its balance stands now, how
// the approval moves it, where it lands. The three numbers the preview shows
// and the approve response is checked against.
export interface CancelImpact {
  accountId: string;
  name: string;
  before: number;
  delta: number;
  after: number;
}

export interface CancelMirrorRow {
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
  rowId: string;
}

export interface CancelLeg {
  accountId: string;
  entryType: 'debit' | 'credit';
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const toNumber = (v: number | string) => (typeof v === 'number' ? v : parseFloat(v));
const signedOf = (entryType: string, amount: number) => (entryType === 'credit' ? amount : -amount);

// The figure a reversal moves: the record's net plus the charges folded into it
// at creation. The same expression the immediate path, the request amount and
// the approval all use — named once so preview and apply cannot drift apart.
export function movementTotalOf(record: {
  net_amount?: string | number | null;
  amount?: string | number | null;
  additional_charges?: Array<{ amount: string | number }> | null;
}): number {
  const charges = (record.additional_charges || [])
    .reduce((sum, c) => sum + (parseFloat(String(c.amount)) || 0), 0);
  return parseFloat(String(record.net_amount || record.amount || 0)) + charges;
}

export interface LoadingCancelPlan {
  mirrors: CancelMirrorRow[];
  affected: CancelImpact[];
  accountIds: string[];
  problems: string[];
  safe: boolean;
}

// A sale's rows are mirrored one for one: every row the sale owns flips
// direction, so the channel's deduction returns to the account that paid and
// the till's credit walks back out of the drawer. Mirroring the recorded rows —
// rather than recomputing from the record's columns — is what makes the undo
// exact when corrections have touched the sale: the ledger is what the
// balances, the statement and the shift's expected closing are built from
// (§34's rule, and D43's).
export function planLoadingCancel(
  record: { status?: string },
  rows: CancelRow[],
  accounts: CancelAccount[],
): LoadingCancelPlan {
  const problems: string[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const accountIds = [...new Set(rows.map((r) => r.account_id))];
  const mirrors: CancelMirrorRow[] = [];
  const deltas = new Map<string, number>();

  if (record.status === 'reversed') problems.push('This loading sale is already cancelled');
  else if (record.status !== 'completed') problems.push('Only completed loading sales can be cancelled');

  if (rows.length === 0) problems.push('This sale wrote no ledger rows — there is nothing to cancel');

  for (const row of rows) {
    const account = byId.get(row.account_id);
    if (!account) {
      problems.push(`A ledger row of this sale points at an account that no longer exists`);
      continue;
    }
    const amount = toNumber(row.amount);
    if (!(amount > 0)) {
      problems.push('A ledger row of this sale carries no amount — nothing to mirror');
      continue;
    }
    const entryType: 'debit' | 'credit' = row.entry_type === 'debit' ? 'credit' : 'debit';
    mirrors.push({ rowId: row.id || '', accountId: row.account_id, entryType, amount });
    deltas.set(row.account_id, round2((deltas.get(row.account_id) || 0) + signedOf(entryType, amount)));
  }

  const affected: CancelImpact[] = [];
  for (const accountId of accountIds) {
    const account = byId.get(accountId);
    if (!account) continue;
    const before = round2(toNumber(account.current_balance));
    const delta = round2(deltas.get(accountId) || 0);
    const after = round2(before + delta);
    affected.push({ accountId, name: account.name, before, delta, after });
    if (account.status === 'closed') {
      problems.push(`${account.name} is closed — closed accounts cannot move`);
    }
    if (after < 0) {
      problems.push(
        `${account.name} would fall to ${after.toFixed(2)} — cancelling takes ${(-delta).toFixed(2)} ` +
        `from a balance of ${before.toFixed(2)}, and a balance may not go below zero`
      );
    }
  }

  return { mirrors, affected, accountIds, problems, safe: problems.length === 0 };
}

export interface TransactionCancelPlan {
  accountLeg: CancelLeg;
  drawerLeg: CancelLeg | null;
  affected: CancelImpact[];
  notes: string[];
  problems: string[];
  safe: boolean;
}

// What approving the reversal of a completed movement will post: the account
// leg from the record's own total (the figure every reversal path has always
// moved), the till's leg from the rows it actually wrote — corrections
// appended included, whichever way the fee was taken (unwindDrawerLeg) — and
// the honest note when the record's columns and its rows disagree, because
// approval posts the record's figure and the difference would stay behind.
export function planTransactionCancel(
  record: {
    status?: string;
    code?: string | null;
    direction?: string;
    account_id: string;
    net_amount?: string | number | null;
    amount?: string | number | null;
    additional_charges?: Array<{ amount: string | number }> | null;
  },
  accountRows: CancelRow[],
  otherRows: CancelRow[],
  accounts: CancelAccount[],
): TransactionCancelPlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const total = movementTotalOf(record);

  if (record.status === 'reversed') problems.push('This transaction is already reversed');
  else if (record.status !== 'completed') problems.push('Only completed transactions can be reversed');
  if (record.code === 'adjustment_in' || record.code === 'adjustment_out') {
    problems.push('Adjustment transactions cannot be reversed');
  }

  const reversesIn = record.direction === 'in';
  const accountLeg: CancelLeg = {
    accountId: record.account_id,
    entryType: reversesIn ? 'debit' : 'credit',
    amount: total,
  };

  const unwind = unwindDrawerLeg(otherRows as unknown as RecordedLedgerRow[]);
  const drawerLeg: CancelLeg | null = unwind
    ? { accountId: unwind.accountId, entryType: unwind.entryType, amount: unwind.amount }
    : null;

  // The columns-versus-rows note: approval posts the record's figure, so if the
  // account's rows for this movement sum to something else, that difference
  // survives the cancellation. Said plainly rather than silently absorbed —
  // "returned to the original balance" is only true when the two agree, and
  // where they do not, the fee audit (§34) is where the row gets fixed first.
  const rowsSum = round2(accountRows.reduce((sum, row) => sum + signedOf(row.entry_type, toNumber(row.amount)), 0));
  const legMove = signedOf(accountLeg.entryType, total);
  const residual = round2(rowsSum + legMove);
  if (Math.abs(residual) >= 0.01) {
    const name = byId.get(record.account_id)?.name || 'the account';
    notes.push(
      `This movement's ledger rows on ${name} sum ${rowsSum.toFixed(2)} while its record says ` +
      `${total.toFixed(2)} — approval posts ${total.toFixed(2)}, so ${residual.toFixed(2)} would remain on ${name}. ` +
      `Fix the row with the Fee Audit tool first if the record is the one that is wrong.`
    );
  }

  const affected: CancelImpact[] = [];
  const impacts = [accountLeg, ...(drawerLeg ? [drawerLeg] : [])];
  for (const leg of impacts) {
    const account = byId.get(leg.accountId);
    if (!account) {
      problems.push('An account this reversal would touch no longer exists');
      continue;
    }
    const before = round2(toNumber(account.current_balance));
    const delta = signedOf(leg.entryType, leg.amount);
    const after = round2(before + delta);
    affected.push({ accountId: leg.accountId, name: account.name, before, delta, after });
    if (account.status === 'closed') {
      problems.push(`${account.name} is closed — closed accounts cannot move`);
    }
    if (after < 0) {
      problems.push(
        `${account.name} would fall to ${after.toFixed(2)} — cancelling takes ${(-delta).toFixed(2)} ` +
        `from a balance of ${before.toFixed(2)}, and a balance may not go below zero`
      );
    }
  }

  return { accountLeg, drawerLeg, affected, notes, problems, safe: problems.length === 0 };
}
