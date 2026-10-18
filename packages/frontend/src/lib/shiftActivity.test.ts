import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ api: { get: vi.fn() } }));

import { api } from './api';
import { fetchShiftActivity, type ShiftActivity } from './shiftActivity';

const get = vi.mocked(api.get);

const payload: ShiftActivity = {
  shiftDates: ['2026-10-04'],
  branches: [
    {
      branchId: 'branch-1',
      branchName: 'Main Branch',
      shiftDate: '2026-10-04',
      income: { txnFees: 10, loadMargin: 5, totalIncome: 15, drawerIncome: 11, nonCashIncome: 4 },
      expense: { serviceFees: 4, providerCharges: 1, operatingExpenses: 2, totalExpense: 7 },
    },
  ],
  totals: {
    income: { txnFees: 10, loadMargin: 5, total: 15, drawerIncome: 11, nonCashIncome: 4 },
    expense: { serviceFees: 4, providerCharges: 1, operatingExpenses: 2, total: 7 },
    net: 8,
  },
};

describe('fetchShiftActivity', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('asks for the whole report when nothing narrows it', async () => {
    get.mockResolvedValue(payload);
    await expect(fetchShiftActivity()).resolves.toEqual(payload);
    expect(get).toHaveBeenCalledWith('/reports/shift-activity');
  });

  it('narrows to the branch and to nothing else', async () => {
    get.mockResolvedValue(payload);
    await fetchShiftActivity('branch-1');
    expect(get).toHaveBeenCalledWith('/reports/shift-activity?branchId=branch-1');
  });

  it('reads an empty branch as no branch rather than sending an empty value', async () => {
    get.mockResolvedValue(payload);
    await fetchShiftActivity('');
    expect(get).toHaveBeenCalledWith('/reports/shift-activity');
  });

  it('resolves to null rather than throwing when the panel cannot load', async () => {
    get.mockRejectedValue(new Error('403 Forbidden'));
    await expect(fetchShiftActivity('branch-1')).resolves.toBeNull();
  });

  it('still returns the payload when a previous call failed', async () => {
    get.mockRejectedValueOnce(new Error('timeout'));
    await expect(fetchShiftActivity()).resolves.toBeNull();

    get.mockResolvedValue(payload);
    await expect(fetchShiftActivity()).resolves.toEqual(payload);
  });

  it('accepts a backend that does not serve the daily income split yet', async () => {
    // The two new fields are optional so the panel can be built and shipped
    // ahead of the endpoint that fills them. If they were required this would
    // not compile — which is the point: the card reads an em dash rather than
    // a 0.00 that would claim the shift earned nothing.
    const older: ShiftActivity = {
      ...payload,
      branches: [{ ...payload.branches[0], income: { txnFees: 10, loadMargin: 5, totalIncome: 15 } }],
      totals: { ...payload.totals, income: { txnFees: 10, loadMargin: 5, total: 15 } },
    };

    get.mockResolvedValue(older);
    await expect(fetchShiftActivity()).resolves.toEqual(older);
    expect(older.branches[0].income.drawerIncome).toBeUndefined();
    expect(older.totals.income.nonCashIncome).toBeUndefined();
  });
});
