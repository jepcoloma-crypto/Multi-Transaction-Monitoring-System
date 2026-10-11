// Shapes ledger rows into a Sources and Uses statement with a tie-out against
// account balances. Pure — no network, no database — so every bucket and
// subtotal is testable without one.
//
// The statement is built from ledger_entries rather than from the income
// report's figures on purpose. Fee income is not a separate credit anywhere in
// the ledger: a transfer posts one debit to the sender and one credit to the
// receiver, and the fee rides inside them. A statement that tried to reproduce
// totalIncome would therefore stop adding up to the balance it exists to
// explain.
//
// So the two answer different questions and are not expected to agree:
//   this one   — where did the cash physically move
//   income     — what did the company earn
//
// Because every ledger row lands in exactly one bucket, the tie-out holds by
// construction: opening + Σsources − Σuses = closing. If it ever does not,
// rows have been dropped or double-counted, which is what the check exposes.

import { manilaDateTimeKey } from './manilaTime';
import { createError } from '../middleware/error';

export type CashBucket =
  | 'owner_capital'
  | 'borrowings'
  | 'transfers'
  | 'customer_cash'
  | 'load'
  | 'operating_expenses'
  | 'provider_charges'
  | 'payments'
  | 'cash_payments'
  | 'other_income'
  | 'adjustments'
  | 'corrections'
  | 'opening_float'
  | 'other';

export const BUCKET_LABELS: Record<CashBucket, string> = {
  owner_capital: 'Owner Capital',
  borrowings: 'Borrowings',
  transfers: 'Branch Transfers',
  customer_cash: 'Customer Cash',
  load: 'Load',
  operating_expenses: 'Operating Expenses',
  provider_charges: 'Provider Charges',
  payments: 'Payments & Bills',
  cash_payments: 'Cash Payments',
  other_income: 'Other Income',
  adjustments: 'Adjustments',
  corrections: 'Corrections',
  opening_float: 'Opening Float',
  other: 'Other',
};

// The buckets where the drawer paid out the company's own money, and the only
// rows that make up a cash expense.
//
// Direction alone cannot answer this. `owner_return` and `cash_out` both leave
// the drawer, but an owner drawing capital back out and a customer being handed
// their money are settlements, not spending — totalling every debit would have
// booked a 200,000 owner return as an expense. These three are the rows where
// the company was the party that paid.
//
// `cash_payments` is the closest call and still stays out. Paying a supplier or
// settling what is owed is money leaving the company, which is more than
// `owner_return` can claim — but it buys or clears a debt rather than being the
// cost of running the business, and the report this total feeds is the one
// somebody reads to learn what operating costs them. It gets its own line in
// Sources and Uses instead, so the peso is never invisible, only not mislabelled.
export const EXPENSE_BUCKETS: readonly CashBucket[] = [
  'operating_expenses',
  'provider_charges',
  'payments',
];

const toCents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

// The movement codes where money can physically change hands, and so the only
// ones asked for a payment method. These are the codes the drawer gate keys on;
// every other type is money moving between accounts rather than through them.
export const CASH_MOVEMENT_CODES = [
  'cash_in',
  'cash_out',
  'customer_payment',
  'customer_withdrawal',
] as const;

// Everything the column may store, matching paymentMethodOptions on the client.
export const PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya', 'provider_interest'] as const;

// provider_interest is excluded from what a cash movement may carry: it
// describes where an interest credit came from, not how cash was handed over,
// and accepting it on a cash movement would record a method the operator could
// not have used.
export const MOVEMENT_PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type MovementPaymentMethod = (typeof MOVEMENT_PAYMENT_METHODS)[number];

export function isCashMovement(code: string | null | undefined): boolean {
  return (CASH_MOVEMENT_CODES as readonly string[]).includes(String(code));
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isMovementPaymentMethod(value: unknown): value is MovementPaymentMethod {
  return typeof value === 'string' && (MOVEMENT_PAYMENT_METHODS as readonly string[]).includes(value);
}

// Why a transaction type may not be created by file import, or null when it may.
//
// A CSV or JSON row has nowhere to declare how the money changed hands, and the
// drawer leg cannot be decided without that (D11). An imported cash movement
// would therefore be born single-leg and permanently undeclared — exactly the
// state D11 exists to prevent going forward — and import also sits outside the
// shift gate (D17), so it would move physical cash with no open shift behind
// it. The entry form is where both are enforced, so this refuses rather than
// defaulting to a method nobody chose.
//
// Returning the reason rather than a boolean keeps it beside the policy it
// explains and lets the refusal be tested without standing up a route.
export function importTypeRefusal(typeCode: string | null | undefined): string | null {
  if (!isCashMovement(typeCode)) return null;
  return `Cash movement "${typeCode}" cannot be imported: a file cannot declare how the money changed hands. Record it through the entry form.`;
}

export interface DrawerLeg {
  amount: number;
  entryType: 'debit' | 'credit';
}

// What the drawer does when a movement is settled in physical cash.
//
// The drawer and the account are two pools of the same money, so a cash
// movement transfers between them: the drawer moves opposite to the account
// leg, and the fee is credited back to the drawer as income.
//
//   cash-in,  separate   account +500   drawer -490
//   cash-in,  deducted   account +490   drawer -480
//   cash-out, separate   account -500   drawer +510
//   cash-out, deducted   account -500   drawer +510
//
// The sign is what makes the two legs sum to the fee in every row:
//
//     signedAmount + (fee - signedAmount) = fee
//
// so the books grow by exactly what the income report books. Adding them in
// the same direction instead grew the total by the whole movement again — a
// ₱500 cash-in would have added ₱990 to the total while income reported ₱10.
// The two cash-out rows coincide because a debit is never shrunk by a deducted
// fee (D13): the account loses the whole 500 and the drawer keeps the 10.
//
// `signedAmount` is the signed account leg; `fee` is always positive. Null means
// nothing physically changed hands and no ledger row should be written.
export function drawerLeg(signedAmount: number, fee: number): DrawerLeg | null {
  const delta = Math.round((fee - signedAmount) * 100) / 100;
  if (delta === 0) return null;
  return delta > 0
    ? { amount: delta, entryType: 'credit' }
    : { amount: -delta, entryType: 'debit' };
}

/** What the drawer does, in the shape the posting path takes a counterparty in. */
export interface DrawerCounterparty {
  accountId: string;
  amount: number;
  entryType: 'debit' | 'credit';
}

/** One ledger row as the database returns it, for the two functions below. */
export interface RecordedLedgerRow {
  account_id: string;
  amount: string | number;
  entry_type: 'debit' | 'credit';
}

/**
 * The single account a movement's drawer side sits on.
 *
 * Read from the ledger, not from `payment_method`: the rows are the truth about
 * what posted, and the method says nothing about the 108 historical movements
 * stored NULL. `null` means this movement has no drawer side — a GCash row, or
 * an expense booked straight out of the float, where the account *is* the
 * drawer.
 *
 * More than one such account is refused rather than chosen between: a
 * transaction has one drawer, and picking which of two the money moved through
 * would move the wrong one. That state cannot be reached today (a transaction
 * owns ledger rows on a single account, or corrections refuse it) — the refusal
 * is here so it stays unreachable rather than silently writing half a pair.
 */
export function drawerAccountId(rows: RecordedLedgerRow[]): string | null {
  if (rows.length === 0) return null;

  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  if (accountIds.length > 1) {
    throw createError(
      409,
      'This movement posted on more than one account besides its own — refusing to move the drawer',
    );
  }
  return accountIds[0];
}

/**
 * The drawer's side of an unwind: the movement the original made, run backwards
 * — with the drawer keeping the fee it earned.
 *
 * Mirroring the recorded rows is what keeps the pair exact. Recomputing is not
 * the same number: `drawerLeg` answers from a movement's own signed amount and
 * fee, and a reversal books fee 0, so recomputing would not agree with the
 * ₱1,480 a ₱1,500 cash-in with a ₱20 fee actually posted. Mirroring also
 * carries the charges folded into `totalAmount` at creation and any charge
 * adjustment made since, without restating the rules that decided them.
 *
 * The fee mode then decides one thing — did the fee come back with the
 * movement, or did it stay where it was earned?
 *
 *   - Separate: the customer received the whole amount, so the fee was never
 *     inside the movement and the drawer keeps it. The unwind carries it on top
 *     of the mirror: that ₱1,500 cash-in is unwound by a credit of ₱1,500, not
 *     ₱1,480, so the ₱20 the branch earned ends up in the drawer where the
 *     income report says it is.
 *   - Deducted: the fee was handed back inside the movement, so the mirror
 *     already returns it and the unwind adds nothing.
 *
 * That is the same split the income report makes — a separate fee stays earned,
 * a deducted one is refunded — and making them agree is the point: two surfaces
 * that disagree about where the money is cannot both be right, and an operator
 * counting the till is the one who finds out.
 *
 * Several rows on the same account are summed, in whole centavos: corrections
 * append, so the drawer can legitimately own more than one row for the record
 * being undone, and a float error between them would leave a residue the count
 * cannot explain. A sum that cancels to zero writes no row at all.
 */
export function unwindDrawerLeg(
  rows: RecordedLedgerRow[],
  fee?: { cents: number; separate: boolean },
): DrawerCounterparty | null {
  const accountId = drawerAccountId(rows);
  if (!accountId) return null;

  const recorded = rows.reduce(
    (sum, row) => sum + (row.entry_type === 'credit' ? 1 : -1) * toCents(row.amount),
    0,
  );
  if (recorded === 0) return null;

  const unwind = -recorded + (fee?.separate ? fee.cents : 0);
  if (unwind === 0) return null;

  return unwind > 0
    ? { accountId, amount: money(unwind), entryType: 'credit' }
    : { accountId, amount: money(-unwind), entryType: 'debit' };
}

/**
 * The drawer's side of a charge that changed.
 *
 * Charges ride inside `totalAmount` at creation — the leg `resolveDrawerLeg`
 * posts is `fee − (netAmount + charges)` — so moving them moves the drawer by
 * the same amount, always against the account's own direction: the identity
 * `signed + drawer_delta = fee` holds only if the two sides move oppositely,
 * and a charge added to a cash-out is an amount the drawer hands out.
 *
 * `rows` decides whether there is a drawer side at all; this function only
 * states what it does when there is one.
 */
export function chargeDrawerLeg(
  rows: RecordedLedgerRow[],
  delta: number,
  accountEntryType: 'debit' | 'credit',
): DrawerCounterparty | null {
  const accountId = drawerAccountId(rows);
  const cents = toCents(delta);
  if (!accountId || cents === 0) return null;

  return {
    accountId,
    amount: money(Math.abs(cents)),
    entryType: accountEntryType === 'credit' ? 'debit' : 'credit',
  };
}

// The drawer participates only when the money is physically handed over. A
// GCash or bank movement lands in the wallet without passing through it, and
// giving those a drawer leg would double-count the same peso.
export function touchesDrawer(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === 'cash';
}

/**
 * What a cash-typed account may say about how money reached or left it.
 *
 * A cash account's balance *is* the drawer's cash, so crediting one means
 * physical cash walked in and debiting one means it walked out. The only
 * method that says so is `cash`: recording `gcash` against it books a wallet
 * movement the drawer never saw, and the next shift closes short against
 * money nobody counted. Every one of the 20 transactions already sitting on a
 * cash account in production carries `cash` — this makes that impossible to
 * get wrong rather than merely true so far.
 *
 * A missing method is filled in rather than refused: the account answers the
 * question, so asking again produces a 400 where the books already know. A
 * method that *disagrees* is refused rather than quietly overwritten, because
 * overwriting would record something the operator did not choose.
 */
export type CashAccountMethodOutcome =
  | { action: 'accept'; method: string | null }
  | { action: 'force'; method: 'cash' }
  | { action: 'refuse'; message: string };

export function resolveCashAccountMethod(
  accountTypeCode: string | null | undefined,
  paymentMethod: string | null | undefined
): CashAccountMethodOutcome {
  if (String(accountTypeCode) !== 'cash') {
    return { action: 'accept', method: paymentMethod ?? null };
  }

  const method =
    typeof paymentMethod === 'string' && paymentMethod.trim() !== '' ? paymentMethod.trim() : null;

  if (method === null) return { action: 'force', method: 'cash' };
  if (method === 'cash') return { action: 'accept', method: 'cash' };

  return {
    action: 'refuse',
    message:
      `A cash account holds physical cash, so it cannot have been paid by ${method}. ` +
      'Record it as cash, or choose the account that method actually paid.',
  };
}

/**
 * Why a transaction type may not be recorded directly, or null when it may.
 *
 * `expense` is the system's own row. It is written beside a cash movement
 * carrying a provider charge and links back through `linked_transaction_id`;
 * typed in by hand it posts a debit with no recipient and describes nothing.
 * It is also the one cost that would settle instantly, because only owner
 * funding and operating expenses route through the approval queue — so a
 * hand-typed Expense spends company money with no second signature, which is
 * exactly what the queue exists to prevent.
 *
 * A cost the company chose to pay is an operating expense.
 */
export function directTypeRefusal(typeCode: string | null | undefined): string | null {
  if (typeCode !== 'expense') return null;
  return 'The Expense type records a provider charge the company paid and was never billed for. ' +
    'It is written by the system when a cash movement carries a provider charge, and cannot be ' +
    'typed in. To record a cost the company chose to pay, use an operating expense.';
}

/**
 * A fee is income. Booking one on a cost would report the company as having
 * earned from an expense.
 */
export function expenseFeeRefusal(typeCode: string | null | undefined, fee: number): string | null {
  if (typeCode !== 'expense' || !(fee > 0)) return null;
  return 'An Expense row cannot carry a fee: a fee is income, and this row is a cost. ' +
    'The amount is what the provider charged.';
}

/**
 * Which types need a second signature, and which of those may be created as a
 * request rather than an entry.
 *
 * Three rules in one place because a route that recomputed them would be one
 * refactor from letting a type settle it should not have:
 *
 * - **Owner money** (funding and returns) waits unless an administrator records
 *   it. That path's established behaviour, deliberately unchanged.
 * - **Operating expenses and cash payments** wait above the configured
 *   threshold and settle below it, so small payouts never sat in a queue nobody
 *   needed. The two share one threshold because they are both cash leaving the
 *   drawer on purpose.
 * - **Borrowings** follow the owner-money rule: a loan creates a debt the
 *   company has to repay, so anyone who is not an administrator leaves it for a
 *   second signature. An administrator takes it at once, because the cash has
 *   already arrived in the drawer and leaving the row pending would put the
 *   shift's expected figure behind the physical count until someone approved
 *   it — a variance nobody created.
 *
 * `controlled` is the other half of the answer: only these types may be created
 * as pending at all, so it is what the create route checks against a caller
 * who asked for `status: 'pending'` on something ordinary.
 */
export function controlledApproval(
  typeCode: string | null | undefined,
  amount: number,
  expenseThreshold: number,
  isAdminCreator: boolean,
): { controlled: boolean; requiresApproval: boolean } {
  const isThresholdGated = typeCode === 'operating_expense' || typeCode === 'cash_payment';
  const controlled =
    typeCode === 'owner_funding' ||
    typeCode === 'owner_return' ||
    isThresholdGated ||
    typeCode === 'loan_received' ||
    typeCode === 'loan_repayment';
  // Both threshold-gated codes share one setting deliberately: they are the two
  // ways cash walks out of the drawer as a outflow somebody chose to make, and
  // a second threshold would only ever drift away from the first.
  const requiresApproval = isThresholdGated
    ? amount > expenseThreshold
    : controlled && !isAdminCreator;
  return { controlled, requiresApproval };
}

const money = (cents: number): number => cents / 100;

// A ledger row carries either a transaction (source_type 'transaction', with
// the type code reachable through it) or a non-transaction source such as a
// transfer, a loading operation, an admin balance edit or a gap fix. The
// transaction's type code is the more specific signal, so it wins whenever it
// is present — including for adjustment rows, which post through the same path
// as any other transaction even though their name suggests otherwise.
export function bucketFor(sourceType: string | null | undefined, txnCode: string | null | undefined): CashBucket {
  if (txnCode) {
    switch (txnCode) {
      case 'owner_funding':
      case 'owner_return':
        return 'owner_capital';
      case 'transfer_in':
      case 'transfer_out':
        return 'transfers';
      case 'cash_in':
      case 'cash_out':
      case 'customer_payment':
      case 'customer_withdrawal':
        return 'customer_cash';
      case 'load_purchase':
        return 'load';
      case 'operating_expense':
        return 'operating_expenses';
      // Cash that left the drawer without being the cost of running the
      // business — a supplier, a bill being settled, cash handed to someone.
      // Its own bucket, deliberately outside EXPENSE_BUCKETS, so Cash on hand
      // and the shift's expected figure both fall while the expense reports do
      // not move.
      case 'cash_payment':
        return 'cash_payments';
      case 'expense':
        return 'provider_charges';
      case 'service_fee':
      case 'bill_payment':
      case 'refund':
        return 'payments';
      case 'other_income':
      case 'refund_received':
        return 'other_income';
      case 'adjustment_in':
      case 'adjustment_out':
        return 'adjustments';
      // Borrowed money and the principal paid back. Kept out of EXPENSE_BUCKETS
      // on the same reasoning that keeps `owner_return` out: a repayment hands
      // back money the company never spent, so totalling it as spending would
      // report the cost of being in business as everything borrowed and repaid.
      case 'loan_received':
      case 'loan_repayment':
        return 'borrowings';
      default:
        return 'other';
    }
  }

  switch (sourceType) {
    case 'transfer':
      return 'transfers';
    case 'loading':
      return 'load';
    case 'adjustment':
      return 'adjustments';
    case 'gap_fix':
      return 'corrections';
    // A shift's float. A shift writes no ledger row, so no row of this kind is
    // written today; a row that names this source is still classified by it
    // rather than falling through to Other, so the register reads a float as a
    // float the moment one is ever posted.
    case 'opening_float':
    case 'shift':
      return 'opening_float';
    default:
      return 'other';
  }
}

export interface LedgerFlowRow {
  branch_id: string;
  entry_type: 'credit' | 'debit';
  amount: string | number;
  source_type: string | null;
  txn_code: string | null;
}

export interface BranchBalance {
  id: string;
  code: string;
  name: string;
  opening: string | number;
  current: string | number;
}

export interface BucketLine {
  bucket: CashBucket;
  label: string;
  amount: number;
  count: number;
}

export interface BranchStatement {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  sources: number;
  uses: number;
  closing: number;
  current: number;
}

export interface CashStatement {
  sources: BucketLine[];
  uses: BucketLine[];
  branches: BranchStatement[];
  totals: {
    opening: number;
    sources: number;
    uses: number;
    closing: number;
    current: number;
    difference: number;
    balanced: boolean;
  };
}

const sortByAmount = (a: BucketLine, b: BucketLine): number =>
  b.amount - a.amount || a.label.localeCompare(b.label);

export function buildCashStatement(rows: LedgerFlowRow[], branches: BranchBalance[]): CashStatement {
  const sourceCents = new Map<CashBucket, number>();
  const sourceCounts = new Map<CashBucket, number>();
  const useCents = new Map<CashBucket, number>();
  const useCounts = new Map<CashBucket, number>();

  const branchSources = new Map<string, number>();
  const branchUses = new Map<string, number>();

  for (const row of rows) {
    const bucket = bucketFor(row.source_type, row.txn_code);
    const cents = toCents(row.amount);
    const isCredit = row.entry_type === 'credit';

    const totals = isCredit ? sourceCents : useCents;
    const counts = isCredit ? sourceCounts : useCounts;
    totals.set(bucket, (totals.get(bucket) || 0) + cents);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);

    const perBranch = isCredit ? branchSources : branchUses;
    perBranch.set(row.branch_id, (perBranch.get(row.branch_id) || 0) + cents);
  }

  const sources: BucketLine[] = [...sourceCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: sourceCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const uses: BucketLine[] = [...useCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: useCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const branchStatements: BranchStatement[] = branches.map((branch) => {
    const opening = toCents(branch.opening);
    const branchSource = branchSources.get(branch.id) || 0;
    const branchUse = branchUses.get(branch.id) || 0;
    return {
      branchId: branch.id,
      code: branch.code,
      name: branch.name,
      opening: money(opening),
      sources: money(branchSource),
      uses: money(branchUse),
      closing: money(opening + branchSource - branchUse),
      current: toCents(branch.current) / 100,
    };
  });

  const sum = (pick: (b: BranchStatement) => number): number =>
    branchStatements.reduce((total, b) => total + toCents(pick(b)), 0);

  const opening = sum((b) => b.opening);
  const branchSourceTotal = sum((b) => b.sources);
  const branchUseTotal = sum((b) => b.uses);
  const closing = sum((b) => b.closing);
  const current = sum((b) => b.current);
  const difference = closing - current;

  return {
    sources,
    uses,
    branches: branchStatements,
    totals: {
      opening: money(opening),
      sources: money(branchSourceTotal),
      uses: money(branchUseTotal),
      closing: money(closing),
      current: money(current),
      difference: money(difference),
      // Only expected to be zero when the period reaches the present. A
      // statement covering a past window closes at its own end date and will
      // legitimately differ from today's balance.
      balanced: difference === 0,
    },
  };
}

// The cash register — every ledger row that touched a branch's cash accounts,
// newest first. This is the drawer's full history: what "Total on the books"
// and "Cash on hand" are built from, in the order the balance moved. It answers
// "what has been recorded against cash" without a period filter, because a list
// of what exists is a point-in-time question, not the period question D18 keeps
// off this screen.
//
// Classified with `bucketFor`, the same function the position statement uses,
// so a row reads the same in the list as it reads in the totals it belongs to.
export interface CashRecordRaw {
  id: string;
  entry_date: string | Date;
  entry_type: string;
  amount: string | number;
  balance_after: string | number;
  source_type: string | null;
  reference_number: string | null;
  description: string | null;
  account_name: string;
  branch_code: string | null;
  branch_name: string | null;
  transaction_number: number | string | null;
  // The transaction's id, kept separate from its number because reversing a row
  // needs the id and the register carries the number. Null for a ledger row
  // with no transaction behind it — a transfer, adjustment or gap fix.
  transaction_id: string | null;
  // The transaction's status, so a row the drawer has already given back can
  // say so. A ledger register keeps every posting — including one later
  // reversed — and a reader who cannot tell them apart reads a refunded expense
  // as money that is still gone.
  transaction_status: string | null;
  // The reversal's own transaction, where one was posted — its number and when
  // it landed. Null unless the row is reversed, so the register can name what
  // undid a movement instead of only announcing that something did.
  reversed_by_number: number | string | null;
  reversed_by_at: string | Date | null;
  transaction_date: string | Date | null;
  payee: string | null;
  txn_code: string | null;
  payment_method: string | null;
  created_by_username: string | null;
}

export interface CashRecordRow {
  id: string;
  // The day the row is filed under — the transaction's business date where one
  // exists, the posting instant otherwise. The register reads this, not
  // `entryDate`: an expense entered for Sep 25 files under Sep 25 even when it
  // was posted into the drawer on Oct 7.
  businessDate: string;
  // The instant the row actually hit the drawer. Kept beside the business date
  // so the two can be told apart when they differ.
  entryDate: string;
  direction: 'in' | 'out';
  bucket: CashBucket;
  category: string;
  amount: string;
  balanceAfter: string;
  accountName: string;
  branchCode: string | null;
  branchName: string | null;
  transactionNumber: number | null;
  // Null wherever `transactionNumber` is, and for the same reason: there is no
  // transaction to act on. The register's reversal action keys off this rather
  // than off the number, so a ledger-only row can never be offered one.
  transactionId: string | null;
  // The transaction's status. In practice 'completed' or 'reversed' — a row
  // with a ledger entry behind it is never pending — and null wherever
  // `transactionId` is, for the same reason. Carried so the register can flag a
  // movement that was undone: the entry itself is a fact and stays, but the
  // money it moved has since been given back.
  transactionStatus: string | null;
  // The transaction that undid this one, where one exists. The register shows
  // it beside the flag so a reader is told not merely that the money came back
  // but which entry brought it back — the difference between a warning and an
  // audit trail. Null when nothing reversed the row, and when its reversal
  // carries no `REV-<number>` reference to be found by.
  reversedByNumber: number | null;
  // The instant the reversal posted, for the same reason the row carries both
  // a business day and a posting instant.
  reversedAt: string | null;
  paymentMethod: string | null;
  payee: string | null;
  referenceNumber: string | null;
  description: string | null;
  recordedBy: string | null;
}

const moneyString = (value: unknown): string => (toCents(value) / 100).toFixed(2);

export function toCashRecordRow(raw: CashRecordRaw): CashRecordRow {
  const bucket = bucketFor(raw.source_type, raw.txn_code);
  const number = raw.transaction_number === null || raw.transaction_number === undefined || raw.transaction_number === ''
    ? null
    : Number(raw.transaction_number);
  // One test for the three fields that describe the transaction rather than the
  // ledger row itself. They come from one LEFT JOIN, so they are either all
  // there or all absent, and keying all three off the number keeps them from
  // ever disagreeing about whether a transaction stands behind the row.
  const hasTransaction = Number.isFinite(number as number);
  // The row that undid this one, where one could be found. Absent, unparseable
  // and a figure are three states and only the third is worth showing: a
  // register that printed a half-parsed reversal reference would mislead more
  // than one that printed nothing.
  const reversedBy = raw.reversed_by_number === null || raw.reversed_by_number === undefined || raw.reversed_by_number === ''
    ? null
    : Number(raw.reversed_by_number);
  const reversedWhen = raw.reversed_by_at ? new Date(raw.reversed_by_at) : null;
  // The business date the operator named, falling back to the posting instant
  // for a row with no transaction (a transfer, adjustment or gap fix). Parse
  // rather than concatenate, so an invalid value falls back too instead of
  // reaching the formatter as garbage.
  const entryDate = new Date(raw.entry_date).toISOString();
  const business = raw.transaction_date ? new Date(raw.transaction_date) : null;
  return {
    id: raw.id,
    businessDate: business && !Number.isNaN(business.getTime()) ? business.toISOString() : entryDate,
    entryDate,
    direction: raw.entry_type === 'credit' ? 'in' : 'out',
    bucket,
    category: BUCKET_LABELS[bucket],
    amount: moneyString(raw.amount),
    balanceAfter: moneyString(raw.balance_after),
    accountName: raw.account_name,
    branchCode: raw.branch_code,
    branchName: raw.branch_name,
    transactionNumber: hasTransaction ? number : null,
    transactionId: hasTransaction ? raw.transaction_id : null,
    transactionStatus: hasTransaction ? raw.transaction_status ?? null : null,
    // Untied to `hasTransaction` on purpose: the join that finds a reversal
    // keys off the transaction number, so a row without one cannot have a
    // match in the first place.
    reversedByNumber: Number.isFinite(reversedBy as number) ? reversedBy : null,
    reversedAt: reversedWhen && !Number.isNaN(reversedWhen.getTime()) ? reversedWhen.toISOString() : null,
    paymentMethod: raw.payment_method,
    payee: raw.payee,
    referenceNumber: raw.reference_number,
    description: raw.description,
    recordedBy: raw.created_by_username,
  };
}

export function isExpenseBucket(bucket: CashBucket): boolean {
  return EXPENSE_BUCKETS.includes(bucket);
}

// The expense total for exactly the rows the register is showing.
//
// Sums money out only: an expense-bucket row facing the other way is a refund
// coming back, not spending, and reversals post to `adjustments` rather than
// into the bucket they reverse. Computed over the filtered population rather
// than the current page, so the figure describes every row the record count
// names instead of one screen of them.
//
// Pure — no network, no database — so the endpoint and its test run the same
// function (AGENTS.md architecture rule 1).
export function cashExpenseTotal(rows: CashRecordRow[]): string {
  let cents = 0;
  for (const row of rows) {
    if (row.direction === 'out' && isExpenseBucket(row.bucket)) cents += toCents(row.amount);
  }
  return (cents / 100).toFixed(2);
}

const csvCell = (value: unknown): string => {
  const normalized = value === null || value === undefined ? '' : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
};

const CASH_RECORD_COLUMNS: { header: string; key: keyof CashRecordRow }[] = [
  { header: 'Business Day', key: 'businessDate' },
  { header: 'Posted At', key: 'entryDate' },
  { header: 'Branch', key: 'branchCode' },
  { header: 'Account', key: 'accountName' },
  { header: 'Txn #', key: 'transactionNumber' },
  { header: 'Status', key: 'transactionStatus' },
  { header: 'Reversed By', key: 'reversedByNumber' },
  { header: 'Type', key: 'category' },
  { header: 'Direction', key: 'direction' },
  { header: 'Amount', key: 'amount' },
  { header: 'Balance After', key: 'balanceAfter' },
  { header: 'Payment Method', key: 'paymentMethod' },
  { header: 'Payee', key: 'payee' },
  { header: 'Reference', key: 'referenceNumber' },
  { header: 'Description', key: 'description' },
  { header: 'Recorded By', key: 'recordedBy' },
];

/**
 * The register as CSV. Both dates are read by `manilaDateTimeKey` rather than
 * the instant's UTC text, so a row filed under Sep 25 in Manila is not exported
 * as Sep 24, and one posted Oct 7 is not exported as Oct 6 — the same
 * off-by-a-day a report's last day used to lose. The BOM lets Excel read the
 * peso signs and dashes the description column may carry.
 */
export function cashRecordsCsv(rows: CashRecordRow[]): string {
  const lines = [CASH_RECORD_COLUMNS.map(c => csvCell(c.header)).join(',')];
  for (const row of rows) {
    const cells = CASH_RECORD_COLUMNS.map(c => {
      const value = c.key === 'businessDate' || c.key === 'entryDate'
        ? manilaDateTimeKey(new Date(row[c.key])).replace('T', ' ')
        : row[c.key];
      return csvCell(value);
    });
    lines.push(cells.join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
