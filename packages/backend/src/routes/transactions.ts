import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { branchClause, assertBranch } from '../middleware/scope';
import { assertOpenShift } from '../middleware/shiftGate';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { processTransaction, updateAccountBalance, createLedgerEntry, lockAccounts } from '../services/balance';
import type { CounterpartyLeg } from '../services/balance';
import { drawerLeg, drawerLegs, unwindDrawerLeg, chargeDrawerLeg, resolveCashAccountMethod } from '../services/cashManagement';
import type { RecordedLedgerRow } from '../services/cashManagement';
import { validateMovementInputs, movementRefusals, paymentPlan, fundingProblem, netAmountOf } from '../services/movementPlan';
import { resolveMovementFee } from '../services/movementFee';
import { parseManilaDateTime, manilaDateKey } from '../services/manilaTime';
import { expenseApprovalThreshold } from '../services/settings';
import { assertReferenceIsNew } from '../services/referenceRule';
import { withTransaction } from '../services/withTransaction';
import { movementTotalOf, planLoadingCancel, planTransactionCancel } from '../services/cancelPlan';
import { executeLoadingCancel } from '../services/loadingReversal';
import { auditInside, closedAccountNames } from '../services/ledgerGates';
import { PaginatedResponse } from '../types';

const router = Router();

router.use(authenticate);

router.get('/', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;
    const accountId = req.query.accountId as string;
    const typeId = req.query.typeId as string;
    const status = req.query.status as string;
    // Fee handling (D42): 'added' = the fee rode on top of the amount,
    // 'deducted' = it was inside the amount the customer sent. Anything else
    // is refused rather than quietly returning every row.
    const feeMode = req.query.feeMode as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const search = req.query.search as string;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (accountId) { conditions.push(`t.account_id = $${paramIndex++}`); params.push(accountId); }
    if (typeId) { conditions.push(`t.transaction_type_id = $${paramIndex++}`); params.push(typeId); }
    if (status) { conditions.push(`t.status = $${paramIndex++}`); params.push(status); }
    if (startDate) { conditions.push(`t.transaction_date >= $${paramIndex++}`); params.push(startDate); }
    if (endDate) { conditions.push(`t.transaction_date < ($${paramIndex++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (req.query.minAmount) { conditions.push(`t.amount >= $${paramIndex++}`); params.push(parseFloat(req.query.minAmount as string)); }
    if (req.query.maxAmount) { conditions.push(`t.amount <= $${paramIndex++}`); params.push(parseFloat(req.query.maxAmount as string)); }
    if (feeMode) {
      if (feeMode !== 'added' && feeMode !== 'deducted') {
        throw createError(400, "feeMode must be 'added' or 'deducted'");
      }
      // A row with no fee has no handling to speak of — the column itself
      // shows a dash there — so each option matches only rows that carry one,
      // exactly the rows the Fee Handling badge names.
      conditions.push(`t.fee_added_to_balance = $${paramIndex++} AND t.fee > 0`);
      params.push(feeMode === 'added');
    }
    if (search) {
      conditions.push(`(t.reference_number ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex} OR t.customer_name ILIKE $${paramIndex} OR CAST(t.transaction_number AS TEXT) ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    const scope = branchClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM transactions t ${whereClause}`,
      params
    );

    const transactions = await query(
      `SELECT t.*, tt.name as type_name, tt.code as type_code, tt.direction,
              tc.name as category_name, a.name as account_name,
              u1.username as created_by_username, u2.email as approved_by_email
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN users u1 ON t.created_by = u1.id
       LEFT JOIN users u2 ON t.approved_by = u2.id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const response: PaginatedResponse<any> = {
      data: transactions,
      pagination: {
        page, limit,
        total: parseInt(countResult?.count || '0'),
        totalPages: Math.ceil(parseInt(countResult?.count || '0') / limit),
      },
    };

    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const accountId = req.query.accountId as string;

    const conditions: string[] = ["t.status = 'completed'"];
    const params: any[] = [];
    let paramIndex = 1;

    if (startDate) { conditions.push(`t.transaction_date >= $${paramIndex++}`); params.push(startDate); }
    if (endDate) { conditions.push(`t.transaction_date < ($${paramIndex++}::date + INTERVAL '1 day')`); params.push(endDate); }
    if (accountId) { conditions.push(`t.account_id = $${paramIndex++}`); params.push(accountId); }
    const scope = branchClause(req, 't', 'transactions.read_all', paramIndex);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
      paramIndex = scope.paramIndex;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const summary = await queryOne(
      `SELECT
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_money_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_money_out,
        COALESCE(SUM(COALESCE(t.fee, 0)), 0) as total_fees,
        COUNT(*) as transaction_count
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${whereClause}`,
      params
    );

    const byType = await query(
      `SELECT tt.name as type_name, tt.direction, COUNT(*) as count, COALESCE(SUM(t.amount + chg.total), 0) as total_amount
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${whereClause}
       GROUP BY tt.id, tt.name, tt.direction
       ORDER BY total_amount DESC`,
      params
    );

    res.json({
      success: true,
      data: {
        summary: {
          totalMoneyIn: parseFloat(summary?.total_money_in || '0'),
          totalMoneyOut: parseFloat(summary?.total_money_out || '0'),
          totalFees: parseFloat(summary?.total_fees || '0'),
          transactionCount: parseInt(summary?.transaction_count || '0'),
          netMovement: parseFloat(summary?.total_money_in || '0') - parseFloat(summary?.total_money_out || '0'),
        },
        byType,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/today', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Manila's day, stated the same way the query below states it. One side a
    // UTC slice and the other Manila would disagree for eight hours every night.
    const today = manilaDateKey();
    const scope = branchClause(req, 't', 'transactions.read_all', 2);
    const todayWhere =
      `WHERE (t.transaction_date AT TIME ZONE 'Asia/Manila')::date = $1${scope.clause ? ` AND ${scope.clause}` : ''}`;
    const todayParams: any[] = [today, ...scope.params];
    const summary = await queryOne(
      `SELECT
        COUNT(*) as transaction_count,
        COALESCE(SUM(CASE WHEN t.status = 'completed' AND tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as money_in,
        COALESCE(SUM(CASE WHEN t.status = 'completed' AND tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as money_out,
        COALESCE(SUM(CASE WHEN t.status = 'completed' THEN COALESCE(t.fee, 0) ELSE 0 END), 0) as fees_collected,
        COUNT(CASE WHEN t.status = 'completed' THEN 1 END) as completed_count,
        COUNT(CASE WHEN t.status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN t.status = 'reversed' THEN 1 END) as reversed_count
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${todayWhere}`,
      todayParams
    );

    res.json({
      success: true,
      data: {
        today: {
          transactionCount: parseInt(summary?.transaction_count || '0'),
          moneyIn: parseFloat(summary?.money_in || '0'),
          moneyOut: parseFloat(summary?.money_out || '0'),
          feesCollected: parseFloat(summary?.fees_collected || '0'),
          completedCount: parseInt(summary?.completed_count || '0'),
          pendingCount: parseInt(summary?.pending_count || '0'),
          reversedCount: parseInt(summary?.reversed_count || '0'),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/by-customer-name', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.query.name as string;
    if (!name) throw createError(400, 'Customer name is required');

    const scope = branchClause(req, 't', 'transactions.read_all', 2);
    const nameParams: any[] = [`%${name}%`, ...scope.params];
    const nameSummaryParams: any[] = [`%${name}%`, ...scope.params];
    const listWhere = `WHERE t.customer_name ILIKE $1${scope.clause ? ` AND ${scope.clause}` : ''}`;
    const summaryWhere = `WHERE t.customer_name ILIKE $1 AND t.status = 'completed'${scope.clause ? ` AND ${scope.clause}` : ''}`;

    const transactions = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.transaction_date, t.status,
              t.reference_number, t.description, t.additional_charges, t.customer_name, t.customer_id,
              tt.name as type_name, tt.code as type_code, tt.direction, a.name as account_name
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       ${listWhere}
       ORDER BY t.created_at DESC`,
      nameParams
    );

    const summary = await queryOne(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(CASE WHEN tt.direction = 'in' THEN t.amount + chg.total ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN tt.direction = 'out' THEN t.amount + chg.total ELSE 0 END), 0) as total_out,
        COALESCE(SUM(COALESCE(t.fee, 0)), 0) as total_fees
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN (c->>'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c->>'amount')::numeric END), 0) AS total
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.additional_charges) = 'array' THEN t.additional_charges ELSE '[]'::jsonb END
         ) c
       ) chg ON true
       ${summaryWhere}`,
      nameSummaryParams
    );

    res.json({
      success: true,
      data: {
        customerName: name,
        transactions,
        summary: {
          totalTransactions: parseInt(summary?.total_count || '0'),
          totalMoneyIn: parseFloat(summary?.total_in || '0'),
          totalMoneyOut: parseFloat(summary?.total_out || '0'),
          totalFees: parseFloat(summary?.total_fees || '0'),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authorize('transactions.read'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transaction = await queryOne(
      `SELECT t.*, tt.name as type_name, tt.code as type_code, tt.direction,
              tc.name as category_name, a.name as account_name,
              u1.username as created_by_username, u2.email as approved_by_email
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN transaction_categories tc ON t.transaction_category_id = tc.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN users u1 ON t.created_by = u1.id
       LEFT JOIN users u2 ON t.approved_by = u2.id
       WHERE t.id = $1`,
      [req.params.id]
    );

    if (!transaction) {
      throw createError(404, 'Transaction not found');
    }
    await assertBranch(req, transaction?.account_id, 'transactions.read_all', 'Transaction not found');

    const ledgerEntries = await query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY created_at, id`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...transaction, ledgerEntries } });
  } catch (error) {
    next(error);
  }
});

// The drawer's side of a movement settled in physical cash (design D12; the
// direction is opposite to the account leg, design D24).
//
// The rows come from `drawerLegs` rather than being restated here: on a
// cash-out the fee first, then the movement (D37), because the customer paid
// the fee in cash and it lands in the till; on a cash-in the till's only row
// is the net, because the fee was paid in e-money and posts on the account's
// side instead (D42). The rule covering both directions and both fee modes
// lives in one tested place. The account is the branch's own cash account; a
// movement already booked against one — an expense paid straight out of the
// float — posts a single row rather than two against the same balance.
//
// Nothing is locked here. queryOne runs through the pool rather than the open
// transaction, so any lock it took would be released at statement end and would
// only put this path out of order with processTransaction's sorted locking. The
// balance read is advisory for the same reason the balance check above it is:
// the authoritative check is the one updateAccountBalance makes inside the
// transaction. This one exists only so an operator is told the drawer is short
// rather than being left to infer it from "Insufficient balance".
async function resolveDrawerLeg(
  accountId: string,
  paymentMethod: string | null,
  signedAmount: number,
  fee: number,
  direction: string
): Promise<CounterpartyLeg[]> {
  if (paymentMethod !== 'cash') return [];

  const drawer = await queryOne<{ id: string }>(
    // The branch's oldest open cash account. `t.code = 'cash'` is what makes it
    // the drawer; what it is called is a label, so nothing downstream may
    // depend on the name — this used to prefer `'Revolving Fund'` by string and
    // renaming the account would have silently moved every drawer leg.
    `SELECT a.id FROM accounts a
     JOIN account_types t ON t.id = a.account_type_id
     WHERE t.code = 'cash' AND a.status <> 'closed'
       AND a.branch_id = (SELECT branch_id FROM accounts WHERE id = $1)
     ORDER BY a.created_at ASC
     LIMIT 1`,
    [accountId]
  );
  // Refused rather than skipped: a movement recorded as paid in cash whose
  // branch has no drawer is one the system cannot account for, and posting one
  // leg while quietly dropping the other is how a drawer drifts out of step with
  // the statements meant to explain it.
  if (!drawer) throw createError(400, 'This branch has no cash account to take the money from');
  if (drawer.id === accountId) return [];

  const legs = drawerLegs(signedAmount, fee, direction);
  if (legs.length === 0) return [];

  // The advisory checks the net figure — the cash that actually crosses the
  // till, whichever side the fee was paid on (D42) — so what the drawer must
  // hold to hand the money out is the amount it has always been asked for.
  const net = drawerLeg(signedAmount, fee);
  if (net) await assertDrawerCanFund({ accountId: drawer.id, ...net });

  return legs.map((leg) => ({
    accountId: drawer.id,
    amount: leg.amount,
    entryType: leg.entryType,
    role: leg.role,
  }));
}

// The ledger rows a completed movement wrote on accounts other than its own —
// for a transaction that is the drawer's leg, and nothing else sits there.
//
// Read rather than re-derived from `payment_method`, because the ledger is what
// the balances, the statement and a shift's expected closing are built from: a
// leg inferred here could disagree with the leg that posted, and the method
// says nothing about the charges folded into `totalAmount` at creation.
//
// `conn` is the caller's transaction so the rows read are the ones that are
// committed — a read through the pool would not see a leg this same
// transaction had just written.
async function recordedLedgerRows(
  conn: any,
  transactionId: string,
  primaryAccountId: string,
): Promise<RecordedLedgerRow[]> {
  const result = await conn.query(
    `SELECT account_id, amount, entry_type
       FROM ledger_entries
      WHERE source_type = 'transaction' AND source_id = $1
        AND account_id <> $2
      ORDER BY created_at, id`,
    [transactionId, primaryAccountId],
  );
  return result.rows;
}

// A drawer leg can be a debit — the movement hands cash out — and the till has
// to hold it. Asked before anything is written, so the refusal names the drawer
// rather than the account the operator is looking at. Advisory for the same
// reason resolveDrawerLeg's read is: the authoritative check is the one
// updateAccountBalance makes inside the transaction.
async function assertDrawerCanFund(leg: CounterpartyLeg | null): Promise<void> {
  if (!leg || leg.entryType !== 'debit') return;

  const balance = await queryOne<{ current_balance: string }>(
    'SELECT current_balance FROM accounts WHERE id = $1', [leg.accountId]
  );
  const held = parseFloat(balance?.current_balance || '0');
  if (held < leg.amount) {
    throw createError(400,
      `The branch's cash drawer holds ${held.toFixed(2)} but this movement hands out ${leg.amount.toFixed(2)}`);
  }
}

router.post('/', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const {
      accountId, transactionTypeId, transactionCategoryId, feeRuleId, amount, fee, manualFee,
      referenceNumber, externalReference, transactionDate, description,
      customerName, customerContact, status, feeAddedToBalance, additionalCharges, notes, customerId,
      paymentMethod, providerCharge, payee,
    } = req.body;

    // Parsed once and reused three times — the shift gate, the row and the
    // ledger entry have to agree on the instant, or a movement can pass the
    // gate for one day and be recorded on another. Read in Manila rather than
    // in this host's UTC+3: an entry typed for 00:30 would otherwise land five
    // hours early, in the previous operator's day.
    const bookedAt = transactionDate ? parseManilaDateTime(String(transactionDate)) : null;
    if (transactionDate && !bookedAt) throw createError(400, 'Invalid transaction date');

    let resolvedTypeId = transactionTypeId;
    let resolvedCategoryId = transactionCategoryId || null;

    if (feeRuleId) {
      const feeRule = await queryOne<{ transaction_type_id: string; transaction_category_id: string | null }>(
        'SELECT transaction_type_id, transaction_category_id FROM transaction_fees WHERE id = $1',
        [feeRuleId]
      );
      if (!feeRule) throw createError(404, 'Fee rule not found');
      resolvedTypeId = feeRule.transaction_type_id;
      resolvedCategoryId = feeRule.transaction_category_id;
    }

    if (!accountId || !resolvedTypeId || amount === undefined) {
      throw createError(400, 'Account, transaction type (or fee rule), and amount are required');
    }

    // Creating a transaction moves money on the named account, so the account
    // has to sit in one of the caller's branches. Every read in this file was
    // already scoped, but the create path never was -- without this, a scoped
    // caller could name any account in the system and debit it directly.
    await assertBranch(req, accountId, 'transactions.write_all', 'Account not found');

    const amountNum = parseFloat(amount);
    const enteredFee = parseFloat(fee || '0');
    const inputProblem = validateMovementInputs(amountNum, enteredFee);
    if (inputProblem) throw createError(400, inputProblem);

    // Resolved by the shared fee walk, so the preview this form will read and
    // the row this route commits can only ever quote the same charge.
    const feeNum = await resolveMovementFee({
      typeId: resolvedTypeId,
      categoryId: resolvedCategoryId,
      amount: amountNum,
      enteredFee,
      manualFee: Boolean(manualFee),
    });

    const account = await queryOne<{ id: string; name: string; status: string; created_by: string; type_code: string }>(
      `SELECT a.id, a.name, a.status, a.created_by, t.code AS type_code
       FROM accounts a JOIN account_types t ON t.id = a.account_type_id
       WHERE a.id = $1`,
      [accountId]
    );
    if (!account) throw createError(404, 'Account not found');
    if (account.status === 'closed') throw createError(400, 'Cannot add transactions to a closed account');

    const txType = await queryOne<{ id: string; direction: string; code: string }>(
      'SELECT id, direction, code FROM transaction_types WHERE id = $1', [resolvedTypeId]
    );
    if (!txType) throw createError(404, 'Transaction type not found');

    // Two things a hand-crafted request can do that the entry form cannot. The
    // form is driven by fee rules and has no free type picker, so both were
    // reachable only over the API — and one of them would have spent company
    // money with no second signature behind it. Returned by the shared list so
    // the preview reports them in this same order.
    const refusals = movementRefusals(txType.code, feeNum);
    if (refusals.length > 0) throw createError(400, refusals[0]);

    // Before anything is written, and before the payment-method question: if the
    // branch is shut there is nothing an operator can fix by filling in a field
    // (D17). Owner funding is exempt inside the guard — it is how the drawer
    // gets funded in the first place. The date the row will carry is checked
    // against the shift's date here, so a mistyped day is caught before any of
    // the balance work below rather than after it.
    await assertOpenShift(accountId, txType.code, { eventDate: bookedAt });

    // Checked beside the shift gate because it refuses on the same grounds —
    // something already stored — and so before any balance work, when the only
    // thing lost by refusing is a form the operator has to correct. A double
    // submit dies here; a reversal and its re-entry both pass, because the
    // original has already been undone and its reference freed. The rule and
    // why it is not a unique index: services/referenceRule.
    await assertReferenceIsNew(client, { accountId, referenceNumber, eventDate: bookedAt });

    // Everything the entry preview must also know — the method the account
    // forces, the figures the row will carry, whose approval it needs, and the
    // drawer's side of it — decided in one shared sequence so the preview an
    // operator reads before saving and this commit cannot disagree (see
    // `paymentPlan`). The payment-method rules and their migration-036
    // reasoning live there now; what happens below is what happened before,
    // asked once instead of in pieces.
    const expenseThreshold = await expenseApprovalThreshold();
    const plan = paymentPlan({
      direction: txType.direction,
      code: txType.code,
      accountTypeCode: account.type_code,
      amount: amountNum,
      fee: feeNum,
      feeAddedToBalance: feeAddedToBalance !== false,
      additionalCharges,
      paymentMethod,
      providerCharge,
      requestedStatus: status,
      expenseThreshold,
      isAdminCreator: (req.user!.roles || []).includes('administrator'),
    });
    if (plan.problems.length > 0) throw createError(400, plan.problems[0]);

    const paymentMethodValue = plan.paymentMethod;
    const entryType = plan.entryType;
    const netAmount = plan.netAmount;
    const totalAmount = plan.totalAmount;
    const providerChargeNum = plan.providerCharge;
    const finalStatus = plan.finalStatus;

    // The provider-charge rules, the D42 fee arithmetic and the
    // approval decision all moved into `paymentPlan` above — the same sequence
    // the preview runs — so the figures destructured there are what this row
    // writes. What remains here is the writing itself.

    // Resolved before anything is written, so a branch with no drawer refuses
    // the whole submission rather than leaving a row whose drawer leg never
    // landed. A pending row moves nothing yet — its leg belongs to approval,
    // which is where the money actually leaves (design D5). Completed movements
    // hand over their rows (D37/D42); an e-wallet tender or a movement booked
    // onto the drawer itself posts no counterparties at all.
    const counterparties = finalStatus === 'completed'
      ? await resolveDrawerLeg(
          accountId, paymentMethodValue, entryType === 'credit' ? totalAmount : -totalAmount, feeNum, txType.direction
        )
      : [];

    // The fee row belongs on the account when the fee was paid in e-money — a
    // cash-in's tender — and the drawer took part (D42): the drawer's row is
    // then the net cash alone and the fee lands as its own line on the
    // receiving account. With no drawer rows there is no pairing to keep
    // honest, so the account's row stays whole.
    const feeOnAccount = txType.direction === 'in' && feeNum > 0 && counterparties.length > 0;

    // A pending row withdraws nothing yet, so there is nothing to fund: the
    // balance belongs to approval, which checks it inside the same
    // transaction that writes the debit. Checking here would refuse a
    // proposal merely because owner funding has not arrived yet — and would
    // make the float impossible to open with, since a new revolving fund
    // starts at zero. The verdict itself is shared, so the preview reports
    // this same refusal before the operator types their password.
    if (entryType === 'debit' && finalStatus !== 'pending') {
      const balance = await queryOne<{ current_balance: string }>(
        'SELECT current_balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]
      );
      const problem = fundingProblem({
        balance: parseFloat(balance?.current_balance || '0'),
        entryType,
        status: finalStatus,
        totalAmount,
        providerCharge: providerChargeNum,
      });
      if (problem) throw createError(400, problem);
    }

    const txNumber = await queryOne<{ nextval: string }>("SELECT nextval('transactions_transaction_number_seq') as nextval");

    const transaction = await queryOne(
      `INSERT INTO transactions (transaction_number, account_id, transaction_type_id, transaction_category_id,
       amount, fee, net_amount, reference_number, external_reference, transaction_date, description,
       customer_name, customer_contact, status, created_by, fee_added_to_balance, additional_charges, notes, customer_id, payment_method, payee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [
        txNumber!.nextval, accountId, resolvedTypeId, resolvedCategoryId,
        amountNum, feeNum, netAmount, referenceNumber || null, externalReference || null,
        bookedAt ?? new Date(), description || null,
        customerName || null, customerContact || null, finalStatus, req.user!.userId,
        feeAddedToBalance !== false, JSON.stringify(additionalCharges || []), notes || null, customerId || null,
        paymentMethodValue, payee || null,
      ]
    );

    let newBalance: number | undefined;
    const effectiveDate = bookedAt ?? new Date();
    if (finalStatus === 'completed') {
      ({ newBalance } = await processTransaction(
        accountId, resolvedTypeId, totalAmount, feeNum, entryType as 'debit' | 'credit',
        transaction!.id, referenceNumber, description, effectiveDate, client,
        counterparties, feeOnAccount
      ));
    }

    // Posted after the movement it belongs to, so on a cash-in the money it is
    // paid out of has already landed. It is a debit with no credit anywhere in
    // the pool — the same shape as a transfer's service fee, which is exactly
    // what makes it an expense rather than a customer's cost. All of it stays
    // inside the caller's BEGIN: if the charge cannot be afforded, nothing the
    // operator submitted is written either.
    if (providerChargeNum > 0) {
      const expenseType = await queryOne<{ id: string }>(
        `SELECT id FROM transaction_types WHERE code = 'expense' AND is_active = true`
      );
      if (!expenseType) throw createError(500, 'The Expense transaction type is not configured');

      const chargeNumber = await queryOne<{ nextval: string }>(
        "SELECT nextval('transactions_transaction_number_seq') as nextval"
      );
      const chargeDescription = `Provider charge on transaction #${transaction!.transaction_number} (not billed to the customer)`;

      const chargeRow = (await client.query(
        `INSERT INTO transactions (transaction_number, account_id, transaction_type_id,
           amount, fee, net_amount, description, transaction_date, status, created_by,
           linked_transaction_id)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          chargeNumber!.nextval, accountId, expenseType.id, providerChargeNum, providerChargeNum,
          chargeDescription, effectiveDate, finalStatus, req.user!.userId, transaction!.id,
        ]
      )).rows[0];

      ({ newBalance } = await processTransaction(
        accountId, expenseType.id, providerChargeNum, 0, 'debit',
        chargeRow.id, null, chargeDescription, effectiveDate, client
      ));
    }

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.created',
      entity: 'transaction',
      entityId: transaction!.id,
      ipAddress: req.ip,
      newData: {
        accountName: account.name, amount: amountNum, direction: txType.direction,
        status: finalStatus, ...(newBalance !== undefined ? { newBalance } : {}),
        ...(providerChargeNum > 0 ? { providerCharge: providerChargeNum } : {}),
      },
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// The entry form's leg preview: what this submission would write, read from the
// same fee walk (`resolveMovementFee`), the same pure rules (`paymentPlan`) and
// the same drawer resolution (`resolveDrawerLeg`) the commit above runs — so
// the figure an operator reads before saving cannot disagree with the rows the
// save posts. Read-only: nothing is written, nothing is locked. Refusals the
// commit would raise come back as `problems`, in the order it raises them, so
// the form can show every reason a save would fail instead of the first one
// that happened to trip.
router.post('/preview', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      accountId, transactionTypeId, transactionCategoryId, feeRuleId, amount, fee, manualFee,
      transactionDate, additionalCharges, paymentMethod, providerCharge, status, feeAddedToBalance,
    } = req.body;

    const problems: string[] = [];

    const bookedAt = transactionDate ? parseManilaDateTime(String(transactionDate)) : null;
    if (transactionDate && !bookedAt) problems.push('Invalid transaction date');

    let resolvedTypeId = transactionTypeId;
    let resolvedCategoryId = transactionCategoryId || null;
    if (feeRuleId) {
      const feeRule = await queryOne<{ transaction_type_id: string; transaction_category_id: string | null }>(
        'SELECT transaction_type_id, transaction_category_id FROM transaction_fees WHERE id = $1',
        [feeRuleId]
      );
      if (!feeRule) throw createError(404, 'Fee rule not found');
      resolvedTypeId = feeRule.transaction_type_id;
      resolvedCategoryId = feeRule.transaction_category_id;
    }

    if (!accountId || !resolvedTypeId || amount === undefined) {
      throw createError(400, 'Account, transaction type (or fee rule), and amount are required');
    }
    await assertBranch(req, accountId, 'transactions.write_all', 'Account not found');

    const amountNum = parseFloat(amount);
    const enteredFee = parseFloat(fee || '0');
    const inputProblem = validateMovementInputs(amountNum, enteredFee);
    if (inputProblem) {
      // Every figure below hangs off these two inputs, so there is nothing
      // worth quoting yet — the same refusal the commit makes, first.
      return res.json({ success: true, data: { legs: [], problems: [inputProblem] } });
    }

    const feeNum = await resolveMovementFee({
      typeId: resolvedTypeId,
      categoryId: resolvedCategoryId,
      amount: amountNum,
      enteredFee,
      manualFee: Boolean(manualFee),
    });

    const account = await queryOne<{ id: string; name: string; status: string; type_code: string }>(
      `SELECT a.id, a.name, a.status, t.code AS type_code
       FROM accounts a JOIN account_types t ON t.id = a.account_type_id
       WHERE a.id = $1`,
      [accountId]
    );
    if (!account) throw createError(404, 'Account not found');
    if (account.status === 'closed') problems.push('Cannot add transactions to a closed account');

    const txType = await queryOne<{ id: string; direction: string; code: string }>(
      'SELECT id, direction, code FROM transaction_types WHERE id = $1', [resolvedTypeId]
    );
    if (!txType) throw createError(404, 'Transaction type not found');

    problems.push(...movementRefusals(txType.code, feeNum));

    // The same gate the commit calls, run for the day this entry would carry.
    // A closed branch is information worth having before half the form is
    // filled in, so it joins the list rather than ending the request.
    try {
      await assertOpenShift(accountId, txType.code, { eventDate: bookedAt });
    } catch (err: any) {
      problems.push(err?.message || 'This branch has no open shift for the day selected');
    }

    const expenseThreshold = await expenseApprovalThreshold();
    const plan = paymentPlan({
      direction: txType.direction,
      code: txType.code,
      accountTypeCode: account.type_code,
      amount: amountNum,
      fee: feeNum,
      feeAddedToBalance: feeAddedToBalance !== false,
      additionalCharges,
      paymentMethod,
      providerCharge,
      requestedStatus: status,
      expenseThreshold,
      isAdminCreator: (req.user!.roles || []).includes('administrator'),
    });
    problems.push(...plan.problems);

    // The legs, resolved exactly as the commit resolves them. A pending row
    // writes no ledger rows yet — what is listed is what approval will post,
    // which is the movement the operator is really choosing between.
    const legs: Array<{ role: string; accountId: string; accountName: string; entryType: string; amount: number }> = [
      { role: 'account', accountId, accountName: account.name, entryType: plan.entryType, amount: plan.totalAmount },
    ];

    const balanceRow = await queryOne<{ current_balance: string }>(
      'SELECT current_balance FROM accounts WHERE id = $1', [accountId]
    );
    const accountBalance = parseFloat(balanceRow?.current_balance || '0');

    let drawerBalance: number | null = null;
    if (plan.finalStatus === 'completed') {
      try {
        // The save posts the drawer's rows — the till's own fee line on a
        // cash-out (D37), or the single net cash figure on a cash-in, whose
        // fee was paid in e-money and posts on the account instead (D42) —
        // but the preview always lists the drawer as their net, because an
        // operator checks it against the cash tin: ₱10 in and ₱510 out is a
        // −₱500 drawer, not −₱510. One line here; the statement keeps every
        // row, where the running balance explains the pair.
        const drawerRows = await resolveDrawerLeg(
          accountId, plan.paymentMethod, plan.drawerSignedAmount, feeNum, txType.direction
        );
        if (drawerRows.length > 0) {
          const drawerAcct = await queryOne<{ name: string; current_balance: string }>(
            'SELECT name, current_balance FROM accounts WHERE id = $1', [drawerRows[0].accountId]
          );
          const netCents = drawerRows.reduce(
            (sum, row) => sum + (row.entryType === 'credit' ? 1 : -1) * Math.round(row.amount * 100),
            0
          );
          legs.push({
            role: 'drawer',
            accountId: drawerRows[0].accountId,
            accountName: drawerAcct?.name || 'Cash on hand',
            entryType: netCents >= 0 ? 'credit' : 'debit',
            amount: Math.abs(netCents) / 100,
          });
          drawerBalance = parseFloat(drawerAcct?.current_balance || '0');
        }
      } catch (err: any) {
        // A branch with no drawer, or one too short to hand the money out:
        // exactly the refusals the commit makes, reported before the save.
        problems.push(err?.message || 'The drawer side of this movement could not be resolved');
      }
      if (plan.providerCharge > 0) {
        legs.push({ role: 'charge', accountId, accountName: account.name, entryType: 'debit', amount: plan.providerCharge });
      }
    }

    const funding = fundingProblem({
      balance: accountBalance,
      entryType: plan.entryType,
      status: plan.finalStatus,
      totalAmount: plan.totalAmount,
      providerCharge: plan.providerCharge,
    });
    if (funding) problems.push(funding);

    res.json({
      success: true,
      data: {
        legs,
        problems,
        fee: feeNum,
        netAmount: plan.netAmount,
        totalAmount: plan.totalAmount,
        providerCharge: plan.providerCharge,
        status: plan.finalStatus,
        requiresApproval: plan.requiresApproval,
        paymentMethod: plan.paymentMethod,
        cashBehavior: plan.cashBehavior,
        accountBalance,
        drawerBalance,
      },
    });
  } catch (error) { next(error); }
});

router.patch('/:id/charges', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    const { additionalCharges } = req.body;
    if (!Array.isArray(additionalCharges)) {
      throw createError(400, 'additionalCharges must be an array');
    }

    await client.query('BEGIN');

    const originalRes = await client.query(
      `SELECT t.id, t.created_by, t.account_id, t.additional_charges, t.status, t.reference_number, t.transaction_date, tt.direction, tt.code
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1
       FOR UPDATE`,
      [req.params.id]
    );
    const original = originalRes.rows[0];
    if (!original) throw createError(404, 'Transaction not found');
    await assertBranch(req, original?.account_id, 'transactions.write_all', 'Transaction not found');
    if (original.status === 'completed' && !(req.user!.roles || []).includes('administrator')) {
      throw createError(403, 'Only administrators can adjust charges on a completed transaction');
    }

    const chargeTotal = (charges: any): number =>
      Math.round(
        (Array.isArray(charges) ? charges : []).reduce(
          (sum: number, c: any) => sum + (parseFloat(c?.amount) || 0), 0
        ) * 100
      ) / 100;

    const oldTotal = chargeTotal(original.additional_charges);
    const newTotal = chargeTotal(additionalCharges);
    const delta = Math.round((newTotal - oldTotal) * 100) / 100;

    if (delta !== 0 && original.status === 'completed') {
      // Money changes hands only on a non-zero delta against a settled row, so
      // only then is the branch's open shift a precondition. A zero-delta edit
      // rewrites the row's figures and is left alone (D17).
      //
      // Held to today, not to the date the row carries: the row is not re-dated,
      // but the entry written below is stamped now, so it is the shift covering
      // now that must account for it. Checking the row's date instead would let
      // an entry land on a day no shift was ever open for.
      await assertOpenShift(original.account_id, original.code);
      const creditLike = original.direction === 'in' || original.direction === 'adjustment';
      const entryType: 'debit' | 'credit' = delta > 0
        ? (creditLike ? 'credit' : 'debit')
        : (creditLike ? 'debit' : 'credit');
      const amount = Math.abs(delta);

      // The drawer's side, when this movement ever had one. Charges ride inside
      // totalAmount at creation, so the leg they asked for moves by the same
      // amount, against the account (chargeDrawerLeg). Left out, a charge added
      // to a cash movement leaves the till behind the books by that figure —
      // and the shift that counts it would close on a variance nobody caused.
      //
      // Whether there is a side at all comes from the ledger rather than from
      // payment_method: the rows are the truth about what posted.
      const drawerRows = await recordedLedgerRows(client, original.id, original.account_id);
      const drawerSide = chargeDrawerLeg(drawerRows, delta, entryType);
      await assertDrawerCanFund(drawerSide);

      let newBalance: number;
      try {
        newBalance = await updateAccountBalance(original.account_id, amount, entryType, client);
      } catch (err: any) {
        if (err?.message === 'Insufficient balance') throw createError(400, 'Insufficient balance for charge adjustment');
        throw err;
      }

      const note = `Additional charges updated: ${oldTotal.toFixed(2)} -> ${newTotal.toFixed(2)}`;

      await createLedgerEntry(
        original.account_id,
        entryType,
        amount,
        newBalance,
        original.id,
        null,
        original.reference_number,
        note,
        new Date(),
        client
      );

      if (drawerSide) {
        const drawerBalance = await updateAccountBalance(
          drawerSide.accountId, drawerSide.amount, drawerSide.entryType, client
        );
        await createLedgerEntry(
          drawerSide.accountId,
          drawerSide.entryType,
          drawerSide.amount,
          drawerBalance,
          original.id,
          null,
          original.reference_number,
          note,
          new Date(),
          client
        );
      }
    }

    const updated = await client.query(
      `UPDATE transactions SET additional_charges = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [JSON.stringify(additionalCharges), req.params.id]
    );

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.charges_updated',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { additionalCharges, oldTotal, newTotal, delta },
    });

    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.patch('/:id/notes', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notes } = req.body;
    const transaction = await queryOne('SELECT id, created_by FROM transactions WHERE id = $1', [req.params.id]);
    await assertBranch(req, transaction?.account_id, 'transactions.write_all', 'Transaction not found');

    const updated = await queryOne(
      `UPDATE transactions SET notes = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [notes || null, req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.notes_updated',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { notes },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// Administrator-only edit. Safe metadata is always editable; amount/fee changes move the
// account balance and shift the ledger's running balance from the edited entry onward.
router.patch('/:id', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  if (!(req.user!.roles || []).includes('administrator')) {
    return next(createError(403, 'Only administrators can edit transactions'));
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const row = (await client.query(
      `SELECT t.*, tt.direction
       FROM transactions t JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1 FOR UPDATE OF t`,
      [req.params.id]
    )).rows[0];
    if (!row) throw createError(404, 'Transaction not found');
    if (row.status !== 'pending') {
      throw createError(400, row.status === 'completed'
        ? 'Completed transactions are locked — request a reversal instead'
        : 'Only pending transactions can be edited');
    }

    const body = req.body || {};
    const provided = (key: string) => body[key] !== undefined && body[key] !== null;

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const updates: string[] = [];
    const params: any[] = [];
    const set = (column: string, value: any) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    // Read as Manila, the same way creation reads it: this value arrives exactly
    // as the operator typed it, and the browser that typed it did not choose the
    // server's zone. Taken as local, a 09:00 entry would be written 14:00.
    const transactionDate = provided('transactionDate')
      ? parseManilaDateTime(String(body.transactionDate))
      : null;
    if (provided('transactionDate') && !transactionDate) throw createError(400, 'Invalid transaction date');

    if (transactionDate) set('transaction_date', transactionDate.toISOString());
    if (provided('referenceNumber')) set('reference_number', String(body.referenceNumber).trim() || null);
    if (provided('externalReference')) set('external_reference', String(body.externalReference).trim() || null);
    if (provided('description')) set('description', String(body.description).trim() || null);
    if (provided('customerName')) set('customer_name', String(body.customerName).trim() || null);
    if (provided('customerContact')) set('customer_contact', String(body.customerContact).trim() || null);
    // The same rule as creation: an edit is the other way to put a wallet
    // movement on a drawer account, and the label is what the shift report
    // reads back. Blank comes out as cash; a method that disagrees is refused
    // rather than overwritten, so nobody's edit is silently rewritten.
    if (provided('paymentMethod')) {
      const acct = await queryOne<{ type_code: string }>(
        `SELECT t.code AS type_code FROM accounts a
         JOIN account_types t ON t.id = a.account_type_id WHERE a.id = $1`,
        [row.account_id]
      );
      const outcome = resolveCashAccountMethod(acct?.type_code, body.paymentMethod);
      if (outcome.action === 'refuse') throw createError(400, outcome.message);
      set('payment_method', outcome.action === 'force' ? outcome.method : String(body.paymentMethod).trim() || null);
    }
    if (provided('notes')) set('notes', String(body.notes).trim() || null);

    const amountInput = provided('amount') ? Number(body.amount) : parseFloat(row.amount);
    if (!Number.isFinite(amountInput) || amountInput < 0) throw createError(400, 'Amount cannot be negative');

    const feeInput = provided('fee') ? Number(body.fee) : parseFloat(row.fee || '0');
    if (!Number.isFinite(feeInput) || feeInput < 0) throw createError(400, 'Fee cannot be negative');
    const feeNum = Math.ceil(feeInput - 1e-9);

    const feeAddedToBalance = provided('feeAddedToBalance') ? body.feeAddedToBalance !== false : row.fee_added_to_balance !== false;

    // The same rule as creation, read from the same planner: the fee rides the
    // side the customer paid it on (design D42), so the balance moves by
    // amount + fee on a cash-in that collected it on top and by amount − fee
    // on a cash-out that carved it from the amount — the other two cells carry
    // the amount as typed. Editing must reproduce what the create path would
    // have written, or correcting an amount would quietly re-price the
    // movement — so both ask `netAmountOf`, and the preview quotes it too.
    const net = netAmountOf({
      direction: row.direction,
      amount: amountInput,
      fee: feeNum,
      feeAddedToBalance,
    });
    if (net.exceeds) {
      throw createError(400, 'Fee cannot exceed the transaction amount when the fee is taken inside the amount');
    }
    const netAmount = net.netAmount;

    set('amount', round2(amountInput));
    set('fee', feeNum);
    set('net_amount', round2(netAmount));
    set('fee_added_to_balance', feeAddedToBalance);

    // Checked against what the row will hold rather than against what was sent,
    // because either field can be what makes the duplicate: a reference moved
    // onto one already used this day, or this row moved onto a day that already
    // holds it. The row is passed as the one to ignore, so keeping its own
    // reference is never mistaken for colliding with itself.
    await assertReferenceIsNew(client, {
      accountId: row.account_id,
      referenceNumber: provided('referenceNumber') ? body.referenceNumber : row.reference_number,
      eventDate: transactionDate ?? row.transaction_date,
      excludeId: req.params.id,
    });

    updates.push('updated_at = NOW()');
    const updated = (await client.query(
      `UPDATE transactions SET ${updates.join(', ')} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, req.params.id]
    )).rows[0];

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.updated',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: {
        amount: parseFloat(row.amount), fee: parseFloat(row.fee || '0'),
        netAmount: parseFloat(row.net_amount), transactionDate: row.transaction_date,
        referenceNumber: row.reference_number, customerName: row.customer_name,
        paymentMethod: row.payment_method, description: row.description,
      },
      newData: {
        transactionNumber: updated.transaction_number, amount: parseFloat(updated.amount),
        fee: parseFloat(updated.fee), netAmount: parseFloat(updated.net_amount),
        transactionDate: updated.transaction_date, referenceNumber: updated.reference_number,
        customerName: updated.customer_name, paymentMethod: updated.payment_method,
        description: updated.description, balanceDelta: 0,
      },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

router.post('/:id/reverse', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const original = await queryOne(
      `SELECT t.*, tt.direction FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!original) throw createError(404, 'Transaction not found');
    await assertBranch(req, original?.account_id, 'transactions.write_all', 'Transaction not found');
    if (original.status === 'reversed') throw createError(400, 'Transaction already reversed');
    if (original.status === 'pending' || original.status === 'rejected') {
      throw createError(400, 'Unsettled fund movements cannot be reversed');
    }

    const txType = await queryOne<{ code: string }>(
      'SELECT code FROM transaction_types WHERE id = $1', [original.transaction_type_id]
    );
    if (txType?.code === 'adjustment_in' || txType?.code === 'adjustment_out') {
      throw createError(400, 'Adjustment transactions cannot be reversed');
    }

    // Unwinding moves money back, so it is gated like the movement it undoes —
    // which means a mistake made under a closed shift waits for the next open
    // one instead of reopening yesterday's count (D17).
    await assertOpenShift(original.account_id, txType?.code);

    const isAdmin = req.user!.roles.includes('administrator');
    const { reason } = req.body;

    if (isAdmin) {
      // Admin: execute reversal immediately. The status flip, the reversing row
      // and the balance move it causes are one unit of work on one connection,
      // so none of them can land without the others — the difference between a
      // reversal that did not happen and one that has been recorded twice.
      const reverseTx = await withTransaction(async (client) => {
        const totalOriginalAmount = movementTotalOf(original);

        // The drawer's side of the original, unwound with it. Unwinding is a
        // movement like any other — D17 gates it as one — so the cash the
        // original moved between the account and the till has to move back.
        // Read from the rows the original actually wrote rather than
        // recomputed: the fee comes back with the movement whichever way it
        // was taken, so the mirror of the recorded rows is the whole answer
        // (details on unwindDrawerLeg). Resolved before anything is
        // written, so a leg that cannot be posted leaves the original untouched.
        const drawerSide = unwindDrawerLeg(
          await recordedLedgerRows(client, original.id, original.account_id)
        );
        await assertDrawerCanFund(drawerSide);

        await client.query(
          `UPDATE transactions SET status = 'reversed', updated_at = NOW() WHERE id = $1`,
          [req.params.id]
        );

        const reverseEntryType = original.direction === 'in' ? 'debit' : 'credit';
        const reverseTypeId = (await client.query<{ id: string }>(
          `SELECT id FROM transaction_types WHERE code = $1`,
          [original.direction === 'in' ? 'adjustment_out' : 'adjustment_in']
        )).rows[0];

        const created = (await client.query(
          `INSERT INTO transactions (account_id, transaction_type_id, amount, fee, net_amount,
           reference_number, transaction_date, description, status, created_by, payment_method)
           VALUES ($1, $2, $3, 0, $3, $4, NOW(), $5, 'completed', $6, $7)
           RETURNING *`,
          [
            original.account_id, reverseTypeId!.id, original.amount,
            `REV-${original.transaction_number}`, `Reversal: ${reason || original.description || 'Transaction reversal'}`,
            req.user!.userId,
            // Carried over, so a row that owns a drawer leg declares the tender
            // behind it. Left NULL when the original was, which is what keeps
            // the 108 historical rows reversible (migration 036).
            original.payment_method ?? null,
          ]
        )).rows[0];

        await processTransaction(
          original.account_id, reverseTypeId!.id, totalOriginalAmount, 0,
          reverseEntryType as 'debit' | 'credit', created.id,
          `REV-${original.transaction_number}`, `Reversal: ${reason || 'Transaction reversal'}`,
          new Date(), client,
          drawerSide ? [drawerSide] : []
        );

        return created;
      });

      await createAuditLog({
        userId: req.user!.userId,
        action: 'transaction.reversed',
        entity: 'transaction',
        entityId: req.params.id,
        ipAddress: req.ip,
        newData: { originalNumber: original.transaction_number, reason },
      });

      res.json({ success: true, data: reverseTx });
    } else {
      // Non-admin: create pending reversal for admin approval. The reason is
      // required, not optional — the queue's whole decision rests on it, and
      // "no reason given" is not something an administrator can act on.
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw createError(400, 'reason is required');
      }
      // One open request per record — two requests for the same movement would
      // race their approvers; migration 047 enforces it, this turns the
      // constraint into a plain sentence.
      const open = await queryOne(
        `SELECT id FROM pending_reversals WHERE entity_type = 'transaction' AND entity_id = $1 AND status = 'pending'`,
        [req.params.id]
      );
      if (open) throw createError(409, 'A reversal request for this transaction is already awaiting approval');

      const reversalAmount = movementTotalOf(original);

      let pending;
      try {
        pending = await queryOne(
          `INSERT INTO pending_reversals (entity_type, entity_id, account_id, requested_by, reversal_amount, reason)
           VALUES ('transaction', $1, $2, $3, $4, $5)
           RETURNING *`,
          [req.params.id, original.account_id, req.user!.userId, reversalAmount, reason.trim()]
        );
      } catch (err: any) {
        if (err?.code === '23505') throw createError(409, 'A reversal request for this transaction is already awaiting approval');
        throw err;
      }

      await createAuditLog({
        userId: req.user!.userId,
        action: 'transaction.reverse_requested',
        entity: 'transaction',
        entityId: req.params.id,
        ipAddress: req.ip,
        newData: { originalNumber: original.transaction_number, reason: reason.trim(), pendingReversalId: pending!.id },
      });

      res.json({ success: true, data: pending });
    }
  } catch (error) {
    next(error);
  }
});

type ControlledCode = 'owner_funding' | 'owner_return' | 'operating_expense' | 'cash_payment';

// The movements whose release is a head-office decision rather than a branch
// one. They share the administrator-only bar on approve and reject, and they
// share an expense's audit action rather than an owner-fund one — a payment
// approved under `transaction.owner_fund_approved` would file it as capital.
const HEAD_OFFICE_CODES = new Set<string>(['operating_expense', 'cash_payment']);

// The movements that may only ever be created as `pending` and must be
// settled by a second person. Everything else completes on creation or runs its
// own workflow (transfers, reversals).
function assertControlledType(code: string): asserts code is ControlledCode {
  if (code !== 'owner_funding' && code !== 'owner_return' && code !== 'operating_expense' && code !== 'cash_payment') {
    throw createError(400, 'Only owner fund movements, operating expenses and cash payments require approval');
  }
}

// List owner fund movements awaiting approval (administrators + managers)
router.get('/owner-funds/pending', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === 'rejected' ? 'rejected' : 'pending';
    const rows = await query(
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.net_amount, t.status, t.transaction_date,
              t.description, t.notes, t.payment_method, t.reference_number, t.created_at,
              t.rejection_reason, t.additional_charges,
              tt.code AS type_code, tt.name AS type_name, tt.direction,
              a.name AS account_name, a.current_balance,
              u.username AS created_by_username,
              ru.username AS rejected_by_username
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN users u ON t.created_by = u.id
       LEFT JOIN users ru ON t.rejected_by = ru.id
       WHERE tt.code IN ('owner_funding', 'owner_return') AND t.status = $1
       ORDER BY t.created_at ASC`,
      [status]
    );
    res.json({ success: true, data: { data: rows } });
  } catch (error) {
    next(error);
  }
});

// Approve an owner fund movement — funds move only here, never at creation
router.post('/:id/approve', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const row = (await client.query(
      `SELECT t.*, tt.code, tt.direction
       FROM transactions t JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1 FOR UPDATE OF t`,
      [req.params.id]
    )).rows[0];
    if (!row) throw createError(404, 'Transaction not found');
    // Approving settles the movement on this account, so it must be the
    // caller's. Checked before the status guard so a scoped caller cannot
    // probe for pending requests outside their branches.
    await assertBranch(req, row.account_id, 'transactions.write_all', 'Transaction not found');
    // Settling is where a pending row finally moves money (D5), so the shift has
    // to be open here as well as at creation: the approver may be looking at a
    // branch that shut in between (D17).
    //
    // Held to the row's own date, because that is the date the settlement
    // entry below carries. It has to fall inside the window of the shift that
    // authorised it — checked against approval time instead, the entry would
    // count towards a shift that never gated it.
    await assertOpenShift(row.account_id, row.code, { eventDate: row.transaction_date });
    assertControlledType(row.code);
    // Releasing an outflow the branch chose to make is a head-office decision,
    // so expenses and payments sit behind administrator-only on top of the
    // two-person rule — the same bar reversals already clear. Owner funds keep
    // their wider approver set untouched; changing it here would alter live
    // behaviour unrelated to this feature.
    if (HEAD_OFFICE_CODES.has(row.code) && !req.user!.roles.includes('administrator')) {
      throw createError(403, 'Only administrators can approve operating expenses and cash payments');
    }
    if (row.status !== 'pending') throw createError(400, 'Only pending fund movements can be approved');
    if (row.created_by === req.user!.userId) throw createError(400, 'You cannot approve your own request');

    const charges = (row.additional_charges || [])
      .reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);
    const totalAmount = parseFloat(row.net_amount || row.amount) + charges;
    const entryType: 'debit' | 'credit' =
      row.direction === 'in' || row.direction === 'adjustment' ? 'credit' : 'debit';

    // Resolved before any account is locked, so this path and the creation path
    // take the two locks in the same order. Locking the primary first here and
    // letting processTransaction sort them afterwards would give the two paths
    // opposite orders whenever the drawer sorts ahead of the wallet.
    const counterparties = await resolveDrawerLeg(
      row.account_id, row.payment_method,
      entryType === 'credit' ? totalAmount : -totalAmount, parseFloat(row.fee || 0), row.direction
    );

    // The same rule as creation (D42): the fee row belongs on the account when
    // the fee was paid in e-money and the drawer took part — pending rows
    // carry neither leg yet, so this is decided here, where they are written.
    const feeOnAccount =
      row.direction === 'in' && parseFloat(row.fee || 0) > 0 && counterparties.length > 0;

    await lockAccounts(client, [row.account_id, ...counterparties.map((leg) => leg.accountId)]);

    const account = (await client.query(
      'SELECT id, name, current_balance, status FROM accounts WHERE id = $1',
      [row.account_id]
    )).rows[0];
    if (!account) throw createError(404, 'Account not found');
    if (account.status !== 'active') throw createError(400, 'Account is not active');

    if (entryType === 'debit' && parseFloat(account.current_balance) < totalAmount) {
      throw createError(400, 'Insufficient balance');
    }

    const { newBalance } = await processTransaction(
      row.account_id, row.transaction_type_id, totalAmount, parseFloat(row.fee || 0), entryType,
      row.id, row.reference_number, row.description, new Date(row.transaction_date), client,
      counterparties, feeOnAccount
    );

    const updated = (await client.query(
      `UPDATE transactions SET status = 'completed', approved_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user!.userId, req.params.id]
    )).rows[0];

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: HEAD_OFFICE_CODES.has(row.code)
        ? 'transaction.expense_approved'
        : 'transaction.owner_fund_approved',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: {
        transactionNumber: updated.transaction_number, accountName: account.name,
        amount: totalAmount, direction: row.direction, newBalance,
      },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// Reject an owner fund movement — no money ever moves
router.post('/:id/reject', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw createError(400, 'Rejection reason is required');
    }

    const row = await queryOne(
      `SELECT t.*, tt.code
       FROM transactions t JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!row) throw createError(404, 'Transaction not found');
    await assertBranch(req, row.account_id, 'transactions.write_all', 'Transaction not found');
    assertControlledType(row.code);
    // Same head-office gate as approval — declining a payment is the same
    // decision as releasing one.
    if (HEAD_OFFICE_CODES.has(row.code) && !req.user!.roles.includes('administrator')) {
      throw createError(403, 'Only administrators can reject operating expenses and cash payments');
    }
    if (row.status !== 'pending') throw createError(400, 'Only pending fund movements can be rejected');
    if (row.created_by === req.user!.userId) throw createError(400, 'You cannot reject your own request');

    const updated = await queryOne(
      `UPDATE transactions
       SET status = 'rejected', rejected_by = $1, rejection_reason = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [req.user!.userId, reason.trim(), req.params.id]
    );

    await createAuditLog({
      userId: req.user!.userId,
      action: HEAD_OFFICE_CODES.has(row.code)
        ? 'transaction.expense_rejected'
        : 'transaction.owner_fund_rejected',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      newData: { transactionNumber: updated!.transaction_number, reason: reason.trim() },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// List pending reversals (admin/manager). Requires transactions.approve so operators
// cannot read other people's reversal requests — parity with /owner-funds/pending.
router.get('/reversals/pending', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === 'rejected' ? 'rejected' : 'pending';
    const rows = await query(
      `SELECT pr.*,
              CASE WHEN pr.entity_type = 'transaction' THEN t.transaction_number ELSE lt.transaction_number END AS transaction_number,
              CASE WHEN pr.entity_type = 'transaction' THEN t.amount ELSE lt.total_cost END AS original_amount,
              CASE WHEN pr.entity_type = 'transaction' THEN t.status ELSE lt.status END AS original_status,
              CASE WHEN pr.entity_type = 'transaction' THEN t.description
                   ELSE 'Loading sale #' || lt.transaction_number END AS description,
              COALESCE(tt.name, 'Loading sale') AS type_name,
              tt.code AS type_code,
              CASE WHEN pr.entity_type = 'loading' THEN 'out' ELSE tt.direction END AS direction,
              a.name AS account_name,
              u.username AS requested_by_username, ru.username AS decided_by_username
       FROM pending_reversals pr
       LEFT JOIN transactions t ON pr.entity_type = 'transaction' AND pr.entity_id = t.id
       LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
       LEFT JOIN loading_transactions lt ON pr.entity_type = 'loading' AND pr.entity_id = lt.id
       LEFT JOIN accounts a ON a.id = COALESCE(t.account_id, lt.account_id, pr.account_id)
       JOIN users u ON pr.requested_by = u.id
       LEFT JOIN users ru ON pr.approved_by = ru.id
       WHERE pr.entity_type IN ('transaction', 'loading') AND pr.status = $1
       ORDER BY pr.created_at ASC`,
      [status]
    );
    res.json({ success: true, data: { data: rows } });
  } catch (error) {
    next(error);
  }
});

// The shift verdict as data rather than an exception: a preview must be able
// to say "the branch is shut, approval would be refused" instead of failing to
// load — the same question the approval path asks, answered without writing
// anything.
async function shiftVerdict(accountId: string, typeCode?: string | null) {
  try {
    await assertOpenShift(accountId, typeCode ?? undefined);
    return { open: true, message: null as string | null };
  } catch (err: any) {
    return { open: false, message: err?.message || 'No open shift — approval would be refused' };
  }
}

interface PreviewBody {
  record: {
    kind: 'transaction' | 'loading';
    number: number;
    status: string;
    typeCode: string | null;
    typeName: string;
    accountName: string;
    description: string | null;
    date: string | null;
  };
  affected: Array<{ accountId: string; name: string; before: number; delta: number; after: number }>;
  rowsToAppend: Array<{ name: string; entryType: string; amount: number }>;
  notes: string[];
  problems: string[];
  shift: { open: boolean; message: string | null };
}

async function previewLoadingCancel(pending: any): Promise<PreviewBody> {
  const record = await queryOne(
    `SELECT lt.*, a.name AS account_name
       FROM loading_transactions lt JOIN accounts a ON a.id = lt.account_id
      WHERE lt.id = $1`,
    [pending.entity_id]
  );
  if (!record) throw createError(404, 'Loading transaction not found');

  const rows = await query(
    `SELECT id, account_id, entry_type, amount FROM ledger_entries
      WHERE source_type = 'loading' AND source_id = $1 ORDER BY created_at, id`,
    [pending.entity_id]
  );
  const ids = [...new Set<string>([record.account_id, ...rows.map((r: any) => r.account_id)])];
  const accounts = await query(`SELECT id, name, status, current_balance FROM accounts WHERE id = ANY($1)`, [ids]);
  const plan = planLoadingCancel(record, rows, accounts);
  const names = new Map<string, string>(accounts.map((a: any) => [a.id, a.name]));

  return {
    record: {
      kind: 'loading',
      number: record.transaction_number,
      status: record.status,
      typeCode: null,
      typeName: 'Loading sale',
      accountName: record.account_name,
      description: `Loading sale #${record.transaction_number} to ${record.customer_number}`,
      date: record.created_at,
    },
    affected: plan.affected,
    rowsToAppend: plan.mirrors.map((m) => ({
      name: names.get(m.accountId) || m.accountId,
      entryType: m.entryType,
      amount: m.amount,
    })),
    notes: [],
    problems: plan.problems,
    shift: await shiftVerdict(record.account_id, null),
  };
}

async function previewTransactionCancel(pending: any): Promise<PreviewBody> {
  const record = await queryOne(
    `SELECT t.*, tt.code, tt.name AS type_name, tt.direction, a.name AS account_name
       FROM transactions t
       JOIN transaction_types tt ON tt.id = t.transaction_type_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1`,
    [pending.entity_id]
  );
  if (!record) throw createError(404, 'Transaction not found');

  const rows = await query(
    `SELECT id, account_id, entry_type, amount FROM ledger_entries
      WHERE source_type = 'transaction' AND source_id = $1 ORDER BY created_at, id`,
    [pending.entity_id]
  );
  const accountRows = rows.filter((r: any) => r.account_id === record.account_id);
  const otherRows = rows.filter((r: any) => r.account_id !== record.account_id);
  const ids = [...new Set<string>([record.account_id, ...rows.map((r: any) => r.account_id)])];
  const accounts = await query(`SELECT id, name, status, current_balance FROM accounts WHERE id = ANY($1)`, [ids]);
  const plan = planTransactionCancel(record, accountRows, otherRows, accounts);
  const names = new Map<string, string>(accounts.map((a: any) => [a.id, a.name]));

  const rowsToAppend = [{
    name: names.get(plan.accountLeg.accountId) || record.account_name,
    entryType: plan.accountLeg.entryType,
    amount: plan.accountLeg.amount,
  }];
  if (plan.drawerLeg) {
    rowsToAppend.push({
      name: names.get(plan.drawerLeg.accountId) || 'the till',
      entryType: plan.drawerLeg.entryType,
      amount: plan.drawerLeg.amount,
    });
  }

  return {
    record: {
      kind: 'transaction',
      number: record.transaction_number,
      status: record.status,
      typeCode: record.code,
      typeName: record.type_name,
      accountName: record.account_name,
      description: record.description,
      date: record.transaction_date,
    },
    affected: plan.affected,
    rowsToAppend,
    notes: plan.notes,
    problems: plan.problems,
    shift: await shiftVerdict(record.account_id, record.code),
  };
}

// What approving this request will do — every account it touches, the rows it
// appends, and every guard that would refuse it — read-only, so an
// administrator sees the affected balances before money moves: the "check all
// affected" step of the cancellation workflow (D44). The plans come from the
// same service the approval path commits through, so the preview cannot
// disagree with the approval (§34's rule).
router.get('/reversals/:reversalId/preview', authorize('transactions.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = await queryOne(
      `SELECT pr.*, u.username AS requested_by_username
         FROM pending_reversals pr JOIN users u ON u.id = pr.requested_by
        WHERE pr.id = $1`,
      [req.params.reversalId]
    );
    if (!pending) throw createError(404, 'Reversal request not found');

    const request = {
      id: pending.id,
      entityType: pending.entity_type,
      status: pending.status,
      reason: pending.reason,
      requestedBy: pending.requested_by,
      requestedByUsername: pending.requested_by_username,
      reversalAmount: parseFloat(pending.reversal_amount),
      createdAt: pending.created_at,
      isOwnRequest: pending.requested_by === req.user!.userId,
    };

    let base: PreviewBody;
    if (pending.entity_type === 'loading') base = await previewLoadingCancel(pending);
    else if (pending.entity_type === 'transaction') base = await previewTransactionCancel(pending);
    else throw createError(400, 'This request type cannot be previewed');

    // Everything that would stop the approval, gathered where the approval
    // checks it: the plan's problems, the shift verdict, the two-person rule
    // and a request nobody may decide twice.
    const problems = [...base.problems];
    if (pending.status !== 'pending') problems.push(`This request is already ${pending.status}`);
    if (request.isOwnRequest) problems.push('You raised this request — another administrator has to decide it');
    const safeToApply = problems.length === 0 && base.shift.open;

    res.json({ success: true, data: { ...base, problems, safeToApply, request } });
  } catch (error) {
    next(error);
  }
});

// Approve a pending reversal (admin only)
router.post('/reversals/:reversalId/approve', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user!.roles.includes('administrator')) {
    return next(createError(403, 'Only administrators can approve reversals'));
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const pending = (await client.query(
      `SELECT * FROM pending_reversals WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [req.params.reversalId]
    )).rows[0];
    if (!pending) throw createError(404, 'Pending reversal not found or already processed');
    if (pending.requested_by === req.user!.userId) {
      throw createError(403, 'You cannot approve your own reversal request');
    }

    // Loading cancellations ride the same queue — the request row says which
    // record it is deciding, and each branch executes its own kind.
    if (pending.entity_type === 'loading') {
      const meta = (await client.query(
        `SELECT account_id, transaction_number FROM loading_transactions WHERE id = $1`,
        [pending.entity_id]
      )).rows[0];
      if (!meta) throw createError(404, 'Loading transaction not found');
      // Approving a cancellation executes it, so the branch has to be open for
      // it — the request may have been raised under one shift and approved
      // under a closed branch (D17).
      await assertOpenShift(meta.account_id, undefined);

      const result = await executeLoadingCancel(client, {
        loadingId: pending.entity_id,
        reason: pending.reason || 'Admin approved cancellation',
      });

      const approvedLoading = await client.query(
        `UPDATE pending_reversals SET status = 'approved', approved_by = $1, updated_at = NOW()
          WHERE id = $2 AND status = 'pending'`,
        [req.user!.userId, req.params.reversalId]
      );
      if (approvedLoading.rowCount !== 1) throw createError(409, 'This cancellation request was already processed');

      await client.query('COMMIT');

      await createAuditLog({
        userId: req.user!.userId,
        action: 'loading.reversal_approved',
        entity: 'loading_transaction',
        entityId: pending.entity_id,
        ipAddress: req.ip,
        newData: {
          transactionNumber: meta.transaction_number,
          reason: pending.reason,
          affected: result.affected,
          approvedBy: req.user!.userId,
        },
      });

      res.json({ success: true, data: { status: 'reversed', affected: result.affected } });
      return;
    }

    const original = (await client.query(
      `SELECT t.*, tt.direction, tt.code FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [pending.entity_id]
    )).rows[0];
    if (!original) throw createError(404, 'Original transaction not found');
    if (original.status === 'reversed') throw createError(400, 'Transaction already reversed');
    if (original.status !== 'completed') throw createError(400, 'Only completed transactions can be reversed');

    // Approving a reversal executes it, so the branch has to be open for it —
    // the request may have been raised under one shift and approved under a
    // closed branch (D17).
    await assertOpenShift(original.account_id, original.code);

    // Execute the reversal
    const totalOriginalAmount = movementTotalOf(original);

    // The drawer's side of the original, unwound with it — the same leg the
    // immediate path posts, read from the rows the original wrote so the
    // movement comes back to the centavo, whichever way the fee was taken
    // (unwindDrawerLeg). Resolved before anything is written, so a leg that
    // cannot be posted leaves both records alone.
    const drawerSide = unwindDrawerLeg(
      await recordedLedgerRows(client, original.id, original.account_id)
    );
    await assertDrawerCanFund(drawerSide);

    // Closed is closed, on both legs of the reversal — the account the movement
    // returns to and the till it returns from (the same refusal corrections
    // give, in the approval's voice).
    const closingIds = [original.account_id, ...(drawerSide ? [drawerSide.accountId] : [])];
    const closingAccounts = (await client.query(
      `SELECT id, name, status FROM accounts WHERE id = ANY($1)`,
      [closingIds]
    )).rows;
    const closedNames = closedAccountNames(closingAccounts);
    if (closedNames.length > 0) {
      throw createError(409, `Refusing to approve — closed accounts cannot move: ${closedNames.join(', ')}`);
    }

    await client.query(
      `UPDATE transactions SET status = 'reversed', updated_at = NOW() WHERE id = $1`,
      [pending.entity_id]
    );

    const reverseEntryType = original.direction === 'in' ? 'debit' : 'credit';
    const reverseTypeId = (await client.query<{ id: string }>(
      `SELECT id FROM transaction_types WHERE code = $1`,
      [original.direction === 'in' ? 'adjustment_out' : 'adjustment_in']
    )).rows[0];

    const reverseTx = (await client.query(
      `INSERT INTO transactions (account_id, transaction_type_id, amount, fee, net_amount,
       reference_number, transaction_date, description, status, created_by, payment_method)
       VALUES ($1, $2, $3, 0, $3, $4, NOW(), $5, 'completed', $6, $7)
       RETURNING *`,
      [
        original.account_id, reverseTypeId!.id, totalOriginalAmount,
        `REV-${original.transaction_number}`,
        `Reversal: ${pending.reason || original.description || 'Admin approved reversal'}`,
        req.user!.userId,
        // The tender the original declared, so a row owning a drawer leg
        // declares the same one (NULL for the historical rows, unchanged).
        original.payment_method ?? null,
      ]
    )).rows[0];

    try {
      await processTransaction(
        original.account_id, reverseTypeId!.id, totalOriginalAmount, 0,
        reverseEntryType as 'debit' | 'credit', reverseTx!.id,
        `REV-${original.transaction_number}`, `Reversal: ${pending.reason || 'Admin approved reversal'}`,
        new Date(), client,
        drawerSide ? [drawerSide] : []
      );
    } catch (err: any) {
      if (err?.message !== 'Insufficient balance') throw err;
      const acct = (await client.query(
        `SELECT name, current_balance FROM accounts WHERE id = $1`,
        [original.account_id]
      )).rows[0];
      if (!acct) throw err;
      throw createError(400,
        `Cannot approve reversal: it would take ${acct.name} below zero ` +
        `(balance ₱${Number(acct.current_balance).toFixed(2)}, reversal needs ₱${totalOriginalAmount.toFixed(2)})`);
    }

    const approved = await client.query(
      `UPDATE pending_reversals SET status = 'approved', approved_by = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'pending'`,
      [req.user!.userId, req.params.reversalId]
    );
    if (approved.rowCount !== 1) throw createError(409, 'This reversal request was already processed');

    // The belt on the suspenders: commit only when every affected account
    // still reconciles after the mirror landed — chain, balance and last row
    // (the gate every correction commits behind, now on approvals too: the
    // answer to "check all the affected accounts" happens inside the very
    // transaction that would post them).
    const verdict = await auditInside(client, closingIds);
    if (!verdict.accounts.every((a) => a.reconciled)) {
      const bad = verdict.accounts.filter((a) => !a.reconciled).map((a) => `${a.name} (gap ${a.gap})`);
      throw createError(409, `Refusing to commit — ${bad.join(', ')} did not reconcile after reversal`);
    }

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.reversal_approved',
      entity: 'transaction',
      entityId: pending.entity_id,
      ipAddress: req.ip,
      newData: { originalNumber: original.transaction_number, approvedBy: req.user!.userId },
    });

    // The affected balances as they stand once the transaction committed — the
    // approve response carries them so the queue can show what actually moved,
    // not only what the preview promised.
    const affected = await query(
      `SELECT id, name, current_balance AS balance FROM accounts WHERE id = ANY($1)`,
      [closingIds]
    );

    res.json({ success: true, data: { reversal: reverseTx, affected } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// Reject a pending reversal (admin only)
router.post('/reversals/:reversalId/reject', authorize('transactions.write'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAdmin = req.user!.roles.includes('administrator');
    if (!isAdmin) throw createError(403, 'Only administrators can reject reversals');

    const { reason } = req.body;

    const target = await queryOne<{ requested_by: string }>(
      `SELECT requested_by FROM pending_reversals WHERE id = $1 AND status = 'pending'`,
      [req.params.reversalId]
    );
    if (!target) throw createError(404, 'Pending reversal not found or already processed');
    if (target.requested_by === req.user!.userId) {
      throw createError(403, 'You cannot reject your own reversal request');
    }

    const pending = await queryOne(
      `UPDATE pending_reversals SET status = 'rejected', approved_by = $1, reason = COALESCE($2, reason), updated_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [req.user!.userId, reason || null, req.params.reversalId]
    );
    if (!pending) throw createError(404, 'Pending reversal not found or already processed');

    await createAuditLog({
      userId: req.user!.userId,
      // Filed under whichever record kind the request belongs to, so a loading
      // cancellation lands in the audit log as one and a transaction reversal
      // keeps the action it has always written.
      action: `${pending.entity_type}.reversal_rejected`,
      entity: pending.entity_type === 'loading' ? 'loading_transaction' : 'transaction',
      entityId: pending.entity_id,
      ipAddress: req.ip,
      newData: { reason },
    });

    res.json({ success: true, data: pending });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authorize('transactions.delete'), async (req: Request, res: Response, next: NextFunction) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const original = await client.query(
      `SELECT t.id, t.transaction_number, t.amount, t.net_amount, t.fee, t.status, t.account_id, t.created_by,
              t.fee_added_to_balance, t.additional_charges, tt.direction
       FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    const transaction = original.rows[0];
    await assertBranch(req, transaction?.account_id, 'transactions.write_all', 'Transaction not found');
    if (transaction.status === 'completed' || transaction.status === 'reversed') {
      throw createError(400, transaction.status === 'reversed'
        ? 'Reversed transactions cannot be deleted — its reversal is already recorded'
        : 'Completed transactions cannot be deleted — request a reversal instead');
    }

    // Restore account balance for completed transactions
    if (transaction.status === 'completed') {
      const amount = parseFloat(transaction.net_amount || transaction.amount);
      const charges = (transaction.additional_charges || [])
        .reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);
      // Read back the figure the row actually posted rather than recomputing
      // one: `net_amount` is what the account's own rows summed to when it was
      // written — the four-cell figure since D42, the amount as typed since
      // D40, the shrunk figure for a legacy deducted-fee row — so the undo
      // matches the post exactly either way.
      const totalImpact = amount + charges;
      const balanceDelta = transaction.direction === 'in' ? totalImpact : -totalImpact;

      await client.query(
        `UPDATE accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
        [balanceDelta, transaction.account_id]
      );
    }

    await client.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [req.params.id]);
    await client.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.deleted',
      entity: 'transaction',
      entityId: req.params.id,
      ipAddress: req.ip,
      oldData: { transactionNumber: transaction.transaction_number, amount: parseFloat(transaction.amount), status: transaction.status },
    });

    res.json({ success: true, data: { message: 'Transaction deleted' } });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

export default router;
