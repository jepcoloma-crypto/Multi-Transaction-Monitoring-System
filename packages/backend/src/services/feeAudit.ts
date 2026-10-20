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
import { netAmountOf, entryTypeFor, feeOnDrawerOf } from './movementPlan';
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

/**
 * Where a movement's fee-bearing rows sit, netted, in pesos.
 *
 * A fee is a *row*, and on a cash-in the tender mode decides only which side
 * carries it — both cells move identical pesos (D46), so the row's home is the
 * whole difference between them. These two figures say where it actually is,
 * as opposed to where the record's flag claims.
 */
export interface FeeSideNets {
  /** The receiving account's fee-bearing rows, netted (credits less debits). */
  accountFeeNet: number;
  /** The till's fee-bearing rows, netted. */
  drawerFeeNet: number;
}

// A fee-bearing row, read off `role` first with the description as the read of
// a row written before migration 048 labelled it — the same precedence the
// integrity check judges by, so the re-post and the check that watches it can
// never name a different row.
//
// Not `isFeeLedgerRow`: that reads the description alone, and it is shared with
// the Statement of Account, whose callers need their own review before its
// rule may move. `correction` counts beside `fee` because a re-posted fee
// arrives as a correction line and netting only fee rows would report a gap for
// exactly the rows that were fixed.
const FEE_ROW_ROLES = new Set(['fee', 'correction']);

interface RowLike {
  account_id: string;
  entry_type: string;
  amount: string | number;
  role?: string | null;
  description?: string | null;
}

function isFeeRow(row: RowLike): boolean {
  const role = row.role == null ? '' : String(row.role);
  if (role !== '') return FEE_ROW_ROLES.has(role);
  const description = row.description ?? '';
  return (
    description === 'Service fee' ||
    description.startsWith('Service fee ') ||
    description.startsWith('Fee correction')
  );
}

const signedOf = (row: RowLike): number =>
  (row.entry_type === 'credit' ? 1 : -1) * (parseFloat(String(row.amount)) || 0);

/**
 * The fee-bearing net on each side of a movement, from the rows themselves.
 *
 * Both nets come from the same rows the totals above are measured from, so the
 * re-carve below and the totals correction cannot read different history.
 */
export function currentFeeNets(
  rows: RowLike[],
  primaryAccountId: string,
  drawerAccountId: string | null
): FeeSideNets {
  let accountFeeNet = 0;
  let drawerFeeNet = 0;
  for (const row of rows) {
    if (!isFeeRow(row)) continue;
    if (row.account_id === primaryAccountId) accountFeeNet = round2(accountFeeNet + signedOf(row));
    else if (drawerAccountId !== null && row.account_id === drawerAccountId) {
      drawerFeeNet = round2(drawerFeeNet + signedOf(row));
    }
  }
  return { accountFeeNet, drawerFeeNet };
}

/**
 * Where a fee-bearing row would net on each side, or null when the rows say
 * neither.
 *
 * `direction` fixes the sign a fee row faces on the account, because a fee row
 * takes its own side's direction (`planPostings`): a cash-in's faces credit, a
 * cash-out's debit. Demanding a positive fee net would read a cash-out's fee
 * row as "not readable" and stop, when in fact a cash-out whose fee sits on the
 * account is the clearest case for moving it.
 *
 * Null is a shape this planner will not guess at: the fee is spread across both
 * sides or matches neither figure, which is the state the fee audit exists to
 * name. Guessing here would move a row on invented history.
 */
export function feeRowIsOnDrawer(
  nets: FeeSideNets,
  fee: number,
  direction: string
): boolean | null {
  const accountFace = entryTypeFor(direction) === 'credit' ? fee : -fee;
  const onDrawer = cents(nets.drawerFeeNet) === cents(fee) && cents(nets.accountFeeNet) === 0;
  const onAccount = cents(nets.accountFeeNet) === cents(accountFace) && cents(nets.drawerFeeNet) === 0;
  return onDrawer ? true : onAccount ? false : null;
}

/**
 * One row of a fee re-carve: the append-only way the fee's line migrates.
 *
 * A cash-in's two tender modes move the same pesos, so the per-account targets
 * are identical under both and a totals correction has nothing to append — yet
 * the fee's row still has to change sides. This is that change, written as two
 * zero-sum pairs: a fee-bearing row on the side gaining the fee and a movement
 * row to hold that account's total where it was, mirrored on the side losing it.
 * Every net and every balance is unchanged; only which side's fee-bearing rows
 * carry the fee moves.
 */
export interface FeeRowRecarve {
  accountId: string;
  entryType: 'credit' | 'debit';
  amount: number;
  role: 'fee' | 'movement' | 'correction';
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
  /**
   * Rows that move the fee's line to the side the target mode names, when the
   * totals alone cannot. Null when nothing has to move.
   */
  recarve: FeeRowRecarve[] | null;
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
  /**
   * Where the fee's row actually sits, read off the movement's own rows. Omit
   * it and the plan re-carves nothing — the totals it targets are identical
   * under both cash-in modes, so a mode flip would otherwise write a flag that
   * says one thing and leave rows that say another.
   */
  currentFeeNets?: FeeSideNets | null;
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

  const recarve = planFeeRowRecarve({
    direction: input.direction,
    fee,
    feeAddedToBalance,
    targetModeDeclared: input.target.feeAddedToBalance !== undefined,
    primaryAccountId: input.primaryAccountId,
    drawerAccountId: input.drawerAccountId,
    nets: input.currentFeeNets ?? null,
  });

  return {
    columns: { amount, fee, net_amount: netAmount, fee_added_to_balance: feeAddedToBalance },
    amounts,
    signs,
    targets,
    recarve,
  };
}

/**
 * The rows that move the fee's line across, or null when none are needed.
 *
 * Judged against where the fee's row *is*, not against whether the flag is
 * changing. A re-post that only flips the flag was tried three times on
 * transaction 44 and moved nothing, because the rows it was meant to fix had
 * been left behind by the flip before it — so a "did the mode change?" test
 * would miss the exact case this exists for. The rows say which side carries
 * the fee; the target mode says which side should; the difference is the work.
 *
 * Only a re-post that actually names a tender mode may move the row. An amount
 * fix on a movement whose fee sits on the wrong side leaves it where it is:
 * that is the fee audit's finding to report, not this correction's to do
 * unasked.
 *
 * No drawer means no second side to move between, and creation writes the
 * account's single whole row either way, so there is nothing to re-carve.
 *
 * An unreadable shape is refused rather than guessed at: if the fee's row is
 * spread across both sides or matches neither figure, the fee audit is the tool
 * that names what those rows are, and moving money on a guess is worse than
 * stopping.
 */
function planFeeRowRecarve(input: {
  direction: string;
  fee: number;
  feeAddedToBalance: boolean;
  targetModeDeclared: boolean;
  primaryAccountId: string;
  drawerAccountId: string | null;
  nets: FeeSideNets | null;
}): FeeRowRecarve[] | null {
  if (input.fee <= 0 || !input.drawerAccountId || input.nets === null) return null;
  if (!input.targetModeDeclared) return null;
  const drawerAccountId = input.drawerAccountId;
  const nets = input.nets;

  const onDrawer = feeRowIsOnDrawer(nets, input.fee, input.direction);
  if (onDrawer === null) {
    throw createError(
      400,
      'This movement’s ledger rows do not agree about which side carries its fee, ' +
        'so the fee cannot be re-posted safely. Run the fee audit to see what those rows are.'
    );
  }

  const targetOnDrawer = feeOnDrawerOf({
    direction: input.direction,
    fee: input.fee,
    feeAddedToBalance: input.feeAddedToBalance,
  });
  if (onDrawer === targetOnDrawer) return null;

  // Each side's fee net moves from where it stands to where the target mode
  // puts it — and every sign is derived from that, never written out. A fee row
  // takes its own side's direction, so a cash-out's faces debit on the account
  // while the till's is always a credit; a pair assumed positive would book
  // +fee against a −fee and leave the fee exactly where it was.
  //
  // Each row is paired with a movement row of the same size the other way, so
  // both accounts keep the totals the deltas above target. Four rows, no
  // balance and no net moves, and the fee's line has crossed.
  const entryFor = (net: number): 'credit' | 'debit' => (net >= 0 ? 'credit' : 'debit');
  const accountFace = entryTypeFor(input.direction) === 'credit' ? 1 : -1;

  const recarve: FeeRowRecarve[] = [];
  for (const side of ['account', 'drawer'] as const) {
    const accountId = side === 'account' ? input.primaryAccountId : drawerAccountId;
    const current = side === 'account' ? nets.accountFeeNet : nets.drawerFeeNet;
    const target = side === 'account'
      ? (targetOnDrawer ? 0 : accountFace * input.fee)
      : (targetOnDrawer ? input.fee : 0);

    const delta = round2(target - current);
    if (delta === 0) continue;

    recarve.push({
      accountId,
      entryType: entryFor(delta),
      amount: Math.abs(delta),
      // The side that held nothing earns the fee's own row; the side giving it
      // up earns a correction, which counts as fee-bearing and cancels it.
      role: current === 0 ? 'fee' : 'correction',
    });
    recarve.push({
      accountId,
      entryType: entryFor(-delta),
      amount: Math.abs(delta),
      role: 'movement',
    });
  }

  return recarve.length > 0 ? recarve : null;
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
