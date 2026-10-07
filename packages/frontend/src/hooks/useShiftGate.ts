import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Shown wherever a create action is shut because no branch drawer is open. */
export const NO_OPEN_SHIFT_HINT = 'Open a shift first — no money can move without one.';

type ShiftSummary = { id: string; status: 'open' | 'closed' };

export type ShiftGate = {
  /** Whether the create action should be offered right now. */
  ready: boolean;
  /** True while the answer is still in flight, so a button cannot flash on and then off. */
  loading: boolean;
};

export function useShiftGate(): ShiftGate {
  const [gate, setGate] = useState<ShiftGate>({ ready: false, loading: true });

  useEffect(() => {
    let alive = true;
    api
      .get<{ shifts: ShiftSummary[] }>('/cash-management/shifts')
      .then((value) => {
        if (alive) setGate({ ready: (value.shifts || []).some((s) => s.status === 'open'), loading: false });
      })
      .catch(() => {
        // The endpoint needs `reports.read`, which is not the same permission
        // as being allowed to write. If it cannot be asked, the action stays
        // available: the server refuses with its own 409 anyway, whereas
        // refusing here would quietly stop someone who is allowed to work.
        if (alive) setGate({ ready: true, loading: false });
      });

    return () => { alive = false; };
  }, []);

  return gate;
}
