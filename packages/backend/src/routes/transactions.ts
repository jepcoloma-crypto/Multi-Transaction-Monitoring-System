import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getClient } from '../database/connection';
import { authenticate, authorize } from '../middleware/auth';
import { branchClause, assertBranch } from '../middleware/scope';
import { assertOpenShift } from '../middleware/shiftGate';
import { createError } from '../middleware/error';
import { createAuditLog } from '../services/audit';
import { processTransaction, updateAccountBalance, createLedgerEntry, lockAccounts } from '../services/balance';
import type { CounterpartyLeg } from '../services/balance';
import { isCashMovement, isPaymentMethod, isMovementPaymentMethod, PAYMENT_METHODS, MOVEMENT_PAYMENT_METHODS, drawerLeg, resolveCashAccountMethod, directTypeRefusal, expenseFeeRefusal } from '../services/cashManagement';
import { calculateTieredFee } from '../services/feeCalc';
import { parseManilaDateTime, manilaDateKey } from '../services/manilaTime';
import { expenseApprovalThreshold } from '../services/settings';
import { withTransaction } from '../services/withTransaction';
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
              tt.name as type_name, tt.direction, a.name as account_name
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
// The amount comes from drawerLeg rather than being restated here, so the rule
// covering both directions and both fee modes lives in one tested place. The
// account is the branch's own cash account; a movement already booked against
// one — an expense paid straight out of the float — posts a single row rather
// than two against the same balance.
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
  fee: number
): Promise<CounterpartyLeg | null> {
  if (paymentMethod !== 'cash') return null;

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
  if (drawer.id === accountId) return null;

  const leg = drawerLeg(signedAmount, fee);
  if (!leg) return null;

  if (leg.entryType === 'debit') {
    const balance = await queryOne<{ current_balance: string }>(
      'SELECT current_balance FROM accounts WHERE id = $1', [drawer.id]
    );
    const held = parseFloat(balance?.current_balance || '0');
    if (held < leg.amount) {
      throw createError(400,
        `The branch's cash drawer holds ${held.toFixed(2)} but this movement hands out ${leg.amount.toFixed(2)}`);
    }
  }

  return { accountId: drawer.id, amount: leg.amount, entryType: leg.entryType };
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
    if (amountNum < 0) throw createError(400, 'Amount cannot be negative');

    let feeNum = parseFloat(fee || '0');
    if (feeNum < 0) throw createError(400, 'Fee cannot be negative');

    const feeConfigs = await query<{ id: string; fee_type: string; fee_value: number; min_fee: number; max_fee: number | null; calculation_method: string }>(
      `SELECT id, fee_type, fee_value, min_fee, max_fee, calculation_method FROM transaction_fees
       WHERE transaction_type_id = $1 AND is_active = true
       AND (transaction_category_id IS NULL OR transaction_category_id = $2)`,
      [resolvedTypeId, resolvedCategoryId]
    );
    if (feeConfigs.length > 0 && !manualFee) {
      const feeTiers = await query<any>(
        'SELECT * FROM transaction_fee_tiers WHERE fee_id = ANY($1::uuid[]) ORDER BY min_amount',
        [feeConfigs.map((f) => f.id)]
      );
      let totalFee = 0;
      for (const fc of feeConfigs) {
        const configTiers = feeTiers.filter((t: any) => t.fee_id === fc.id);
        const tierResult = calculateTieredFee(fc, configTiers, amountNum);
        let calcFee: number;
        if (tierResult !== null) {
          calcFee = tierResult;
        } else if (fc.fee_type === 'percentage') {
          calcFee = (amountNum * Number(fc.fee_value)) / 100;
        } else {
          calcFee = Number(fc.fee_value);
        }
        if (fc.min_fee && calcFee < Number(fc.min_fee)) calcFee = Number(fc.min_fee);
        if (fc.max_fee && calcFee > Number(fc.max_fee)) calcFee = Number(fc.max_fee);
        totalFee += calcFee;
      }
      feeNum = Math.round(totalFee * 100) / 100;
    }
    feeNum = Math.ceil(feeNum - 1e-9);

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
    // money with no second signature behind it.
    const typeRefusal = directTypeRefusal(txType.code);
    if (typeRefusal) throw createError(400, typeRefusal);
    const feeRefusal = expenseFeeRefusal(txType.code, feeNum);
    if (feeRefusal) throw createError(400, feeRefusal);

    // Before anything is written, and before the payment-method question: if the
    // branch is shut there is nothing an operator can fix by filling in a field
    // (D17). Owner funding is exempt inside the guard — it is how the drawer
    // gets funded in the first place. The date the row will carry is checked
    // against the shift's date here, so a mistyped day is caught before any of
    // the balance work below rather than after it.
    await assertOpenShift(accountId, txType.code, { eventDate: bookedAt });

    // A cash movement is not recorded until the operator says how the money
    // actually changed hands, because that is what decides whether the drawer
    // takes part. Presence is enforced here rather than as a NOT NULL column
    // constraint because reversal rewrites the original row (see :798 and :1095
    // below) and all 108 historical cash movements are NULL — a constraint would
    // have made every one of them un-reversible the moment it ran, and
    // backfilling them would mean guessing which were physical cash. Migration
    // 036 records that reasoning and carries the value check instead.
    let paymentMethodValue =
      paymentMethod === undefined || paymentMethod === null || String(paymentMethod).trim() === ''
        ? null
        : String(paymentMethod).trim();

    if (paymentMethodValue !== null && !isPaymentMethod(paymentMethodValue)) {
      throw createError(400, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    if (isCashMovement(txType.code) && !isMovementPaymentMethod(paymentMethodValue)) {
      throw createError(400,
        `A ${txType.code.replace(/_/g, ' ')} needs a payment method: ${MOVEMENT_PAYMENT_METHODS.join(', ')}`);
    }

    // A cash account's balance *is* the drawer's cash, so it can only have been
    // paid in or paid out physically. Left to the operator this is the field
    // that records a wallet movement the drawer never saw, and the shift then
    // closes short against money nobody counted. A blank is answered by the
    // account; a method that disagrees is refused rather than quietly
    // overwritten, because overwriting would record something nobody chose.
    const cashMethod = resolveCashAccountMethod(account.type_code, paymentMethodValue);
    if (cashMethod.action === 'refuse') throw createError(400, cashMethod.message);
    if (cashMethod.action === 'force') paymentMethodValue = cashMethod.method;

    // A provider charge on a cash movement is the company's own cost: the
    // customer is never billed for it, so it cannot be folded into this row's
    // amount or fee. It is recorded as a second, linked row typed `expense`
    // (migration 032 explains why the two figures must stay separate).
    //
    // Keyed in by hand because it happens on only some movements — a rule
    // that fired on every cash transaction would invent charges the provider
    // never made. Restricted to money actually moving in or out, so it can
    // never be bolted onto a reversal or an adjustment.
    let providerChargeNum = 0;
    if (providerCharge !== undefined && providerCharge !== null && providerCharge !== '') {
      providerChargeNum = parseFloat(String(providerCharge));
      if (!Number.isFinite(providerChargeNum)) throw createError(400, 'Provider charge must be a number');
      if (providerChargeNum < 0) throw createError(400, 'Provider charge cannot be negative');
      providerChargeNum = Math.round(providerChargeNum * 100) / 100;
      if (providerChargeNum > 0 && txType.direction !== 'in' && txType.direction !== 'out') {
        throw createError(400, 'A provider charge can only be recorded on a cash-in or cash-out');
      }
      if (providerChargeNum > 0 && txType.code === 'expense') {
        throw createError(400, 'A provider charge cannot be added to an expense row');
      }
    }

    const entryType = txType.direction === 'in' || txType.direction === 'adjustment' ? 'credit' : 'debit';
    const deductFee = feeAddedToBalance === false && feeNum > 0;
    if (deductFee && amountNum < feeNum) {
      throw createError(400, 'Fee cannot exceed the transaction amount when deducted from transaction amount');
    }
    // A deducted fee shrinks what a credit lands on, never what a debit removes.
    // Taking it from a debit as well collected it from nobody: the balance would
    // drop by amount − fee and the customer would be handed amount − fee, so the
    // fee was booked as income and physically never taken. On a debit the whole
    // amount leaves and the drawer is what retains the fee (design D13).
    const netAmount = deductFee && entryType === 'credit'
      ? Math.round((amountNum - feeNum) * 100) / 100
      : amountNum;
    const totalCharges = (additionalCharges || []).reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);
    const totalAmount = netAmount + totalCharges;

    const isOwnerFund = txType.code === 'owner_funding' || txType.code === 'owner_return';
    const isOperatingExpense = txType.code === 'operating_expense';
    const isControlled = isOwnerFund || isOperatingExpense;
    const isAdminCreator = (req.user!.roles || []).includes('administrator');
    // An administrator who creates an owner fund settles it at once — that
    // path's established behaviour, deliberately left alone. An operating
    // expense settles when it is recorded at or below the configured threshold
    // and waits for a second signature above it, so small purchases no longer
    // sit in a queue nobody needed. The same threshold is served to the expense
    // form, so what the operator is told matches what the books will do.
    const expenseThreshold = await expenseApprovalThreshold();
    const requiresApproval = isOperatingExpense
      ? amountNum > expenseThreshold
      : isControlled && !isAdminCreator;
    const finalStatus = requiresApproval ? 'pending' : (status || 'completed');

    if (finalStatus !== 'completed' && !isControlled) {
      throw createError(400, 'Only owner fund movements and operating expenses can be created as pending');
    }

    // Rejected rather than silently dropped: a charge the operator typed in
    // and the books then forgot would be worse than one refused up front.
    if (providerChargeNum > 0 && finalStatus !== 'completed') {
      throw createError(400, 'A provider charge can only be recorded on a transaction that completes now');
    }

    // Resolved before anything is written, so a branch with no drawer refuses
    // the whole submission rather than leaving a row whose drawer leg never
    // landed. A pending row moves nothing yet — its leg belongs to approval,
    // which is where the money actually leaves (design D5).
    const counterparty = finalStatus === 'completed'
      ? await resolveDrawerLeg(
          accountId, paymentMethodValue, entryType === 'credit' ? totalAmount : -totalAmount, feeNum
        )
      : null;

    // A pending row withdraws nothing yet, so there is nothing to fund: the
    // balance belongs to approval, which checks it inside the same
    // transaction that writes the debit. Checking here would refuse a
    // proposal merely because owner funding has not arrived yet — and would
    // make the float impossible to open with, since a new revolving fund
    // starts at zero.
    if (entryType === 'debit' && finalStatus !== 'pending') {
      const balance = await queryOne<{ current_balance: string }>(
        'SELECT current_balance FROM accounts WHERE id = $1 FOR UPDATE', [accountId]
      );
      // The charge is a second debit from the same balance, so the account has
      // to carry both. Rounded before comparing: two 2-decimal figures added
      // as floats can land a hair above the true total and reject a balance
      // that is exactly enough.
      const required = Math.round((totalAmount + providerChargeNum) * 100) / 100;
      if (parseFloat(balance?.current_balance || '0') < required) {
        throw createError(400, providerChargeNum > 0
          ? 'Insufficient balance for the transaction plus the provider charge'
          : 'Insufficient balance');
      }
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
        feeAddedToBalance !== false, counterparty
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
        chargeRow.id, null, chargeDescription, effectiveDate, client, true
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

      let newBalance: number;
      try {
        newBalance = await updateAccountBalance(original.account_id, amount, entryType, client);
      } catch (err: any) {
        if (err?.message === 'Insufficient balance') throw createError(400, 'Insufficient balance for charge adjustment');
        throw err;
      }

      await createLedgerEntry(
        original.account_id,
        entryType,
        amount,
        newBalance,
        original.id,
        null,
        original.reference_number,
        `Additional charges updated: ${oldTotal.toFixed(2)} -> ${newTotal.toFixed(2)}`,
        new Date(),
        client
      );
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

    const deductFee = feeAddedToBalance === false && feeNum > 0;
    if (deductFee && amountInput < feeNum) {
      throw createError(400, 'Fee cannot exceed the transaction amount when deducted from transaction amount');
    }
    // The same rule as creation: a deducted fee shrinks what a credit lands on,
    // never what a debit removes (design D13). Editing must reproduce what the
    // create path would have written, or correcting an amount would quietly
    // re-price the movement.
    const isCredit = row.direction === 'in' || row.direction === 'adjustment';
    const netAmount = deductFee && isCredit ? round2(amountInput - feeNum) : amountInput;

    set('amount', round2(amountInput));
    set('fee', feeNum);
    set('net_amount', round2(netAmount));
    set('fee_added_to_balance', feeAddedToBalance);

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
        const originalCharges = original.additional_charges || [];
        const totalOriginalAmount = parseFloat(original.net_amount || original.amount) + originalCharges.reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);

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
           reference_number, transaction_date, description, status, created_by)
           VALUES ($1, $2, $3, 0, $3, $4, NOW(), $5, 'completed', $6)
           RETURNING *`,
          [
            original.account_id, reverseTypeId!.id, original.amount,
            `REV-${original.transaction_number}`, `Reversal: ${reason || original.description || 'Transaction reversal'}`,
            req.user!.userId,
          ]
        )).rows[0];

        await processTransaction(
          original.account_id, reverseTypeId!.id, totalOriginalAmount, 0,
          reverseEntryType as 'debit' | 'credit', created.id,
          `REV-${original.transaction_number}`, `Reversal: ${reason || 'Transaction reversal'}`,
          new Date(), client
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
      // Non-admin: create pending reversal for admin approval
      const originalCharges = original.additional_charges || [];
      const reversalAmount = parseFloat(original.net_amount || original.amount) + originalCharges.reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);

      const pending = await queryOne(
        `INSERT INTO pending_reversals (entity_type, entity_id, account_id, requested_by, reversal_amount, reason)
         VALUES ('transaction', $1, $2, $3, $4, $5)
         RETURNING *`,
        [req.params.id, original.account_id, req.user!.userId, reversalAmount, reason || null]
      );

      await createAuditLog({
        userId: req.user!.userId,
        action: 'transaction.reverse_requested',
        entity: 'transaction',
        entityId: req.params.id,
        ipAddress: req.ip,
        newData: { originalNumber: original.transaction_number, reason, pendingReversalId: pending!.id },
      });

      res.json({ success: true, data: pending });
    }
  } catch (error) {
    next(error);
  }
});

type ControlledCode = 'owner_funding' | 'owner_return' | 'operating_expense';

// The three movements that may only ever be created as `pending` and must be
// settled by a second person. Everything else completes on creation or runs its
// own workflow (transfers, reversals).
function assertControlledType(code: string): asserts code is ControlledCode {
  if (code !== 'owner_funding' && code !== 'owner_return' && code !== 'operating_expense') {
    throw createError(400, 'Only owner fund movements and operating expenses require approval');
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
    // Releasing an operating cost is a head-office decision, so expenses sit
    // behind administrator-only on top of the two-person rule — the same bar
    // reversals already clear. Owner funds keep their wider approver set
    // untouched; changing it here would alter live behaviour unrelated to
    // this feature.
    if (row.code === 'operating_expense' && !req.user!.roles.includes('administrator')) {
      throw createError(403, 'Only administrators can approve operating expenses');
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
    const counterparty = await resolveDrawerLeg(
      row.account_id, row.payment_method,
      entryType === 'credit' ? totalAmount : -totalAmount, parseFloat(row.fee || 0)
    );

    await lockAccounts(client, [row.account_id, ...(counterparty ? [counterparty.accountId] : [])]);

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
      row.fee_added_to_balance !== false, counterparty
    );

    const updated = (await client.query(
      `UPDATE transactions SET status = 'completed', approved_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user!.userId, req.params.id]
    )).rows[0];

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: row.code === 'operating_expense'
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
    // Same head-office gate as approval — declining an operating expense is
    // the same decision as releasing one.
    if (row.code === 'operating_expense' && !req.user!.roles.includes('administrator')) {
      throw createError(403, 'Only administrators can reject operating expenses');
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
      action: row.code === 'operating_expense'
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
      `SELECT pr.*, t.transaction_number, t.amount AS original_amount, t.status AS original_status,
              t.description, tt.name AS type_name, tt.direction, a.name AS account_name,
              u.username AS requested_by_username, ru.username AS decided_by_username
       FROM pending_reversals pr
       JOIN transactions t ON pr.entity_id = t.id
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       JOIN accounts a ON t.account_id = a.id
       JOIN users u ON pr.requested_by = u.id
       LEFT JOIN users ru ON pr.approved_by = ru.id
       WHERE pr.entity_type = 'transaction' AND pr.status = $1
       ORDER BY pr.created_at ASC`,
      [status]
    );
    res.json({ success: true, data: { data: rows } });
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

    const original = (await client.query(
      `SELECT t.*, tt.direction, tt.code FROM transactions t
       JOIN transaction_types tt ON t.transaction_type_id = tt.id
       WHERE t.id = $1`,
      [pending.entity_id]
    )).rows[0];
    if (!original) throw createError(404, 'Original transaction not found');
    if (original.status === 'reversed') throw createError(400, 'Transaction already reversed');

    // Approving a reversal executes it, so the branch has to be open for it —
    // the request may have been raised under one shift and approved under a
    // closed branch (D17).
    await assertOpenShift(original.account_id, original.code);

    // Execute the reversal
    const originalCharges = original.additional_charges || [];
    const totalOriginalAmount = parseFloat(original.net_amount || original.amount) + originalCharges.reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);

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
       reference_number, transaction_date, description, status, created_by)
       VALUES ($1, $2, $3, 0, $3, $4, NOW(), $5, 'completed', $6)
       RETURNING *`,
      [
        original.account_id, reverseTypeId!.id, totalOriginalAmount,
        `REV-${original.transaction_number}`,
        `Reversal: ${pending.reason || original.description || 'Admin approved reversal'}`,
        req.user!.userId,
      ]
    )).rows[0];

    try {
      await processTransaction(
        original.account_id, reverseTypeId!.id, totalOriginalAmount, 0,
        reverseEntryType as 'debit' | 'credit', reverseTx!.id,
        `REV-${original.transaction_number}`, `Reversal: ${pending.reason || 'Admin approved reversal'}`,
        new Date(), client
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

    await client.query('COMMIT');

    await createAuditLog({
      userId: req.user!.userId,
      action: 'transaction.reversal_approved',
      entity: 'transaction',
      entityId: pending.entity_id,
      ipAddress: req.ip,
      newData: { originalNumber: original.transaction_number, approvedBy: req.user!.userId },
    });

    res.json({ success: true, data: reverseTx });
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
      action: 'transaction.reversal_rejected',
      entity: 'transaction',
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
      `SELECT t.id, t.transaction_number, t.amount, t.fee, t.status, t.account_id, t.created_by,
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
      const amount = parseFloat(transaction.amount);
      const fee = parseFloat(transaction.fee || 0);
      const charges = (transaction.additional_charges || [])
        .reduce((sum: number, c: any) => sum + (parseFloat(c.amount) || 0), 0);
      const netAmount = transaction.fee_added_to_balance ? amount : amount - fee;
      const totalImpact = netAmount + charges;
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
