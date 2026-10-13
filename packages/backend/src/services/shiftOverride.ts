import crypto from 'crypto';
import { config } from '../config';

// The second signature for a back-dated shift (D38). The operator does not
// hand her session over: an administrator proves who she is at the moment the
// past day is picked, and the proof comes back as a token this server can
// check again when the shift is actually opened. Three properties are what
// make it a signature rather than a checkbox:
//
//   it is short-lived — five minutes, the walk-over-and-approve window, not
//   the rest of the shift;
//   it is bound — to this branch and this exact day, so an approval collected
//   for Monday cannot be spent on Tuesday, and a captured one is worth at
//   most the single shift the one-per-day rule lets that day take anyway;
//   it is signed — HMAC over the payload with the server's own secret, so
//   nothing inside can be edited after issue, and the purpose claim keeps it
//   from being confused with any other token this secret might ever sign.
//
// Stateless on purpose: a table of issued approvals would have to be cleaned
// up, would survive restarts it has no reason to survive, and would buy
// nothing the binding and the five minutes do not already buy.

export const SHIFT_OVERRIDE_TTL_SECONDS = 5 * 60;

const PURPOSE = 'shift-override';

interface OverridePayload {
  /** The administrator who approved, by id. The operator's id never appears. */
  a: string;
  /** Branch the approval may open a shift in. */
  b: string;
  /** Shift date (YYYY-MM-DD) it may open, and no other. */
  d: string;
  /** Purpose, so this token cannot stand in for another kind. */
  p: string;
  /** Expiry, epoch seconds. */
  x: number;
  /** Nonce, so two approvals of the same day are not the same token. */
  n: string;
}

const sign = (body: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(body).digest('base64url');

/**
 * Mint the administrator's approval for one branch and one day. `secret` and
 * `nowMs` are parameters so the tests can hold the clock and the key; the
 * live callers take both from the server.
 */
export function mintShiftOverrideToken(
  adminUserId: string,
  branchId: string,
  shiftDate: string,
  secret: string = config.jwt.secret,
  nowMs: number = Date.now(),
): string {
  const payload: OverridePayload = {
    a: adminUserId,
    b: branchId,
    d: shiftDate,
    p: PURPOSE,
    x: Math.floor(nowMs / 1000) + SHIFT_OVERRIDE_TTL_SECONDS,
    n: crypto.randomBytes(8).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * The administrator whose credentials minted the token — or nothing at all,
 * for anything that is not exactly one approval of this branch and this day,
 * still inside its five minutes, signed with this server's key.
 */
export function verifyShiftOverrideToken(
  token: unknown,
  branchId: string,
  shiftDate: string,
  secret: string = config.jwt.secret,
  nowMs: number = Date.now(),
): { adminUserId: string } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  // Constant-time: the signature is the whole barrier between a guessed
  // payload and an approved back-date, so the comparison must not leak where
  // the two strings first differ.
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload: OverridePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.p !== PURPOSE) return null;
  if (payload.b !== branchId || payload.d !== shiftDate) return null;
  if (typeof payload.a !== 'string' || !payload.a) return null;
  // Expired at the second it names, not a second into the one after — five
  // minutes is the window, and the last one it opens is the one before.
  if (!Number.isFinite(payload.x) || Math.floor(nowMs / 1000) >= payload.x) return null;
  return { adminUserId: payload.a };
}
