// The fee audit and its re-post planner (design D43).
//
// The ON/OFF fee flag decides what posts in two of the four cells (D42), and
// it is written once, at entry, by whoever was at the counter. When a row was
// flagged backwards — or its amount was typed as the tender total instead of
// the figure the rule expects — the account and the till are both off by the
// fee, and nothing after entry could see it, name it, or fix it: amount
// corrections refuse a cash movement outright, and the flag itself was not
// editable anywhere.
//
// This module answers both halves without touching the database. It reads a
// movement's recorded rows and says what actually posted, what its declared
// mode says should have posted, and what the opposite mode would post — the
// same `netAmountOf` and `drawerLeg` the entry route writes with, so the audit
// and the movement it judges can never disagree about arithmetic. It then
// plans a re-post: the target figures per account, from which the route
// appends delta rows exactly as an amount correction does. Nothing is
// rewritten; the record's own columns are updated in the same transaction that
// appends the rows.
import { createError } from '../middleware/error';
import { netAmountOf, entryTypeFor } from './movementPlan';
import { drawerLeg } from './cashManagement';
import { sumCharges } from './amountFields';

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

export type FeeAuditStatus = 'ok' | 'opposite' | 'neither';

export interface FeeLeg {
  /** What the account's own rows sum to, signed — `net_amount` plus charges. */
  accountTotal: number;
  /** What the drawer's rows sum to, signed; null when the movement has no drawer. */
  drawerNet: number | null;
}

export interface FeeClassification {
  status: FeeAuditStatus;
  actual: FeeLeg;
  declared: FeeLeg;
  opposite: FeeLeg;
}

export interface FeeFiguresInput {
  direction: string;
  amount: number;
  fee: number;
  feeAddedToBalance: boolean;
  charges: number;
}

/**
 * What a movement posts under one fee mode (D42): the account's whole figure
 * signed by its own direction, and the drawer's net. The drawer is only
 * computed when the movement actually settles in cash — `hasDrawer` is the
 * recorder's own rows, not an assumption from the method, because a movement
 * booked onto the drawer itself writes no counterparty row.
 */
export function expectedPostings(input: FeeFiguresInput, hasDrawer: boolean): FeeLeg {
  const { netAmount } = netAmountOf({
    direction: input.direction,
    amount: input.amount,
    fee: input.fee,
    feeAddedToBalance: input.feeAddedToBalance,
  });
  const totalAmount = round2(netAmount + input.charges);
  const accountTotal = entryTypeFor(input.direction) === 'credit' ? totalAmount : -totalAmount;
  if (!hasDrawer) return { accountTotal, drawerNet: null };

  const drawer = drawerLeg(accountTotal, input.fee);
  return {
    accountTotal,
    drawerNet: drawer ? (drawer.entryType === 'credit' ? drawer.amount : -drawer.amount) : 0,
  };
}

const legMatches = (actual: number | null, expected: number | null): boolean =>
  actual === null || expected === null || cents(actual) === cents(expected);

/**
 * Judge one movement against both fee modes. The status is decided by the
 * legs that exist: matching the declared mode is `ok`; matching only the
 * opposite mode means the flag was backwards when the row was written — or
 * the row predates D42, where both modes posted alike and the two changed
 * cells therefore sit exactly one fee away from their declaration; matching
 * neither means the figures themselves, not just the flag, are wrong.
 *
 * A row whose toggle was backwards but whose arithmetic was self-consistent
 * under the wrong mode looks `ok` here — postings alone cannot say which way
 * the tender really ran. That is the admin's call from the figures shown
 * beside each row; the tool never guesses it.
 */
export function classifyFeeMovement(input: FeeFiguresInput & {
  actualAccountTotal: number;
  actualDrawerNet: number | null;
  hasDrawer: boolean;
}): FeeClassification {
  const declared = expectedPostings(input, input.hasDrawer);
  const opposite = expectedPostings(
    { ...input, feeAddedToBalance: !input.feeAddedToBalance },
    input.hasDrawer
  );
  const actual: FeeLeg = {
    accountTotal: input.actualAccountTotal,
    drawerNet: input.hasDrawer ? (input.actualDrawerNet ?? 0) : null,
  };

  const declaredMatches =
    legMatches(actual.accountTotal, declared.accountTotal) &&
    legMatches(actual.drawerNet, declared.drawerNet);
  const oppositeMatches =
    legMatches(actual.accountTotal, opposite.accountTotal) &&
    legMatches(actual.drawerNet, opposite.drawerNet);

  const status: FeeAuditStatus = declaredMatches ? 'ok' : oppositeMatches ? 'opposite' : 'neither';
  return { status, actual, declared, opposite };
}

export interface FeeRepostColumns {
  amount: number;
  fee: number;
  net_amount: number;
  fee_added_to_balance: boolean;
}

export interface FeeRepostPlan {
  columns: FeeRepostColumns;
  /** Target magnitude per account, keyed by account id — `simulateCorrection`'s input. */
  amounts: Record<string, number>;
}

// Record columns arrive as pg hands them over: NUMERIC as a string, the flag
// as a boolean. Missing or unreadable figures read as zero rather than
// throwing, because the audit runs over history written by several rules.
const readMoney = (value: unknown): number => {
  const n = parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? round2(n) : 0;
};

/**
 * Plan a re-post: what the movement should have posted under the target, as
 * the record's own columns and the per-account magnitudes the delta rows will
 * land on. The drawer's target is the net — the cash that physically crossed
 * the till — because that is what its recorded rows have always summed to,
 * whichever rows a previous correction appended.
 *
 * The fee-inside guard is creation's own, with creation's message: a cut
 * larger than what was sent books income the money never carried, and a
 * re-post must not be a door around it.
 */
export function planFeeRepost(input: {
  direction: string;
  recordAmount: unknown;
  recordFee: unknown;
  recordFeeAddedToBalance: unknown;
  additionalCharges: unknown;
  primaryAccountId: string;
  drawerAccountId: string | null;
  target: { amount?: unknown; fee?: unknown; feeAddedToBalance?: unknown };
}): FeeRepostPlan {
  const amount =
    input.target.amount === undefined ? readMoney(input.recordAmount) : readMoney(input.target.amount);
  const fee =
    input.target.fee === undefined ? readMoney(input.recordFee) : readMoney(input.target.fee);
  const feeAddedToBalance =
    input.target.feeAddedToBalance === undefined
      ? input.recordFeeAddedToBalance !== false
      : input.target.feeAddedToBalance !== false;

  // Unreadable charges are refused with the corrections' own message — the
  // ledger figure is about to be derived from this, and guessing it would
  // move money on invented data.
  const charges = sumCharges(input.additionalCharges);

  const feeInside = feeAddedToBalance === false && fee > 0;
  if (feeInside && amount < fee) {
    throw createError(400, 'Fee cannot exceed the transaction amount when the fee is taken inside the amount');
  }

  const { netAmount } = netAmountOf({ direction: input.direction, amount, fee, feeAddedToBalance });
  const totalAmount = round2(netAmount + charges);
  const signedAccount = entryTypeFor(input.direction) === 'credit' ? totalAmount : -totalAmount;

  const amounts: Record<string, number> = { [input.primaryAccountId]: totalAmount };
  if (input.drawerAccountId) {
    const drawer = drawerLeg(signedAccount, fee);
    amounts[input.drawerAccountId] = drawer ? drawer.amount : 0;
  }

  return {
    columns: { amount, fee, net_amount: netAmount, fee_added_to_balance: feeAddedToBalance },
    amounts,
  };
}

/**
 * The record's columns as they are now, for the audit response and the
 * preview's "before" — the four figures a re-post may change, and nothing else.
 */
export function currentFeeColumns(record: Record<string, any>): FeeRepostColumns {
  return {
    amount: readMoney(record.amount),
    fee: readMoney(record.fee),
    net_amount: readMoney(record.net_amount),
    fee_added_to_balance: record.fee_added_to_balance !== false,
  };
}

/** The four columns a re-post may actually change, diffed against the record. */
export function changedFeeColumns(
  before: FeeRepostColumns,
  after: FeeRepostColumns
): Partial<FeeRepostColumns> | null {
  const changed: Partial<FeeRepostColumns> = {};
  if (cents(before.amount) !== cents(after.amount)) changed.amount = after.amount;
  if (cents(before.fee) !== cents(after.fee)) changed.fee = after.fee;
  if (cents(before.net_amount) !== cents(after.net_amount)) changed.net_amount = after.net_amount;
  if (before.fee_added_to_balance !== after.fee_added_to_balance) {
    changed.fee_added_to_balance = after.fee_added_to_balance;
  }
  return Object.keys(changed).length > 0 ? changed : null;
}
