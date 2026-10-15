// Executing a loading cancellation: the plan (services/cancelPlan.ts), the
// append-only mirror writes, the record's status flip and the reconciliation
// gate — one function, one connection, so the request path in loading.ts and
// the approval path in transactions.ts cannot grow two different executions of
// the same decision (the rule §34 made explicit: one planner, one arithmetic).
//
// The caller owns the transaction: BEGIN before, COMMIT after, ROLLBACK on the
// thrown error. Nothing here commits.

import { createError } from '../middleware/error';
import { updateAccountBalance, lockAccounts } from './balance';
import { planLoadingCancel } from './cancelPlan';
import type { CancelImpact } from './cancelPlan';
import { auditInside } from './ledgerGates';

export interface LoadingCancelResult {
  affected: CancelImpact[];
  transactionNumber: number;
}

export async function executeLoadingCancel(
  client: any,
  input: { loadingId: string; reason: string },
): Promise<LoadingCancelResult> {
  const loading = (await client.query(
    `SELECT id, transaction_number, status FROM loading_transactions WHERE id = $1 FOR UPDATE`,
    [input.loadingId],
  )).rows[0];
  if (!loading) throw createError(404, 'Loading transaction not found');
  if (loading.status === 'reversed') throw createError(400, 'This loading sale is already cancelled');
  if (loading.status !== 'completed') throw createError(400, 'Only completed loading sales can be cancelled');

  // The rows the sale wrote — both halves, channel and till, read by source so
  // the mirror is exact whatever corrections touched them (§34: the recorded
  // rows are the whole answer).
  const rows = (await client.query(
    `SELECT id, account_id, entry_type, amount
       FROM ledger_entries
      WHERE source_type = 'loading' AND source_id = $1
      ORDER BY created_at, id`,
    [input.loadingId],
  )).rows;

  const accountIds = [...new Set<string>(rows.map((r: any) => String(r.account_id)))];
  if (accountIds.length === 0) {
    throw createError(400, 'This sale wrote no ledger rows — there is nothing to cancel');
  }

  // Both accounts locked in sorted id order — the same order every path that
  // holds more than one account locks in, so a concurrent sale or cash movement
  // can never deadlock against a cancellation by locking the pair the other way.
  // Balances are read after the lock, so the plan below is the state this
  // cancellation actually starts from.
  await lockAccounts(client, accountIds);
  const accounts = (await client.query(
    `SELECT id, name, status, current_balance FROM accounts WHERE id = ANY($1)`,
    [accountIds],
  )).rows;

  const plan = planLoadingCancel(loading, rows, accounts);
  if (!plan.safe) throw createError(400, `Cannot cancel: ${plan.problems.join('; ')}`);

  // Append the mirrors — never a rewrite. Each row flips direction through the
  // balance service, so balance_after and the chain stay intact and the
  // statement shows the sale and its cancellation as the pair they are.
  for (const mirror of plan.mirrors) {
    const balance = await updateAccountBalance(mirror.accountId, mirror.amount, mirror.entryType, client);
    await client.query(
      `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
       VALUES ($1, 'loading', $2, $3, $4, $5, $6, NOW())`,
      [
        mirror.accountId,
        input.loadingId,
        mirror.entryType,
        mirror.amount,
        balance,
        `Cancellation of loading sale #${loading.transaction_number}: ${input.reason}`,
      ],
    );
  }

  // The status flip carries its own race check: whoever gets the row first
  // posts the mirrors, everyone else finds the sale already cancelled.
  const flipped = await client.query(
    `UPDATE loading_transactions SET status = 'reversed', updated_at = NOW() WHERE id = $1 AND status = 'completed'`,
    [input.loadingId],
  );
  if (flipped.rowCount !== 1) throw createError(409, 'This loading sale was already processed');

  // The belt on the suspenders: commit only when every affected account still
  // reconciles — chain, balance and last row — after the mirrors landed.
  const verdict = await auditInside(client, accountIds);
  if (!verdict.accounts.every((a) => a.reconciled)) {
    const bad = verdict.accounts.filter((a) => !a.reconciled).map((a) => `${a.name} (gap ${a.gap})`);
    throw createError(409, `Refusing to commit — ${bad.join(', ')} did not reconcile after cancellation`);
  }

  return { affected: plan.affected, transactionNumber: loading.transaction_number };
}
