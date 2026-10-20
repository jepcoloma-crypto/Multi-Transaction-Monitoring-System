// Integrity checks (design IC1–IC6): whether the books' two halves agree.
//
// On 2026-10-19 a cash-in's service fee was credited to the customer instead of
// the till, twice, and nothing in the system noticed — because nothing in the
// system ever compared two surfaces that do not derive from each other. Every
// invariant the posting path asserts held: D24's identity held on both rows, the
// balances matched their ledgers, the tests passed. The books were internally
// perfect and said the wrong thing about where twenty pesos was.
//
// So these checks are deliberately not more of the same. They put a *business
// claim* beside a *physical fact* — what the income report says the till earned,
// against what the till's own rows carry — because only a comparison across
// subsystems can see a rule that is wrong but self-consistent (IC1).
//
// Every function here is pure and takes plain data: no database, no HTTP, no
// clock. The route gathers the rows; these decide what they mean. That keeps the
// checks testable against the exact rows transactions 3 and 21 used to hold, so
// the regression is a fixture rather than a hope.

const cents = (n: number): number => Math.round(n * 100);

export type IntegrityStatus = 'pass' | 'findings';

export interface IntegrityFinding {
  transactionNumber: number | null;
  referenceNumber: string | null;
  direction: string | null;
  amount: number | null;
  fee: number | null;
  /** What the check says should have been there. */
  expected: number | null;
  /** What the ledger actually holds. */
  actual: number | null;
  /** Why those two differing is a problem, in one sentence. */
  detail: string;
}

export interface IntegrityCheck {
  id: string;
  title: string;
  /** What the check asserts, stated so a reader can disagree with it. */
  states: string;
  status: IntegrityStatus;
  /** How many movements the verdict covers. */
  checked: number;
  summary: string;
  findings: IntegrityFinding[];
}

const pass = (
  id: string, title: string, states: string, checked: number, summary: string
): IntegrityCheck => ({ id, title, states, status: 'pass', checked, summary, findings: [] });

const fail = (
  id: string, title: string, states: string, checked: number, summary: string,
  findings: IntegrityFinding[]
): IntegrityCheck => ({ id, title, states, status: 'findings', checked, summary, findings });

export const money = (n: number): string =>
  (n < 0 ? '-' : '') + '₱' + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ------------------------------------------------- check 1: the till's fee ---
// The income report reads `transactions.fee` and books every fee collected on
// top as the till's income (`drawerIncome = fee_on_top + load_margin`). That is
// a claim about money the tin is holding. These rows say whether it is true.

export interface TillIncomeRow {
  transactionNumber: number;
  referenceNumber: string | null;
  direction: string;
  amount: number;
  fee: number;
  feeAddedToBalance: boolean;
  status: string;
  /** The drawer's fee-bearing rows for this movement, netted (credits less debits). */
  drawerFeeNet: number;
  /** Whether the movement wrote any drawer row at all (IC6 — absence is a finding, not a pass). */
  hasDrawerRows: boolean;
}

export function checkTillHoldsItsIncome(rows: TillIncomeRow[]): IntegrityCheck {
  const title = 'The till holds what income says it earned';
  const states =
    "Every fee the income report books as the till's must appear in the till's own rows.";

  // Only fees counted as till income are in scope: a fee carved from the amount
  // belongs to the receiving account, and the report does not claim it for the tin.
  const claimed = rows.filter(
    (r) => r.status === 'completed' && cents(r.fee) > 0 && r.feeAddedToBalance
  );

  const incomeClaim = claimed.reduce((sum, r) => sum + cents(r.fee), 0);
  const tillCarries = claimed.reduce((sum, r) => sum + cents(r.drawerFeeNet), 0);

  const findings: IntegrityFinding[] = [];
  for (const r of claimed) {
    if (!r.hasDrawerRows) {
      findings.push({
        transactionNumber: r.transactionNumber,
        referenceNumber: r.referenceNumber,
        direction: r.direction,
        amount: r.amount,
        fee: r.fee,
        expected: r.fee,
        actual: 0,
        detail: 'The movement wrote no drawer row at all, so there is nothing the till could be holding.',
      });
      continue;
    }
    if (cents(r.drawerFeeNet) !== cents(r.fee)) {
      const short = cents(r.fee) - cents(r.drawerFeeNet);
      findings.push({
        transactionNumber: r.transactionNumber,
        referenceNumber: r.referenceNumber,
        direction: r.direction,
        amount: r.amount,
        fee: r.fee,
        expected: r.fee,
        actual: r.drawerFeeNet,
        detail:
          short > 0
            ? `Income books ${money(r.fee)} as the till's, but its rows carry ${money(r.drawerFeeNet)} — ${money(short / 100)} short.`
            : `The till's rows carry ${money(r.drawerFeeNet)} against a booked fee of ${money(r.fee)}.`,
      });
    }
  }

  const short = incomeClaim - tillCarries;
  const summary =
    findings.length === 0
      ? `Income books ${money(incomeClaim / 100)} of on-top fees; the till's rows carry ${money(tillCarries / 100)}.`
      : `Income books ${money(incomeClaim / 100)} of on-top fees; the till's rows carry ${money(tillCarries / 100)} — ${money(short / 100)} apart.`;

  return findings.length
    ? fail('till-income', title, states, claimed.length, summary, findings)
    : pass('till-income', title, states, claimed.length, summary);
}

// ------------------------------------------- check 2: the fee's own row side ---
// Both cash-in cells move the same pesos since D46, so a backwards tender flag
// cannot be caught from the figures — `classifyFeeMovement` reads `ok`. The flag
// is still checkable, because the two cells put the fee's *row* on opposite
// sides. Netting both sides also absorbs a re-post: a corrected movement has a
// fee row on each side, and only the net says where it finally landed.

export interface FeePlacementRow {
  transactionNumber: number;
  referenceNumber: string | null;
  direction: string;
  amount: number;
  fee: number;
  feeAddedToBalance: boolean;
  status: string;
  /** The receiving account's fee-bearing rows, netted. */
  accountFeeNet: number;
  /** The drawer's fee-bearing rows, netted. */
  drawerFeeNet: number;
}

/** Which side carries a movement's fee row, from the tender and the direction (D37/D46). */
export function feeRowSide(direction: string, feeAddedToBalance: boolean): 'drawer' | 'account' {
  // A cash-out's fee was paid in cash under either mode, so the till has always kept it.
  if (direction !== 'in') return 'drawer';
  // A cash-in's fee is the tin's when it was collected on top; cut from the
  // amount it is a slice of what the customer sent, and stays on their account.
  return feeAddedToBalance ? 'drawer' : 'account';
}

export function checkFeeRowPlacement(rows: FeePlacementRow[]): IntegrityCheck {
  const title = "The fee's row sits where its mode says";
  const states =
    'A fee collected on top, and every cash-out fee, must sit in the till; a fee carved from the amount sits on the receiving account.';

  const candidates = rows.filter((r) => r.status === 'completed' && cents(r.fee) > 0);

  const findings: IntegrityFinding[] = [];
  for (const r of candidates) {
    const side = feeRowSide(r.direction, r.feeAddedToBalance);
    const onDrawer = cents(r.drawerFeeNet) === cents(r.fee) && cents(r.accountFeeNet) === 0;
    const onAccount = cents(r.accountFeeNet) === cents(r.fee) && cents(r.drawerFeeNet) === 0;
    if (side === 'drawer' ? onDrawer : onAccount) continue;

    findings.push({
      transactionNumber: r.transactionNumber,
      referenceNumber: r.referenceNumber,
      direction: r.direction,
      amount: r.amount,
      fee: r.fee,
      expected: r.fee,
      actual: side === 'drawer' ? r.drawerFeeNet : r.accountFeeNet,
      detail:
        `The tender records this fee as ${r.feeAddedToBalance ? 'collected on top' : 'cut from the amount'}, ` +
        `so its row belongs in the ${side === 'drawer' ? 'till' : "customer's account"} — ` +
        // These two are pesos already: the route sums `ledger_entries.amount`,
        // a NUMERIC in pesos. Check 1's figures are summed in cents and do
        // divide here, which is what made dividing here look right — a ₱10 fee
        // reported as ₱0.10 in the one message an operator reads to act on.
        `the till carries ${money(r.drawerFeeNet)} and the account ${money(r.accountFeeNet)}.`,
    });
  }

  const summary =
    findings.length === 0
      ? `${candidates.length} fee-bearing movements, every fee row on the side its tender names.`
      : `${findings.length} of ${candidates.length} fee-bearing movements carry their fee row on the wrong side.`;

  return findings.length
    ? fail('fee-placement', title, states, candidates.length, summary, findings)
    : pass('fee-placement', title, states, candidates.length, summary);
}

// --------------------------------------------- check 3: net_amount is honest ---
// `net_amount` records what the account's own rows summed to when the movement
// was written — read back rather than recomputed, so an edit and a reversal
// agree with the rows they actually left behind. Stored as a magnitude: a
// debit's rows sum negative, and comparing without the absolute value reported
// thirty findings against perfectly correct books. (Found by running it first.)
//
// `net_amount` is not the whole figure, though, and comparing it alone was the
// second such finding: creation posts `net_amount + additional_charges` as the
// account's row (amountFields), and every reversal path moves the same sum
// (`movementTotalOf`, "the figure every reversal path moves"). A movement that
// billed a charge therefore left rows larger than its own column by exactly the
// charge, and this check read that as three books disagreeing when it was one
// expression applied to half a figure. The charges are folded in here so the
// comparison is against what the account was actually asked to move.

export interface NetAmountRow {
  transactionNumber: number;
  referenceNumber: string | null;
  direction: string;
  amount: number;
  fee: number;
  netAmount: number;
  /** Charges billed on top of the amount, which the account's rows carry too. */
  additionalCharges: number;
  status: string;
  /** The primary account's own rows, netted and signed. */
  accountNet: number;
  /** False when the movement left the account with no rows at all. */
  hasAccountRows: boolean;
}

export function checkNetAmountConsistency(rows: NetAmountRow[]): IntegrityCheck {
  const title = "`net_amount` is what the account's rows sum to";
  const states = "A movement's stored figure matches the ledger it actually wrote.";

  const candidates = rows.filter((r) => r.status === 'completed');

  const findings: IntegrityFinding[] = [];
  for (const r of candidates) {
    if (!r.hasAccountRows) {
      findings.push({
        transactionNumber: r.transactionNumber,
        referenceNumber: r.referenceNumber,
        direction: r.direction,
        amount: r.amount,
        fee: r.fee,
        expected: r.netAmount,
        actual: 0,
        detail: 'The record is completed but wrote no rows on its own account.',
      });
      continue;
    }
    // What the account was asked to move: the amount, plus whatever the
    // movement billed on top of it. In cents throughout, so the sum of two
    // stored figures cannot drift by a centavo on the way in.
    const expectedCents = cents(r.netAmount) + cents(r.additionalCharges);
    const actual = Math.abs(cents(r.accountNet)) / 100;
    if (expectedCents !== cents(actual)) {
      findings.push({
        transactionNumber: r.transactionNumber,
        referenceNumber: r.referenceNumber,
        direction: r.direction,
        amount: r.amount,
        fee: r.fee,
        expected: expectedCents / 100,
        actual,
        detail:
          `The record claims ${money(expectedCents / 100)} but the account's rows sum to ${money(actual)}. ` +
          'It was written under a rule its ledger no longer matches.',
      });
    }
  }

  const summary =
    findings.length === 0
      ? `${candidates.length} completed movements, each claiming what its own rows moved.`
      : `${findings.length} of ${candidates.length} completed movements disagree with the rows they wrote.`;

  return findings.length
    ? fail('net-amount', title, states, candidates.length, summary, findings)
    : pass('net-amount', title, states, candidates.length, summary);
}

/** Every check, in the order the page shows them. */
export function runIntegrityChecks(
  tillRows: TillIncomeRow[],
  placementRows: FeePlacementRow[],
  netRows: NetAmountRow[]
): IntegrityCheck[] {
  return [
    checkTillHoldsItsIncome(tillRows),
    checkFeeRowPlacement(placementRows),
    checkNetAmountConsistency(netRows),
  ];
}

