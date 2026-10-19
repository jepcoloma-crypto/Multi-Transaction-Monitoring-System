import { useState, useEffect, type ReactNode } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Coins,
  ArrowLeftRight,
  ArrowUpDown,
  Smartphone,
  CheckSquare,
  BarChart3,
  Bell,
  FileText,
  Settings,
  Users,
  Shield,
  Menu,
  X,
  LogOut,
  ChevronDown,
  User,
  Upload,
  DollarSign,
  UserCircle,
  Database,
  Pencil,
  Building2,
  Receipt,
  ScanSearch,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { api, unwrapRows } from '../lib/api';
import GlobalSearch from './GlobalSearch';

type NavItem = { name: string; href: string; icon: typeof Settings };
type MenuItem = NavItem & { approverOnly?: boolean; adminOnly?: boolean; reviewerOnly?: boolean };

// Ordered by what gets done there rather than by importance. The first list is
// where money is moved, in the order a branch day moves it: the drawer is
// opened on Cash Management, fed from the other four, and closed there again.
// The second is where money is looked at — screens read rather than written.
// Cash Management carries Coins because Accounts holds Wallet, and the two used
// to share one icon, which left the two hardest screens on the board to tell
// apart wearing the same picture.
const dailyWork: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Cash Transactions', href: '/transactions', icon: ArrowLeftRight },
  { name: 'Fund Transfers', href: '/transfers', icon: ArrowUpDown },
  { name: 'Loading', href: '/loading', icon: Smartphone },
  { name: 'Customers', href: '/customers', icon: UserCircle },
  { name: 'Cash Management', href: '/cash-management', icon: Coins },
];

const review: NavItem[] = [
  { name: 'Accounts', href: '/accounts', icon: Wallet },
  { name: 'Reconciliation', href: '/reconciliation', icon: CheckSquare },
  { name: 'Reports', href: '/reports', icon: BarChart3 },
  { name: 'Alerts', href: '/alerts', icon: Bell },
];

const adminSection: MenuItem[] = [
  { name: 'Providers', href: '/providers', icon: Settings },
  { name: 'Transaction Fees', href: '/transaction-fees', icon: DollarSign },
  { name: 'Additional Charges', href: '/additional-charges', icon: DollarSign },
  { name: 'Provider Charges', href: '/provider-charges', icon: DollarSign },
  { name: 'Amount Corrections', href: '/amount-corrections', icon: Pencil, adminOnly: true },
  { name: 'Fee Audit', href: '/fee-audit', icon: Receipt, adminOnly: true },
  { name: 'Integrity Checks', href: '/integrity', icon: ScanSearch, reviewerOnly: true },
  { name: 'Approvals', href: '/transfer-approvals', icon: CheckSquare, approverOnly: true },
  { name: 'Import', href: '/import', icon: Upload },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Audit Logs', href: '/audit-logs', icon: FileText },
  { name: 'Backup', href: '/backup', icon: Database },
];

const adminNavigation: NavItem[] = [
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Roles', href: '/roles', icon: Shield },
  { name: 'Branches', href: '/branches', icon: Building2 },
];

/**
 * The name shown in the mobile header for a path. Searches every list rather
 * than only the ones a given role happens to see: the title describes the page
 * underneath it, and a user who somehow lands on a restricted page should read
 * what it is, not what their role allows.
 */
const titleFor = (pathname: string): string | undefined =>
  [...dailyWork, ...review, ...adminSection, ...adminNavigation].find((n) => n.href === pathname)?.name;

/**
 * What this session can see, stated on every page.
 *
 * Branch scoping happens in the query layer, where it is invisible: a
 * filtered list and a complete one look identical until somebody compares
 * screens with a colleague and concludes the accounts have gone missing.
 * Naming the scope makes a query that quietly excludes rows legible without
 * anyone having to suspect data loss first.
 */
function BranchScopeBadge() {
  const { user } = useAuth();
  const branches = user?.branches ?? [];

  if (user?.canSeeAllBranches) {
    return (
      <span className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
        <Building2 className="w-3.5 h-3.5" />
        Viewing: All branches
      </span>
    );
  }

  // Absent means unconfirmed, not empty: a session opened before these
  // fields existed, or /auth/me failing to return. Stating nothing beats
  // asserting a scope that was never checked.
  if (branches.length === 0) return null;

  return (
    <span className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
      <Building2 className="w-3.5 h-3.5" />
      {branches.length === 1
        ? `Branch: ${branches[0].name}`
        : `Branches: ${branches.map((b) => b.name).join(', ')}`}
    </span>
  );
}

/**
 * One sidebar row, written once. The sidebar renders four separate lists —
 * daily work, review, administration and user management — and this markup
 * had been copied into each of them. A fifth copy would be a fifth place for
 * a hover style or a font weight to drift away from the other four, which on
 * a list an operator scans by eye is the kind of difference nobody reports.
 */
function NavLink({ item, active, onClick, badge }: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <Link
      to={item.href}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        active
          ? 'bg-primary-600 text-white'
          : 'text-gray-300 hover:bg-gray-800 hover:text-white'
      }`}
    >
      <item.icon className="w-5 h-5" />
      {item.name}
      {badge}
    </Link>
  );
}

/** The label that says where one group of destinations ends and the next begins. */
const NavHeading = ({ label }: { label: string }) => (
  <p className="px-3 py-1 text-xs font-semibold text-gray-500 uppercase">{label}</p>
);

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const isAdmin = user?.roles?.includes('administrator');
  const isApprover = isAdmin || user?.roles?.includes('manager');
  // Integrity Checks is read-only, so it reaches the auditor as well as the
  // administrator: the role that can see every finding still cannot move a peso.
  const isReviewer = isAdmin || user?.roles?.includes('auditor');
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    if (!isApprover) return;
    let cancelled = false;
    const load = async () => {
      const results = await Promise.allSettled([
        api.get<{ pagination?: { total?: number } }>('/transfers?status=pending&limit=1'),
        api.get<unknown>('/transactions/owner-funds/pending?status=pending'),
        api.get<unknown>('/transactions/reversals/pending?status=pending'),
      ]);
      if (cancelled) return;
      const [transfers, funds, rev] = results;
      let total = 0;
      if (transfers.status === 'fulfilled') total += transfers.value.pagination?.total || 0;
      if (funds.status === 'fulfilled') total += unwrapRows(funds.value).length;
      if (rev.status === 'fulfilled') total += unwrapRows(rev.value).length;
      setPendingApprovals(total);
    };
    load();
    window.addEventListener('approvals-changed', load);
    const timer = setInterval(load, 60000);
    return () => {
      cancelled = true;
      window.removeEventListener('approvals-changed', load);
      clearInterval(timer);
    };
  }, [isApprover, location.pathname]);

  return (
    <div className="min-h-screen flex">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 text-white transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto print:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-16 px-6 border-b border-gray-800">
          <span className="text-lg font-bold">Financial Monitor</span>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="mt-4 px-3 space-y-1 overflow-y-auto max-h-[calc(100vh-8rem)] no-scrollbar">
          <NavHeading label="Daily work" />
          {dailyWork.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={location.pathname === item.href}
              onClick={() => setSidebarOpen(false)}
            />
          ))}

          <div className="border-t border-gray-800 my-3"></div>
          <NavHeading label="Review & reports" />
          {review.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={location.pathname === item.href}
              onClick={() => setSidebarOpen(false)}
            />
          ))}

          <div className="border-t border-gray-800 my-3"></div>
          <NavHeading label="Administration" />
          {adminSection
            .filter((item) => {
              if (item.adminOnly) return Boolean(isAdmin);
              if (item.approverOnly) return Boolean(isApprover);
              if (item.reviewerOnly) return Boolean(isReviewer);
              return true;
            })
            .map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={location.pathname === item.href}
                onClick={() => setSidebarOpen(false)}
                badge={
                  item.href === '/transfer-approvals' && pendingApprovals > 0 ? (
                    <span className="ml-auto bg-red-500 text-white text-xs font-semibold rounded-full px-1.5 py-0.5 leading-none">
                      {pendingApprovals > 99 ? '99+' : pendingApprovals}
                    </span>
                  ) : undefined
                }
              />
            ))}

          {isAdmin && (
            <>
              <div className="border-t border-gray-800 my-3"></div>
              <NavHeading label="User Management" />
              {adminNavigation.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={location.pathname === item.href}
                  onClick={() => setSidebarOpen(false)}
                />
              ))}
            </>
          )}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-gray-800">
          <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white w-full">
            <LogOut className="w-5 h-5" />
            Logout
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6 print:hidden">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 rounded-md text-gray-600 hover:bg-gray-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold text-gray-900">
              {titleFor(location.pathname) || 'Dashboard'}
            </h1>
            <BranchScopeBadge />
          </div>

          <div className="flex items-center gap-3">
            <GlobalSearch />

          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900"
            >
              <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center overflow-hidden">
                {(user as any)?.avatarUrl ? (
                  <img src={(user as any).avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm font-medium text-primary-700">
                    {user?.firstName?.[0]}{user?.lastName?.[0]}
                  </span>
                )}
              </div>
              <span className="hidden md:block">{user?.firstName} {user?.lastName}</span>
              <ChevronDown className="w-4 h-4" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <p className="text-sm font-medium text-gray-900">{user?.firstName} {user?.lastName}</p>
                    <p className="text-xs text-gray-500">{user?.email}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {user?.roles?.map((role) => (
                        <span key={role} className="badge-blue text-[10px]">{role}</span>
                      ))}
                    </div>
                  </div>
                  <div className="py-1">
                    <Link
                      to="/profile"
                      onClick={() => setUserMenuOpen(false)}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                    >
                      <User className="w-4 h-4" />
                      My Profile
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 overflow-auto print:p-0 print:overflow-visible">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
