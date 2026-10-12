// What a load sale does to the books, decided once and shared by every path
// that records one. Pure — no network, no database — so the drawer's share of a
// sale is testable without a server, and so the preview an operator reads before
// saving is the same arithmetic the commit performs.
//
// The rule the owner set, verbatim:
//
//   "Cost price will deducted to my balance. selling price will go to my cash
//    on hand."
//
// So a cash load sale is one conversion between two pools of the same money:
// the product's cost leaves the channel (the e-wallet that buys it), the
// selling price lands in the drawer (the physical cash the customer handed
// over), and the difference is the margin — already sitting inside the drawer's
// increase, never written as a third row. The income report reads that margin
// from `loading_transactions.profit`, which is why it already reconciled while
// Cash on hand did not: the cost leg was always posted, the drawer leg never
// was. That gap is this module's reason to exist.
//
// A load posted against a non-cash method (an e-wallet settled online) touches
// no drawer, because no physical cash changed hands — the same line the
// transactions draw with `touchesDrawer`. The channel still pays the cost.

export interface LoadingProductFees {
  /** What the product's cost adds to the channel deduction. Per unit, like the cost. */
  providerConvenienceFee?: number | string | null;
}

export interface LoadingSaleInput {
  unitCost: number | string;
  unitPrice: number | string;
  quantity: number | string;
  /** How the customer settled. Only 'cash' puts anything in the drawer. */
  paymentMethod?: string | null;
  fees?: LoadingProductFees;
}

export interface LoadingSaleLegs {
  /** What the channel loses: cost, plus the fees that ride inside the deduction. */
  channelDeduction: number;
  /** What the drawer gains: the selling price, whole. Zero when not settled in cash. */
  drawerIncrease: number;
  /** The company's earning on the sale, already inside `drawerIncrease`. */
  margin: number;
}

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Centavo-safe multiply, so a quantity of products cannot accumulate float error. */
const multiply = (unit: number, quantity: number): number =>
  Math.round(unit * quantity * 100) / 100;

const toCents = (value: number): number => Math.round(value * 100);
const money = (cents: number): number => cents / 100;

/**
 * The legs a load sale writes.
 *
 * Compared in whole centavos rather than floats: a margin computed as
 * `revenue - cost` in binary floats can land a fraction of a centavo off, and a
 * figure the operator reads as ₱47.99 that the books hold as ₱47.98 is a
 * discrepancy they did not create and cannot explain.
 *
 * `providerConvenienceFee` scales with quantity because it is charged per
 * product. That mirrors how the entry route derives it, so the two paths cannot
 * drift on what a fee means. `companyAdditionalCharge` is deliberately absent:
 * the entry route records it against the customer but never takes it from the
 * balance, so it moves no leg here either.
 */
export function loadingSaleLegs(input: LoadingSaleInput): LoadingSaleLegs {
  const unitCost = toNumber(input.unitCost);
  const unitPrice = toNumber(input.unitPrice);
  const quantity = toNumber(input.quantity);

  const totalCost = multiply(unitCost, quantity);
  const totalRevenue = multiply(unitPrice, quantity);
  const margin = money(toCents(totalRevenue) - toCents(totalCost));

  const convenienceFee = multiply(toNumber(input.fees?.providerConvenienceFee), quantity);

  // The channel pays the cost and the fees that settle with it. The drawer is
  // spared both: the customer handed over the selling price, and the fees are
  // the company's own cost of buying, not the till's.
  const channelDeduction = money(toCents(totalCost) + toCents(convenienceFee));

  const cashSettled = input.paymentMethod === 'cash';

  return {
    channelDeduction,
    drawerIncrease: cashSettled ? totalRevenue : 0,
    margin,
  };
}
