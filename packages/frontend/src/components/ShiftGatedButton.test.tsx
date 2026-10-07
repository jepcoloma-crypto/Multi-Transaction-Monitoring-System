import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '../lib/api';
import { ShiftGatedButton } from './ShiftGatedButton';
import { NO_OPEN_SHIFT_HINT } from '../hooks/useShiftGate';

const get = vi.mocked(api.get);

const openShifts = { shifts: [{ id: 'shift-1', status: 'open' as const }] };
const closedShifts = { shifts: [{ id: 'shift-1', status: 'closed' as const }] };

const renderButton = (onClick = vi.fn()) => {
  render(<ShiftGatedButton onClick={onClick}>Record expense</ShiftGatedButton>);
  return { onClick, button: screen.getByRole('button', { name: 'Record expense' }) as HTMLButtonElement };
};

describe('ShiftGatedButton', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('is disabled with a progress reason while the check is in flight', () => {
    get.mockReturnValue(new Promise(() => {}));
    const { button } = renderButton();
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Checking whether a shift is open…')).toBeTruthy();
  });

  it('is disabled with the shift reason when nothing is open', async () => {
    get.mockResolvedValue(closedShifts);
    const { button } = renderButton();
    await waitFor(() => expect(screen.getByText(NO_OPEN_SHIFT_HINT)).toBeTruthy());
    expect(button.disabled).toBe(true);
  });

  it('is disabled with the shift reason when there are no shifts at all', async () => {
    get.mockResolvedValue({ shifts: [] });
    const { button } = renderButton();
    await waitFor(() => expect(screen.getByText(NO_OPEN_SHIFT_HINT)).toBeTruthy());
    expect(button.disabled).toBe(true);
  });

  it('enables and drops the reason once a shift is open', async () => {
    get.mockResolvedValue(openShifts);
    const { button } = renderButton();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.queryByText(NO_OPEN_SHIFT_HINT)).toBeNull();
    expect(screen.queryByText('Checking whether a shift is open…')).toBeNull();
  });

  it('offers the action, not silence, when the gate cannot be checked', async () => {
    // Fail-open: the server still refuses with its own 409, whereas refusing
    // here would quietly stop someone who is allowed to work.
    get.mockRejectedValue(new Error('403 Forbidden'));
    const { button } = renderButton();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('does not fire onClick while gated', async () => {
    get.mockResolvedValue(closedShifts);
    const { onClick, button } = renderButton();
    await waitFor(() => expect(button.disabled).toBe(true));

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick once the gate opens', async () => {
    get.mockResolvedValue(openShifts);
    const { onClick, button } = renderButton();
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
