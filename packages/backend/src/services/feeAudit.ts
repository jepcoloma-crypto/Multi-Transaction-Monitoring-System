// The fee audit and its re-post planner (design D43).
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
//
// Before this existed, nothing after entry could see such a row, name it, or
// fix it: the amount form corrected one account only, so it refused a cash
// movement outright, and the flag itself was not editable anywhere.
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
 * What a movement posts under one fee mode (D46): the account's whole figure
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
 * opposite mode means the flag was backwards when the row was written —
 * reachable only for a cash-out, since D46 gave both cash-in cells the same
 * figures; matching neither means the figures themselves, not just the flag,
 * are wrong.
 *
 * Two things follow from that, and neither can be read out of the postings.
 * A cash-in whose flag was typed backwards still looks `ok`, because both its
 * cells move the same pesos — only the side carrying the fee's own row differs,
 * and that is the tender, which the admin reads off the figures shown beside
 * the row. And a cash-in that credited the customer the fee — D42's own
 * posting, transactions 3 and 21 — matches neither cell and is named `neither`,
 * which is the row the fee re-post exists to correct. The tool never guesses
 * the tender; it only says which postings the books were meant to hold.
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
  /**
   * Which way each account's target is measured — read off the plan's own
   * arithmetic (`entryTypeFor`/`drawerLeg`), never off row history: a till's
   * first row may be the fee row, which faces the other way from its net.
   */
  signs: Record<string, 1 | -1>;
  /** The signed targets themselves, for the preview and the audit record. */
  targets: { accountTotal: number; drawerNet: number | null };
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
 * the record's own columns, the per-account magnitudes the delta rows will
 * land on, and the direction each target is measured in — declared by this
 * plan, because row history cannot say it: a till's first row may be the fee
 * row, which faces the other way from the till's net. The drawer's target is
 * the net — the cash that physically crossed the till — because that is what
 * its recorded rows have always summed to, whichever rows a previous
 * correction appended.
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

  // The same expectedPostings the audit judges with: the plan says what each
  // leg must sum to, signed, so the delta engine measures every target in the
  // direction this plan writes rather than the direction history happens to
  // show (D43's defect — see §34).
  const targets = expectedPostings(
    { direction: input.direction, amount, fee, feeAddedToBalance, charges },
    input.drawerAccountId !== null
  );

  const amounts: Record<string, number> = { [input.primaryAccountId]: totalAmount };
  const signs: Record<string, 1 | -1> = {
    [input.primaryAccountId]: targets.accountTotal < 0 ? -1 : 1,
  };
  if (input.drawerAccountId) {
    amounts[input.drawerAccountId] = Math.abs(targets.drawerNet ?? 0);
    signs[input.drawerAccountId] = (targets.drawerNet ?? 0) < 0 ? -1 : 1;
  }

  return {
    columns: { amount, fee, net_amount: netAmount, fee_added_to_balance: feeAddedToBalance },
    amounts,
    signs,
    targets,
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
