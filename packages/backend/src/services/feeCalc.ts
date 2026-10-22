type NumLike = number | string;

export interface FeeTierRow {
  min_amount: NumLike;
  max_amount: NumLike | null;
  fee_type: string;
  fee_value: NumLike;
}

export interface FeeConfigRow {
  fee_type: string;
  fee_value: NumLike;
  calculation_method?: string | null;
  // The step columns that make flat_per_step a schedule rather than a flat
  // figure. Optional because callers have historically described a rule by
  // only the three fields above; the ones that price a step pass them.
  base_amount?: NumLike | null;
  step_amount?: NumLike | null;
  step_fee?: NumLike | null;
  min_fee?: NumLike | null;
  max_fee?: NumLike | null;
}

const toNum = (value: NumLike | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const tierFee = (tier: FeeTierRow, amount: number): number =>
  tier.fee_type === 'percentage' ? (amount * toNum(tier.fee_value)) / 100 : toNum(tier.fee_value);

const matchTier = (tiers: FeeTierRow[], amount: number): FeeTierRow | undefined => {
  const sorted = [...tiers].sort((a, b) => toNum(a.min_amount) - toNum(b.min_amount));
  if (sorted.length === 0) return undefined;
  let matched = sorted.find(
    t => amount >= toNum(t.min_amount) && (t.max_amount === null || amount <= toNum(t.max_amount))
  );
  if (!matched && amount >= toNum(sorted[0].min_amount)) {
    matched =
      sorted.find(t => amount < toNum(t.min_amount)) ||
      sorted.filter(t => amount >= toNum(t.min_amount)).pop();
  }
  return matched;
};

// A flat_per_step rule is priced by its step columns, and it owns no tiers --
// so this case has to be reachable when the tier walk has nothing to walk, or
// the rule answers null and the caller falls back to a bare fee_value, which
// is how an ATM withdrawal came to cost a flat 30 at every amount. It sits
// below the tier walk rather than above it: a rule that has both answers its
// tier first and reaches for the step only when no tier matched, which is the
// order the entry form's own calculator (Transactions.tsx) and the fee-rule
// endpoint (transactionFees.ts) already use. Three copies that disagree are
// worse than one.
const stepFee = (config: FeeConfigRow, amount: number): number => {
  const base = toNum(config.base_amount);
  const step = toNum(config.step_amount) || 1;
  const perStep = toNum(config.step_fee);
  return amount > base
    ? toNum(config.fee_value) + Math.ceil((amount - base) / step) * perStep
    : toNum(config.fee_value);
};

export const calculateTieredFee = (
  config: FeeConfigRow,
  tiers: FeeTierRow[],
  amount: number
): number | null => {
  if (config.calculation_method === 'per_amount' && tiers.length > 0) {
    const bounded = tiers
      .filter(t => t.max_amount !== null && t.max_amount !== undefined)
      .sort((a, b) => toNum(b.max_amount) - toNum(a.max_amount));
    if (bounded.length > 0) {
      const chunkTier = bounded[0];
      const chunk = toNum(chunkTier.max_amount);
      if (chunk > 0) {
        const full = Math.floor(amount / chunk);
        const remainder = amount - full * chunk;
        if (full > 0) {
          let fee = full * tierFee(chunkTier, chunk);
          const remTier = matchTier(tiers, remainder);
          if (remTier) fee += tierFee(remTier, remainder);
          return fee;
        }
        const remTier = matchTier(tiers, remainder);
        if (remTier) return tierFee(remTier, remainder);
        return null;
      }
    }
  }

  if (tiers.length > 0) {
    const tier = matchTier(tiers, amount);
    if (tier) return tierFee(tier, amount);
  }

  if (config.fee_type === 'flat_per_step') return stepFee(config, amount);

  return null;
};
