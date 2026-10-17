import { describe, it, expect } from 'vitest';
import { feeRuleLabel, groupFeeRules } from './feeRuleLabel';
import type { FeeRuleOption } from './feeRuleLabel';

// The eight rules this deployment actually runs, in the shape the API hands
// them over. Bracket-priced rules carry fee_value 0 with the real money in
// their tiers — reading fee_value alone is what used to advertise a Globe
// load as free.
const rules: FeeRuleOption[] = [
  {
    id: 'r1', name: 'E-Wallet Cash-In Fee', direction: 'in', type_name: 'E-Wallet Cash-In',
    category_name: 'E-Wallet Cash-In', fee_type: 'fixed', fee_value: 0, calculation_method: 'per_amount',
    tiers: [
      { min_amount: 1, max_amount: 100, fee_value: 5 },
      { min_amount: 101, max_amount: 1000, fee_value: 10 },
    ],
  },
  {
    id: 'r2', name: 'Bill Payment Service Fee', direction: 'out', type_name: 'Bill Payment',
    category_name: null, fee_type: 'fixed', fee_value: 0, calculation_method: 'per_amount',
    tiers: [
      { min_amount: 1, max_amount: 100, fee_value: 5 },
      { min_amount: 101, max_amount: 1000, fee_value: 10 },
    ],
  },
  {
    id: 'r3', name: 'E-Wallet Cash-Out Fee', direction: 'out', type_name: 'Cash Out',
    category_name: 'E-Wallet Cash Out', fee_type: 'fixed', fee_value: 0, calculation_method: 'per_amount',
    tiers: [
      { min_amount: 1, max_amount: 100, fee_value: 5 },
      { min_amount: 101, max_amount: 1000, fee_value: 10 },
    ],
  },
  {
    id: 'r4', name: 'ATM Withdrawal Fee 3,000.00 Above', direction: 'out', type_name: 'Customer Withdrawal',
    category_name: 'ATM Withdrawal', fee_type: 'flat_per_step', fee_value: 30,
    step_amount: 1000, step_fee: 30, calculation_method: 'bracket', tiers: [],
  },
  {
    id: 'r5', name: 'ATM Withdrawal Minimum', direction: 'out', type_name: 'Customer Withdrawal',
    category_name: null, fee_type: 'fixed', fee_value: 0, calculation_method: 'bracket',
    tiers: [{ min_amount: 1, max_amount: 3000, fee_value: 30 }],
  },
  {
    id: 'r6', name: 'Globe Load', direction: 'out', type_name: 'Load Purchase',
    category_name: 'Globe Load', fee_type: 'fixed', fee_value: 0, calculation_method: 'bracket',
    tiers: [
      { min_amount: 1, max_amount: 50, fee_value: 3 },
      { min_amount: 51, max_amount: 100, fee_value: 5 },
      { min_amount: 101, max_amount: 1000, fee_value: 10 },
    ],
  },
  {
    id: 'r7', name: 'Load DITO Sim', direction: 'out', type_name: 'Load Purchase',
    category_name: 'DITO Sim', fee_type: 'fixed', fee_value: 5, calculation_method: 'bracket', tiers: [],
  },
  {
    id: 'r8', name: 'Smart Load', direction: 'out', type_name: 'Load Purchase',
    category_name: 'Smart Load', fee_type: 'fixed', fee_value: 0, calculation_method: 'bracket',
    tiers: [
      { min_amount: 1, max_amount: 50, fee_value: 3 },
      { min_amount: 51, max_amount: 100, fee_value: 5 },
      { min_amount: 101, max_amount: 1000, fee_value: 10 },
    ],
  },
];

const labelOf = (id: string): string => {
  const flat = groupFeeRules(rules).flatMap((g) => g.rules);
  const rule = flat.find((r) => r.id === id)!;
  return feeRuleLabel(rule);
};

describe('feeRuleLabel', () => {
  it('never advertises a bracket-priced rule as free', () => {
    // Globe Load's fee_value is 0; its tiers are what charge. The old label
    // printed "Globe Load (₱0.00)".
    expect(labelOf('r6')).not.toContain('₱0.00');
    expect(labelOf('r6')).toContain('fee by amount');
  });

  it('says the same for the other two rules that used to read ₱0.00', () => {
    expect(labelOf('r8')).toContain('fee by amount');
    expect(labelOf('r5')).not.toContain('₱0.00');
  });

  it('names the single bracket a one-tier rule actually has', () => {
    expect(labelOf('r5')).toBe('ATM Withdrawal Minimum — ₱30.00 (₱1.00–₱3,000.00)');
  });

  it('spells out a per-step rule rather than quoting its base alone', () => {
    expect(labelOf('r4')).toContain('₱30.00 + ₱30.00 per ₱1,000.00');
  });

  it('keeps a genuinely free or fixed rule honest too', () => {
    expect(labelOf('r7')).toBe('Load DITO Sim — ₱5.00');
  });

  it('drops the bracket noise the old label carried', () => {
    // Was: "[OUT] Load Purchase / Globe Load — Globe Load (₱0.00)"
    expect(labelOf('r6')).toBe('Globe Load — fee by amount');
  });
});

describe('groupFeeRules', () => {
  it('splits by the side of the till the money moves', () => {
    const groups = groupFeeRules(rules);
    expect(groups.map((g) => g.label)).toEqual(['Money In', 'Money Out']);
    expect(groups[0].rules).toHaveLength(1);
    expect(groups[1].rules).toHaveLength(7);
  });

  it('leaves unambiguous names alone, so the common case stays short', () => {
    const flat = groupFeeRules(rules).flatMap((g) => g.rules);
    expect(flat.find((r) => r.id === 'r6')!.name).toBe('Globe Load');
    expect(flat.find((r) => r.id === 'r5')!.name).toBe('ATM Withdrawal Minimum');
  });

  it('only adds the service when two rules share a name', () => {
    const colliding: FeeRuleOption[] = [
      { id: 'c1', name: 'ATM Withdrawal', direction: 'out', type_name: 'Customer Withdrawal', category_name: 'ATM Withdrawal', fee_type: 'fixed', fee_value: 30 },
      { id: 'c2', name: 'ATM Withdrawal', direction: 'out', type_name: 'Customer Withdrawal', category_name: null, fee_type: 'fixed', fee_value: 50 },
    ];
    const names = groupFeeRules(colliding)[0].rules.map((r) => r.name);
    expect(names).toEqual(['ATM Withdrawal (ATM Withdrawal)', 'ATM Withdrawal (Customer Withdrawal)']);
  });

  it('puts a rule with no readable side in Other rather than dropping it', () => {
    const odd = groupFeeRules([{ id: 'o1', name: 'Adjustment', direction: 'adjustment', fee_type: 'fixed', fee_value: 0 }]);
    expect(odd).toHaveLength(1);
    expect(odd[0].label).toBe('Other');
    expect(odd[0].rules[0].id).toBe('o1');
  });
});
