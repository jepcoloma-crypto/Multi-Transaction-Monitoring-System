// Amount corrections change a record's own figures and then reconcile the
// ledger to match, so both halves have to be derived from one place. This
// module owns which fields an operator may edit, how they recompute into the
// derived columns, and what each record type posts to the ledger.
//
// The ledger expressions mirror the routes that originally wrote each record:
// transactions post net_amount plus charges, transfers post the source
// deduction against the destination amount, loading posts cost plus the
// provider's convenience fee. A correction that derived those differently from
// the way the row was first written would leave a gap no later audit could
// explain, so the record side and the ledger side are kept side by side here
// rather than being worked out independently at each call site.
//
// A cash settlement gives the record a drawer beside its own account (D12/D24),
// and the drawer's row is planned here too — through the same drawerLeg and
// loadingSaleLegs creation writes with — because a correction that moved only
// the account would leave the till contradicting the record forever, which is
// exactly what the fee audit judges both legs against (D43). Each account's
// target also carries the direction it is measured in, declared by the plan
// rather than read off row history: a till's first row may face the other way
// from the till's net (§34).
import { createError } from '../middleware/error';
import { netAmountOf, entryTypeFor } from './movementPlan';
import { drawerLeg } from './cashManagement';
import { loadingSaleLegs } from './loadingPosting';

export type AmountableSource = 'transaction' | 'transfer' | 'loading';

export interface AmountField {
  key: string;
  label: string;
  /** 'id' fields carry an identifier rather than a figure, so no bound applies. */
  kind: 'money' | 'qty' | 'id';
  /** null where the figure may legitimately go negative, as a loss does. */
  min: number | null;
}

export const AMOUNT_FIELDS: Record<AmountableSource, AmountField[]> = {
  transaction: [
    { key: 'amount', label: 'Amount', kind: 'money', min: 0 },
    { key: 'fee', label: 'Fee', kind: 'money', min: 0 },
  ],
  transfer: [
    { key: 'transfer_amount', label: 'Transfer amount', kind: 'money', min: 0 },
    { key: 'transfer_fee', label: 'Service charge', kind: 'money', min: 0 },
  ],
  loading: [
    { key: 'product_id', label: 'Product', kind: 'id', min: null },
    { key: 'quantity', label: 'Quantity', kind: 'qty', min: 1 },
    { key: 'unit_cost', label: 'Unit cost', kind: 'money', min: 0 },
    { key: 'unit_price', label: 'Selling price', kind: 'money', min: 0 },
    { key: 'provider_convenience_fee', label: 'Provider fee (total)', kind: 'money', min: 0 },
    { key: 'company_additional_charge', label: 'Company charge', kind: 'money', min: 0 },
    { key: 'profit', label: 'Profit', kind: 'money', min: null },
  ],
};

export function isAmountable(source: string): source is AmountableSource {
  return Object.prototype.hasOwnProperty.call(AMOUNT_FIELDS, source);
}

export interface AmountPlan {
  /** Record columns to write, including everything derived from the inputs. */
  columns: Record<string, number | string>;
  /** What each account's ledger row for this record should come to. */
  amounts: Record<string, number>;
  /**
   * Which way each account's target is measured — declared by the plan's own
   * arithmetic, never read off row history: a till's first row may be the fee
   * row, which faces the other way from the till's net (D43's defect, §34).
   */
  signs: Record<string, 1 | -1>;
}

interface RowLike {
  account_id: string;
  entry_type: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const has = (obj: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

function readMoney(raw: unknown, label: string, min: number | null): number {
  const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(parsed)) throw createError(400, `${label} is not a number`);
  const value = round2(parsed);
  if (min !== null && value < min) throw createError(400, `${label} cannot be below ${min}`);
  return value;
}

function readQuantity(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw createError(400, 'Quantity must be a whole number');
  }
  if (parsed < 1) throw createError(400, 'Quantity must be at least 1');
  return parsed;
}

// Charges are stored as a JSON array and are summed the same way creation
// sums them. An unreadable array is refused rather than treated as zero: the
// ledger amount is about to be derived from this figure, and guessing it
// would move money on invented data.
export function sumCharges(raw: unknown): number {
  let list: unknown[] = [];
  if (raw === null || raw === undefined || raw === '') {
    list = [];
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      list = parsed;
    } catch {
      throw createError(400, 'The additional charges on this record could not be read');
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    throw createError(400, 'The additional charges on this record could not be read');
  }

  const total = list.reduce<number>((sum, entry) => {
    const amount = (entry as { amount?: unknown })?.amount;
    const n = parseFloat(String(amount ?? 0));
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  return round2(total);
}

// The first row written on an account is the one that set the record's
// direction there — corrections append after it, often with the opposite sign.
function baseEntryTypesByAccount(rows: RowLike[]): Map<string, string> {
  const bases = new Map<string, string>();
  for (const row of rows) if (!bases.has(row.account_id)) bases.set(row.account_id, row.entry_type);
  return bases;
}

function accountOfBase(bases: Map<string, string>, entryType: string): string | null {
  for (const [accountId, type] of bases) if (type === entryType) return accountId;
  return null;
}

// The drawer a cash settlement gave the record, found by subtraction: creation
// writes the record's own account plus at most one till beside it, so the
// record's account_id names the first and whatever else its rows touch is the
// second. A record whose rows spread further is one this planner does not
// understand — named rather than guessed at, the same rule the fee re-post
// judges by (movementShape).
function drawerOf(record: Record<string, unknown>, rows: RowLike[]): string | null {
  const primary = record.account_id;
  if (typeof primary !== 'string' || !primary) {
    throw createError(400, 'This record does not name an account');
  }
  const others = [...new Set(rows.map((r) => r.account_id))].filter((id) => id !== primary);
  if (others.length > 1) {
    throw createError(400, 'the movement spans more accounts than its own and one drawer');
  }
  return others.length === 1 ? others[0] : null;
}

function readProposal(sourceType: AmountableSource, proposed: unknown): Record<string, unknown> {
  if (typeof proposed !== 'object' || proposed === null || Array.isArray(proposed)) {
    throw createError(400, 'fields must be an object');
  }
  const input = proposed as Record<string, unknown>;
  const allowed = new Set(AMOUNT_FIELDS[sourceType].map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw createError(400, `${key} is not an editable amount field for ${sourceType}`);
    }
  }
  return input;
}

function planTransaction(
  record: Record<string, unknown>,
  rows: RowLike[],
  read: (key: string) => unknown
): AmountPlan {
  const amount = readMoney(read('amount'), 'Amount', 0);
  const fee = readMoney(read('fee'), 'Fee', 0);

  // The same rule as creation, asked of the same function (design D46): a
  // cash-in lands the amount and never the fee — the fee is the till's income
  // whichever way the tender carried it — while a cash-out still cuts a fee
  // taken inside the amount from what leaves. A fee taken inside the amount
  // still cannot exceed it, because it is a cut of the amount the customer
  // sent and a larger cut would book income that money never carried.
  // Reproducing exactly what creation would have written, instead of quietly
  // re-pricing the movement.
  const { exceeds, netAmount } = netAmountOf({
    direction: String(record.direction ?? ''),
    amount,
    fee,
    feeAddedToBalance: record.fee_added_to_balance !== false,
  });
  if (exceeds) {
    throw createError(400, 'Fee cannot exceed the transaction amount when the fee is taken inside the amount');
  }
  const charges = sumCharges(record.additional_charges);

  const primary = String(record.account_id);
  const drawerId = drawerOf(record, rows);
  const totalAmount = round2(netAmount + charges);
  const accountTotal = entryTypeFor(String(record.direction ?? '')) === 'credit' ? totalAmount : -totalAmount;
  const amounts: Record<string, number> = { [primary]: totalAmount };
  const signs: Record<string, 1 | -1> = { [primary]: accountTotal < 0 ? -1 : 1 };

  // The drawer's net, from the same drawerLeg the entry route and the fee
  // re-post call, so all three agree cell for cell (D46/D43): the till moves
  // by what the corrected figures say crossed it, or the fee audit would find
  // the record and its own two legs telling different stories.
  if (drawerId) {
    const drawer = drawerLeg(accountTotal, fee);
    const drawerNet = drawer ? (drawer.entryType === 'credit' ? drawer.amount : -drawer.amount) : 0;
    amounts[drawerId] = Math.abs(drawerNet);
    signs[drawerId] = drawerNet < 0 ? -1 : 1;
  }

  return {
    columns: { amount, fee, net_amount: netAmount },
    amounts,
    signs,
  };
}

function planTransfer(
  record: Record<string, unknown>,
  rows: RowLike[],
  read: (key: string) => unknown
): AmountPlan {
  const transferAmount = readMoney(read('transfer_amount'), 'Transfer amount', 0);
  const transferFee = readMoney(read('transfer_fee'), 'Service charge', 0);
  if (transferAmount <= 0) throw createError(400, 'Transfer amount must be greater than zero');

  const totalSourceDeduction = round2(transferAmount + transferFee);
  const destinationAmount = transferAmount;

  const bases = baseEntryTypesByAccount(rows);
  const sourceAccount = accountOfBase(bases, 'debit');
  const destinationAccount = accountOfBase(bases, 'credit');
  if (!sourceAccount || !destinationAccount) {
    throw createError(400, 'This transfer does not own both a source debit and a destination credit row');
  }

  return {
    columns: {
      transfer_amount: transferAmount,
      transfer_fee: transferFee,
      total_source_deduction: totalSourceDeduction,
      destination_amount: destinationAmount,
    },
    amounts: { [sourceAccount]: totalSourceDeduction, [destinationAccount]: destinationAmount },
    // The source's rows open with a debit and the destination's with a credit,
    // so these declare what the first-row fallback would read — now as the
    // plan's own statement rather than a coincidence of write order.
    signs: { [sourceAccount]: -1, [destinationAccount]: 1 },
  };
}

// The provider fee is stored as a total, written at creation as a per-unit
// rate times quantity. An edit to the count therefore has to carry the rate
// with it, which recovering from the stored total does exactly while the old
// quantity is known. An operator who types a fee of their own overrides that.
function scaledProviderFee(record: Record<string, unknown>, quantity: number): number {
  const total = readMoney(record.provider_convenience_fee ?? 0, 'Provider fee', 0);
  const previous = Number(record.quantity);
  if (!Number.isFinite(previous) || previous < 1) return total;
  return round2((total / previous) * quantity);
}

function planLoading(
  record: Record<string, unknown>,
  rows: RowLike[],
  values: Record<string, unknown>,
  read: (key: string) => unknown
): AmountPlan {
  const quantity = readQuantity(read('quantity'));
  const unitCost = readMoney(read('unit_cost'), 'Unit cost', 0);
  const unitPrice = readMoney(read('unit_price'), 'Selling price', 0);
  const companyCharge = readMoney(read('company_additional_charge'), 'Company charge', 0);
  const providerFee = has(values, 'provider_convenience_fee')
    ? readMoney(values.provider_convenience_fee, 'Provider fee', 0)
    : scaledProviderFee(record, quantity);

  const totalCost = round2(unitCost * quantity);
  const totalRevenue = round2(unitPrice * quantity);
  const profit = has(values, 'profit')
    ? readMoney(values.profit, 'Profit', null)
    : round2(totalRevenue - totalCost);

  const primary = String(record.account_id);
  const drawerId = drawerOf(record, rows);
  const columns: Record<string, number | string> = {
    quantity,
    unit_cost: unitCost,
    unit_price: unitPrice,
    total_cost: totalCost,
    total_revenue: totalRevenue,
    profit,
    provider_convenience_fee: providerFee,
    company_additional_charge: companyCharge,
  };

  // The product is re-pointed only when the operator actually picked one: it
  // carries no figure of its own — the figures beside it do — but leaving the
  // old product on a sale whose prices were just rewritten would mislabel
  // every report that groups by product. An empty selection is refused rather
  // than written; the route checks the id names a real product before this.
  if (has(values, 'product_id')) {
    const productId = typeof values.product_id === 'string' ? values.product_id.trim() : '';
    if (!productId) throw createError(400, 'Product must be selected');
    columns.product_id = productId;
  }

  const amounts: Record<string, number> = { [primary]: round2(totalCost + providerFee) };
  // The channel's row is a debit — the cost leaves it — so its target is
  // always measured that way.
  const signs: Record<string, 1 | -1> = { [primary]: -1 };

  // The drawer's share is the selling price and nothing else: the same
  // loadingSaleLegs the entry route posts with, so a cash sale's till moves by
  // exactly what the corrected revenue says, and a sale settled any other way
  // unwinds a till row that should never have been standing.
  if (drawerId) {
    const legs = loadingSaleLegs({
      unitCost,
      unitPrice,
      quantity,
      paymentMethod: String(record.payment_method ?? 'cash'),
    });
    amounts[drawerId] = legs.drawerIncrease;
    signs[drawerId] = 1; // credited, so it can only gain
  }

  return { columns, amounts, signs };
}

export function planAmountCorrection(
  sourceType: string,
  record: Record<string, unknown>,
  rows: RowLike[],
  proposed: unknown
): AmountPlan {
  if (!isAmountable(sourceType)) {
    throw createError(400, `Amounts are not correctable for ${sourceType}`);
  }
  if (!record) throw createError(404, `No ${sourceType} found with that id`);
  if (rows.length === 0) throw createError(400, 'This record has no ledger rows to correct against');

  const values = readProposal(sourceType, proposed);
  const read = (key: string): unknown => (has(values, key) ? values[key] : record[key]);

  if (sourceType === 'transaction') return planTransaction(record, rows, read);
  if (sourceType === 'transfer') return planTransfer(record, rows, read);
  return planLoading(record, rows, values, read);
}

// Selling price and company charges never reach the ledger, so a correction
// that moves only those changes the record and nothing else. The gate that
// refuses a no-op has to look here as well or it would reject a legitimate
// edit on the grounds that no money moved.
export function columnsChanged(
  record: Record<string, unknown>,
  columns: Record<string, number | string>
): boolean {
  for (const [key, value] of Object.entries(columns)) {
    const raw = record[key];
    if (raw === null || raw === undefined) return true;
    const current = Number(raw);
    if (!Number.isFinite(current)) {
      // A column that carries an identifier rather than a figure — the
      // loading product a correction may re-point — differs only when the
      // string does; Number() on a uuid is NaN for both sides.
      if (String(raw) === String(value)) continue;
      return true;
    }
    if (!Number.isFinite(Number(value))) return true;
    // Half a cent: float dust from the arithmetic above is around 1e-13, while
    // the smallest difference that means anything to a ledger is a whole cent.
    if (Math.abs(current - Number(value)) >= 0.005) return true;
  }
  return false;
}
