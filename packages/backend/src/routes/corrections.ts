import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { ownerClause } from '../middleware/scope';
import { createError } from '../middleware/error';
import { auditLedger } from '../services/ledgerAudit';
import { loadScopedLedger, loadLedgerRowsBySource } from '../services/ledgerQuery';
import { strategyFor, verifyShape } from '../services/correctionStrategy';
import { randomUUID } from 'crypto';
import { simulateCorrection, appendPlannedRows } from '../services/correctionPreview';
import { validateTierA, TIER_A_FIELDS } from '../services/correctionFields';
import { planReEntry, RE_ENTERABLE } from '../services/reEntryPlan';
import { planGapFix, isGapFixDirection, GAP_FIX_DIRECTIONS, GAP_FIX_LABELS } from '../services/gapFixPlan';
import { updateAccountBalance } from '../services/balance';
import { createAuditLog } from '../services/audit';
import { mintTransferReference, MintedTransfer } from '../services/transferReference';
import type { Simulation, CorrectionEntry } from '../services/correctionPreview';
import type { AccountAudit } from '../services/ledgerAudit';
import type { ReEntryAccounts, ReEntryMove, OriginalAccounts } from '../services/reEntryPlan';
import type { LedgerRowRef } from '../services/ledgerQuery';

const router = Router();
router.use(authenticate);

const SOURCE_TABLES: Record<string, string> = {
  transaction: 'transactions',
  transfer: 'transfers',
  loading: 'loading_transactions',
  reconciliation: 'reconciliations',
};

const TABLES_WITH_UPDATED_AT = new Set(['transactions', 'transfers', 'loading_transactions']);

const ENTRY_COLUMNS =
  'le.account_id, le.id, le.entry_type, le.amount, le.balance_after, le.source_id, le.created_at';
const ACCOUNT_COLUMNS = 'a.id, a.name, a.status, a.opening_balance, a.current_balance';

function requireReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw createError(400, 'reason is required');
  return reason.trim();
}

// Postgres rejects a non-uuid literal with 22P02, which the error middleware
// surfaces as a 500 — bad input from a caller should never reach it as a fault.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw createError(400, `${field} must be a UUID`);
  return value;
}

function requireSource(sourceType: string, sourceId: string): string {
  const strategy = strategyFor(sourceType);
  if (!strategy) throw createError(400, `Unknown source type: ${sourceType}`);
  if (!strategy.addressable) {
    throw createError(400, 'Direct balance adjustments carry no source record to correct');
  }
  const table = SOURCE_TABLES[sourceType];
  if (!table) throw createError(400, `Unknown source type: ${sourceType}`);
  return table;
}

function pick(row: any, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c, row[c]]));
}

function observedShape(rows: LedgerRowRef[]) {
  return {
    rowCount: rows.length,
    accountIds: [...new Set(rows.map((r) => r.account_id))],
    entryTypes: [...new Set(rows.map((r) => r.entry_type))],
  };
}

// Correcting a record that is not completed would move money on behalf of a
// movement that never finished, or undo a reversal that already gave the money
// back. Only completed operator-entered records carry live ledger rows.
async function requireCompleted(sourceType: string, sourceId: string, table: string) {
  const record = await queryOne(`SELECT * FROM ${table} WHERE id = $1`, [sourceId]);
  if (!record) throw createError(404, `No ${sourceType} found with that id`);
  if (RE_ENTERABLE[sourceType] && record.status !== 'completed') {
    throw createError(409, `A ${sourceType} with status ${record.status} cannot be corrected`);
  }
  return record;
}

router.get('/audit', authorize('reports.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const scope = ownerClause(req, 'a', 'accounts.read_all', 1);
    const { accounts, entries } = await loadScopedLedger(scope);
    res.json({ success: true, data: auditLedger(accounts, entries) });
  } catch (error) { next(error); }
});

// ------------------------------------------------------------ gap fixes -----
// detect -> propose -> human approve -> guarded apply. Nothing in this block
// writes money on its own: the plan is recomputed from the ledger under FOR
// UPDATE at approval time, and the transaction commits only if the account
// reconciles afterwards.

const GAP_FIX_STATUS = new Set(['pending', 'approved', 'rejected']);

const GAP_FIX_LIST_SQL = `
  SELECT gf.id, gf.account_id, gf.direction, gf.observed_gap, gf.reason, gf.status,
         gf.proposed_by, gf.decided_by, gf.decision_reason, gf.applied_at,
         gf.created_at, gf.updated_at,
         a.name AS account_name, u.username AS proposed_by_username,
         d.username AS decided_by_username
  FROM gap_fixes gf
  JOIN accounts a ON a.id = gf.account_id
  JOIN users u ON u.id = gf.proposed_by
  LEFT JOIN users d ON d.id = gf.decided_by
  WHERE ($1::text IS NULL OR gf.status = $1)
  ORDER BY gf.created_at ASC`;

router.get('/gap-fixes', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = req.query.status;
    if (requested !== undefined && (typeof requested !== 'string' || !GAP_FIX_STATUS.has(requested))) {
      throw createError(400, `status must be one of ${[...GAP_FIX_STATUS].join(', ')}`);
    }
    const status = typeof requested === 'string' ? requested : null;
    const rows = await query(GAP_FIX_LIST_SQL, [status]);

    // An approver must read drift, not just what was written down: the proposal
    // only stands while the gap is still the amount it was recorded as.
    const accountIds = [...new Set(rows.map((r: any) => r.account_id))];
    const live = new Map<string, number>();
    if (accountIds.length > 0) {
      const { accounts, entries } = await loadAccountsAndEntries(accountIds);
      for (const account of auditLedger(accounts, entries).accounts) live.set(account.id, account.gap);
    }

    res.json({
      success: true,
      data: { data: rows.map((r: any) => ({ ...r, liveGap: live.get(r.account_id) ?? null })) },
    });
  } catch (error) { next(error); }
});

router.post('/gap-fixes', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const direction = req.body?.direction;
    const reason = requireReason(req.body?.reason);
    if (!req.body?.accountId) throw createError(400, 'accountId is required');
    const accountId = requireUuid(req.body.accountId, 'accountId');
    if (!isGapFixDirection(direction)) {
      throw createError(400, `direction must be one of ${GAP_FIX_DIRECTIONS.join(', ')}`);
    }

    const { accounts, entries } = await loadAccountsAndEntries([accountId]);
    if (accounts.length === 0) throw createError(404, 'Account not found');

    const audit = auditLedger(accounts, entries).accounts[0];
    const plan = planGapFix(audit, direction);
    if (plan.problems.length > 0) throw createError(409, `Cannot propose a gap fix: ${plan.problems.join('; ')}`);

    const fix = await queryOne(
      `INSERT INTO gap_fixes (account_id, direction, observed_gap, reason, proposed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [accountId, direction, plan.gap, reason, req.user!.userId]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'gap_fix.proposed',
      entity: 'gap_fix',
      entityId: fix!.id,
      ipAddress: req.ip,
      reason,
      newData: { accountName: audit.name, direction, observedGap: plan.gap, amount: plan.amount },
    });

    res.status(201).json({
      success: true,
      data: { fix, plan, belief: GAP_FIX_LABELS[direction], account: { id: audit.id, name: audit.name, audit } },
    });
  } catch (error) { next(error); }
});

router.post('/gap-fixes/:fixId/approve', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  if (!(req.user!.roles || []).includes('administrator')) {
    return next(createError(403, 'Only administrators can approve a gap fix'));
  }

  let started = false;
  const client = await getClient();
  try {
    const fixId = requireUuid(req.params.fixId, 'fixId');
    await client.query('BEGIN');
    started = true;

    const fix = (await client.query('SELECT * FROM gap_fixes WHERE id = $1 FOR UPDATE', [fixId])).rows[0];
    if (!fix) throw createError(404, 'Gap fix not found');
    if (fix.status !== 'pending') throw createError(409, `This gap fix was already ${fix.status}`);
    if (fix.proposed_by === req.user!.userId) {
      throw createError(403, 'You cannot approve your own gap fix proposal');
    }

    await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [fix.account_id]);

    const { accounts, entries } = await loadAccountsAndEntries([fix.account_id], client);
    const audit = auditLedger(accounts, entries).accounts[0];
    const plan = planGapFix(audit, fix.direction);
    if (plan.problems.length > 0) throw createError(409, `Cannot apply: ${plan.problems.join('; ')}`);

    const proposed = parseFloat(fix.observed_gap);
    if (plan.gap !== proposed) {
      throw createError(
        409,
        `The gap moved from ${proposed.toFixed(2)} to ${plan.gap.toFixed(2)} after this was proposed — ` +
          'reject it and propose again'
      );
    }

    if (fix.direction === 'record_entry') {
      // The balance already holds the money; only the ledger is behind, so
      // current_balance is left alone and the row lands on it.
      await client.query(
        `INSERT INTO ledger_entries (account_id, source_type, source_id, entry_type, amount, balance_after, description, entry_date)
         VALUES ($1, 'gap_fix', $2, $3, $4, $5, $6, NOW())`,
        [fix.account_id, fix.id, plan.entryType!, plan.amount, plan.balanceAfter!, `Gap fix: ${fix.reason}`]
      );
    } else {
      await client.query('UPDATE accounts SET current_balance = $1, updated_at = NOW() WHERE id = $2', [
        plan.newBalance!,
        fix.account_id,
      ]);
    }

    const verdict = await auditInside(client, [fix.account_id]);
    const after = verdict.accounts[0];
    if (!after.reconciled) {
      throw createError(409, `Refusing to commit — ${after.name} does not reconcile after the fix (${after.issues.join('; ')})`);
    }

    const updated = (
      await client.query(
        `UPDATE gap_fixes SET status = 'approved', decided_by = $1, applied_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND status = 'pending' RETURNING *`,
        [req.user!.userId, fix.id]
      )
    ).rows[0];
    if (!updated) throw createError(409, 'This gap fix was already processed');

    await client.query('COMMIT');
    started = false;

    await createAuditLog({
      userId: req.user!.userId,
      action: 'gap_fix.applied',
      entity: 'gap_fix',
      entityId: fix.id,
      ipAddress: req.ip,
      reason: fix.reason,
      oldData: { direction: fix.direction, gap: plan.gap, currentBalance: audit.currentBalance },
      newData: { gap: after.gap, currentBalance: after.currentBalance, expectedBalance: after.expectedBalance },
    });

    res.json({ success: true, data: { fix: updated, plan, before: audit, after } });
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.post('/gap-fixes/:fixId/reject', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  if (!(req.user!.roles || []).includes('administrator')) {
    return next(createError(403, 'Only administrators can reject a gap fix'));
  }

  try {
    const reason = requireReason(req.body?.reason);
    const fixId = requireUuid(req.params.fixId, 'fixId');
    const fix = await queryOne('SELECT * FROM gap_fixes WHERE id = $1', [fixId]);
    if (!fix) throw createError(404, 'Gap fix not found');
    if (fix.status !== 'pending') throw createError(409, `This gap fix was already ${fix.status}`);
    if (fix.proposed_by === req.user!.userId) {
      throw createError(403, 'You cannot reject your own gap fix proposal');
    }

    const updated = await queryOne(
      `UPDATE gap_fixes SET status = 'rejected', decided_by = $1, decision_reason = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user!.userId, reason, fix.id]
    );
    if (!updated) throw createError(409, 'This gap fix was already processed');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'gap_fix.rejected',
      entity: 'gap_fix',
      entityId: fix.id,
      ipAddress: req.ip,
      reason,
      oldData: { direction: fix.direction, observedGap: fix.observed_gap, proposedBy: fix.proposed_by },
      newData: { decisionReason: reason },
    });

    res.json({ success: true, data: updated });
  } catch (error) { next(error); }
});

router.post('/preview', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceType, sourceId, amounts } = req.body || {};
    if (!sourceType || !sourceId) throw createError(400, 'sourceType and sourceId are required');

    const table = requireSource(sourceType, sourceId);
    const exists = await queryOne(`SELECT 1 AS present FROM ${table} WHERE id = $1`, [sourceId]);
    if (!exists) throw createError(404, `No ${sourceType} found with that id`);

    const rows = await loadLedgerRowsBySource(sourceType, sourceId);
    const strategy = strategyFor(sourceType)!;
    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);

    const { accounts, entries } = await loadAccountsAndEntries(observed.accountIds);
    const before = auditLedger(accounts, entries);

    let simulation: Simulation | null = null;
    if (amounts !== undefined && amounts !== null) {
      if (!shape.ok) throw createError(409, `Cannot preview: ${shape.problems.join('; ')}`);
      simulation = simulateCorrection(accounts, entries, rows, amounts);
    }

    const safeToCorrect =
      shape.ok &&
      simulation !== null &&
      simulation.problems.length === 0 &&
      simulation.affectedAccountsAfter.every((a) => a.reconciled);

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        strategy,
        shape,
        ledgerRows: rows,
        before: before.accounts,
        simulation,
        safeToCorrect,
      },
    });
  } catch (error) { next(error); }
});

// Tier A: metadata only. No ledger row, no balance, nothing numeric — so it is
// a single guarded UPDATE with a whitelist deciding which columns are reachable.
router.patch('/:sourceType/:sourceId', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceType, sourceId } = req.params;
    const table = requireSource(sourceType, sourceId);
    if (!TIER_A_FIELDS[sourceType]) {
      throw createError(400, `No metadata fields are correctable for ${sourceType}`);
    }
    const reason = requireReason(req.body?.reason);

    const record = await requireCompleted(sourceType, sourceId, table);

    const { columns, values } = validateTierA(sourceType, req.body?.fields);
    const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
    if (TABLES_WITH_UPDATED_AT.has(table)) assignments.push('updated_at = NOW()');

    await query(
      `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $${values.length + 1}`,
      [...values, sourceId]
    );

    const updated = await queryOne(`SELECT * FROM ${table} WHERE id = $1`, [sourceId]);

    await createAuditLog({
      userId: req.user!.userId,
      action: `${sourceType}.metadata_corrected`,
      entity: sourceType,
      entityId: sourceId,
      ipAddress: req.ip,
      reason,
      oldData: pick(record, columns),
      newData: pick(updated, columns),
    });

    res.json({ success: true, data: { changed: pick(updated, columns) } });
  } catch (error) { next(error); }
});

// Tier B: an amount correction that moves money. One transaction per call, the
// affected accounts locked in id order so a two-sided correction cannot
// deadlock, and the result re-audited inside the transaction before COMMIT —
// the preview says it is safe, the gate checks it actually was.
router.post('/:sourceType/:sourceId/apply', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  const { sourceType, sourceId } = req.params;
  let started = false;
  const client = await getClient();

  try {
    const table = requireSource(sourceType, sourceId);
    const reason = requireReason(req.body?.reason);
    const amounts = req.body?.amounts;
    if (amounts === undefined || amounts === null) throw createError(400, 'amounts is required');

    const exists = await queryOne(`SELECT 1 AS present FROM ${table} WHERE id = $1`, [sourceId]);
    if (!exists) throw createError(404, `No ${sourceType} found with that id`);
    await requireCompleted(sourceType, sourceId, table);

    const strategy = strategyFor(sourceType)!;
    await client.query('BEGIN');
    started = true;

    const rows: LedgerRowRef[] = (await client.query(
      `SELECT le.id, le.account_id, le.entry_type, le.amount, le.balance_after, le.created_at
       FROM ledger_entries le
       WHERE le.source_type = $1 AND le.source_id = $2
       ORDER BY le.created_at, le.id`,
      [sourceType, sourceId]
    )).rows;

    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);
    if (!shape.ok) throw createError(409, `Cannot correct: ${shape.problems.join('; ')}`);

    const accountIds = observed.accountIds;
    await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [accountIds]);

    const { accounts, entries } = await loadAccountsAndEntries(accountIds, client);
    const simulation = simulateCorrection(accounts, entries, rows, amounts);

    if (simulation.problems.length > 0) {
      throw createError(409, `Refusing to correct: ${simulation.problems.join('; ')}`);
    }
    if (simulation.corrections.length === 0) {
      throw createError(400, 'Those amounts do not change anything');
    }
    if (!simulation.affectedAccountsAfter.every((a) => a.reconciled)) {
      const bad = simulation.affectedAccountsAfter.filter((a) => !a.reconciled).map((a) => a.name);
      throw createError(409, `Refusing to correct — ${bad.join(', ')} would not reconcile`);
    }

    for (const correction of simulation.corrections) {
      const newBalance = await updateAccountBalance(
        correction.accountId, correction.amount, correction.entryType, client
      );
      await client.query(
        `INSERT INTO ledger_entries
           (account_id, transaction_id, transfer_id, source_type, source_id,
            entry_type, amount, balance_after, reference_number, description, entry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NOW())`,
        [
          correction.accountId,
          sourceType === 'transaction' ? sourceId : null,
          sourceType === 'transfer' ? sourceId : null,
          sourceType,
          sourceId,
          correction.entryType,
          correction.amount,
          newBalance,
          `Correction: ${reason}`,
        ]
      );
    }

    const verdict = await auditInside(client, accountIds);
    if (!verdict.accounts.every((a) => a.reconciled)) {
      const bad = verdict.accounts.filter((a) => !a.reconciled).map((a) => `${a.name} (gap ${a.gap})`);
      throw createError(409, `Refusing to commit — ${bad.join(', ')} did not reconcile after correction`);
    }

    await client.query('COMMIT');
    started = false;

    await createAuditLog({
      userId: req.user!.userId,
      action: `${sourceType}.amount_corrected`,
      entity: sourceType,
      entityId: sourceId,
      ipAddress: req.ip,
      reason,
      oldData: { amounts: simulation.changes.map((c) => ({ ledgerId: c.ledgerId, amount: c.fromAmount })) },
      newData: { amounts: simulation.changes.map((c) => ({ ledgerId: c.ledgerId, amount: c.toAmount })) },
    });

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        applied: simulation.corrections,
        balances: simulation.balances,
        after: verdict.accounts,
      },
    });
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// Phase 4 — correct and re-enter.
//
// A record that sat on the wrong account cannot be fixed by appending a
// correction: its rows are on the wrong account, and moving account_id in place
// would both rewrite completed history and leave one record owning ledger rows
// on accounts it no longer claims. So the original is reversed (status change
// plus an opposite-sign row, exactly what the reversal flow does) and a clone
// of it is written onto the corrected accounts — the original keeps its whole
// past, the clone owns nothing but the new accounts, and verifyShape still
// holds for both afterwards.
//
// Everything lands in one transaction: clone, reversal rows, replacement rows,
// and a re-audit before COMMIT. If the replacement cannot be written — the
// account it moves onto will not reconcile, or the account it leaves no longer
// has the money — the reversal rolls back with it, so money is never
// half-moved.
const CLONE_SQL: Record<string, { sql: string; numberColumn: string }> = {
  transaction: {
    numberColumn: 'transaction_number',
    sql: `INSERT INTO transactions (
            id, transaction_number, account_id, transaction_type_id, transaction_category_id,
            amount, fee, net_amount, reference_number, external_reference, transaction_date,
            description, customer_name, customer_contact, status, created_by,
            fee_added_to_balance, additional_charges, notes, customer_id, payment_method
          )
          SELECT $1, nextval('transactions_transaction_number_seq'), $2, t.transaction_type_id, t.transaction_category_id,
            t.amount, t.fee, t.net_amount, t.reference_number, t.external_reference, t.transaction_date,
            t.description, t.customer_name, t.customer_contact, 'completed', $3,
            t.fee_added_to_balance, t.additional_charges, t.notes, t.customer_id, t.payment_method
          FROM transactions t
          WHERE t.id = $4
          RETURNING id, transaction_number`,
  },
  loading: {
    numberColumn: 'transaction_number',
    sql: `INSERT INTO loading_transactions (
            id, transaction_number, account_id, product_id, customer_number, quantity,
            unit_cost, unit_price, total_cost, total_revenue, profit,
            provider_convenience_fee, company_additional_charge,
            payment_method, reference_number, status, notes, created_by, created_at
          )
          SELECT $1, nextval('loading_transactions_transaction_number_seq'), $2, l.product_id, l.customer_number, l.quantity,
            l.unit_cost, l.unit_price, l.total_cost, l.total_revenue, l.profit,
            l.provider_convenience_fee, l.company_additional_charge,
            l.payment_method, l.reference_number, 'completed', l.notes, $3, l.created_at
          FROM loading_transactions l
          WHERE l.id = $4
          RETURNING id, transaction_number`,
  },
  transfer: {
    numberColumn: 'transfer_number',
    // external_reference is copied because it names the counterparty's record
    // of the same real-world event; transfer_reference is not, because a
    // re-entry is a new transfer and needs its own identity ($6/$7, minted by
    // the caller from the sequence value it also supplies).
    sql: `INSERT INTO transfers (
            id, transfer_number, source_account_id, destination_account_id,
            transfer_amount, transfer_fee, total_source_deduction, destination_amount,
            transfer_reference, external_reference, purpose, status, transfer_date,
            created_by, completed_at, notes, attachment_path, fee_deducted_from_amount
          )
          SELECT $1, $6, $2, $3,
            t.transfer_amount, t.transfer_fee, t.total_source_deduction, t.destination_amount,
            $7, t.external_reference, t.purpose, 'completed', t.transfer_date,
            $4, NOW(), t.notes, t.attachment_path, t.fee_deducted_from_amount
          FROM transfers t
          WHERE t.id = $5
          RETURNING id, transfer_number`,
  },
};

function cloneParams(sourceType: string, newRecordId: string, moves: ReEntryMove[], userId: string, sourceId: string, minted?: MintedTransfer): unknown[] {
  if (sourceType === 'transfer') {
    const source = moves.find((m) => m.role === 'source');
    const destination = moves.find((m) => m.role === 'destination');
    if (!source || !destination) throw createError(409, 'the re-entry plan is missing an account');
    if (!minted) throw createError(500, 'transfer re-entry is missing a minted reference');
    return [newRecordId, source.to, destination.to, userId, sourceId, minted.number, minted.reference];
  }
  const single = moves.find((m) => m.role === 'account');
  if (!single) throw createError(409, 'the re-entry plan is missing an account');
  return [newRecordId, single.to, userId, sourceId];
}

async function mintNextTransfer(client: any): Promise<MintedTransfer> {
  const row = (await client.query("SELECT nextval('transfers_transfer_number_seq') AS value")).rows[0];
  const number = Number(row.value);
  return { number, reference: mintTransferReference(number) };
}

// The planner reasons about accounts by role; the row it is handed comes
// straight out of Postgres, so the snake_case columns are translated here once
// rather than at every call site.
function originalAccounts(sourceType: string, record: any): OriginalAccounts {
  if (sourceType === 'transfer') {
    return {
      sourceAccountId: record.source_account_id,
      destinationAccountId: record.destination_account_id,
    };
  }
  return { accountId: record.account_id };
}

router.post('/re-enter/preview', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceType, sourceId, accounts } = req.body || {};
    if (!sourceType || !sourceId) throw createError(400, 'sourceType and sourceId are required');
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
      throw createError(400, 'accounts is required');
    }

    const table = requireSource(sourceType, sourceId);
    if (!RE_ENTERABLE[sourceType]) throw createError(400, `${sourceType} records cannot be re-entered`);

    const original = await requireCompleted(sourceType, sourceId, table);
    const rows = await loadLedgerRowsBySource(sourceType, sourceId);
    const strategy = strategyFor(sourceType)!;
    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);

    let before: AccountAudit[] = [];
    let moves: ReEntryMove[] | null = null;
    let simulation: { corrections: CorrectionEntry[]; problems: string[]; after: AccountAudit[] } | null = null;

    if (shape.ok) {
      const plan = planReEntry(sourceType, rows, originalAccounts(sourceType, original), accounts as ReEntryAccounts, sourceId, randomUUID());
      moves = plan.moves;

      const involved = [...new Set([...observed.accountIds, ...plan.newAccountIds])];
      const { accounts: live, entries } = await loadAccountsAndEntries(involved);
      before = auditLedger(live, entries).accounts;

      const appended = appendPlannedRows(live, entries, plan.planned);
      const after = auditLedger(appended.simulatedAccounts, appended.simulatedEntries);
      simulation = { corrections: appended.corrections, problems: appended.problems, after: after.accounts };
    } else if (observed.accountIds.length > 0) {
      const { accounts: live, entries } = await loadAccountsAndEntries(observed.accountIds);
      before = auditLedger(live, entries).accounts;
    }

    const safeToReEnter =
      shape.ok &&
      simulation !== null &&
      simulation.problems.length === 0 &&
      simulation.after.every((a) => a.reconciled);

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        strategy,
        shape,
        ledgerRows: rows,
        moves,
        before,
        simulation,
        safeToReEnter,
      },
    });
  } catch (error) { next(error); }
});

router.post('/:sourceType/:sourceId/re-enter', authorize('transactions.correct'), async (req: Request, res: Response, next: NextFunction) => {
  const { sourceType, sourceId } = req.params;
  let started = false;
  const client = await getClient();

  try {
    const table = requireSource(sourceType, sourceId);
    const clone = CLONE_SQL[sourceType];
    if (!clone) throw createError(400, `${sourceType} records cannot be re-entered`);
    const reason = requireReason(req.body?.reason);
    const requested = req.body?.accounts;
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw createError(400, 'accounts is required');
    }

    const original = await requireCompleted(sourceType, sourceId, table);
    const newRecordId = randomUUID();

    await client.query('BEGIN');
    started = true;

    const rows: LedgerRowRef[] = (await client.query(
      `SELECT le.id, le.account_id, le.entry_type, le.amount, le.balance_after, le.created_at
       FROM ledger_entries le
       WHERE le.source_type = $1 AND le.source_id = $2
       ORDER BY le.created_at, le.id`,
      [sourceType, sourceId]
    )).rows;

    const strategy = strategyFor(sourceType)!;
    const observed = observedShape(rows);
    const shape = verifyShape(strategy, observed);
    if (!shape.ok) throw createError(409, `Cannot re-enter: ${shape.problems.join('; ')}`);

    const plan = planReEntry(sourceType, rows, originalAccounts(sourceType, original), requested as ReEntryAccounts, sourceId, newRecordId);

    const involved = [...new Set([...observed.accountIds, ...plan.newAccountIds])];
    await client.query('SELECT id FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE', [involved]);

    const { accounts, entries } = await loadAccountsAndEntries(involved, client);
    const appended = appendPlannedRows(accounts, entries, plan.planned);

    if (appended.problems.length > 0) {
      throw createError(409, `Refusing to re-enter: ${appended.problems.join('; ')}`);
    }
    const proposed = auditLedger(appended.simulatedAccounts, appended.simulatedEntries);
    if (!proposed.accounts.every((a) => a.reconciled)) {
      const bad = proposed.accounts.filter((a) => !a.reconciled).map((a) => a.name);
      throw createError(409, `Refusing to re-enter — ${bad.join(', ')} would not reconcile`);
    }

    const minted = sourceType === 'transfer' ? await mintNextTransfer(client) : undefined;

    const cloneRow = (
      await client.query(clone.sql, cloneParams(sourceType, newRecordId, plan.moves, req.user!.userId, sourceId, minted))
    ).rows[0];
    if (!cloneRow) throw createError(404, `No ${sourceType} found with that id`);

    await client.query(
      `UPDATE ${table} SET status = 'reversed', updated_at = NOW() WHERE id = $1`,
      [sourceId]
    );

    // Rows are written in the order the simulation committed to: that order is
    // what produced the balance_after values the gate just approved.
    for (const row of appended.applied) {
      const newBalance = await updateAccountBalance(row.accountId, row.amount, row.entryType, client);
      const inserted = await client.query(
        `INSERT INTO ledger_entries
           (account_id, transaction_id, transfer_id, source_type, source_id,
            entry_type, amount, balance_after, reference_number, description, entry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NOW())
         RETURNING id`,
        [
          row.accountId,
          sourceType === 'transaction' ? row.sourceId : null,
          sourceType === 'transfer' ? row.sourceId : null,
          sourceType,
          row.sourceId,
          row.entryType,
          row.amount,
          newBalance,
          row.sourceId === newRecordId ? `Re-entered: ${reason}` : `Reversal: ${reason}`,
        ]
      );

      if (sourceType === 'transfer' && row.sourceId === newRecordId) {
        await client.query(
          `INSERT INTO transfer_entries
             (transfer_id, account_id, entry_type, entry_category, amount, balance_after, ledger_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            newRecordId,
            row.accountId,
            row.entryType,
            row.entryType === 'debit' ? 'transfer_out' : 'transfer_in',
            row.amount,
            newBalance,
            inserted.rows[0].id,
          ]
        );
      }
    }

    const verdict = await auditInside(client, involved);
    if (!verdict.accounts.every((a) => a.reconciled)) {
      const bad = verdict.accounts.filter((a) => !a.reconciled).map((a) => `${a.name} (gap ${a.gap})`);
      throw createError(409, `Refusing to commit — ${bad.join(', ')} did not reconcile after re-entry`);
    }

    await client.query('COMMIT');
    started = false;

    await createAuditLog({
      userId: req.user!.userId,
      action: `${sourceType}.re_entered`,
      entity: sourceType,
      entityId: sourceId,
      ipAddress: req.ip,
      reason,
      oldData: { status: original.status, moves: plan.moves },
      newData: { newRecordId, newRecordNumber: cloneRow[clone.numberColumn], moves: plan.moves },
    });

    res.json({
      success: true,
      data: {
        source: { type: sourceType, id: sourceId },
        newRecord: { id: cloneRow.id, number: cloneRow[clone.numberColumn] },
        moves: plan.moves,
        applied: appended.corrections,
        balances: accounts.map((a) => {
          const after = appended.simulatedAccounts.find((s) => s.id === a.id)!;
          return {
            accountId: a.id,
            before: parseFloat(String(a.current_balance)),
            after: parseFloat(String(after.current_balance)),
          };
        }),
        after: verdict.accounts,
      },
    });
  } catch (error) {
    if (started) await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

const ACCOUNTS_SQL = `SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ANY($1) ORDER BY a.name, a.id`;
const ACCOUNT_ENTRIES_SQL = `SELECT ${ENTRY_COLUMNS} FROM ledger_entries le WHERE le.account_id = ANY($1) ORDER BY le.created_at, le.id`;

interface LoadedLedger {
  accounts: any[];
  entries: any[];
}

// Reads through the transaction client when one is supplied, so the gate checks
// the same uncommitted state the correction is about to write.
async function loadAccountsAndEntries(accountIds: string[], client?: any): Promise<LoadedLedger> {
  if (accountIds.length === 0) return { accounts: [], entries: [] };

  if (client) {
    const accounts = await client.query(ACCOUNTS_SQL, [accountIds]);
    const entries = await client.query(ACCOUNT_ENTRIES_SQL, [accountIds]);
    return { accounts: accounts.rows, entries: entries.rows };
  }

  const accounts = await query(ACCOUNTS_SQL, [accountIds]);
  const entries = await query(ACCOUNT_ENTRIES_SQL, [accountIds]);
  return { accounts, entries };
}

async function auditInside(client: any, accountIds: string[]) {
  const { accounts, entries } = await loadAccountsAndEntries(accountIds, client);
  return auditLedger(accounts, entries);
}

export default router;
