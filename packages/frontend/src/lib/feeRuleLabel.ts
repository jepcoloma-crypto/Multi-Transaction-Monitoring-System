import { formatCurrency } from './format';

// What the New Transaction form's Fee Rule dropdown puts in front of an
// operator. The list is where a transaction is *identified* — "the customer
// wants a Globe load" — so the label names the rule and says what it will
// charge, and nothing else. The exact fee is not the dropdown's job to
// promise: it is computed from the amount once the amount is known, and the
// form prints it in the Fee field as the operator types.
//
// The fee phrase has to be true. A bracket-priced rule carries fee_value 0
// with the real money in its tiers, so reading fee_value alone told an
// operator that a Globe load cost nothing. Anything whose price depends on
// the amount therefore says so, or names the one bracket it has.

export interface FeeRuleTier {
  min_amount?: number | string | null;
  max_amount?: number | string | null;
  fee_value?: number | string | null;
}

export interface FeeRuleLabelParts {
  id?: string;
  name: string;
  /** `in` / `out` — which side of the till the money moves. Drives grouping, not the label. */
  direction?: string | null;
  type_name?: string | null;
  category_name?: string | null;
  fee_type?: string | null;
  fee_value?: number | string | null;
  step_amount?: number | string | null;
  step_fee?: number | string | null;
  calculation_method?: string | null;
  tiers?: FeeRuleTier[] | null;
}

const asNumber = (value: number | string | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// The service the rule belongs to, for when two rules share a name.
const serviceOf = (rule: FeeRuleLabelParts): string =>
  (rule.category_name ?? '').trim() || (rule.type_name ?? '').trim() || 'Transaction';

export const feeRuleLabel = (rule: FeeRuleLabelParts): string => {
  const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];

  let fee: string;
  if (tiers.length > 1) {
    fee = 'fee by amount';
  } else if (tiers.length === 1) {
    const tier = tiers[0];
    const min = asNumber(tier.min_amount);
    const max = tier.max_amount === null || tier.max_amount === undefined
      ? null
      : asNumber(tier.max_amount);
    const range = max === null ? `${formatCurrency(min)} up` : `${formatCurrency(min)}–${formatCurrency(max)}`;
    fee = `${formatCurrency(asNumber(tier.fee_value))} (${range})`;
  } else if (rule.calculation_method === 'flat_per_step' || rule.fee_type === 'flat_per_step') {
    fee = `${formatCurrency(asNumber(rule.fee_value))} + ${formatCurrency(asNumber(rule.step_fee))} per ${formatCurrency(asNumber(rule.step_amount))}`;
  } else if (rule.fee_type === 'percentage') {
    fee = `${asNumber(rule.fee_value)}%`;
  } else {
    fee = formatCurrency(asNumber(rule.fee_value));
  }

  return `${rule.name} — ${fee}`;
};

export interface FeeRuleOption extends FeeRuleLabelParts {
  id: string;
}

export interface FeeRuleGroup<T extends FeeRuleOption> {
  label: string;
  rules: T[];
}

// Grouped by the side of the till the money moves, which is the first thing
// an operator rules out. A name repeated inside one group is only
// disambiguated when it happens — two "ATM Withdrawal" rules for two
// brackets must not read as one rule twice, and adding the service to every
// label to defend against that would burden the common case for the rare one.
export const groupFeeRules = <T extends FeeRuleOption>(rules: T[]): FeeRuleGroup<T>[] => {
  const order = ['Money In', 'Money Out', 'Other'];
  const byLabel = new Map<string, T[]>();

  for (const rule of rules) {
    const side = rule.direction === 'in' ? 'Money In' : rule.direction === 'out' ? 'Money Out' : 'Other';
    const bucket = byLabel.get(side);
    if (bucket) bucket.push(rule);
    else byLabel.set(side, [rule]);
  }

  return order
    .filter((label) => byLabel.has(label))
    .map((label) => {
      const group = byLabel.get(label)!;
      const seen = new Map<string, number>();
      for (const rule of group) seen.set(rule.name, (seen.get(rule.name) ?? 0) + 1);
      const ambiguous = (rule: T) => (seen.get(rule.name) ?? 0) > 1;
      return {
        label,
        rules: group.map((rule) => (
          ambiguous(rule) ? { ...rule, name: `${rule.name} (${serviceOf(rule)})` } : rule
        )),
      };
    });
};
