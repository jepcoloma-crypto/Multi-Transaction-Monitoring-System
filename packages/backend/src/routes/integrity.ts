import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { branchClause } from '../middleware/scope';
import {
  runIntegrityChecks,
  type TillIncomeRow,
  type FeePlacementRow,
  type NetAmountRow,
} from '../services/integrityChecks';
import { sumCharges } from '../services/amountFields';

// Integrity checks (design IC1–IC6). Read-only, and deliberately so: a finding
// says two surfaces disagree and cannot say which one is wrong, so this module
// never corrects anything. Where a known fixer applies, the finding links to it
// and an administrator confirms the correction in the tool that already owns it.
//
// Gated on `reconciliation.read`, which the auditor and administrator roles both
// hold — so no permission is added, and the role that can see every finding
// cannot move a peso. The checks are bounded and take no locks, so an auditor can
// run them mid-shift.
//
// Scope follows the app's rule: branch filtering happens in the query layer via
// `branchClause`, the same way the ledger audit reads. An auditor without
// `accounts.read_all` sees their own branch.

const router = Router();
router.use(authenticate);

// A movement's fee is marked by the row's own `role` (migration 048), not by
// matching its description. Both a fee row and a line that re-posted one carry
// the fee's money into the till, so `correction` counts beside `fee` — a
// re-posted fee arrives as a correction line, and counting only fee rows would
// report a permanent false gap for exactly the rows that were fixed (IC5).
//
// `role` was not always a column. Rows written before migration 048, and any
// written between the migration and the code that fills it, carry NULL — and a
// `role`-only predicate would silently skip them, which for a check is the
// worst possible failure: it reads as a pass. Check 4 names every such row, and
// the description stays here as the read of a row nobody has labelled yet.
const FEE_ROW_PREDICATE = `(
  CASE WHEN le.role IS NOT NULL
       THEN le.role IN ('fee', 'correction')
       ELSE le.description = 'Service fee'
         OR le.description LIKE 'Service fee %'
         OR le.description LIKE 'Fee correction%'
  END)`;

const num = (v: unknown): number => (v == null ? 0 : Math.round(parseFloat(String(v)) * 100) / 100);
const str = (v: unknown): string | null => (v == null ? null : String(v));

router.get('/run', authorize('reconciliation.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Branch scoping happens in the query layer, as everywhere else (IC4): an
    // auditor without `accounts.read_all` sees their own branch, by the same
    // rule the ledger audit reads by. The checks judge the rows the caller may
    // see and no others.
    const scope = branchClause(req, 'a', 'accounts.read_all', 1, 'self');

    const rows: any[] = await query(
      `WITH cash AS (
         SELECT a.id FROM accounts a
           JOIN account_types ct ON ct.id = a.account_type_id
          WHERE ct.name = 'Cash'
       ),
       primary_rows AS (
         SELECT le.transaction_id,
                SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END) AS net,
                COUNT(*) AS row_count
           FROM ledger_entries le
           JOIN transactions t ON t.id = le.transaction_id AND le.account_id = t.account_id
          GROUP BY 1
       ),
       drawer_rows AS (
         SELECT le.transaction_id,
                SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END) AS net,
                COUNT(*) AS row_count
           FROM ledger_entries le
           JOIN transactions t ON t.id = le.transaction_id
          WHERE le.account_id IN (SELECT id FROM cash)
            AND le.account_id <> t.account_id
          GROUP BY 1
       ),
       primary_fee AS (
         SELECT le.transaction_id,
                SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END) AS fee_net
           FROM ledger_entries le
           JOIN transactions t ON t.id = le.transaction_id AND le.account_id = t.account_id
          WHERE ${FEE_ROW_PREDICATE}
          GROUP BY 1
       ),
       drawer_fee AS (
         SELECT le.transaction_id,
                SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END) AS fee_net
           FROM ledger_entries le
           JOIN transactions t ON t.id = le.transaction_id
          WHERE le.account_id IN (SELECT id FROM cash)
            AND le.account_id <> t.account_id
            AND ${FEE_ROW_PREDICATE}
          GROUP BY 1
       )
       SELECT t.transaction_number, t.reference_number, t.amount, t.fee, t.net_amount,
              CASE WHEN jsonb_typeof(t.additional_charges) = 'array'
                   THEN t.additional_charges ELSE '[]'::jsonb END AS additional_charges,
              t.fee_added_to_balance, t.status, tt.direction,
              COALESCE(pr.net, 0)        AS account_net,
              COALESCE(pr.row_count, 0)  AS account_rows,
              COALESCE(dr.net, 0)        AS drawer_net,
              COALESCE(dr.row_count, 0)  AS drawer_rows,
              COALESCE(pf.fee_net, 0)    AS account_fee_net,
              COALESCE(df.fee_net, 0)    AS drawer_fee_net
         FROM transactions t
         JOIN transaction_types tt ON tt.id = t.transaction_type_id
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN primary_rows pr ON pr.transaction_id = t.id
         LEFT JOIN drawer_rows dr ON dr.transaction_id = t.id
         LEFT JOIN primary_fee pf ON pf.transaction_id = t.id
         LEFT JOIN drawer_fee df ON df.transaction_id = t.id
        ${scope.clause ? `WHERE ${scope.clause}` : ''}
        ORDER BY t.transaction_number`,
      scope.params
    );

    const tillRows: TillIncomeRow[] = rows.map((r) => ({
      transactionNumber: Number(r.transaction_number),
      referenceNumber: str(r.reference_number),
      direction: String(r.direction),
      amount: num(r.amount),
      fee: num(r.fee),
      feeAddedToBalance: r.fee_added_to_balance !== false,
      status: String(r.status),
      drawerFeeNet: num(r.drawer_fee_net),
      hasDrawerRows: Number(r.drawer_rows) > 0,
    }));

    const placementRows: FeePlacementRow[] = rows.map((r) => ({
      transactionNumber: Number(r.transaction_number),
      referenceNumber: str(r.reference_number),
      direction: String(r.direction),
      amount: num(r.amount),
      fee: num(r.fee),
      feeAddedToBalance: r.fee_added_to_balance !== false,
      status: String(r.status),
      accountFeeNet: num(r.account_fee_net),
      drawerFeeNet: num(r.drawer_fee_net),
    }));

    const netRows: NetAmountRow[] = rows.map((r) => ({
      transactionNumber: Number(r.transaction_number),
      referenceNumber: str(r.reference_number),
      direction: String(r.direction),
      amount: num(r.amount),
      fee: num(r.fee),
      netAmount: num(r.net_amount),
      // The column above is already guarded to an array, so this cannot throw;
      // it is the same summation creation and every reversal path use.
      additionalCharges: sumCharges(r.additional_charges),
      status: String(r.status),
      accountNet: num(r.account_net),
      hasAccountRows: Number(r.account_rows) > 0,
    }));

    const checks = runIntegrityChecks(tillRows, placementRows, netRows);

    res.json({
      success: true,
      data: {
        checks,
        ranAt: new Date().toISOString(),
        movements: rows.length,
        clean: checks.every((c) => c.status === 'pass'),
      },
    });
  } catch (error) { next(error); }
});

export default router;
