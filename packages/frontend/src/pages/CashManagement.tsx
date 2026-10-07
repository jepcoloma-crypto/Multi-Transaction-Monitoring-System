import { useState, useEffect, useCallback, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { api, unwrapRows } from '../lib/api';
import { formatCurrency, manilaDateValue, manilaTimeLabel, dateKeyLabel, manilaDayLabel, manilaDateTimeLabel, movementPaymentMethodOptions } from '../lib/format';
import { fetchShiftActivity, type ShiftActivity } from '../lib/shiftActivity';
import {
  fetchCashRecords, downloadCashRecordsCsv,
  type CashRecord, type CashRecordClass, type CashRecordPage,
} from '../lib/cashRecords';
import { useAuth } from '../contexts/AuthContext';
import AccountSelect, { type AccountOption } from '../components/AccountSelect';
import { NO_OPEN_SHIFT_HINT } from '../hooks/useShiftGate';
import {
  Wallet, Landmark, Plus, Check, X, RefreshCw, ShieldAlert, AlertTriangle, Inbox, Receipt,
  TrendingUp, TrendingDown, Coins, ArrowRight, Calendar, Clock, List, Printer,
  Search, Download, ChevronLeft, ChevronRight,
} from 'lucide-react';

// NUMERIC columns arrive as strings and a shift's close fields are still null
// while it is open, so every figure passes through one coercion rather than
// each call site spelling its own.
const money = (value: number | string | null | undefined): number => {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// How long the drawer has been open, said the way an operator would say it.
// Read from the instant rather than by subtracting date keys: a shift opened
// at 23:50 and still open at 00:10 is twenty minutes old, not a day old.
const elapsedLabel = (openedAt: string): string => {
  const started = new Date(openedAt).getTime();
  if (!Number.isFinite(started)) return '—';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

// Only the fields this screen renders. The endpoint still serves the whole
// statement, but its Sources and Uses — and the period that shaped them — now
// belong to Reports (D18, R3), so a wider type here would do nothing except
// invite the moved sections back.
interface Statement {
  totals: { current: number };
  drawer?: number;
  expenseApprovalThreshold?: number;
}

interface Shift {
  id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  status: 'open' | 'closed';
  shift_date: string;
  opening_float: number | string;
  counted_closing: number | string | null;
  expected_closing: number | string | null;
  variance: number | string | null;
  opened_at: string;
  closed_at: string | null;
  opened_by_username: string | null;
  closed_by_username: string | null;
  notes: string | null;
  live: {
    movementCount: number;
    cashIn: number;
    cashOut: number;
    netMovement: number;
    expected: number;
    drawerBalance: number;
    drawerDifference: number;
  } | null;
}

interface ShiftResult extends Shift {
  varianceLabel?: 'BALANCED' | 'OVER' | 'SHORT';
  drawerBalance?: number;
  drawerDifference?: number;
}

// One cash-account ledger row inside a shift's window — the rows that produced
// the expected figure the close dialog counts against. Served by
// `GET /cash-management/shifts/:id/movements`.
interface DrawerMovement {
  id: string;
  entry_date: string;
  entry_type: string;
  amount: number | string;
  balance_after: number | string;
  source_type: string | null;
  reference_number: string | null;
  description: string | null;
  account_name: string;
  transaction_number: number | null;
  payee: string | null;
  txn_code: string | null;
}

interface DrawerActivity {
  netMovement: number;
  expected: number;
  rows: DrawerMovement[];
}

interface PendingExpense {
  id: string;
  transaction_number: number;
  amount: string;
  status: string;
  transaction_date: string;
  description: string | null;
  notes: string | null;
  reference_number: string | null;
  payee: string | null;
  created_at: string;
  rejection_reason: string | null;
  category_name: string | null;
  account_name: string;
  current_balance: string;
  branch_code: string;
  branch_name: string;
  requested_by_username: string | null;
}

interface Category {
  id: string;
  name: string;
}

interface TypeRow {
  id: string;
  code: string;
}

const emptyForm = {
  accountId: '',
  transactionCategoryId: '',
  amount: '',
  payee: '',
  description: '',
  referenceNumber: '',
  transactionDate: manilaDateValue(),
  paymentMethod: 'cash',
};

// The count sheet is the one thing here that leaves the screen: it is counted
// against with a pen before the close and filed after it. It is rendered
// outside the page root because `window.print()` prints the document rather
// than a subtree — the page takes `print:hidden` for the frame a sheet is up,
// leaving this block as all that is on the paper.
function ShiftCountSheet(props: {
  branchName: string;
  shiftDate: string;
  openedAt: string;
  openingFloat: number;
  cashIn?: number;
  cashOut?: number;
  expected: number;
  counted: number | null;
  variance: number | null;
  status?: string | null;
  drawerOnBooks?: number;
  printedAt: string;
}) {
  const { branchName, shiftDate, openedAt, openingFloat, cashIn, cashOut, expected, counted, variance, status, drawerOnBooks, printedAt } = props;

  // Underscores rather than a dash: this half is written on by hand before the
  // figures exist, and a printed "—" reads as a figure of zero.
  const blank = '________________';
  const row = (label: string, value: string, emphasis = false) => (
    <div className={`flex justify-between gap-8 px-3 py-1.5 ${emphasis ? 'bg-gray-100 font-semibold' : ''}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );

  return (
    <div className="hidden print:block bg-white p-10 text-sm text-black">
      <div className="border-b-2 border-black pb-3">
        <h1 className="text-lg font-bold uppercase tracking-wide">Shift count sheet</h1>
        <p className="mt-1">{branchName} · {dateKeyLabel(shiftDate)}</p>
        <p className="text-xs text-gray-700">
          Opened {manilaTimeLabel(openedAt)} · open {elapsedLabel(openedAt)} · printed {printedAt}
        </p>
      </div>

      <div className="mt-4 divide-y divide-gray-300 border border-gray-300">
        {row('Counted opening float', formatCurrency(openingFloat))}
        {cashIn !== undefined && row('Cash in since opening', `+${formatCurrency(cashIn)}`)}
        {cashOut !== undefined && row('Cash out since opening', `−${formatCurrency(cashOut)}`)}
        {row('Expected closing', formatCurrency(expected), true)}
        {row('Counted closing cash', counted === null ? blank : formatCurrency(counted), true)}
        {row('Variance', variance === null ? blank : formatCurrency(variance), true)}
        {status && row('Result', status, true)}
        {drawerOnBooks !== undefined && row('Drawer on the books', formatCurrency(drawerOnBooks))}
      </div>

      <div className="mt-12 grid grid-cols-2 gap-12 text-xs">
        <div className="border-t border-black pt-1">Counted by</div>
        <div className="border-t border-black pt-1">Date / time</div>
      </div>
    </div>
  );
}

export default function CashManagement() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const isApprover = isAdmin || user?.roles?.includes('manager');
  const canWrite = true;

  const [branchId, setBranchId] = useState('');

  const [statement, setStatement] = useState<Statement | null>(null);

  const [shiftActivity, setShiftActivity] = useState<ShiftActivity | null>(null);

  const [loadingActivity, setLoadingActivity] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The rows behind one shift's drawer, fetched only when asked. The page can
  // already say the two readings differ; this is what shows which movements
  // produced the difference, and which shift they belong to while it loads.
  const [drawerShiftId, setDrawerShiftId] = useState<string | null>(null);
  const [drawerActivity, setDrawerActivity] = useState<DrawerActivity | null>(null);
  const [loadingDrawer, setLoadingDrawer] = useState(false);

  const [expenses, setExpenses] = useState<PendingExpense[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState(false);

  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenseTypeId, setExpenseTypeId] = useState('');

  const [shifts, setShifts] = useState<Shift[]>([]);

  // The drawer's register — every cash-account ledger row, newest first. Kept
  // in its own state so a filter or a page change re-reads only this section
  // and never the position above it.
  const [records, setRecords] = useState<CashRecord[]>([]);
  const [recordClasses, setRecordClasses] = useState<CashRecordClass[]>([]);
  const [recordPage, setRecordPage] = useState<CashRecordPage['pagination'] | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordError, setRecordError] = useState('');
  const [recordType, setRecordType] = useState('');
  const [recordSearchInput, setRecordSearchInput] = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [recordPageNum, setRecordPageNum] = useState(1);
  const [exportingRecords, setExportingRecords] = useState(false);

  // Elapsed time only means something if it moves. Without this the card would
  // print "0m" for as long as the page sat untouched, which is worse than
  // printing no elapsed time at all.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!shifts.some((s) => s.status === 'open')) return;
    const timer = setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [shifts]);
  const [drawers, setDrawers] = useState<{ branchId: string; balance: number }[]>([]);
  // Starts true so the first paint reads as "reading the shift" rather than
  // "no shift open" — a figure that flashes a wrong answer before the right one
  // arrives is worse than one that arrives late.
  const [loadingShifts, setLoadingShifts] = useState(true);
  const [shiftError, setShiftError] = useState('');
  const [shiftOpen, setShiftOpen] = useState<{ branchId: string; openingFloat: string; booksBalance: number; shiftDate: string } | null>(null);
  const [shiftClose, setShiftClose] = useState<{ shift: Shift; countedClosing: string; notes: string } | null>(null);
  const [lastClose, setLastClose] = useState<ShiftResult | null>(null);

  // Which sheet, if any, is on the paper. `window.print()` prints the whole
  // document, so the sheet has to be in it for one frame and then gone again —
  // left standing it would ride along on the next print, wanted or not.
  const [printSheet, setPrintSheet] = useState<'count' | 'result' | null>(null);
  useEffect(() => {
    if (!printSheet) return;
    const frame = requestAnimationFrame(() => {
      window.print();
      setPrintSheet(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [printSheet]);

  const [savingShift, setSavingShift] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadStatement = useCallback(async () => {
    setLoading(true);
    try {
      // No period here: this screen is a live position and a window belongs to
      // Reports, not to a drawer count (D18). Only the branch narrows it.
      const params = new URLSearchParams();
      if (branchId) params.set('branchId', branchId);
      const qs = params.toString();
      const result = await api.get<Statement>(`/cash-management/statement${qs ? `?${qs}` : ''}`);
      setStatement(result);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the cash statement');
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  // Income and expense for the business day the open shift belongs to. The
  // period is the shift's own, never a filter this screen is allowed to offer
  // (D18) — fetchShiftActivity owns that rule and the advisory failure; this
  // callback owns only the panel's loading flag.
  const loadShiftActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      setShiftActivity(await fetchShiftActivity(branchId));
    } finally {
      setLoadingActivity(false);
    }
  }, [branchId]);

  // The register reads from the same branch the position is scoped to, and
  // resets to page 1 whenever the filter changes: page 3 of a smaller set is a
  // page that does not exist, and an empty screen reads as "no records".
  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const page = await fetchCashRecords({
        branchId: branchId || undefined,
        type: recordType || undefined,
        search: recordSearch || undefined,
        page: recordPageNum,
        limit: 50,
      });
      setRecords(page.records || []);
      setRecordClasses(page.classes || []);
      setRecordPage(page.pagination || null);
      setRecordError('');
    } catch (err) {
      setRecords([]);
      setRecordClasses([]);
      setRecordPage(null);
      setRecordError(err instanceof Error ? err.message : 'Could not load the cash records');
    } finally {
      setLoadingRecords(false);
    }
  }, [branchId, recordType, recordSearch, recordPageNum]);

  const loadExpenses = useCallback(async () => {
    if (!isApprover) return;
    setLoadingExpenses(true);
    try {
      const value = await api.get<{ data: PendingExpense[] } | PendingExpense[]>('/cash-management/expenses/pending?status=pending');
      setExpenses(unwrapRows<PendingExpense>(value));
    } catch {
      setExpenses([]);
    } finally {
      setLoadingExpenses(false);
    }
  }, [isApprover]);

  const loadShifts = useCallback(async () => {
    setLoadingShifts(true);
    try {
      const value = await api.get<{ shifts: Shift[]; drawers: { branchId: string; balance: number }[] }>(
        '/cash-management/shifts'
      );
      setShifts(value.shifts || []);
      setDrawers(value.drawers || []);
      setShiftError('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load shift status';
      // A backend that predates this feature answers the endpoint with an HTML
      // error page, and the client falls over while parsing it. The parser's
      // complaint reads like a broken screen when the server simply being older
      // is what happened — so report that, without asserting it is the only
      // possible cause.
      setShiftError(
        /<!DOCTYPE|not valid JSON/i.test(message)
          ? 'The server did not return shift data — it may still be running an older build.'
          : message,
      );
      setShifts([]);
      setDrawers([]);
    } finally {
      setLoadingShifts(false);
    }
  }, []);

  const loadSetup = useCallback(async () => {
    try {
      const [branchVal, accountVal, typeVal, categoryVal] = await Promise.allSettled([
        api.get<{ id: string; code: string; name: string }[]>('/branches'),
        api.get<AccountOption[]>('/accounts'),
        api.get<TypeRow[]>('/transaction-types/types'),
        api.get<Category[]>('/transaction-types/categories'),
      ]);
      if (branchVal.status === 'fulfilled') setBranches(unwrapRows(branchVal.value));
      if (accountVal.status === 'fulfilled') setAccounts(unwrapRows(accountVal.value));
      if (typeVal.status === 'fulfilled') {
        const opex = unwrapRows<TypeRow>(typeVal.value).find((t) => t.code === 'operating_expense');
        setExpenseTypeId(opex?.id || '');
      }
      if (categoryVal.status === 'fulfilled') setCategories(unwrapRows(categoryVal.value));
    } catch {
      // Setup is advisory: the form reports a missing type when submitted.
    }
  }, []);

  useEffect(() => { loadSetup(); }, [loadSetup]);
  useEffect(() => { loadStatement(); }, [loadStatement]);
  useEffect(() => { loadShiftActivity(); }, [loadShiftActivity]);
  useEffect(() => { loadExpenses(); }, [loadExpenses]);
  useEffect(() => { loadShifts(); }, [loadShifts]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  // A branch, class or search change narrows the register, so the page number
  // it was on is no longer the page it is on. Reset before the read rather than
  // after: reading page 3 of the new filter and then snapping to page 1 would
  // flash a wrong set first. The loader runs again off the state change.
  useEffect(() => {
    setRecordPageNum(1);
  }, [branchId, recordType, recordSearch]);

  // Debounced so a three-word search is one read, not three. The list is a
  // register of a whole branch's cash history, not a type-ahead, so waiting for
  // a pause costs nothing a live list needs.
  useEffect(() => {
    const handle = setTimeout(() => setRecordSearch(recordSearchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [recordSearchInput]);

  // A shift records a count. Neither of these writes a balance or a ledger row:
  // opening stores the float that was physically counted, and closing stores
  // that count beside arithmetic over movements that already exist. A
  // discrepancy is therefore an event to investigate, never a balance adjusted
  // away from this form (design D14).
  const submitShiftOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftOpen) return;
    const openingFloat = parseFloat(shiftOpen.openingFloat);
    if (!Number.isFinite(openingFloat) || openingFloat < 0) {
      setShiftError('Enter the cash you actually counted in the drawer');
      return;
    }
    // Manila's today rather than the browser's — this host and the browser on
    // it run UTC+3, so a local-clock check would refuse a shift the operator has
    // every right to open at 01:00 Manila. The server checks the same way.
    const today = manilaDateValue();
    if (!shiftOpen.shiftDate) {
      setShiftError('Choose the date this shift covers');
      return;
    }
    if (shiftOpen.shiftDate > today) {
      setShiftError(`A shift cannot be dated ahead of today — today is ${today}`);
      return;
    }
    setSavingShift(true);
    setShiftError('');
    try {
      await api.post('/cash-management/shifts/open', {
        branchId: shiftOpen.branchId,
        openingFloat,
        shiftDate: shiftOpen.shiftDate,
      });
      setShiftOpen(null);
      // The daily figures are keyed on the open shift's own day, so opening one
      // changes which day they describe. Without this the cards keep reading
      // "No shift open" until a reload, and closing one would leave the closed
      // day's figures sitting under a heading that says the shift is open.
      await Promise.all([loadShifts(), loadShiftActivity()]);
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Could not open the shift');
    } finally {
      setSavingShift(false);
    }
  };

  const submitShiftClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftClose) return;
    const countedClosing = parseFloat(shiftClose.countedClosing);
    if (!Number.isFinite(countedClosing) || countedClosing < 0) {
      setShiftError('Enter the cash you actually counted in the drawer');
      return;
    }
    setSavingShift(true);
    setShiftError('');
    try {
      const closed = await api.post<ShiftResult>(`/cash-management/shifts/${shiftClose.shift.id}/close`, {
        countedClosing,
        notes: shiftClose.notes || undefined,
      });
      setShiftClose(null);
      setLastClose(closed);
      await Promise.all([loadShifts(), loadShiftActivity()]);
    } catch (err) {
      setShiftError(err instanceof Error ? err.message : 'Could not close the shift');
    } finally {
      setSavingShift(false);
    }
  };

  // Fetched one shift at a time rather than with the page: a drawer can hold
  // hundreds of rows in a day, and only an operator asking to read them should
  // pay for them. Re-clicking the same shift keeps the rows it already loaded.
  const loadDrawerActivity = async (shiftId: string) => {
    if (drawerShiftId === shiftId && (drawerActivity || loadingDrawer)) return;
    setDrawerShiftId(shiftId);
    setDrawerActivity(null);
    setLoadingDrawer(true);
    try {
      setDrawerActivity(await api.get<DrawerActivity>(`/cash-management/shifts/${shiftId}/movements`));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not load the drawer movements');
      setDrawerShiftId(null);
    } finally {
      setLoadingDrawer(false);
    }
  };

  const hideDrawerActivity = () => {
    setDrawerShiftId(null);
    setDrawerActivity(null);
  };

  // The export narrows exactly as the screen is — branch, class and search —
  // but carries the whole filtered register rather than the visible page.
  const exportRecords = async () => {
    setExportingRecords(true);
    setRecordError('');
    try {
      await downloadCashRecordsCsv({
        branchId: branchId || undefined,
        type: recordType || undefined,
        search: recordSearch || undefined,
      });
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingRecords(false);
    }
  };

  const openForm = () => {
    setForm({ ...emptyForm, transactionDate: manilaDateValue() });
    setFormError('');
    // The revolving fund is where cash-on-hand expenses belong, so it is
    // preselected rather than made the operator hunt for it among the wallets.
    // Prefer this user's own branch's float: the list holds every branch's
    // wallet, and preselecting someone else's cash would be an easy mistake to
    // approve.
    const ownBranches = (user?.branches || []).map((b) => b.name);
    const float =
      accounts.find((a) => a.name === 'Revolving Fund' && !!a.branch_name && ownBranches.includes(a.branch_name))
      || accounts.find((a) => a.name === 'Revolving Fund');
    if (float) setForm((f) => ({ ...f, accountId: float.id }));
    setShowForm(true);
  };

  const submitExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!expenseTypeId) {
      setFormError('The operating expense type is not available on this server.');
      return;
    }
    if (!form.accountId) { setFormError('Choose the wallet the money is paid from.'); return; }
    if (!form.amount || Number(form.amount) <= 0) { setFormError('Enter an amount greater than zero.'); return; }
    if (!form.description.trim()) { setFormError('Describe what the money was spent on.'); return; }

    setSaving(true);
    try {
      await api.post('/transactions', {
        accountId: form.accountId,
        transactionTypeId: expenseTypeId,
        transactionCategoryId: form.transactionCategoryId || null,
        amount: Number(form.amount),
        description: form.description.trim(),
        payee: form.payee.trim() || null,
        referenceNumber: form.referenceNumber.trim() || null,
        transactionDate: form.transactionDate,
        paymentMethod: form.paymentMethod || null,
      });
      setShowForm(false);
      await Promise.all([loadStatement(), loadExpenses(), loadShifts(), loadShiftActivity(), loadRecords()]);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not record the expense');
    } finally {
      setSaving(false);
    }
  };

  const decide = async (expense: PendingExpense, action: 'approve' | 'reject') => {
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    if (action === 'approve') {
      const ok = window.confirm(
        `Approve ${formatCurrency(Number(expense.amount))} — this will be deducted from ${expense.account_name} now?`
      );
      if (!ok) return;
    } else {
      const reason = window.prompt('Reason for rejecting this expense:');
      if (reason === null) return;
      if (!reason.trim()) { alert('A reason is required.'); return; }
      try {
        await api.post(`/transactions/${expense.id}/reject`, { reason: reason.trim() });
        await Promise.all([loadStatement(), loadExpenses(), loadShifts(), loadShiftActivity()]);
        window.dispatchEvent(new Event('approvals-changed'));
        return;
      } catch (err) {
        alert(err instanceof Error ? err.message : `${verb} failed`);
        return;
      }
    }

    setBusy(true);
    try {
      await api.post(`/transactions/${expense.id}/approve`);
      await Promise.all([loadStatement(), loadExpenses(), loadShifts(), loadShiftActivity()]);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      alert(err instanceof Error ? err.message : `${verb} failed`);
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-10 text-center max-w-lg mx-auto">
          <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Sign in required</h2>
          <p className="text-sm text-gray-500">Your session ended. Sign in again to view the cash position.</p>
        </div>
      </div>
    );
  }

  const t = statement?.totals;

  // What the form will say the books will do, taken from the same number the
  // create route uses. Undefined before the statement lands or on a backend
  // older than migration 039 — both fall back to "needs approval", which is
  // what those backends would do anyway.
  const threshold = statement?.expenseApprovalThreshold;
  const enteredAmount = Number(form.amount);
  const settlesNow =
    threshold !== undefined &&
    Number.isFinite(enteredAmount) &&
    enteredAmount > 0 &&
    enteredAmount <= threshold;

  // The drawer's expectation, not a balance: opening count plus the movements
  // the shift has already taken. Summed across the open shifts the caller can
  // see and narrowed by the page's branch, so it is scoped exactly as the two
  // daily figures beside it — three cards that disagreed about which branch
  // they describe would be worse than two cards that said less.
  let openShiftCount = 0;
  let expectedNow = 0;
  for (const shift of shifts) {
    if (shift.status !== 'open' || !shift.live) continue;
    if (branchId && shift.branch_id !== branchId) continue;
    openShiftCount += 1;
    expectedNow += money(shift.live.expected);
  }
  const expectedNowFigure = loadingShifts ? '…' : openShiftCount > 0 ? formatCurrency(expectedNow) : '—';
  const expectedNowSub = loadingShifts
    ? 'Reading the open shift…'
    : openShiftCount > 0
      ? 'What the drawer should hold'
      : 'No shift open';

  // Both daily cards answer for the shift's own day, so both name it — or say
  // there is none. Printing a zero with no window behind it would read as
  // "nothing was earned today", which is a claim about a day nobody opened.
  const dailyFigures =
    !loadingActivity && shiftActivity && shiftActivity.branches.length > 0
      ? {
          income: formatCurrency(shiftActivity.totals.income.total),
          expense: formatCurrency(shiftActivity.totals.expense.total),
          sub: shiftActivity.shiftDates.length === 1
            ? `Shift day · ${dateKeyLabel(shiftActivity.shiftDates[0])}`
            : `${shiftActivity.shiftDates.length} shift days`,
        }
      : {
          income: '—',
          expense: '—',
          sub: loadingActivity ? 'Loading the open shift…' : 'No shift open',
        };

  // The total on the books is every account balance, so the drawer is inside
  // it; the non-cash figure is that total less the drawer. Derived rather than
  // read from the statement so the three cards can never disagree about scope,
  // and left undefined when the drawer is absent (an older backend that does
  // not serve it) rather than passed off as zero.
  const nonCashOnBooks = t && statement?.drawer !== undefined
    ? money(t.current) - money(statement.drawer)
    : undefined;

  return (
    <>
    <div className={`p-6 space-y-6${printSheet ? ' print:hidden' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary-600" />
            Cash Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Where the company's cash physically is, and how it moved.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <button type="button" onClick={loadStatement} className="btn-secondary" disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {/* Refused while no shift is open in the branch the page is scoped
                to, which is the same test `assertOpenShift` runs server-side —
                the button never becomes a way through, only an earlier answer.
                Disabled rather than hidden so the operator can still see that
                the action exists and read why it is shut. */}
            {canWrite && (
              <button
                type="button"
                onClick={openForm}
                className="btn-primary"
                disabled={openShiftCount === 0}
                title={openShiftCount === 0 ? 'No shift is open in this scope' : undefined}
              >
                <Plus className="w-4 h-4" />
                Record expense
              </button>
            )}
          </div>
          {canWrite && openShiftCount === 0 && (
            <p className="text-xs text-amber-700 text-right">
              {loadingShifts
                ? 'Checking whether a shift is open…'
                : NO_OPEN_SHIFT_HINT}
            </p>
          )}
        </div>
      </div>

      {branches.length > 1 && (
        <div className="card">
          {/* Only when there is more than one branch to choose between. With a
              single assigned branch, "All branches I can see" and that branch
              issue the same query, so the control would be two ways of saying
              one thing. Counted rather than keyed on role: an operator may hold
              several branches and a head-office user one, and hiding it by role
              would strand the former with no way to choose. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="form-label">Branch</label>
              <select className="form-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">All branches I can see</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-4">{loadError}</div>
      )}

      {loading ? (
        <div className="card text-center py-10 text-sm text-gray-500">Loading cash position…</div>
      ) : statement && t ? (
        <>
          {/* Money in and money out were never this page's figures: they were
              the statement's Sources and Uses, principal moving rather than
              earnings. The statement itself now lives in Reports with the
              period it is shaped by (D18, R3), so what stays here is the live
              position — what is on the books, what the drawers hold, and what
              the open shift's own day earned and spent. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <div className="card">
              <div className="flex items-center gap-2 text-gray-500">
                <Wallet className="w-4 h-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Total on the books</p>
              </div>
              <p className="text-2xl font-bold mt-2 tabular-nums">{formatCurrency(t.current)}</p>
              <p className="text-sm text-gray-500">Every account totalled — the cash drawer is included</p>
            </div>

            {nonCashOnBooks !== undefined && (
              <div className="card">
                <div className="flex items-center gap-2 text-gray-500">
                  <Landmark className="w-4 h-4" />
                  <p className="text-xs font-semibold uppercase tracking-wide">Accounts (non-cash)</p>
                </div>
                <p className="text-2xl font-bold mt-2 tabular-nums">{formatCurrency(nonCashOnBooks)}</p>
                <p className="text-sm text-gray-500">Banks and e-wallets — total less the drawer</p>
              </div>
            )}

            {statement.drawer !== undefined && (
              <div className="card border border-amber-300">
                <div className="flex items-center gap-2 text-amber-700">
                  <Coins className="w-4 h-4" />
                  <p className="text-xs font-semibold uppercase tracking-wide">Cash on hand</p>
                </div>
                <p className="text-2xl font-bold mt-2 tabular-nums text-amber-700">{formatCurrency(statement.drawer)}</p>
                <p className="text-sm text-gray-500">In the branch drawers — already counted in the total</p>
              </div>
            )}

            <div className="card">
              <div className="flex items-center gap-2 text-gray-500">
                <Clock className="w-4 h-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Expected Now</p>
              </div>
              <p className="text-2xl font-bold mt-2 tabular-nums">{expectedNowFigure}</p>
              <p className="text-sm text-gray-500">{expectedNowSub}</p>
            </div>

            <div className="card">
              <div className="flex items-center gap-2 text-emerald-600">
                <TrendingUp className="w-4 h-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Daily Income</p>
              </div>
              <p className="text-2xl font-bold mt-2 tabular-nums text-emerald-600">{dailyFigures.income}</p>
              <p className="text-sm text-gray-500">{dailyFigures.sub}</p>
            </div>

            <div className="card">
              <div className="flex items-center gap-2 text-red-600">
                <TrendingDown className="w-4 h-4" />
                <p className="text-xs font-semibold uppercase tracking-wide">Daily Expense</p>
              </div>
              <p className="text-2xl font-bold mt-2 tabular-nums text-red-600">{dailyFigures.expense}</p>
              <p className="text-sm text-gray-500">{dailyFigures.sub}</p>
            </div>
          </div>

          {/* Earnings, scoped by the shift instead of by a filter this screen
              is not allowed to have (D18): the window is the business day the
              open shift already belongs to, so it can never name a period the
              books did not record. The components are the Income and Expense
              report's own — served by the same loaders — which is why the same
              day reads the same figure in both places. */}
          <div className="card">
            <div className="px-1 pb-1 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div>
                <h4 className="font-medium">Income &amp; expense — the open shift</h4>
                <p className="text-xs text-gray-500">
                  Scoped to the business day the shift belongs to. Transaction fees and load margin on the
                  income side; transfer fees, provider charges and recorded operating expenses on the expense side.
                </p>
              </div>
              {!loadingActivity && shiftActivity && shiftActivity.shiftDates.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600">
                  <Calendar className="w-3.5 h-3.5" />
                  {shiftActivity.shiftDates.length === 1
                    ? dateKeyLabel(shiftActivity.shiftDates[0])
                    : `${shiftActivity.shiftDates.length} business days`}
                </span>
              )}
            </div>

            {loadingActivity ? (
              <p className="mt-4 text-sm text-gray-500">Loading the shift's income and expense…</p>
            ) : shiftActivity && shiftActivity.branches.length > 0 ? (
              <>
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                    <div className="flex items-center gap-2 text-emerald-700">
                      <TrendingUp className="w-4 h-4" />
                      <p className="text-xs font-semibold uppercase tracking-wide">Income</p>
                    </div>
                    <p className="text-2xl font-bold mt-2 tabular-nums text-emerald-700">
                      {formatCurrency(shiftActivity.totals.income.total)}
                    </p>
                    <dl className="mt-3 space-y-1 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-emerald-900/70">Transaction fees</dt>
                        <dd className="font-medium tabular-nums">
                          {formatCurrency(shiftActivity.totals.income.txnFees)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-emerald-900/70">Load margin</dt>
                        <dd className="font-medium tabular-nums">
                          {formatCurrency(shiftActivity.totals.income.loadMargin)}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                    <div className="flex items-center gap-2 text-red-700">
                      <TrendingDown className="w-4 h-4" />
                      <p className="text-xs font-semibold uppercase tracking-wide">Expense</p>
                    </div>
                    <p className="text-2xl font-bold mt-2 tabular-nums text-red-700">
                      {formatCurrency(shiftActivity.totals.expense.total)}
                    </p>
                    <dl className="mt-3 space-y-1 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-red-900/70">Transfer service fees</dt>
                        <dd className="font-medium tabular-nums">
                          {formatCurrency(shiftActivity.totals.expense.serviceFees)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-red-900/70">Provider charges</dt>
                        <dd className="font-medium tabular-nums">
                          {formatCurrency(shiftActivity.totals.expense.providerCharges)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-red-900/70">Operating expenses</dt>
                        <dd className="font-medium tabular-nums">
                          {formatCurrency(shiftActivity.totals.expense.operatingExpenses)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div className={`mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border px-4 py-2.5 text-sm ${
                  shiftActivity.totals.net >= 0
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  <span className="font-medium">Net for the shift</span>
                  <span className="font-semibold tabular-nums">{formatCurrency(shiftActivity.totals.net)}</span>
                </div>

                {/* Only when the branches disagree about which day they are
                    on: with one date the badge above already says it, and a
                    breakdown of a single row would be noise rather than the
                    reason this list exists. */}
                {shiftActivity.branches.length > 1 && (
                  <dl className="mt-3 divide-y divide-gray-100 text-sm">
                    {shiftActivity.branches.map((branch) => (
                      <div
                        key={branch.branchId}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
                      >
                        <dt className="text-gray-600">
                          {branch.branchName}
                          <span className="text-gray-400"> · {dateKeyLabel(branch.shiftDate)}</span>
                        </dt>
                        <dd className="flex gap-4 tabular-nums">
                          <span className="text-emerald-600">+{formatCurrency(branch.income.totalIncome)}</span>
                          <span className="text-red-600">−{formatCurrency(branch.expense.totalExpense)}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            ) : (
              <p className="mt-4 text-sm text-gray-500">
                No shift is open in this scope. Open a shift and this panel reports what that day earns
                and spends — the figures never appear from a period nobody recorded.
              </p>
            )}
          </div>

          {/* Movement keeps its own section further down — Sources and Uses —
              with the tie-out above proving the two still add up. What the
              cards and the panel above answer is the other question: the
              drawer's expectation and what the shift's own day earned and
              spent. That day is the one period this screen is entitled to name
              (D18); any other period is a Reports question, pointed at from
              here rather than rebuilt here. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>
              Daily income and expense cover the shift's day only — not a chosen period.
            </span>
            <Link
              to="/reports"
              className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium"
            >
              See earnings for any period
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="card">
            <div className="px-1 pb-1">
              <h4 className="font-medium">Shifts</h4>
              <p className="text-xs text-gray-500">
                A count, not a movement. Opening records the cash physically in the drawer; closing checks
                that count against the movements the drawer has already taken. Neither writes a balance, so
                a discrepancy stays something to investigate rather than something this screen can adjust away.
              </p>
            </div>

            {shiftError && (
              <p className="mt-3 text-sm text-red-600">{shiftError}</p>
            )}

            {lastClose && (
              <div className={`mt-3 rounded-lg border p-4 text-sm ${
                lastClose.varianceLabel === 'BALANCED'
                  ? 'border-emerald-300 bg-emerald-50'
                  : lastClose.varianceLabel === 'OVER'
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-red-300 bg-red-50'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    {branches.find((b) => b.id === lastClose.branch_id)?.name || 'Shift'} — closed
                  </p>
                  <div className="flex items-center gap-3">
                    <span className={`badge-${lastClose.varianceLabel === 'BALANCED' ? 'green' : lastClose.varianceLabel === 'OVER' ? 'yellow' : 'red'}`}>
                      {lastClose.varianceLabel}
                    </span>
                    <button type="button" className="text-xs underline text-gray-500" onClick={() => setPrintSheet('result')}>
                      <Printer className="mr-1 inline h-3 w-3" />
                      Print
                    </button>
                    <button type="button" className="text-xs underline text-gray-500" onClick={() => setLastClose(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <dt className="text-xs text-gray-500">Counted</dt>
                    <dd className="font-medium">{formatCurrency(money(lastClose.counted_closing))}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">Expected</dt>
                    <dd className="font-medium">{formatCurrency(money(lastClose.expected_closing))}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">Difference</dt>
                    <dd className="font-medium">{formatCurrency(money(lastClose.variance))}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">Drawer on the books</dt>
                    <dd className="font-medium">{formatCurrency(money(lastClose.drawerBalance))}</dd>
                  </div>
                </dl>
                <p className="text-xs text-gray-600 mt-2">
                  Expected comes from your opening count plus the drawer's movements; the books figure comes
                  from the account balance. They are derived from different things precisely so they can
                  disagree — a gap between them means the float or the movements are wrong.
                </p>
              </div>
            )}

            {loadingShifts ? (
              <p className="text-sm text-gray-500 mt-3">Loading shift status…</p>
            ) : branches.length === 0 ? (
              <p className="text-sm text-gray-500 mt-3">No branches in scope.</p>
            ) : (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                {branches.map((b) => {
                  const open = shifts.find((s) => s.branch_id === b.id && s.status === 'open');
                  const books = drawers.find((d) => d.branchId === b.id)?.balance ?? 0;
                  const live = open?.live || null;

                  return (
                    <div
                      key={b.id}
                      className={`rounded-lg border p-4 ${live ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-white'}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{b.name} ({b.code})</p>
                        <span className={live ? 'badge-green' : 'badge-gray'}>{live ? 'OPEN' : 'CLOSED'}</span>
                      </div>

                      {live && open ? (
                        <>
                          {/* A shift is one Manila day (D17) and a branch holds
                              only one open at a time (D15), so a shift left open
                              from yesterday does not merely look stale — it
                              refuses today's money. Said here rather than left
                              for the 409 to explain after the operator has typed
                              the whole form. */}
                          {open.shift_date < manilaDateValue() && (
                            <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span>
                                Dated {dateKeyLabel(open.shift_date)}. Every movement must carry the shift's own
                                date, so today's transactions will be refused until this is closed and today's
                                shift is opened.
                              </span>
                            </p>
                          )}
                          <dl className="mt-3 space-y-1 text-sm">
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Shift date</dt>
                              <dd className="font-medium" title="Transactions recorded under this shift must carry this date.">
                                {dateKeyLabel(open.shift_date)}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Open for</dt>
                              <dd className="font-medium">{elapsedLabel(open.opened_at)}</dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Opening count</dt>
                              <dd className="font-medium">{formatCurrency(money(open.opening_float))}</dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Cash in / out since</dt>
                              <dd className="font-medium">+{formatCurrency(live.cashIn)} / −{formatCurrency(live.cashOut)}</dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Expected now</dt>
                              <dd className="font-medium">{formatCurrency(live.expected)}</dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Drawer on the books</dt>
                              <dd className="font-medium">{formatCurrency(live.drawerBalance)}</dd>
                            </div>
                          </dl>
                          <p className={`text-xs mt-2 ${Math.abs(live.drawerDifference) < 0.005 ? 'text-emerald-700' : 'text-amber-700'}`}>
                            {Math.abs(live.drawerDifference) < 0.005
                              ? 'The two readings agree.'
                              : `The two readings differ by ${formatCurrency(live.drawerDifference)}.`}
                          </p>
                          <button
                            type="button"
                            className="btn-secondary mt-3 w-full flex items-center justify-center gap-2"
                            onClick={() => (drawerShiftId === open.id ? hideDrawerActivity() : void loadDrawerActivity(open.id))}
                          >
                            <List className="w-4 h-4" />
                            {drawerShiftId === open.id ? 'Hide movements' : 'View movements'}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary mt-3 w-full"
                            onClick={() => { setLastClose(null); setShiftOpen(null); setShiftClose({ shift: open, countedClosing: '', notes: '' }); }}
                          >
                            Close shift
                          </button>
                        </>
                      ) : (
                        <>
                          <dl className="mt-3 space-y-1 text-sm">
                            <div className="flex justify-between gap-3">
                              <dt className="text-gray-500">Drawer on the books</dt>
                              <dd className="font-medium">{formatCurrency(books)}</dd>
                            </div>
                          </dl>
                          <p className="text-xs text-gray-500 mt-2">
                            The float is never prefilled — count the drawer yourself. The books figure is
                            shown so you can see afterwards where the two disagree.
                          </p>
                          <button
                            type="button"
                            className="btn-primary mt-3 w-full"
                            onClick={() => { setLastClose(null); setShiftClose(null); setShiftOpen({ branchId: b.id, openingFloat: '', booksBalance: books, shiftDate: manilaDateValue() }); }}
                          >
                            Open shift
                          </button>
                        </>
                      )}

                      {/* The rows behind "expected now", fetched on demand —
                          a busy drawer can hold hundreds of them, and only an
                          operator who wants to read them should pay to fetch
                          them. Inside the card rather than as a dialog: it
                          explains a figure printed two lines above it. */}
                      {open && drawerShiftId === open.id && (
                        <div className="mt-3 rounded-lg border border-gray-200 bg-white">
                          <div className="flex items-start justify-between gap-2 px-3 pt-3">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Drawer movements</p>
                              <p className="text-xs text-gray-500">
                                {loadingDrawer
                                  ? 'Reading the rows behind the expected figure…'
                                  : `${drawerActivity?.rows.length ?? 0} cash row(s) in this shift's window`}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={hideDrawerActivity}
                              className="shrink-0 text-gray-400 hover:text-gray-600"
                              aria-label="Close movements"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>

                          {!loadingDrawer && drawerActivity && drawerActivity.rows.length > 0 && (
                            <dl className="mt-2 space-y-1 px-3 text-xs">
                              <div className="flex justify-between gap-3">
                                <dt className="text-gray-500">Net movement</dt>
                                <dd className="font-mono font-medium">{formatCurrency(drawerActivity.netMovement)}</dd>
                              </div>
                              <div className="flex justify-between gap-3">
                                <dt className="text-gray-500">Expected at close</dt>
                                <dd className="font-mono font-medium">{formatCurrency(drawerActivity.expected)}</dd>
                              </div>
                            </dl>
                          )}

                          {!loadingDrawer && (
                            <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-100 border-t border-gray-100">
                              {!drawerActivity || drawerActivity.rows.length === 0 ? (
                                <li className="px-3 py-4 text-center text-xs text-gray-500">
                                  No cash movements in this shift's window.
                                </li>
                              ) : drawerActivity.rows.map((row) => (
                                <li key={row.id} className="px-3 py-2 text-xs">
                                  <div className="flex justify-between gap-2">
                                    <span className="truncate text-gray-700">
                                      {row.description || (row.payee ? `Paid to ${row.payee}` : row.account_name)}
                                    </span>
                                    <span className={`shrink-0 font-mono font-medium ${row.entry_type === 'credit' ? 'text-emerald-600' : 'text-red-600'}`}>
                                      {row.entry_type === 'credit' ? '+' : '−'}{formatCurrency(money(row.amount))}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 flex justify-between gap-2 text-gray-500">
                                    <span className="truncate">
                                      {row.account_name} · {manilaTimeLabel(row.entry_date)}
                                    </span>
                                    <span className="shrink-0 font-mono">after {formatCurrency(money(row.balance_after))}</span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </>
      ) : null}

      {/* The register sits below the position, not above it: the figures answer
          "where is the cash", and this answers "what has been recorded against
          it". Both describe the same drawer, so the list is scoped to the same
          branch and carries no period of its own — a register of what exists is
          a point-in-time question, and the period-shaped cash analysis stays in
          Reports (D18).

          Outside the statement's branch on purpose: a statement that failed to
          load must not take the drawer's own history down with it. This is the
          section a reader opens to check a figure, so it renders whatever the
          position above it is doing. */}
      <div className="card overflow-hidden">
        <div className="px-4 pt-4 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="font-medium">Cash records</h4>
            <p className="text-xs text-gray-500">
              Every ledger entry that touched a branch's cash accounts, newest first — the
              complete history of the drawer. A register of what has been recorded, not a
              period, so it carries no From/To; use Reports for a date range. A row is filed
              under its business day, with the instant it was posted beside it.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={exportRecords}
            disabled={exportingRecords || loadingRecords}
          >
            <Download className="w-4 h-4" />
            {exportingRecords ? 'Exporting...' : 'Export CSV'}
          </button>
        </div>

        <div className="px-4 pb-3 flex flex-wrap items-end gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              className="form-input pl-9 w-72"
              placeholder="Search description, reference, txn # or payee"
              value={recordSearchInput}
              onChange={(e) => setRecordSearchInput(e.target.value)}
              aria-label="Search cash records"
            />
          </div>
          <div>
            <label className="form-label">Type</label>
            <select
              className="form-input w-56"
              value={recordType}
              onChange={(e) => setRecordType(e.target.value)}
            >
              <option value="">All types</option>
              {recordClasses.map((c) => (
                <option key={c.bucket} value={c.bucket}>
                  {c.label} ({c.count})
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-gray-500 ml-auto self-center">
            {recordPage ? `${recordPage.total} record(s)` : ''}
          </p>
        </div>

        {recordError && (
          <p className="px-4 pb-3 text-sm text-red-600">{recordError}</p>
        )}

        {loadingRecords ? (
          <p className="px-4 pb-6 text-sm text-gray-500">Loading cash records...</p>
        ) : records.length === 0 ? (
          <p className="px-4 pb-6 text-sm text-gray-500">
            {recordType || recordSearch
              ? 'No cash records match this filter.'
              : 'No cash records have been recorded for this scope yet.'}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px]">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Date</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Posted</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Txn #</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Account</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Description</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Method</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Amount</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Balance after</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Recorded by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {records.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-600" title={`Business day ${manilaDayLabel(row.businessDate)}`}>
                        {manilaDayLabel(row.businessDate)}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-500" title={`Posted into the drawer ${manilaDateTimeLabel(row.entryDate)}`}>
                        {manilaDateTimeLabel(row.entryDate)}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono text-xs whitespace-nowrap">
                        {row.transactionNumber !== null ? `TXN #${row.transactionNumber}` : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-700">{row.category}</td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-600">
                        {row.accountName}
                        {row.branchCode && <span className="text-gray-400"> · {row.branchCode}</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[22rem] truncate" title={row.description || row.payee || ''}>
                        {row.description || row.payee || <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-500">{row.paymentMethod || <span className="text-gray-400">—</span>}</td>
                      <td className={`px-4 py-3 text-sm text-right font-mono whitespace-nowrap ${row.direction === 'in' ? 'text-emerald-600' : 'text-red-600'}`}>
                        {row.direction === 'in' ? '+' : '−'}{formatCurrency(Number(row.amount))}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono whitespace-nowrap text-gray-700">
                        {formatCurrency(Number(row.balanceAfter))}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-500">{row.recordedBy || <span className="text-gray-400">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {recordPage && recordPage.totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-4 py-3">
                <p className="text-xs text-gray-500">
                  Page {recordPage.page} of {recordPage.totalPages}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setRecordPageNum((n) => Math.max(1, n - 1))}
                    disabled={recordPage.page <= 1 || loadingRecords}
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setRecordPageNum((n) => Math.min(recordPage.totalPages, n + 1))}
                    disabled={recordPage.page >= recordPage.totalPages || loadingRecords}
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {isApprover && (
        <div className="card overflow-hidden">
          <div className="px-4 pt-4 pb-1">
            <h4 className="font-medium">Awaiting approval</h4>
            <p className="text-xs text-gray-500">
              These are the expenses above the {threshold !== undefined ? formatCurrency(threshold) : 'approval'} approval threshold. Nobody
              approves their own request, and only an administrator may release or decline one.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Txn #</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Paid to</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loadingExpenses ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>
                ) : expenses.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center">
                      <Inbox className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">Nothing is waiting for a decision.</p>
                    </td>
                  </tr>
                ) : expenses.map((exp) => (
                  <Fragment key={exp.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-3.5 text-sm font-mono text-xs font-medium whitespace-nowrap">TXN #{exp.transaction_number}</td>
                      <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                        {manilaDayLabel(exp.transaction_date)}
                      </td>
                      <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                        {exp.account_name}
                        <span className="text-gray-400"> · {exp.branch_name}</span>
                      </td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{exp.category_name || '—'}</td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{exp.payee || '—'}</td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 max-w-[260px] truncate" title={exp.description || ''}>
                        {exp.description || '—'}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-red-600">
                        {formatCurrency(Number(exp.amount))}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">
                        {isAdmin ? (
                          <div className="inline-flex gap-2">
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={busy}
                              onClick={() => decide(exp, 'approve')}
                            >
                              <Check className="w-4 h-4" /> Approve
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              disabled={busy}
                              onClick={() => decide(exp, 'reject')}
                            >
                              <X className="w-4 h-4" /> Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Administrator decides</span>
                        )}
                      </td>
                    </tr>
                    <tr className="bg-gray-50 detail-row">
                      <td colSpan={8} className="px-4 py-2 text-xs text-gray-500">
                        Requested by <strong>{exp.requested_by_username || '—'}</strong> on{' '}
                        {manilaDateTimeLabel(exp.created_at)}
                        {exp.reference_number && <> · voucher <span className="font-mono">{exp.reference_number}</span></>}
                        {' '}· balance before decision {formatCurrency(Number(exp.current_balance))}
                        <span className="ml-2 inline-flex items-center gap-1 text-gray-400">
                          <AlertTriangle className="w-3 h-3" />
                          approving moves this from {exp.branch_name}'s wallet
                        </span>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4">
          <div className="mx-auto my-10 max-w-2xl bg-white rounded-xl shadow-2xl border border-gray-200">
            <div className="flex items-start gap-3 px-6 pt-6 pb-5 border-b border-gray-200">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
                <Receipt className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-gray-900">Record operating expense</h3>
                <p className="mt-0.5 text-sm text-gray-500">
                  Cash paid out of a wallet for a running cost of the business.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Close"
                className="-mr-1 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={submitExpense}>
              <div className="px-6 py-5 space-y-6">
                <div className={`flex gap-3 rounded-lg border px-4 py-3 ${
                  settlesNow
                    ? 'border-emerald-200 bg-emerald-50'
                    : 'border-blue-200 bg-blue-50'
                }`}>
                  <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${settlesNow ? 'text-emerald-600' : 'text-blue-600'}`} />
                  <p className={`text-xs leading-relaxed ${settlesNow ? 'text-emerald-800' : 'text-blue-800'}`}>
                    {settlesNow
                      ? <>This is deducted from the wallet <span className="font-semibold">now</span>. The amount is at
                        or under the {formatCurrency(threshold)} approval threshold, so nothing reviews it first —
                        check the figure before you save.</>
                      : <>This is saved as a <span className="font-semibold">request</span>, not a
                        withdrawal. Nothing leaves the wallet until a second person approves it, and
                        nobody approves their own request.</>}
                  </p>
                </div>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Amount
                  </h4>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center border-r border-gray-200 text-gray-500">
                      ₱
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      autoFocus
                      className="form-input pl-12 text-2xl font-semibold tabular-nums"
                      value={form.amount}
                      onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                      placeholder="0.00"
                    />
                  </div>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Payment source
                  </h4>
                  <AccountSelect
                    accounts={accounts}
                    value={form.accountId}
                    onChange={(v) => setForm((f) => ({ ...f, accountId: v }))}
                    placeholder="Select the wallet the cash comes out of"
                    className="form-input"
                  />
                  <p className="text-xs text-gray-500 mt-1.5">
                    The revolving fund holds the branch&apos;s physical cash on hand. Any visible
                    wallet may be used.
                  </p>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Expense details
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                      <label className="form-label" htmlFor="exp-description">
                        What was it for <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="exp-description"
                        type="text"
                        className="form-input"
                        value={form.description}
                        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder="Electrical bill — October"
                        required
                      />
                    </div>

                    <div>
                      <label className="form-label" htmlFor="exp-category">Category</label>
                      <select
                        id="exp-category"
                        className="form-input"
                        value={form.transactionCategoryId}
                        onChange={(e) => setForm((f) => ({ ...f, transactionCategoryId: e.target.value }))}
                      >
                        <option value="">Uncategorised</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="form-label" htmlFor="exp-payee">Paid to</label>
                      <input
                        id="exp-payee"
                        type="text"
                        className="form-input"
                        value={form.payee}
                        onChange={(e) => setForm((f) => ({ ...f, payee: e.target.value }))}
                        placeholder="Who received the money"
                      />
                    </div>
                  </div>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Settlement
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="form-label" htmlFor="exp-date">Date paid</label>
                      <input
                        id="exp-date"
                        type="date"
                        className="form-input"
                        value={form.transactionDate}
                        onChange={(e) => setForm((f) => ({ ...f, transactionDate: e.target.value }))}
                        required
                      />
                    </div>

                    <div>
                      <label className="form-label" htmlFor="exp-method">How it was paid</label>
                      <select
                        id="exp-method"
                        className="form-input"
                        value={form.paymentMethod}
                        onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                      >
                        {movementPaymentMethodOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-2">
                      <label className="form-label" htmlFor="exp-reference">Voucher / reference</label>
                      <input
                        id="exp-reference"
                        type="text"
                        className="form-input"
                        value={form.referenceNumber}
                        onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
                        placeholder="Optional"
                      />
                    </div>
                  </div>
                </section>

                {formError && (
                  <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    <p className="text-sm text-red-700">{formError}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 rounded-b-xl">
                <p className="text-xs text-gray-500 hidden sm:block">
                  {settlesNow
                    ? <>Deducted from the wallet <span className="font-medium text-gray-600">immediately</span> —
                      no second signature under {formatCurrency(threshold)}.</>
                    : <>Goes to <span className="font-medium text-gray-600">Awaiting approval</span> for a
                      second signature.</>}
                </p>
                <div className="flex gap-3 ml-auto">
                  <button type="button" className="btn-secondary" onClick={() => setShowForm(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : settlesNow ? 'Record expense' : 'Send for approval'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {shiftOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
          <div className="mx-auto mt-12 max-w-md bg-white rounded-xl shadow-xl border border-gray-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold">Open shift</h3>
              <button type="button" onClick={() => setShiftOpen(null)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={submitShiftOpen} className="p-5 space-y-4">
              <div className="bg-blue-50 border border-blue-200 text-blue-800 text-xs rounded-lg p-3">
                Count the drawer before you enter anything. This stores the number you counted — it does
                not write a balance or a ledger row, so nothing here can move money.
              </div>

              <div>
                <label className="form-label">Branch</label>
                <select
                  className="form-input"
                  value={shiftOpen.branchId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setShiftOpen((s) => s && {
                      ...s,
                      branchId: next,
                      booksBalance: drawers.find((d) => d.branchId === next)?.balance ?? 0,
                    });
                  }}
                >
                  {branches
                    .filter((b) => !shifts.some((s) => s.branch_id === b.id && s.status === 'open'))
                    .map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="form-label">Shift date</label>
                <input
                  type="date"
                  className="form-input"
                  required
                  max={manilaDateValue()}
                  value={shiftOpen.shiftDate}
                  onChange={(e) => setShiftOpen((s) => s && { ...s, shiftDate: e.target.value })}
                />
                <p className="text-xs text-gray-500 mt-1">
                  The day this drawer covers, in Manila time. Every transaction recorded under this
                  shift has to carry the same date — one dated otherwise is refused. Today is{' '}
                  {manilaDateValue()}; an earlier date is allowed so a missed day can still be
                  recorded, a later one is not.
                </p>
              </div>

              <div>
                <label className="form-label">Opening count</label>
                <input
                  className="form-input"
                  inputMode="decimal"
                  autoFocus
                  placeholder="0.00"
                  value={shiftOpen.openingFloat}
                  onChange={(e) => setShiftOpen((s) => s && { ...s, openingFloat: e.target.value })}
                />
                <p className="text-xs text-gray-500 mt-1">
                  The books say this drawer holds {formatCurrency(shiftOpen.booksBalance)}. That figure is
                  deliberately not filled in for you — if the two disagree at close, the difference is the finding.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" className="btn-secondary" onClick={() => setShiftOpen(null)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={savingShift}>
                  {savingShift ? 'Saving…' : 'Open shift'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {shiftClose && (() => {
        const live = shiftClose.shift.live;
        const counted = Number(shiftClose.countedClosing);
        const countedOk = shiftClose.countedClosing.trim() !== '' && Number.isFinite(counted);
        const previewCents = live && countedOk
          ? Math.round(Math.round(counted * 100) - Math.round(live.expected * 100))
          : null;

        return (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
            <div className="mx-auto mt-12 max-w-md bg-white rounded-xl shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                <h3 className="text-lg font-semibold">Close shift — {shiftClose.shift.branch_name}</h3>
                <button type="button" onClick={() => setShiftClose(null)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={submitShiftClose} className="p-5 space-y-4">
                <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
                  <div className="flex justify-between gap-3 px-3 py-2">
                    <span className="text-gray-500">Opening count</span>
                    <span className="font-medium">{formatCurrency(money(shiftClose.shift.opening_float))}</span>
                  </div>
                  <div className="flex justify-between gap-3 px-3 py-2">
                    <span className="text-gray-500">Cash in since</span>
                    <span className="font-medium text-emerald-600">+{formatCurrency(live?.cashIn || 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3 px-3 py-2">
                    <span className="text-gray-500">Cash out since</span>
                    <span className="font-medium text-red-600">−{formatCurrency(live?.cashOut || 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3 px-3 py-2 bg-gray-50">
                    <span className="text-gray-700 font-medium">Expected closing</span>
                    <span className="font-semibold">{formatCurrency(live?.expected || 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3 px-3 py-2">
                    <span className="text-gray-500">Drawer on the books</span>
                    <span className="font-medium">{formatCurrency(live?.drawerBalance || 0)}</span>
                  </div>
                </div>

                <div>
                  <label className="form-label">Counted closing cash</label>
                  <input
                    className="form-input"
                    inputMode="decimal"
                    autoFocus
                    placeholder="0.00"
                    value={shiftClose.countedClosing}
                    onChange={(e) => setShiftClose((s) => s && { ...s, countedClosing: e.target.value })}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
                  <span className="text-gray-500">Difference</span>
                  {previewCents === null ? (
                    <span className="text-gray-400">Enter a count</span>
                  ) : (
                    <span className={`font-semibold ${previewCents === 0 ? 'text-emerald-600' : previewCents > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                      {formatCurrency(previewCents / 100)}
                    </span>
                  )}
                </div>

                <div>
                  <label className="form-label">Notes (optional)</label>
                  <textarea
                    className="form-input"
                    rows={2}
                    value={shiftClose.notes}
                    onChange={(e) => setShiftClose((s) => s && { ...s, notes: e.target.value })}
                  />
                </div>

                <div className="flex justify-end gap-3 pt-1">
                  <button
                    type="button"
                    className="btn-secondary flex items-center gap-2"
                    onClick={() => setPrintSheet('count')}
                  >
                    <Printer className="w-4 h-4" />
                    Print sheet
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setShiftClose(null)}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={savingShift || !countedOk}>
                    {savingShift ? 'Saving…' : 'Close shift'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>

    {/* Outside the page root deliberately — window.print() prints the document,
        and the root above carries print:hidden for exactly as long as one of
        these is mounted. */}
    {printSheet === 'count' && shiftClose && (
      <ShiftCountSheet
        branchName={shiftClose.shift.branch_name}
        shiftDate={shiftClose.shift.shift_date}
        openedAt={shiftClose.shift.opened_at}
        openingFloat={money(shiftClose.shift.opening_float)}
        cashIn={shiftClose.shift.live?.cashIn}
        cashOut={shiftClose.shift.live?.cashOut}
        expected={shiftClose.shift.live?.expected ?? 0}
        counted={null}
        variance={null}
        drawerOnBooks={shiftClose.shift.live?.drawerBalance}
        printedAt={`${dateKeyLabel(manilaDateValue())} ${manilaTimeLabel(new Date())}`}
      />
    )}

    {printSheet === 'result' && lastClose && (
      <ShiftCountSheet
        branchName={branches.find((x) => x.id === lastClose.branch_id)?.name || 'Shift'}
        shiftDate={lastClose.shift_date}
        openedAt={lastClose.opened_at}
        openingFloat={money(lastClose.opening_float)}
        expected={money(lastClose.expected_closing)}
        counted={money(lastClose.counted_closing)}
        variance={money(lastClose.variance)}
        status={lastClose.varianceLabel}
        drawerOnBooks={lastClose.drawerBalance === undefined ? undefined : money(lastClose.drawerBalance)}
        printedAt={`${dateKeyLabel(manilaDateValue())} ${manilaTimeLabel(new Date())}`}
      />
    )}
    </>
  );
}
