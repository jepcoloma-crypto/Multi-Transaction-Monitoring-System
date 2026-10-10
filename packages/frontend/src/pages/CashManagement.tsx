import { useState, useEffect, useCallback, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { api, unwrapRows } from '../lib/api';
import { formatCurrency, manilaDateValue, manilaTimeLabel, dateKeyLabel, manilaDayLabel, manilaDateTimeLabel, movementPaymentMethodOptions, cashOnHandNote, paymentMethodCell, floatAgainstBooks } from '../lib/format';
import { fetchShiftActivity, type ShiftActivity } from '../lib/shiftActivity';
import { denomQty, tallyCents, tallyUsed, denomSubtotalPesos, tallyPesos } from '../lib/tally';
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
  Search, Download, ChevronLeft, ChevronRight, Eye, RotateCcw,
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
  drawerAccounts?: string;
  expenseApprovalThreshold?: number;
  borrowingsOutstanding?: number;
}

interface Shift {
  id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  status: 'open' | 'closed';
  shift_date: string;
  opening_float: number | string;
  // The second reading at open, taken the instant the float is recorded (043).
  // Unlike drawer_balance below this one exists for the whole life of the
  // shift, because the drawer on the books at open is knowable the moment the
  // shift opens — so it is what the opening gap is read from, kept rather than
  // recomputed later against a balance that has already moved on.
  opening_drawer_balance: number | string;
  opening_difference_reason: string | null;
  opening_difference_notes: string | null;
  opening_difference_resolved_at: string | null;
  counted_closing: number | string | null;
  expected_closing: number | string | null;
  variance: number | string | null;
  // The second reading at close, stored alongside the first (042). Both stay
  // null while the shift is open, for the same reason expected_closing does:
  // the balance at close does not exist until the close happens.
  drawer_balance: number | string | null;
  drawer_difference: number | string | null;
  opened_at: string;
  closed_at: string | null;
  opened_by_username: string | null;
  closed_by_username: string | null;
  notes: string | null;
  count_detail: Record<string, number> | null;
  variance_reason: string | null;
  variance_resolved_at: string | null;
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

// A discrepancy nobody has answered for yet. Served by
// `GET /cash-management/variances` — the list D14 implies when it calls a
// discrepancy an event needing investigation.
//
// It now carries two kinds, told apart by `type`, in one row shape: `count` is
// a closing count that missed the expected figure, `float` is an opening float
// that missed the drawer. The columns mean the same thing on both — `expected`
// is what the figure was measured against and `counted` is what was measured —
// so the card that renders them draws one layout rather than two.
interface VarianceRow {
  type: 'count' | 'float';
  id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  shift_date: string;
  variance: number | string;
  counted_closing: number | string;
  expected_closing: number | string;
  variance_reason: string | null;
  notes: string | null;
  // The moment the discrepancy was taken: the close for a count, the open for
  // a float, since a float is wrong the instant it is counted. Shown because an
  // investigation is dated, and two findings from one shift need telling apart
  // by more than their reason.
  at: string;
  by_username: string | null;
}

// One cash-account ledger row inside a shift's window — the rows that produced
// the expected figure the close dialog counts against. Served by
// `GET /cash-management/shifts/:id/movements`.
interface DrawerMovement {
  id: string;
  entry_date: string;
  created_at: string;
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

// Cash events the entry form has no path to. That form picks its type from the
// fee rule it runs, so anything without a fee is unreachable from there — and
// these five move physical cash while carrying none.
//
// Curated rather than every type on the server: a picker offering all nineteen
// would hand straight back the free choice that fee rules and D3 exist to
// avoid. Each one here is a real counter event with no fee and no other form.
const CASH_EVENT_TYPES = [
  {
    code: 'loan_received',
    label: 'Borrowed cash received',
    hint: 'Cash taken into the drawer from a lender. It is the company\u2019s cash to hold but not to keep \u2014 Sources and Uses files it under Borrowings so what is still owed reads off the statement.',
  },
  {
    code: 'loan_repayment',
    label: 'Loan repaid',
    hint: 'Principal handed back to the lender out of the drawer. Not a running cost, so it stays out of the expense totals.',
  },
  {
    code: 'other_income',
    label: 'Other income received',
    hint: 'Money taken in that no fee rule covers \u2014 a rebate, a sale, a charge collected at the counter.',
  },
  {
    code: 'refund',
    label: 'Refund paid out',
    hint: 'Money handed back to a customer at the counter. Record it so the drawer does not close short of an explanation.',
  },
  {
    code: 'refund_received',
    label: 'Refund received back',
    hint: 'Money returned to the company by a provider or partner.',
  },
] as const;

type CashEventCode = (typeof CASH_EVENT_TYPES)[number]['code'];

const emptyEventForm = {
  code: 'loan_received' as CashEventCode,
  accountId: '',
  amount: '',
  payee: '',
  description: '',
  referenceNumber: '',
  transactionDate: manilaDateValue(),
};

// The count sheet is the one thing here that leaves the screen: it is filed
// after the close as the record of what was counted. It is rendered outside
// the page root because `window.print()` prints the document rather than a
// subtree — the page takes `print:hidden` for the frame a sheet is up,
// leaving this block as all that is on the paper.
//
// It is printed from the review step and never from the counting step,
// because it carries the expected figure: shown before a count is taken it
// would put the answer in the counter's hand, which is the whole thing the
// blind count exists to prevent. The counting step prints TallySheet instead.
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

  // Underscores rather than a dash: a blank cell is written on by hand, and a
  // printed "—" reads as a figure of zero.
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

// The pen-and-paper half of the count: what goes in the drawer, counted note
// by note. It carries no expected figure and no drawer balance, which is
// exactly why it is the sheet the counting step may print — the sheet that
// could answer the question for the counter is the one that must not be in
// the room yet. Blank cells are for the pen; whatever is already keyed in
// prints with it.
function TallySheet(props: {
  branchName: string;
  shiftDate: string;
  denoms: { label: string; cents: number }[];
  counts: Record<string, string>;
  totalPesos: number;
  printedAt: string;
}) {
  const { branchName, shiftDate, denoms, counts, totalPesos, printedAt } = props;
  const blank = '________';

  const cell = (value: string) => (
    <td className="border border-black px-3 py-1.5 text-right font-mono">{value}</td>
  );

  return (
    <div className="hidden print:block bg-white p-10 text-sm text-black">
      <div className="border-b-2 border-black pb-3">
        <h1 className="text-lg font-bold uppercase tracking-wide">Drawer tally sheet</h1>
        <p className="mt-1">{branchName} · {dateKeyLabel(shiftDate)}</p>
        <p className="text-xs text-gray-700">printed {printedAt}</p>
      </div>

      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-black px-3 py-1.5 text-left">Denomination</th>
            <th className="border border-black px-3 py-1.5 text-right">Quantity</th>
            <th className="border border-black px-3 py-1.5 text-right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {denoms.map((d) => {
            const qty = parseInt(counts[d.label] ?? '', 10);
            const counted = Number.isFinite(qty) && qty > 0;
            return (
              <tr key={d.label}>
                <td className="border border-black px-3 py-1.5">₱{d.label}</td>
                {cell(counted ? String(qty) : blank)}
                {cell(counted ? formatCurrency(denomSubtotalPesos(d, qty)) : blank)}
              </tr>
            );
          })}
          <tr>
            <td className="border border-black px-3 py-1.5 font-semibold">Total</td>
            {cell('')}
            {cell(totalPesos > 0 ? formatCurrency(totalPesos) : blank)}
          </tr>
        </tbody>
      </table>

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
  // Held apart from the pagination because the totals describe every filtered
  // row while the pagination describes one page of them.
  const [recordTotals, setRecordTotals] = useState<CashRecordPage['totals'] | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordError, setRecordError] = useState('');
  const [recordType, setRecordType] = useState('');
  const [recordSearchInput, setRecordSearchInput] = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [recordPageNum, setRecordPageNum] = useState(1);
  const [exportingRecords, setExportingRecords] = useState(false);
  // The row whose detail panel is open, and whether a reversal is in flight —
  // the latter so a second click cannot file the same request twice while the
  // first is still waiting on the server.
  const [recordDetail, setRecordDetail] = useState<CashRecord | null>(null);
  const [reversingRecord, setReversingRecord] = useState(false);

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
  // The explanation is carried alongside the float because it is required at
  // the same moment: a float that differs from the drawer is accepted, but only
  // with an answer to why (043), and that answer is no easier to get later than
  // the count is. Held here rather than derived on submit so the reason a
  // person chose survives them correcting the figure that asked for it.
  const [shiftOpen, setShiftOpen] = useState<{
    branchId: string;
    openingFloat: string;
    booksBalance: number;
    shiftDate: string;
    openingReason: string;
    openingNotes: string;
  } | null>(null);
  // `step` is the count's integrity: until it flips to 'review' the dialog
  // holds nothing the counter could anchor on. Expected, difference and the
  // drawer's books balance are all in `shift`, but none of them are rendered
  // in 'count', and pressing "Check the count" moves it forward for good — the
  // figure you revealed is the figure you close on.
  const [shiftClose, setShiftClose] = useState<{
    shift: Shift;
    step: 'count' | 'review';
    countedClosing: string;
    denoms: Record<string, string>;
    varianceReason: string;
    notes: string;
  } | null>(null);
  const [lastClose, setLastClose] = useState<ShiftResult | null>(null);

  // Served by GET /cash-management/shifts rather than copied into this file: a
  // reason list the server would refuse is worse than no list at all, and one
  // kept in two places is one kept badly. Both arrive before the shift cards
  // render, so the dialog can never open without them.
  const [denominations, setDenominations] = useState<{ label: string; cents: number }[]>([]);
  const [varianceReasons, setVarianceReasons] = useState<Record<string, string>>({});

  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Which sheet, if any, is on the paper. `window.print()` prints the whole
  // document, so the sheet has to be in it for one frame and then gone again —
  // left standing it would ride along on the next print, wanted or not.
  const [printSheet, setPrintSheet] = useState<'tally' | 'count' | 'result' | null>(null);
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

  // The second form: a cash event with no fee rule behind it, so its type is
  // chosen here rather than implied by a rule. Type ids arrive from setup —
  // the server is the only place that knows them, and a type this build does
  // not have is reported rather than silently dropped.
  const [showEventForm, setShowEventForm] = useState(false);
  const [eventForm, setEventForm] = useState(emptyEventForm);
  const [eventError, setEventError] = useState('');
  const [typeIds, setTypeIds] = useState<Record<string, string>>({});

  // A cash account's balance is the drawer's physical cash, so the only method
  // it can carry is `cash` — and the server refuses anything else (D33).
  const formPaysFromDrawer = accounts.find((a) => a.id === form.accountId)?.type_code === 'cash';

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
      setRecordTotals(page.totals || null);
      setRecordError('');
    } catch (err) {
      setRecords([]);
      setRecordClasses([]);
      setRecordPage(null);
      setRecordTotals(null);
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
      const value = await api.get<{
        shifts: Shift[];
        drawers: { branchId: string; balance: number }[];
        denominations?: { label: string; cents: number }[];
        varianceReasons?: Record<string, string>;
      }>('/cash-management/shifts');
      setShifts(value.shifts || []);
      setDrawers(value.drawers || []);
      if (value.denominations?.length) setDenominations(value.denominations);
      if (value.varianceReasons) setVarianceReasons(value.varianceReasons);
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
    // Deliberately outside the try above: an older backend that has no
    // /variances must not take the shift panel down with it, and an empty list
    // is the honest answer to "could not read them". It refetches on the next
    // load, so a failure costs one blank panel rather than the shift view.
    try {
      const rows = await api.get<VarianceRow[]>('/cash-management/variances');
      setVariances(Array.isArray(rows) ? rows : []);
    } catch {
      setVariances([]);
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
        const rows = unwrapRows<TypeRow>(typeVal.value);
        const opex = rows.find((t) => t.code === 'operating_expense');
        setExpenseTypeId(opex?.id || '');
        const byCode: Record<string, string> = {};
        for (const t of rows) byCode[t.code] = t.id;
        setTypeIds(byCode);
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
    // A float that missed the drawer owes an answer, and this is the moment to
    // ask for it: the person who counted is here, the drawer is in front of
    // them, and the books figure is the one on screen. Asking at close would be
    // asking about a gap set hours ago by somebody who has gone home. The same
    // message comes back from the server, which is the check that counts — this
    // one only saves a round trip.
    const disagrees = floatAgainstBooks(shiftOpen.openingFloat, shiftOpen.booksBalance);
    if (disagrees) {
      const reason = shiftOpen.openingReason.trim();
      if (!reason) {
        setShiftError('Your count does not match the drawer on the books. Say why before opening.');
        return;
      }
      if (reason === 'other' && !shiftOpen.openingNotes.trim()) {
        setShiftError('Choosing "something else" needs the notes to say what happened');
        return;
      }
    }
    setSavingShift(true);
    setShiftError('');
    try {
      await api.post('/cash-management/shifts/open', {
        branchId: shiftOpen.branchId,
        openingFloat,
        shiftDate: shiftOpen.shiftDate,
        // Sent even when they agree, and dropped by the server rather than here:
        // a reason beside a zero gap would read as an incident nobody had, and
        // deciding that once, in one place, is how the two sides stay agreed.
        openingDifferenceReason: shiftOpen.openingReason.trim() || null,
        openingDifferenceNotes: shiftOpen.openingNotes.trim() || null,
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

  // The grid is the count: its total becomes the figure the shift closes on,
  // so the two cannot disagree. The server still checks the pair, because a
  // request that did not come from this screen might.
  const denomTotalCents = (denoms: Record<string, string>): number => tallyCents(denominations, denoms);

  const gridUsed = (denoms: Record<string, string>): boolean => tallyUsed(denominations, denoms);

  // The one-way step: the count is committed, and the reconciliation appears
  // with it. There is no way back because "back" is the loophole — read the
  // expected figure, then count to it. The operator can still abandon the
  // close entirely and start again, which is why the expected figure is not
  // the thing this screen relies on; the ritual is, and it no longer hands
  // anyone the answer while they are counting.
  const checkCount = () => {
    if (!shiftClose) return;
    const text = gridUsed(shiftClose.denoms)
      ? (denomTotalCents(shiftClose.denoms) / 100).toFixed(2)
      : shiftClose.countedClosing.trim();
    const parsed = parseFloat(text);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setShiftError('Enter the cash you actually counted in the drawer');
      return;
    }
    if (!shiftClose.shift.live) {
      setShiftError('This shift has no expected figure to count against yet');
      return;
    }
    setShiftError('');
    setShiftClose((s) => (s ? { ...s, countedClosing: text, step: 'review' } : s));
  };

  const submitShiftClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftClose || shiftClose.step !== 'review') return;
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
        countDetail: gridUsed(shiftClose.denoms) ? shiftClose.denoms : undefined,
        varianceReason: shiftClose.varianceReason || undefined,
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

  // The two discrepancies resolve through their own endpoints and their own
  // stamps, because they are two investigations: settling why the float was
  // wrong is not an answer to whether the closing count was, so one must never
  // quietly close the other.
  const resolveVariance = async (id: string, type: 'count' | 'float') => {
    const opening = type === 'float';
    const confirmed = window.confirm(
      `Mark this ${opening ? 'opening difference' : 'variance'} as investigated?\n\n` +
        'This records that somebody looked into it, and when. It does not change the count, ' +
        'the expected figure, or any balance.',
    );
    if (!confirmed) return;
    // Composite key: one shift can be waiting on both investigations, and a
    // bare shift id would spin both buttons and leave the other half of the
    // work looking answered.
    setResolvingId(`${type}:${id}`);
    setShiftError('');
    try {
      await api.post(`/cash-management/shifts/${id}/${opening ? 'opening-difference' : 'variance'}/resolve`, {});
      await loadShifts();
    } catch (err) {
      setShiftError(
        err instanceof Error ? err.message : `Could not close the ${opening ? 'opening difference' : 'variance'}`,
      );
    } finally {
      setResolvingId(null);
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

  // The reason is asked the way the Transactions screen asks it, and the
  // outcome is reported the way it reports one: an administrator's reversal
  // executes immediately, anyone else's files a request that waits for
  // approval. Both answers are the server's — this screen does not decide
  // which it is, because the endpoint does.
  const reverseRecord = async (row: CashRecord) => {
    if (!row.transactionId || reversingRecord) return;
    const reason = window.prompt('Reason for reversal:');
    if (!reason) return;
    setReversingRecord(true);
    try {
      await api.post(`/transactions/${row.transactionId}/reverse`, { reason });
      window.alert(isAdmin
        ? 'Transaction reversed successfully.'
        : 'Reversal request submitted. Waiting for admin approval.');
      setRecordDetail(null);
      // Both, because an executed reversal moves money the position is totalling
      // while a request only adds a row to the register. Refreshing the wrong
      // one leaves a stale figure on screen with no way to tell it is stale.
      await Promise.all([loadRecords(), loadStatement()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Reversal failed');
    } finally {
      setReversingRecord(false);
    }
  };

  const openForm = () => {
    setForm({ ...emptyForm, transactionDate: manilaDateValue() });
    setFormError('');
    // Cash-on-hand expenses belong on the branch's cash account, so it is
    // preselected rather than made the operator hunt for it among the wallets.
    // Found by `type_code`, not by name: every other query that reaches the
    // drawer matches `account_types.code = 'cash'`, and this one matching the
    // text `'Revolving Fund'` meant renaming the account would have quietly
    // emptied the default while the account itself kept holding the money.
    // Prefer this user's own branch's float: the list holds every branch's
    // wallet, and preselecting someone else's cash would be an easy mistake to
    // approve.
    const ownBranches = (user?.branches || []).map((b) => b.name);
    const float =
      accounts.find((a) => a.type_code === 'cash' && !!a.branch_name && ownBranches.includes(a.branch_name))
      || accounts.find((a) => a.type_code === 'cash');
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

  const openEventForm = () => {
    setEventForm({ ...emptyEventForm, transactionDate: manilaDateValue() });
    setEventError('');
    // The drawer is preselected the same way the expense form preselects it,
    // for the same reason: a borrowed peso and a refund paid at the counter
    // are both cash in the branch's hands, and hunting for the right wallet is
    // how the wrong one gets picked.
    const ownBranches = (user?.branches || []).map((b) => b.name);
    const float =
      accounts.find((a) => a.type_code === 'cash' && !!a.branch_name && ownBranches.includes(a.branch_name))
      || accounts.find((a) => a.type_code === 'cash');
    if (float) setEventForm((f) => ({ ...f, accountId: float.id }));
    setShowEventForm(true);
  };

  const submitCashEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    setEventError('');
    const typeId = typeIds[eventForm.code];
    if (!typeId) {
      setEventError('That transaction type is not available on this server.');
      return;
    }
    if (!eventForm.accountId) { setEventError('Choose the wallet this belongs to.'); return; }
    if (!eventForm.amount || Number(eventForm.amount) <= 0) { setEventError('Enter an amount greater than zero.'); return; }
    if (!eventForm.description.trim()) { setEventError('Describe what happened.'); return; }

    setSaving(true);
    try {
      await api.post('/transactions', {
        accountId: eventForm.accountId,
        transactionTypeId: typeId,
        amount: Number(eventForm.amount),
        description: eventForm.description.trim(),
        payee: eventForm.payee.trim() || null,
        referenceNumber: eventForm.referenceNumber.trim() || null,
        transactionDate: eventForm.transactionDate,
      });
      setShowEventForm(false);
      await Promise.all([loadStatement(), loadExpenses(), loadShifts(), loadShiftActivity(), loadRecords()]);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      setEventError(err instanceof Error ? err.message : 'Could not record the cash event');
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

  // What the cash-event form will tell the operator, mirroring the expense
  // banner. A borrowing waits for a second signature when anyone other than an
  // administrator records it: a loan creates a debt the company has to repay,
  // and D6's two-person rule does not stop at the administrator. An
  // administrator takes it at once, exactly as owner funding already does.
  const eventIsBorrowing = eventForm.code === 'loan_received' || eventForm.code === 'loan_repayment';
  const eventSettlesNow = !eventIsBorrowing || isAdmin;
  const eventIsMoneyIn =
    eventForm.code === 'loan_received' ||
    eventForm.code === 'other_income' ||
    eventForm.code === 'refund_received';

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
              <>
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
                {/* Beside the expense button rather than folded into it: an
                    expense is a running cost and this is everything else the
                    drawer takes in or hands back — borrowed cash, income with
                    no fee, a refund. Same shift gate, same disabled reason. */}
                <button
                  type="button"
                  onClick={openEventForm}
                  className="btn-secondary"
                  disabled={openShiftCount === 0}
                  title={openShiftCount === 0 ? 'No shift is open in this scope' : undefined}
                >
                  <Coins className="w-4 h-4" />
                  Record cash event
                </button>
              </>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
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
                <p className="text-sm text-gray-500">{cashOnHandNote(statement.drawerAccounts)}</p>
              </div>
            )}

            {/* Borrowed money still outstanding, from every borrowing in the
                books rather than from a window: this screen has no period
                (D18), so the figure is simply what is owed now. Held out of
                `totals` because a liability is not part of the statement's
                opening-plus-sources-minus-uses identity — and hidden at zero so
                a business carrying no debt says so by showing nothing rather
                than by adding a permanent ₱0.00 to every read. */}
            {statement.borrowingsOutstanding !== undefined && statement.borrowingsOutstanding !== 0 && (
              <div className="card border border-amber-300">
                <div className="flex items-center gap-2 text-amber-700">
                  <Receipt className="w-4 h-4" />
                  <p className="text-xs font-semibold uppercase tracking-wide">Still owed</p>
                </div>
                <p className="text-2xl font-bold mt-2 tabular-nums text-amber-700">
                  {formatCurrency(statement.borrowingsOutstanding)}
                </p>
                <p className="text-sm text-gray-500">
                  Borrowed and not yet repaid — counted from the start of the books
                </p>
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
                <p className={`text-xs mt-2 font-medium ${Math.abs(lastClose.drawerDifference || 0) < 0.005 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {Math.abs(lastClose.drawerDifference || 0) < 0.005
                    ? 'The two readings agree — the opening count and the drawer on the books matched.'
                    : `The two readings differ by ${formatCurrency(money(lastClose.drawerDifference || 0))}. That gap was set when the shift opened, not by this count, so it survives a balanced close.`}
                </p>
                <p className="text-xs text-gray-600 mt-1">
                  Expected comes from your opening count plus the drawer's movements; the books figure comes
                  from the account balance. They are derived from different things precisely so they can
                  disagree — a gap between them means the float or the movements are wrong.
                </p>
              </div>
            )}

            {variances.length > 0 && (
              <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm">
                <p className="font-semibold text-red-800">
                  {variances.length} {variances.length === 1 ? 'discrepancy' : 'discrepancies'} nobody
                  has answered for
                </p>
                <p className="mt-1 text-xs text-red-700">
                  A discrepancy is an event to investigate, not a balance to adjust. These stay listed
                  until somebody has looked into one — a later shift balancing does not settle it.
                  A shift can contribute both kinds: it may have opened off its drawer and closed off
                  its expected figure, and those are two questions, not one.
                </p>
                <ul className="mt-3 space-y-3">
                  {variances.map((v) => {
                    const cents = Math.round(money(v.variance) * 100);
                    const over = cents > 0;
                    const opening = v.type === 'float';
                    return (
                      // Keyed on the type as well: the same shift can be in the
                      // queue twice for two different reasons, and without that
                      // the two rows collide and one of them cannot be
                      // resolved by clicking it.
                      <li key={`${v.type}:${v.id}`} className="rounded border border-red-200 bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            {v.branch_name} · {dateKeyLabel(v.shift_date)}
                          </span>
                          <span className={`badge-${over ? 'yellow' : 'red'}`}>
                            {opening ? 'FLOAT' : 'COUNT'} · {over ? 'OVER' : 'SHORT'}{' '}
                            {formatCurrency(money(v.variance))}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-gray-600">
                          {opening
                            ? `Counted ${formatCurrency(money(v.counted_closing))} · the books held ${formatCurrency(money(v.expected_closing))}`
                            : `Expected ${formatCurrency(money(v.expected_closing))} · counted ${formatCurrency(money(v.counted_closing))}`}
                          {v.by_username ? ` · ${opening ? 'taken by' : 'closed by'} ${v.by_username}` : ''}
                          {v.at ? ` · ${manilaDateTimeLabel(v.at)}` : ''}
                        </p>
                        <p className="mt-1 text-xs text-gray-700">
                          <span className="text-gray-500">Why: </span>
                          {v.variance_reason
                            ? varianceReasons[v.variance_reason] ?? v.variance_reason
                            : 'no reason was recorded'}
                          {v.notes ? ` · ${v.notes}` : ''}
                        </p>
                        {isAdmin ? (
                          <button
                            type="button"
                            className="btn-secondary mt-2"
                            disabled={resolvingId === `${v.type}:${v.id}`}
                            onClick={() => void resolveVariance(v.id, v.type)}
                          >
                            {resolvingId === `${v.type}:${v.id}` ? 'Recording…' : 'Mark as investigated'}
                          </button>
                        ) : (
                          <p className="mt-2 text-xs text-gray-500">
                            An administrator records the outcome.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
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
                              <dt className="text-gray-500">Drawer on the books then</dt>
                              <dd className="font-medium">{formatCurrency(money(open.opening_drawer_balance))}</dd>
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
                              : `The two readings differ by ${formatCurrency(live.drawerDifference)} — the count above against a drawer of ${formatCurrency(money(open.opening_drawer_balance))}.`}
                          </p>
                          {open.opening_difference_reason && (
                            <p className="text-xs text-gray-600 mt-1">
                              Why, as given when the shift opened:{' '}
                              {varianceReasons[open.opening_difference_reason] ?? open.opening_difference_reason}
                              {open.opening_difference_notes ? ` — ${open.opening_difference_notes}` : ''}
                              {open.opening_difference_resolved_at ? ' · recorded as investigated' : ''}
                            </p>
                          )}
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
                            onClick={() => { setLastClose(null); setShiftOpen(null); setShiftClose({ shift: open, step: 'count', countedClosing: '', denoms: {}, varianceReason: '', notes: '' }); }}
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
                            onClick={() => { setLastClose(null); setShiftClose(null); setShiftOpen({ branchId: b.id, openingFloat: '', booksBalance: books, shiftDate: manilaDateValue(), openingReason: '', openingNotes: '' }); }}
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
                                      {/* The posting time, because that is what puts a row
                                          inside the window: the business day it files under
                                          can be weeks away and reads as a time the shift
                                          was never open. */}
                                      {row.account_name} · {manilaTimeLabel(row.created_at)}
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
              <table className="w-full min-w-[1200px]">
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
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Actions</th>
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
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-500">{paymentMethodCell(row.paymentMethod)}</td>
                      <td className={`px-4 py-3 text-sm text-right font-mono whitespace-nowrap ${row.direction === 'in' ? 'text-emerald-600' : 'text-red-600'}`}>
                        {row.direction === 'in' ? '+' : '−'}{formatCurrency(Number(row.amount))}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono whitespace-nowrap text-gray-700">
                        {formatCurrency(Number(row.balanceAfter))}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-gray-500">{row.recordedBy || <span className="text-gray-400">—</span>}</td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setRecordDetail(row)}
                            className="p-1 text-gray-400 hover:text-primary-600"
                            title="View record details"
                            aria-label={row.transactionNumber ? `View details of TXN #${row.transactionNumber}` : 'View record details'}
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {/* Disabled, not hidden, when no transaction stands
                              behind the row — a transfer or adjustment writes a
                              ledger entry with nothing to reverse, and hiding the
                              button would leave the reader wondering whether it
                              was removed or merely not offered. */}
                          <button
                            type="button"
                            onClick={() => reverseRecord(row)}
                            disabled={!row.transactionId || reversingRecord}
                            className="p-1 text-gray-400 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                            title={row.transactionId
                              ? 'Request a reversal'
                              : 'Nothing to reverse — this row has no transaction behind it'}
                            aria-label={row.transactionId ? 'Request a reversal' : 'Reversal unavailable for this row'}
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/*
                  The total sits under the column it totals rather than above
                  the table: a figure in an Amount column footer is read as that
                  column's sum, which is what it is — narrowed to the expense
                  classes named beside it.

                  It is the filtered population's total while the rows above it
                  are one page of it, so the note says so. Without that a reader
                  would take it for the sum of the rows currently in view.
                */}
                <tfoot className="border-t-2 border-gray-300 bg-red-50">
                  <tr>
                    <td colSpan={7} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold text-gray-700">Cash expenses</span>
                        <span className="text-xs text-gray-500">
                          Operating Expenses, Provider Charges and Payments &amp; Bills — every matching record, not just this page
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-semibold whitespace-nowrap text-red-700">
                      {recordTotals ? formatCurrency(Number(recordTotals.cashExpenses)) : '—'}
                    </td>
                    <td colSpan={3} className="px-4 py-3" />
                  </tr>
                </tfoot>
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
                    onChange={(v) => setForm((f) => ({
                      ...f,
                      accountId: v,
                      // Switching onto a drawer account answers the payment
                      // question for you: its balance is physical cash, so
                      // nothing but cash can have reached or left it.
                      paymentMethod: accounts.find((a) => a.id === v)?.type_code === 'cash' ? 'cash' : f.paymentMethod,
                    }))}
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
                        value={formPaysFromDrawer ? 'cash' : form.paymentMethod}
                        onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                        disabled={formPaysFromDrawer}
                      >
                        {movementPaymentMethodOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {formPaysFromDrawer && (
                        <p className="text-xs text-gray-500 mt-1.5">
                          This account holds physical cash, so the money can only have been
                          handed over by hand. The server refuses anything else anyway.
                        </p>
                      )}
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

      {showEventForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4">
          <div className="mx-auto my-10 max-w-2xl bg-white rounded-xl shadow-2xl border border-gray-200">
            <div className="flex items-start gap-3 px-6 pt-6 pb-5 border-b border-gray-200">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                <Coins className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-gray-900">Record cash event</h3>
                <p className="mt-0.5 text-sm text-gray-500">
                  Money the drawer takes in or hands back that carries no fee of its own.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowEventForm(false)}
                aria-label="Close"
                className="-mr-1 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={submitCashEvent}>
              <div className="px-6 py-5 space-y-6">
                {eventError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {eventError}
                  </div>
                )}

                <div className={`flex gap-3 rounded-lg border px-4 py-3 ${
                  eventSettlesNow ? 'border-emerald-200 bg-emerald-50' : 'border-blue-200 bg-blue-50'
                }`}>
                  <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${eventSettlesNow ? 'text-emerald-600' : 'text-blue-600'}`} />
                  <p className={`text-xs leading-relaxed ${eventSettlesNow ? 'text-emerald-800' : 'text-blue-800'}`}>
                    {eventSettlesNow
                      ? <>Recorded <span className="font-semibold">now</span> — this reaches the books and the
                        drawer the moment you save, and counts in the current shift. Check the figure first.</>
                      : <>Saved as a <span className="font-semibold">request</span>. A borrowing creates a debt the
                        company has to repay, so a second person signs before it counts — nobody approves
                        their own request.</>}
                  </p>
                </div>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    What happened
                  </h4>
                  <select
                    required
                    className="form-input"
                    value={eventForm.code}
                    onChange={(e) => setEventForm((f) => ({ ...f, code: e.target.value as CashEventCode }))}
                  >
                    {CASH_EVENT_TYPES.map((t) => (
                      <option key={t.code} value={t.code}>{t.label}</option>
                    ))}
                  </select>
                  <p className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600">
                    {CASH_EVENT_TYPES.find((t) => t.code === eventForm.code)?.hint}
                  </p>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    {eventIsMoneyIn ? 'Amount received' : 'Amount paid out'}
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
                      value={eventForm.amount}
                      onChange={(e) => setEventForm((f) => ({ ...f, amount: e.target.value }))}
                      placeholder="0.00"
                    />
                  </div>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Wallet
                  </h4>
                  <AccountSelect
                    accounts={accounts}
                    value={eventForm.accountId}
                    onChange={(v) => setEventForm((f) => ({ ...f, accountId: v }))}
                    placeholder="Select the wallet this belongs to"
                    className="form-input"
                  />
                  <p className="text-xs text-gray-500 mt-1.5">
                    Borrowed cash lands in the drawer, so the revolving fund is already selected.
                    Any visible wallet may be used.
                  </p>
                </section>

                <section>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                    Details
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                      <label className="form-label" htmlFor="event-description">Description *</label>
                      <textarea
                        id="event-description"
                        required
                        rows={2}
                        className="form-input"
                        value={eventForm.description}
                        onChange={(e) => setEventForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder={eventIsMoneyIn
                          ? 'e.g. Cash advance from lender, 60-day term'
                          : 'e.g. First repayment of the 60-day loan'}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="event-payee">
                        {eventIsMoneyIn ? 'Received from' : 'Paid to'}
                      </label>
                      <input
                        id="event-payee"
                        type="text"
                        className="form-input"
                        value={eventForm.payee}
                        onChange={(e) => setEventForm((f) => ({ ...f, payee: e.target.value }))}
                        placeholder={eventIsMoneyIn ? 'Lender or source' : 'Lender or recipient'}
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="event-reference">Reference</label>
                      <input
                        id="event-reference"
                        type="text"
                        className="form-input"
                        value={eventForm.referenceNumber}
                        onChange={(e) => setEventForm((f) => ({ ...f, referenceNumber: e.target.value }))}
                        placeholder="Receipt, voucher or agreement no."
                      />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="event-date">Date</label>
                      <input
                        id="event-date"
                        type="date"
                        className="form-input"
                        value={eventForm.transactionDate}
                        onChange={(e) => setEventForm((f) => ({ ...f, transactionDate: e.target.value }))}
                      />
                      <p className="text-xs text-gray-500 mt-1">Shown in Manila time.</p>
                    </div>
                  </div>
                </section>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 rounded-b-xl">
                <p className="text-xs text-gray-500 hidden sm:block">
                  {eventSettlesNow
                    ? <>Posted to the wallet and to the current shift <span className="font-medium text-gray-600">on save</span>.</>
                    : <>Goes to <span className="font-medium text-gray-600">Awaiting approval</span> for a second signature.</>}
                </p>
                <div className="flex gap-3 ml-auto">
                  <button type="button" className="btn-secondary" onClick={() => setShowEventForm(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : eventSettlesNow ? 'Record cash event' : 'Send for approval'}
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
                {/* Asked only when the two actually disagree. A float that
                    matches owes no explanation and is never asked for one, so
                    the form stays as short as the answer has to be — and what
                    decides the field appears is the same comparison the server
                    runs, not a second opinion about it. */}
                {floatAgainstBooks(shiftOpen.openingFloat, shiftOpen.booksBalance) && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                    {floatAgainstBooks(shiftOpen.openingFloat, shiftOpen.booksBalance)}
                  </p>
                )}
              </div>

              {floatAgainstBooks(shiftOpen.openingFloat, shiftOpen.booksBalance) && (
                <div>
                  <label className="form-label">
                    Why does it differ? <span className="text-red-500">*</span>
                  </label>
                  <select
                    className="form-input"
                    value={shiftOpen.openingReason}
                    onChange={(e) => setShiftOpen((s) => s && { ...s, openingReason: e.target.value })}
                  >
                    <option value="">Choose a reason</option>
                    {Object.entries(varianceReasons).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>

                  <label className="form-label mt-3">
                    Notes{shiftOpen.openingReason === 'other' ? ' ' : ' (optional)'}
                    {shiftOpen.openingReason === 'other' && <span className="text-red-500">*</span>}
                  </label>
                  <textarea
                    className="form-input"
                    rows={2}
                    value={shiftOpen.openingNotes}
                    onChange={(e) => setShiftOpen((s) => s && { ...s, openingNotes: e.target.value })}
                  />

                  <p className="text-xs text-gray-500 mt-1">
                    This records why the two readings differ. It does not change either of them — the drawer
                    stays at {formatCurrency(shiftOpen.booksBalance)} on the books, whatever you counted.
                  </p>
                </div>
              )}

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

      {/* A row's full record. The register only fits a column of each field,
          so this is where the reference, payee and posting instant a reader
          would otherwise have to export the CSV to see are readable in place.
          Read-only: a ledger row is append-only, so there is nothing here to
          edit, and the reversal action is offered only where a transaction
          stands behind the row. */}
      {recordDetail && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4">
          <div className="mx-auto my-10 max-w-2xl bg-white rounded-xl shadow-2xl border border-gray-200">
            <div className="flex items-start gap-3 px-6 pt-6 pb-5 border-b border-gray-200">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                <Receipt className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-gray-900">
                  {recordDetail.transactionNumber ? `TXN #${recordDetail.transactionNumber}` : 'Ledger entry'}
                </h3>
                <p className="mt-0.5 text-sm text-gray-500">
                  {recordDetail.category} · {recordDetail.accountName}
                  {recordDetail.branchCode ? ` · ${recordDetail.branchCode}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRecordDetail(null)}
                aria-label="Close"
                className="-mr-1 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <dl className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Business day</dt>
                <dd className="mt-1 text-sm text-gray-900">{manilaDayLabel(recordDetail.businessDate)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Posted to the drawer</dt>
                <dd className="mt-1 text-sm text-gray-900">{manilaDateTimeLabel(recordDetail.entryDate)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {recordDetail.direction === 'in' ? 'Amount received' : 'Amount paid out'}
                </dt>
                <dd className={`mt-1 text-sm font-semibold tabular-nums ${recordDetail.direction === 'in' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {recordDetail.direction === 'in' ? '+' : '−'}{formatCurrency(Number(recordDetail.amount))}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Balance after</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums text-gray-900">{formatCurrency(Number(recordDetail.balanceAfter))}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Type</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.category}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Method</dt>
                <dd className="mt-1 text-sm text-gray-900">{paymentMethodCell(recordDetail.paymentMethod)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Reference</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.referenceNumber || <span className="text-gray-400">—</span>}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Payee</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.payee || <span className="text-gray-400">—</span>}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Recorded by</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.recordedBy || <span className="text-gray-400">—</span>}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Branch</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.branchName || <span className="text-gray-400">—</span>}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Description</dt>
                <dd className="mt-1 text-sm text-gray-900">{recordDetail.description || <span className="text-gray-400">—</span>}</dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 rounded-b-xl">
              <p className="text-xs text-gray-500">
                {recordDetail.transactionId
                  ? 'Completed entries are locked — a reversal is the way to undo one.'
                  : 'This row has no transaction behind it, so there is nothing to reverse.'}
              </p>
              <div className="flex gap-3 ml-auto">
                <button type="button" className="btn-secondary" onClick={() => setRecordDetail(null)}>
                  Close
                </button>
                {recordDetail.transactionId && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => reverseRecord(recordDetail)}
                    disabled={reversingRecord}
                  >
                    <RotateCcw className="w-4 h-4" />
                    {reversingRecord ? 'Sending…' : 'Request a reversal'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {shiftClose && (() => {
        const live = shiftClose.shift.live;
        const counting = shiftClose.step === 'count';
        const countedNum = Number(shiftClose.countedClosing);
        const countedOk = shiftClose.countedClosing.trim() !== '' && Number.isFinite(countedNum) && countedNum >= 0;
        const countedCents = countedOk ? Math.round(countedNum * 100) : 0;
        const usedGrid = gridUsed(shiftClose.denoms);
        // Computed only on the review step, and only ever rendered there: in
        // the counting step this dialog holds no figure the counter could
        // count towards.
        const previewCents = !counting && live ? countedCents - Math.round(live.expected * 100) : null;
        const differed = previewCents !== null && previewCents !== 0;
        const reasonKey = shiftClose.varianceReason;
        const reasonNeedsNotes = reasonKey === 'other';
        const reasonOk = !differed || (reasonKey !== '' && (!reasonNeedsNotes || shiftClose.notes.trim() !== ''));

        return (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
            <div className="mx-auto mt-12 max-w-md bg-white rounded-xl shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                <div>
                  <h3 className="text-lg font-semibold">Close shift — {shiftClose.shift.branch_name}</h3>
                  <p className="text-xs text-gray-500">
                    {counting ? 'Count the drawer. Nothing about what should be in it is shown yet.' : 'Your count is locked. Check it before going on.'}
                  </p>
                </div>
                <button type="button" onClick={() => setShiftClose(null)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={submitShiftClose} className="p-5 space-y-4">
                {counting && (
                  <>
                    <div>
                      <div className="flex items-end justify-between">
                        <label className="form-label">Count by denomination</label>
                        {usedGrid && (
                          <button
                            type="button"
                            className="text-xs text-gray-500 underline hover:text-gray-700"
                            onClick={() => setShiftClose((s) => s && { ...s, denoms: {} })}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      {denominations.length === 0 ? (
                        <p className="text-xs text-gray-500">
                          The note list has not loaded, so type the total below instead.
                        </p>
                      ) : (
                        <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
                          {denominations.map((d) => {
                            const qty = denomQty(shiftClose.denoms, d.label);
                            return (
                              <div key={d.label} className="flex items-center gap-3 px-3 py-1.5">
                                <span className="w-14 shrink-0 tabular-nums text-gray-700">₱{d.label}</span>
                                <span className="flex-1 text-right tabular-nums text-xs text-gray-400">
                                  {qty > 0 ? formatCurrency(denomSubtotalPesos(d, qty)) : ''}
                                </span>
                                <input
                                  className="w-16 rounded border border-gray-300 px-2 py-1 text-right tabular-nums"
                                  inputMode="numeric"
                                  placeholder="0"
                                  aria-label={`How many ${d.label} pieces`}
                                  value={shiftClose.denoms[d.label] ?? ''}
                                  onChange={(e) =>
                                    setShiftClose((s) =>
                                      s && { ...s, denoms: { ...s.denoms, [d.label]: e.target.value.replace(/[^0-9]/g, '') } },
                                    )
                                  }
                                />
                              </div>
                            );
                          })}
                          <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5 text-sm">
                            <span className="font-medium">Tally</span>
                            <span className="font-semibold tabular-nums">
                              {formatCurrency(tallyPesos(denominations, shiftClose.denoms))}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="form-label">Counted closing cash</label>
                      <input
                        className="form-input"
                        inputMode="decimal"
                        autoFocus
                        placeholder="0.00"
                        readOnly={usedGrid}
                        value={usedGrid ? (denomTotalCents(shiftClose.denoms) / 100).toFixed(2) : shiftClose.countedClosing}
                        onChange={(e) => setShiftClose((s) => s && { ...s, countedClosing: e.target.value })}
                      />
                      {usedGrid && (
                        <p className="mt-1 text-xs text-gray-500">
                          Taken from the tally. Clear the tally if you would rather type it.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap justify-end gap-3 pt-1">
                      <button
                        type="button"
                        className="btn-secondary flex items-center gap-2"
                        onClick={() => setPrintSheet('tally')}
                      >
                        <Printer className="w-4 h-4" />
                        Print tally sheet
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setShiftClose(null)}>Cancel</button>
                      <button type="button" className="btn-primary" onClick={checkCount}>Check the count</button>
                    </div>
                  </>
                )}

                {!counting && (
                  <>
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

                    {/* Stated, never enforced: the gap between the two rows
                        above is fixed when the shift opens - the movement posts
                        to both sides and cancels - so it is a discrepancy of its
                        own, separate from the count being taken here. It was
                        only ever shown in the response after closing, when it
                        could no longer be acted on. */}
                    <div
                      className={`rounded-lg border px-3 py-2 text-xs ${Math.abs(live?.drawerDifference || 0) < 0.005 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
                    >
                      {Math.abs(live?.drawerDifference || 0) < 0.005
                        ? 'The two readings agree: your opening count matched the drawer on the books, so any difference below is a difference in the count alone.'
                        : `The two readings differ by ${formatCurrency(live?.drawerDifference || 0)}. That gap was set when this shift opened and no closing count clears it — it means the float and the books disagreed from the start, and it needs an answer of its own.`}
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm">
                      <span className="font-medium text-gray-700">Counted closing cash</span>
                      <span className="font-semibold tabular-nums">{formatCurrency(countedCents / 100)}</span>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
                      <span className="text-gray-500">Difference</span>
                      <span className={`font-semibold ${previewCents === 0 ? 'text-emerald-600' : previewCents! > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                        {formatCurrency((previewCents || 0) / 100)}
                      </span>
                    </div>

                    {differed && (
                      <div>
                        <label className="form-label">
                          Why does the count differ? <span className="text-red-500">*</span>
                        </label>
                        <select
                          className="form-input"
                          value={reasonKey}
                          onChange={(e) => setShiftClose((s) => s && { ...s, varianceReason: e.target.value })}
                        >
                          <option value="">Choose a reason</option>
                          {Object.entries(varianceReasons).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className="form-label">
                        Notes{reasonNeedsNotes ? ' ' : ' (optional)'}
                        {reasonNeedsNotes && <span className="text-red-500">*</span>}
                      </label>
                      <textarea
                        className="form-input"
                        rows={2}
                        value={shiftClose.notes}
                        onChange={(e) => setShiftClose((s) => s && { ...s, notes: e.target.value })}
                      />
                    </div>

                    {differed && !reasonOk && (
                      <p className="text-xs text-amber-700">
                        A count that differs has to say why before this shift can close.
                      </p>
                    )}

                    <div className="flex flex-wrap justify-end gap-3 pt-1">
                      <button
                        type="button"
                        className="btn-secondary flex items-center gap-2"
                        onClick={() => setPrintSheet('count')}
                      >
                        <Printer className="w-4 h-4" />
                        Print sheet
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setShiftClose(null)}>Cancel</button>
                      <button type="submit" className="btn-primary" disabled={savingShift || !countedOk || !reasonOk}>
                        {savingShift ? 'Saving…' : 'Close shift'}
                      </button>
                    </div>
                  </>
                )}
              </form>
            </div>
          </div>
        );
      })()}
    </div>

    {/* Outside the page root deliberately — window.print() prints the document,
        and the root above carries print:hidden for exactly as long as one of
        these is mounted. */}
    {printSheet === 'tally' && shiftClose && (
      <TallySheet
        branchName={shiftClose.shift.branch_name}
        shiftDate={shiftClose.shift.shift_date}
        denoms={denominations}
        counts={shiftClose.denoms}
        totalPesos={tallyPesos(denominations, shiftClose.denoms)}
        printedAt={`${dateKeyLabel(manilaDateValue())} ${manilaTimeLabel(new Date())}`}
      />
    )}

    {printSheet === 'count' && shiftClose && (() => {
      const expected = shiftClose.shift.live?.expected ?? 0;
      const counted = Number(shiftClose.countedClosing);
      const hasCount = shiftClose.countedClosing.trim() !== '' && Number.isFinite(counted);
      const varianceCents = hasCount ? Math.round(counted * 100) - Math.round(expected * 100) : null;
      return (
        <ShiftCountSheet
          branchName={shiftClose.shift.branch_name}
          shiftDate={shiftClose.shift.shift_date}
          openedAt={shiftClose.shift.opened_at}
          openingFloat={money(shiftClose.shift.opening_float)}
          cashIn={shiftClose.shift.live?.cashIn}
          cashOut={shiftClose.shift.live?.cashOut}
          expected={expected}
          counted={hasCount ? counted : null}
          variance={varianceCents === null ? null : varianceCents / 100}
          status={varianceCents === null ? null : varianceCents === 0 ? 'BALANCED' : varianceCents > 0 ? 'OVER' : 'SHORT'}
          drawerOnBooks={shiftClose.shift.live?.drawerBalance}
          printedAt={`${dateKeyLabel(manilaDateValue())} ${manilaTimeLabel(new Date())}`}
        />
      );
    })()}

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
