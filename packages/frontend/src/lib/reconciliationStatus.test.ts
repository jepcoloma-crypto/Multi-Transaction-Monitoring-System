import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ api: { get: vi.fn() } }));

import { api } from './api';
import { fetchOverdueReconciliations, type ReconciliationStatus } from './reconciliationStatus';

const get = vi.mocked(api.get);

const payload: ReconciliationStatus = {
  periodDays: 30,
  accounts: [
    {
      accountId: 'acc-1',
      accountName: 'Ma. Jessica Bautista',
      branchId: 'branch-1',
      branchName: 'Main Branch',
      currentBalance: 31880,
      lastReconciledAt: null,
      daysSince: null,
    },
    {
      accountId: 'acc-2',
      accountName: 'Paula Bayubay',
      branchId: 'branch-1',
      branchName: 'Main Branch',
      currentBalance: 1200,
      lastReconciledAt: '2026-09-01T00:00:00+08:00',
      daysSince: 47,
    },
  ],
};

describe('fetchOverdueReconciliations', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('asks for the whole list when nothing narrows it', async () => {
    get.mockResolvedValue(payload);
    await expect(fetchOverdueReconciliations()).resolves.toEqual(payload);
    expect(get).toHaveBeenCalledWith('/reconciliations/overdue');
  });

  it('narrows to the branch and to nothing else', async () => {
    get.mockResolvedValue(payload);
    await fetchOverdueReconciliations('branch-1');
    expect(get).toHaveBeenCalledWith('/reconciliations/overdue?branchId=branch-1');
  });

  it('reads an empty branch as no branch rather than sending an empty value', async () => {
    get.mockResolvedValue(payload);
    await fetchOverdueReconciliations('');
    expect(get).toHaveBeenCalledWith('/reconciliations/overdue');
  });

  it('keeps "never reconciled" apart from a counted number of days', async () => {
    // The two are different findings. A null is an account with no sign-off on
    // record at all; a number is one that had one and stopped. Collapsing the
    // null to zero would print "0 days", which reads as freshly reconciled.
    get.mockResolvedValue(payload);
    const result = await fetchOverdueReconciliations();
    expect(result?.accounts[0].daysSince).toBeNull();
    expect(result?.accounts[1].daysSince).toBe(47);
  });

  it('resolves to null rather than throwing when the panel cannot load', async () => {
    get.mockRejectedValue(new Error('403 Forbidden'));
    await expect(fetchOverdueReconciliations('branch-1')).resolves.toBeNull();
  });

  it('still returns the list when a previous call failed', async () => {
    get.mockRejectedValueOnce(new Error('timeout'));
    await expect(fetchOverdueReconciliations()).resolves.toBeNull();

    get.mockResolvedValue(payload);
    await expect(fetchOverdueReconciliations()).resolves.toEqual(payload);
  });
});
