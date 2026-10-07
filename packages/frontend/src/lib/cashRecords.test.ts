import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({ api: { get: vi.fn() } }));

import { api } from './api';
import { fetchCashRecords, type CashRecordPage } from './cashRecords';

const get = vi.mocked(api.get);

const payload: CashRecordPage = {
  records: [],
  classes: [],
  pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
};

describe('fetchCashRecords', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('asks for the whole register when nothing narrows it', async () => {
    get.mockResolvedValue(payload);
    await expect(fetchCashRecords()).resolves.toEqual(payload);
    expect(get).toHaveBeenCalledWith('/cash-management/records');
  });

  it('narrows by branch, class, search and page — but never by a date', async () => {
    get.mockResolvedValue(payload);
    await fetchCashRecords({
      branchId: 'branch-1',
      type: 'operating_expenses',
      search: 'rent',
      page: 3,
      limit: 50,
    });
    expect(get).toHaveBeenCalledWith(
      '/cash-management/records?branchId=branch-1&type=operating_expenses&search=rent&page=3&limit=50',
    );
  });

  it('reads an empty filter as no filter rather than sending blank values', async () => {
    get.mockResolvedValue(payload);
    await fetchCashRecords({ branchId: '', type: '', search: '' });
    expect(get).toHaveBeenCalledWith('/cash-management/records');
  });

  it('omits the page when it is the first, so the URL stays the default', async () => {
    get.mockResolvedValue(payload);
    await fetchCashRecords({ branchId: 'branch-1' });
    expect(get).toHaveBeenCalledWith('/cash-management/records?branchId=branch-1');
  });
});