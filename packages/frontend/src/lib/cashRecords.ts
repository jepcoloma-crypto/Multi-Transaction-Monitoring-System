import { api } from './api';

// One ledger row that touched a branch's cash accounts, as `GET
// /cash-management/records` serves it. Amounts arrive as fixed two-decimal
// strings so the renderer never has to guess a precision.
export interface CashRecord {
  id: string;
  businessDate: string;
  entryDate: string;
  direction: 'in' | 'out';
  bucket: string;
  category: string;
  amount: string;
  balanceAfter: string;
  accountName: string;
  branchCode: string | null;
  branchName: string | null;
  transactionNumber: number | null;
  paymentMethod: string | null;
  payee: string | null;
  referenceNumber: string | null;
  description: string | null;
  recordedBy: string | null;
}

// A class the register can be narrowed to, with the count it holds in the
// current branch scope. Built from the same population the rows come from, so
// the dropdown cannot offer a class that yields nothing.
export interface CashRecordClass {
  bucket: string;
  label: string;
  count: number;
}

export interface CashRecordPage {
  records: CashRecord[];
  classes: CashRecordClass[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface CashRecordFilters {
  branchId?: string;
  type?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const queryString = (filters: CashRecordFilters): string => {
  const params = new URLSearchParams();
  if (filters.branchId) params.set('branchId', filters.branchId);
  if (filters.type) params.set('type', filters.type);
  if (filters.search) params.set('search', filters.search);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  return params.toString();
};

/**
 * The drawer's register for the branch in view — every cash-account ledger row,
 * newest first. No period: a list of what has been recorded is a point-in-time
 * question, and the period-shaped cash analysis stays in Reports (D18). Only
 * the branch, the class and a search narrow it.
 *
 * Fatal rather than advisory, unlike `fetchShiftActivity`: this list is the
 * section's whole content, so a caller that silently returned nothing would be
 * showing "no records" for a failure.
 */
export const fetchCashRecords = (filters: CashRecordFilters = {}): Promise<CashRecordPage> => {
  const qs = queryString(filters);
  return api.get<CashRecordPage>(`/cash-management/records${qs ? `?${qs}` : ''}`);
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * The whole filtered register as a CSV file.
 *
 * Narrowed exactly as the screen is, but not to the visible page: the export
 * carries every matching row. The server writes the BOM and reads the date in
 * Manila, so the file opens with its peso signs intact and without the day the
 * rows belong to drifting back by one.
 */
export const downloadCashRecordsCsv = async (filters: CashRecordFilters = {}): Promise<void> => {
  const qs = queryString(filters);
  const res = await fetch(`${API_BASE}/cash-management/records${qs ? `?${qs}&format=csv` : '?format=csv'}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` },
  });
  if (!res.ok) {
    let message = `Export failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      // Non-JSON body: keep the status message.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cash-records.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};