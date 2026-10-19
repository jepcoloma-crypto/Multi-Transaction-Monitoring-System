import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { createError } from '../middleware/error';

// What happened to one movement, assembled (design IC3's other half).
//
// Append-only corrections are only worth as much as they are readable. The
// ledger keeps every row it ever wrote and `audit_logs` records who acted and
// why, but nothing joined them: answering "what happened to txn 3, and who
// authorised it?" meant running three queries and reading prefixes by hand. The
// ₱20 of 2026-10-19 was found by people doing exactly that.
//
// This reads only. It is gated on `reconciliation.read` rather than
// `transactions.correct` because reading a history is the auditor's job and
// moving money is not — the same split the Integrity page draws. Every
// correction path stays where it was, administrator-gated.
//
// Rows are labelled by `role` (migration 048), not by matching a description.
// The description is returned as well, but as the human sentence it is rather
// than as the thing that identifies a row.

const router = Router();
router.use(authenticate);

const num = (v: unknown): number => (v == null ? 0 : Math.round(parseFloat(String(v)) * 100) / 100);
const str = (v: unknown): string | null => (v == null ? null : String(v));

router.get(
  '/movements/:transactionId/history',
  authorize('reconciliation.read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transactionId = String(req.params.transactionId);

      const tx = await queryOne<any>(
        `SELECT t.id, t.transaction_number, t.reference_number, t.amount, t.fee, t.net_amount,
                t.fee_added_to_balance, t.status, t.payment_method, t.description,
                t.transaction_date, t.created_at AS entered_at,
                tt.name AS type_name, tt.direction,
                a.name AS account_name, a.id AS account_id
           FROM transactions t
           JOIN transaction_types tt ON tt.id = t.transaction_type_id
           JOIN accounts a ON a.id = t.account_id
          WHERE t.id = $1`,
        [transactionId],
      );

      // 404 rather than 403 for a movement outside what the caller may see, so
      // the response cannot be used to prove a record exists elsewhere.
      if (!tx) throw createError(404, 'Movement not found');

      // Every row this movement ever wrote, both sides, in the order they were
      // written — the order the statement's running balance reads.
      const rows = await query<any>(
        `SELECT le.id, le.entry_type, le.amount, le.balance_after, le.description,
                le.role, le.created_at, le.source_type,
                a.name AS account_name, a.id AS account_id
           FROM ledger_entries le
           JOIN accounts a ON a.id = le.account_id
          WHERE le.transaction_id = $1
          ORDER BY le.created_at, le.id`,
        [transactionId],
      );

      // Who acted on this record, and why. `old_data`/`new_data` are returned as
      // recorded: they are the before and after of the record's own columns, and
      // an amount correction is otherwise invisible from the rows alone.
      const trail = await query<any>(
        `SELECT al.id, al.action, al.reason, al.created_at, al.old_data, al.new_data,
                u.username
           FROM audit_logs al
           LEFT JOIN users u ON u.id = al.user_id
          WHERE al.entity = 'transaction' AND al.entity_id = $1
          ORDER BY al.created_at, al.id`,
        [transactionId],
      );

      res.json({
        success: true,
        data: {
          transaction: {
            id: tx.id,
            transactionNumber: Number(tx.transaction_number),
            referenceNumber: str(tx.reference_number),
            amount: num(tx.amount),
            fee: num(tx.fee),
            netAmount: num(tx.net_amount),
            // A NULL flag predates D46 and reads as "collected on top", the same
            // way every other reader in the system treats it.
            feeAddedToBalance: tx.fee_added_to_balance !== false,
            status: String(tx.status),
            paymentMethod: str(tx.payment_method),
            description: str(tx.description),
            direction: str(tx.direction),
            typeName: str(tx.type_name),
            accountName: str(tx.account_name),
            transactionDate: tx.transaction_date,
            enteredAt: tx.entered_at,
          },
          rows: rows.map((r) => ({
            id: r.id,
            entryType: String(r.entry_type),
            amount: num(r.amount),
            balanceAfter: num(r.balance_after),
            description: str(r.description),
            role: str(r.role),
            accountName: str(r.account_name),
            accountId: r.account_id,
            createdAt: r.created_at,
          })),
          trail: trail.map((e) => ({
            id: e.id,
            action: String(e.action),
            username: str(e.username),
            reason: str(e.reason),
            createdAt: e.created_at,
            changed: changedColumns(e.old_data, e.new_data),
          })),
          // A count rather than the rows themselves: the question a reader asks
          // first is "has this been touched?", and the answer should not require
          // scanning the list.
          corrections: rows.filter((r) => r.role === 'correction' || r.role === 'reversal').length,
          touched: trail.some((e) => e.action !== 'transaction.created'),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * The record columns an audit entry actually changed.
 *
 * `old_data` and `new_data` carry the whole row, so without this a reader is
 * asked to diff two blobs by eye to find the one figure that moved.
 */
function changedColumns(
  oldData: unknown,
  newData: unknown,
): { column: string; from: unknown; to: unknown }[] {
  const before = (oldData ?? {}) as Record<string, unknown>;
  const after = (newData ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: { column: string; from: unknown; to: unknown }[] = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      out.push({ column: key, from: a ?? null, to: b ?? null });
    }
  }
  return out;
}

export default router;
