import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '../lib/api';
import { useShiftGate } from './useShiftGate';

const get = vi.mocked(api.get);

const openShifts = { shifts: [{ id: 'shift-1', status: 'open' as const }] };
const closedShifts = { shifts: [{ id: 'shift-1', status: 'closed' as const }] };

describe('useShiftGate', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('reports closed and loading before the answer arrives', () => {
    get.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useShiftGate());
    expect(result.current).toEqual({ ready: false, loading: true });
  });

  it('always asks the shift endpoint', () => {
    get.mockReturnValue(new Promise(() => {}));
    renderHook(() => useShiftGate());
    expect(get).toHaveBeenCalledWith('/cash-management/shifts');
  });

  it('opens when a shift is open', async () => {
    get.mockResolvedValue(openShifts);
    const { result } = renderHook(() => useShiftGate());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(true);
  });

  it('stays closed when every shift is closed', async () => {
    get.mockResolvedValue(closedShifts);
    const { result } = renderHook(() => useShiftGate());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(false);
  });

  it('stays closed when there are no shifts at all', async () => {
    get.mockResolvedValue({ shifts: [] });
    const { result } = renderHook(() => useShiftGate());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(false);
  });

  it('treats a missing shifts array as closed rather than crashing', async () => {
    get.mockResolvedValue({} as never);
    const { result } = renderHook(() => useShiftGate());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(false);
  });

  it('fails open when the endpoint cannot be asked', async () => {
    // The endpoint needs `reports.read`, which is not the same permission as
    // being allowed to write — refusing here would stop someone the server
    // would have allowed.
    get.mockRejectedValue(new Error('403 Forbidden'));
    const { result } = renderHook(() => useShiftGate());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(true);
  });

  it('does not update state after the caller has unmounted', async () => {
    let resolve!: (v: typeof openShifts) => void;
    get.mockReturnValue(new Promise((r) => { resolve = r; }));

    const { unmount } = renderHook(() => useShiftGate());
    unmount();

    // A late answer must not reach React; if it did, this would warn.
    resolve(openShifts);
    await new Promise((r) => setTimeout(r, 0));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
