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

export const calculateTieredFee = (
  config: FeeConfigRow,
  tiers: FeeTierRow[],
  amount: number
): number | null => {
  if (tiers.length === 0) return null;

  if (config.calculation_method === 'per_amount') {
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

  const tier = matchTier(tiers, amount);
  return tier ? tierFee(tier, amount) : null;
};
