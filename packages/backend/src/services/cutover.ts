// The cutover's arithmetic, asked once and obeyed twice.
//
// The runbook (flow doc §9, owner's choice recorded there) freezes the legacy
// Revolving Fund by moving the counted cash out of it and letting the new
// Drawer open with exactly what the operator counted — the remainder is what
// the legacy line freezes holding. This plan is what both the dry run prints
// and the committing run applies: the operator's only look at the numbers and
// the numbers the books actually receive come from the same function, because
// a dry run that agrees with its commit only by coincidence is no dry run at
// all — the same lesson the entry preview and the entry save share.
//
// Pure on purpose: the script owns the database, this owns the pesos.

const cents = (value: number): number => Math.round(value * 100);
const money = (valueInCents: number): string => (valueInCents / 100).toFixed(2);

export interface CutoverContext {
  /** Branch whose till was counted. */
  branchName: string;
  /** The legacy cash account being frozen. */
  legacyName: string;
  /** Its books balance — what the count is handed against. */
  legacyBalance: number;
  /** Physical cash counted out of the drawer. */
  counted: number;
}

export interface CutoverPlan {
  /** Non-empty means the run must stop before touching a row. */
  problems: string[];
  /** Pesos moved legacy → Drawer: the count itself. */
  transfer: number;
  /** What the legacy fund freezes holding: its balance less the count. */
  remainder: number;
  /** The new Drawer's balance after the cutover: the count itself. */
  drawerAfter: number;
  /** Whether any ledger row is needed at all (a zero count against a zero fund moves nothing). */
  movesMoney: boolean;
  reference: string;
  /** Each row stands alone as the labeled line the runbook promises. */
  drawerDescription: string;
  legacyDescription: string;
}

export function cutoverPlan(
  ctx: CutoverContext,
  opts: { reference?: string; today?: string } = {}
): CutoverPlan {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const reference = opts.reference || `CUTOVER-${today}`;
  const problems: string[] = [];

  const legacyOk = Number.isFinite(ctx.legacyBalance) && ctx.legacyBalance >= 0;
  const countedOk = Number.isFinite(ctx.counted) && ctx.counted >= 0;

  if (!Number.isFinite(ctx.legacyBalance)) {
    problems.push(`The legacy fund's balance must be a number, got ${ctx.legacyBalance}`);
  } else if (ctx.legacyBalance < 0) {
    problems.push(`The legacy fund's balance cannot be negative, got ${ctx.legacyBalance}`);
  }
  if (!Number.isFinite(ctx.counted)) {
    problems.push(`Counted cash must be a number, got ${ctx.counted}`);
  } else if (ctx.counted < 0) {
    problems.push(`Counted cash cannot be negative, got ${ctx.counted}`);
  }

  const legacyC = legacyOk ? cents(ctx.legacyBalance) : 0;
  const countedC = countedOk ? cents(ctx.counted) : 0;

  if (legacyOk && countedOk && countedC > legacyC) {
    // The mechanism cannot run backwards: the count is handed OUT of the fund,
    // and the books hold what they hold. A count above the books is its own
    // finding — someone counts more cash than the fund ever held, and the
    // answer is a human looking, not a script guessing.
    problems.push(
      `The count cannot come out of ${ctx.legacyName}: counted ${money(countedC)} but the books hold ${money(legacyC)}`
    );
  }

  const transferC = countedC;
  const remainderC = legacyC - transferC;

  return {
    problems,
    transfer: transferC / 100,
    remainder: remainderC / 100,
    drawerAfter: transferC / 100,
    movesMoney: problems.length === 0 && transferC > 0,
    reference,
    drawerDescription:
      `Cutover opening: counted ${money(transferC)} handed from ${ctx.legacyName} (${ctx.branchName})`,
    legacyDescription:
      `Cutover: counted ${money(transferC)} handed to the new Drawer; ${ctx.legacyName} freezes at ${money(remainderC)}`,
  };
}
