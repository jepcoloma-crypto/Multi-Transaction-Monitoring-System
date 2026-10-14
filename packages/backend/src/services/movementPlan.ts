// What a movement writes, decided once and shared by the entry route and the
// entry preview. Pure — no network, no database — so the figures an operator
// reads before saving are testable without a server, and so the preview and
// the commit cannot drift into disagreeing about the till.
//
// The sequence is the create route's own, in its own order, with its own
// messages: input guards first, then the type refusals (checked before the
// shift gate, because a type nobody may record is not worth a gate error), then
// everything that depends on the account's type and the operator's choices. The
// route keeps the parts that are genuinely route-shaped — reading rows, the
// shift gate, the drawer's identity and balance — and throws what this module
// reports in `problems`, in order, exactly as it threw them before they moved.
//
// The drawer leg comes from `drawerLeg` (D12/D24), the approval decision from
// `controlledApproval`, and the refusals from the same functions the route has
// always called. This module owns no rules of its own; it sequences them.

import {
  directTypeRefusal,
  expenseFeeRefusal,
  isCashMovement,
  isPaymentMethod,
  isMovementPaymentMethod,
  PAYMENT_METHODS,
  MOVEMENT_PAYMENT_METHODS,
  resolveCashAccountMethod,
  controlledApproval,
  drawerLeg,
} from './cashManagement';
import type { DrawerLeg } from './cashManagement';

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Which way an account's own row moves, from a type's direction. */
export function entryTypeFor(direction: string): 'debit' | 'credit' {
  return direction === 'in' || direction === 'adjustment' ? 'credit' : 'debit';
}

/**
 * What the balance moves: the fee rides the side the customer paid it on (D42).
 *
 * A fee paid on top of a cash-in is e-money arriving with the amount, so the
 * account lands amount + fee. A fee carved from the amount of a cash-out is
 * cash the till keeps, so the account hands out amount − fee. The other two
 * cells need no rule of their own: a fee inside a cash-in is already cut from
 * the drawer's leg by `drawerLeg`'s formula, and a fee on top of a cash-out is
 * already added to it — so those two cells carry the amount as typed, and the
 * books grow by exactly the fee in all four (design D24's identity).
 *
 * D40 posted the amount as typed in every cell, which left two of them
 * wrong: a ₱510 cash-in with a ₱10 fee on top booked ₱500 on the account and
 * ₱490 out of the drawer — ₱10 that never existed in the till. This restores
 * the tender flag as a posting rule, but only where it moves a peso: the
 * account's figure changes in the two cells the old formula mis-netted.
 *
 * A fee inside the amount cannot exceed it — the fee is a cut of what was
 * sent, and a larger cut would book income the money never carried — so that
 * is refused rather than silently absorbed (D40's guard, unchanged).
 *
 * Shared by the entry route, the entry preview, the edit route and the
 * correction planner: editing must reproduce what creation would have
 * written, or correcting an amount would quietly re-price the movement.
 */
export function netAmountOf(input: {
  direction: string;
  amount: number;
  fee: number;
  feeAddedToBalance: boolean;
}): { feeInside: boolean; exceeds: boolean; netAmount: number } {
  const feeInside = input.feeAddedToBalance === false && input.fee > 0;
  const exceeds = feeInside && input.amount < input.fee;
  const fee = input.fee > 0 ? round2(input.fee) : 0;
  const netAmount = input.direction === 'in' && !feeInside
    ? round2(input.amount + fee)
    : input.direction === 'out' && feeInside
      ? round2(input.amount - fee)
      : input.amount;
  return { feeInside, exceeds, netAmount };
}

/**
 * The two figures typed by hand, refused before any rule is consulted.
 *
 * A non-finite amount used to travel all the way to the INSERT and come back
 * as a 500 from Postgres about `NaN`; the preview would have had no way to
 * reproduce that, so the guard lives here where both paths meet it.
 */
export function validateMovementInputs(amount: number, enteredFee: number): string | null {
  if (!Number.isFinite(amount)) return 'Amount must be a number';
  if (amount < 0) return 'Amount cannot be negative';
  if (enteredFee < 0) return 'Fee cannot be negative';
  return null;
}

/**
 * The refusals that belong before the shift gate: a type nobody may record, or
 * a fee on a cost. Returned as a list so the preview can show both; the route
 * throws the first, which is the one it always threw first.
 */
export function movementRefusals(typeCode: string, fee: number): string[] {
  const problems: string[] = [];
  const typeRefusal = directTypeRefusal(typeCode);
  if (typeRefusal) problems.push(typeRefusal);
  const feeRefusal = expenseFeeRefusal(typeCode, fee);
  if (feeRefusal) problems.push(feeRefusal);
  return problems;
}

export interface PaymentPlanInput {
  direction: string;
  code: string;
  accountTypeCode: string | null;
  amount: number;
  fee: number;
  feeAddedToBalance: boolean;
  additionalCharges?: Array<{ amount?: unknown }> | null;
  /** As typed by the operator; blank and absent both mean "no method yet". */
  paymentMethod?: unknown;
  providerCharge?: unknown;
  requestedStatus?: unknown;
  expenseThreshold: number;
  isAdminCreator: boolean;
}

export interface PaymentPlan {
  /** After the cash-account rule has forced or accepted it. */
  paymentMethod: string | null;
  entryType: 'debit' | 'credit';
  /** Whether the fee was taken inside the amount: tender record and posting rule (D42). */
  feeInside: boolean;
  netAmount: number;
  totalCharges: number;
  totalAmount: number;
  providerCharge: number;
  /** What the movement's own status will be once approval rules are applied. */
  finalStatus: string;
  requiresApproval: boolean;
  /** Signed for `drawerLeg`: positive when the account's leg is a credit. */
  drawerSignedAmount: number;
  /** The drawer's own row, before the route checks the account's identity. */
  drawerLeg: DrawerLeg | null;
  /** The entry form's badge: does physical cash enter or leave the drawer. */
  cashBehavior: 'in' | 'out' | 'none';
  /** Refusals in the order the create route threw them. */
  problems: string[];
}

export function paymentPlan(input: PaymentPlanInput): PaymentPlan {
  const problems: string[] = [];

  // A cash movement is not planned until the operator says how the money
  // actually changed hands, because that is what decides whether the drawer
  // takes part (migration 036 carries the same reasoning).
  let method =
    input.paymentMethod === undefined || input.paymentMethod === null || String(input.paymentMethod).trim() === ''
      ? null
      : String(input.paymentMethod).trim();

  if (method !== null && !isPaymentMethod(method)) {
    problems.push(`Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  if (isCashMovement(input.code) && !isMovementPaymentMethod(method)) {
    problems.push(`A ${input.code.replace(/_/g, ' ')} needs a payment method: ${MOVEMENT_PAYMENT_METHODS.join(', ')}`);
  }

  // A cash account's balance *is* the drawer's cash: a blank is answered by the
  // account, and a method that disagrees is refused rather than overwritten,
  // because overwriting would record something nobody chose.
  const cashMethod = resolveCashAccountMethod(input.accountTypeCode, method);
  if (cashMethod.action === 'refuse') problems.push(cashMethod.message);
  if (cashMethod.action === 'force') method = cashMethod.method;

  // A provider charge is the company's own cost: never folded into this row's
  // amount or fee, recorded as a second linked expense row instead (migration
  // 032), and only on money actually moving in or out.
  let providerChargeNum = 0;
  if (input.providerCharge !== undefined && input.providerCharge !== null && input.providerCharge !== '') {
    providerChargeNum = parseFloat(String(input.providerCharge));
    if (!Number.isFinite(providerChargeNum)) {
      problems.push('Provider charge must be a number');
      providerChargeNum = 0;
    } else if (providerChargeNum < 0) {
      problems.push('Provider charge cannot be negative');
      providerChargeNum = 0;
    } else {
      providerChargeNum = round2(providerChargeNum);
      if (providerChargeNum > 0 && input.direction !== 'in' && input.direction !== 'out') {
        problems.push('A provider charge can only be recorded on a cash-in or cash-out');
      }
      if (providerChargeNum > 0 && input.code === 'expense') {
        problems.push('A provider charge cannot be added to an expense row');
      }
    }
  }

  const entryType = entryTypeFor(input.direction);
  const net = netAmountOf({
    direction: input.direction,
    amount: input.amount,
    fee: input.fee,
    feeAddedToBalance: input.feeAddedToBalance,
  });
  if (net.exceeds) {
    problems.push('Fee cannot exceed the transaction amount when the fee is taken inside the amount');
  }
  const feeInside = net.feeInside;
  const netAmount = net.netAmount;
  const totalCharges = (input.additionalCharges || []).reduce(
    (sum, c) => sum + (parseFloat(String(c?.amount)) || 0),
    0
  );
  const totalAmount = netAmount + totalCharges;

  // Who may settle at once and who must wait, in one place so the three rules
  // cannot drift apart (see `controlledApproval`).
  const { controlled: isControlled, requiresApproval } = controlledApproval(
    input.code,
    input.amount,
    input.expenseThreshold,
    input.isAdminCreator
  );
  const finalStatus = requiresApproval ? 'pending' : (input.requestedStatus as string) || 'completed';

  if (finalStatus !== 'completed' && !isControlled) {
    problems.push('Only owner fund movements, operating expenses, cash payments and borrowings can be created as pending');
  }
  // A charge the operator typed in and the books then forgot would be worse
  // than one refused up front.
  if (providerChargeNum > 0 && finalStatus !== 'completed') {
    problems.push('A provider charge can only be recorded on a transaction that completes now');
  }

  // Signed for `drawerLeg`: positive when the account's leg is a credit. It is
  // the account's whole row — netAmount plus charges, the figure the balance
  // actually moves (D42) — because the drawer has to move opposite to exactly
  // what the account moved, or the identity `signed + drawer_delta = fee`
  // breaks on any movement that carries charges. The fee rides the side that
  // paid it (D42), so this is where the two fee modes stop being the same
  // number: a cash-in that collected the fee on top signs for amount + fee.
  const drawerSignedAmount = entryType === 'credit' ? totalAmount : -totalAmount;
  const drawerLegRow = method === 'cash' ? drawerLeg(drawerSignedAmount, input.fee) : null;

  // The badge the entry form shows beside the type. On a movement booked
  // straight onto a cash account the account leg *is* the drawer, so its
  // direction answers; otherwise the drawer's own leg does; a movement settled
  // any other way touches no physical cash.
  let cashBehavior: 'in' | 'out' | 'none' = 'none';
  if (input.accountTypeCode === 'cash') {
    cashBehavior = entryType === 'credit' ? 'in' : 'out';
  } else if (drawerLegRow) {
    cashBehavior = drawerLegRow.entryType === 'credit' ? 'in' : 'out';
  }

  return {
    paymentMethod: method,
    entryType,
    feeInside,
    netAmount,
    totalCharges,
    totalAmount,
    providerCharge: providerChargeNum,
    finalStatus,
    requiresApproval,
    drawerSignedAmount,
    drawerLeg: drawerLegRow,
    cashBehavior,
    problems,
  };
}

export interface FundingCheck {
  balance: number;
  entryType: 'debit' | 'credit';
  status: string;
  totalAmount: number;
  providerCharge: number;
}

/**
 * Whether the account can afford what it is about to hand over, and how the
 * refusal reads. The charge is a second debit from the same balance, so the
 * account has to carry both — rounded before comparing: two 2-decimal figures
 * added as floats can land a hair above the true total and reject a balance
 * that is exactly enough.
 *
 * A pending row withdraws nothing yet, so there is nothing to fund: the balance
 * belongs to approval, which checks it inside the same transaction that writes
 * the debit (design D5).
 */
export function fundingProblem(check: FundingCheck): string | null {
  if (check.entryType !== 'debit' || check.status === 'pending') return null;
  const required = round2(check.totalAmount + check.providerCharge);
  if (check.balance < required) {
    return check.providerCharge > 0
      ? 'Insufficient balance for the transaction plus the provider charge'
      : 'Insufficient balance';
  }
  return null;
}
