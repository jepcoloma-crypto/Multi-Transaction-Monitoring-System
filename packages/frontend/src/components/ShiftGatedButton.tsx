import type { ReactNode } from 'react';
import { NO_OPEN_SHIFT_HINT, useShiftGate } from '../hooks/useShiftGate';

type Props = {
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  variant?: 'btn-primary' | 'btn-secondary';
};

/**
 * A create button the shift gate (D17) conditions on a drawer being open.
 *
 * Disabled rather than hidden, and always accompanied by the reason: a grey
 * button with nothing beside it reads as a broken control, and the operator
 * would be left guessing whether the refusal is the shift or their click. The
 * server is still the authority — this only answers earlier.
 */
export function ShiftGatedButton({ onClick, children, icon, variant = 'btn-primary' }: Props) {
  const gate = useShiftGate();

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button type="button" onClick={onClick} className={`${variant} flex items-center gap-2`} disabled={!gate.ready}>
        {icon}
        {children}
      </button>
      {!gate.ready && (
        <p className="text-xs text-amber-700">
          {gate.loading ? 'Checking whether a shift is open…' : NO_OPEN_SHIFT_HINT}
        </p>
      )}
    </div>
  );
}
