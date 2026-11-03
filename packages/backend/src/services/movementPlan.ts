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
 * The same question asked of the direction *and* the code, because one
 * direction family answers two opposite movements.
 *
 * The adjustment pair shares the single direction value 'adjustment' — the
 * family says "adjustment", not which way — so direction alone books every
 * adjustment as money in: an Adjustment Out meant to take cash out of the
 * drawer was credited into it. `paymentPlan` always knew this (its own inline
 * override), but the approve route settled with the direction-only rule, so
 * an operator-created Adjustment Out — which waits for approval by design —
 * posted the wrong way the moment an admin released it, while an
 * admin-created one (settled immediately, correct sign) looked fine. One
 * function, used by both paths, so the two cannot disagree again.
 */
export function entryTypeOf(direction: string, code: string): 'debit' | 'credit' {
  return code === 'adjustment_out' ? 'debit' : entryTypeFor(direction);
}

/**
 * The sign a reversal of this movement posts: always the mirror of the
 * original — money that left comes back, money that landed returns. Asked of
 * direction AND code for the same reason `entryTypeOf` is: the adjustment
 * pair shares one direction value, so a family-only rule reverses an
 * Adjustment In with a credit — handing money back to an account it was
 * landing in, doubling it instead of removing it. Every other family comes
 * out exactly where the old ternary put it.
 */
export function mirrorEntryTypeOf(direction: string, code: string): 'debit' | 'credit' {
  return entryTypeOf(direction, code) === 'credit' ? 'debit' : 'credit';
}

/**
 * The type code a reversal row carries. The adjustment pair swaps members —
 * the mirror of an Adjustment Out is an Adjustment In and the other way
 * around — and every other movement mirrors through the pair by its family,
 * exactly as it always has.
 */
export function mirrorTypeCodeOf(direction: string, code: string): string {
  if (code === 'adjustment_out') return 'adjustment_in';
  if (code === 'adjustment_in') return 'adjustment_out';
  return direction === 'in' ? 'adjustment_out' : 'adjustment_in';
}

/**
 * What the balance moves: a cash-in lands the amount and never the fee (D46).
 *
 * A cash-in's fee is the till's income whichever way the tender carried it, so
 * the receiving account lands `amount` and nothing else — a fee collected on
 * top is handed over as separate cash and stays in the drawer (D46, reversing
 * D42's "in, fee on top" cell), and a fee carved from the amount was never in
 * the balance to begin with. Only a cash-out still reads the flag: a fee carved
 * from what leaves is cut from the debit, so the account hands out amount − fee.
 * The books grow by exactly the fee in all four cells either way, because
 * `drawerLeg` takes the rest (design D24's identity).
 *
 * D40 posted the amount as typed in every cell, which left two of them
 * wrong: a ₱510 cash-in with a ₱10 fee on top booked ₱500 on the account and
 * ₱490 out of the drawer — ₱10 that never existed in the till. D42 fixed that
 * by landing amount + fee on the account, which over-credited the customer by
 * the fee and left the till holding nothing to show for it. The account now
 * lands the amount alone and the fee posts on the drawer as its own row.
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
  const netAmount = input.direction === 'out' && feeInside
    ? round2(input.amount - fee)
    : input.amount;
  return { feeInside, exceeds, netAmount };
}

/**
 * Whether a movement's fee takes its own row on the till (D37/D46).
 *
 * On a cash-out the customer paid the fee in cash, so it has always been the
 * till's own first row. A cash-in collected it the other way: a fee taken
 * inside the amount was cut from what the account receives and rides that
 * account (D42's other cell, unchanged), while a fee collected on top was
 * handed over as separate cash — it is the drawer's income, not the
 * e-wallet's, and posts beside the movement on the drawer (D46).
 *
 * The flag is about where the fee's *row* goes, not about the balance: both
 * cash-in cells land the same figure on the account, and only this decides
 * which side carries the line that says the fee exists.
 *
 * Every direction but a cash-in already posts the fee on the till, so they
 * keep doing so unchanged. A movement with no fee, or one whose branch has no
 * drawer, never reaches the row split at all — `resolveDrawerLeg` writes
 * nothing for it — so `true` there is inert rather than wrong.
 */
export function feeOnDrawerOf(input: {
  direction: string;
  fee: number;
  feeAddedToBalance: boolean;
}): boolean {
  if (!(input.fee > 0)) return false;
  if (input.direction !== 'in') return true;
  return input.feeAddedToBalance !== false;
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
  /**
   * Cash claim (C1): has the physical cash actually been handed over? Only a
   * cash-in answered "no" may be recorded as pending instead of completing;
   * blank and absent both mean yes — the default is unchanged behaviour.
   */
  cashReceived?: unknown;
  expenseThreshold: number;
  isAdminCreator: boolean;
}

export interface PaymentPlan {
  /** After the cash-account rule has forced or accepted it. */
  paymentMethod: string | null;
  entryType: 'debit' | 'credit';
  /** Whether the fee was taken inside the amount: the tender's record, and still a posting rule for a cash-out (D46). */
  feeInside: boolean;
  /** Whether the fee takes its own row on the till rather than the account (D37/D46). */
  feeOnDrawer: boolean;
  netAmount: number;
  totalCharges: number;
  totalAmount: number;
  providerCharge: number;
  /** What the movement's own status will be once approval rules are applied. */
  finalStatus: string;
  requiresApproval: boolean;
  /** Why the row waits: approval rules, or cash that has not arrived (cash claim, C1). */
  pendingReason: 'approval' | 'cash_receipt' | null;
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

  // The adjustment pair shares one direction value — the family says
  // "adjustment", not which way — so the code has to carry the sign (see
  // `entryTypeOf`): an Adjustment In credits the account it lands on, an
  // Adjustment Out debits it. Planning both off the family value booked every
  // adjustment as money in, which would have put cash INTO the drawer an
  // "Adjustment Out" is meant to take it out of. The reversal flow writes its
  // own rows (mirroring the original) and never asks this question; the entry
  // route, its preview and the cash-event form do.
  const entryType = entryTypeOf(input.direction, input.code);
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

  // Cash claim (C1): the one case an ordinary movement may be created
  // pending. The operator states the physical cash has not arrived, so the row
  // waits as UNCLAIMED and posts no legs until someone claims it — narrower
  // than the old refusal by design: cash tender, money in, not a controlled
  // type (those already wait for approval, which is a different question).
  // Everything else keeps the refusal below, because its money has already
  // changed hands somewhere the system cannot see.
  const cashReceived =
    input.cashReceived === undefined || input.cashReceived === null
      ? true
      : !(input.cashReceived === false || String(input.cashReceived).toLowerCase() === 'false');
  const awaitingCash = !requiresApproval && !cashReceived && method === 'cash' && input.direction === 'in';
  // Refused rather than quietly ignored when the tender or the direction
  // cannot wait at all: the form only offers the choice where it is legal, so
  // a request claiming otherwise is not something an operator chose.
  if (!requiresApproval && !cashReceived && !awaitingCash) {
    problems.push('Only a cash-in paid in cash can wait for cash that has not arrived');
  }

  let finalStatus = requiresApproval ? 'pending' : (input.requestedStatus as string) || 'completed';
  let pendingReason: 'approval' | 'cash_receipt' | null = requiresApproval ? 'approval' : null;
  if (awaitingCash) {
    finalStatus = 'pending';
    pendingReason = 'cash_receipt';
  } else if (finalStatus !== 'completed' && !isControlled) {
    problems.push('Only owner fund movements, operating expenses, cash payments, borrowings and unclaimed cash-ins can be created as pending');
  }
  // A charge the operator typed in and the books then forgot would be worse
  // than one refused up front.
  if (providerChargeNum > 0 && finalStatus !== 'completed') {
    problems.push('A provider charge can only be recorded on a transaction that completes now');
  }

  // Signed for `drawerLeg`: positive when the account's leg is a credit. It is
  // the account's whole row — netAmount plus charges, the figure the balance
  // actually moves (D46) — because the drawer has to move opposite to exactly
  // what the account moved, or the identity `signed + drawer_delta = fee`
  // breaks on any movement that carries charges. The fee takes its own row on
  // whichever side the tender put it (D37/D46), which is where the two cash-in
  // modes stop looking alike even though both land `amount` on the account.
  const drawerSignedAmount = entryType === 'credit' ? totalAmount : -totalAmount;
  const feeOnDrawer = feeOnDrawerOf({
    direction: input.direction,
    fee: input.fee,
    feeAddedToBalance: input.feeAddedToBalance,
  });
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
    feeOnDrawer,
    netAmount,
    totalCharges,
    totalAmount,
    providerCharge: providerChargeNum,
    finalStatus,
    requiresApproval,
    pendingReason: finalStatus === 'pending' ? pendingReason : null,
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
