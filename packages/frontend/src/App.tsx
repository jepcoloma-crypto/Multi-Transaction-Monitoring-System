import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Accounts from './pages/Accounts';
import Providers from './pages/Providers';
import Transactions from './pages/Transactions';
import FundTransfers from './pages/FundTransfers';
import TransferApprovals from './pages/TransferApprovals';
import Loading from './pages/Loading';
import Reconciliation from './pages/Reconciliation';
import Reports from './pages/Reports';
import Alerts from './pages/Alerts';
import AuditLogs from './pages/AuditLogs';
import Settings from './pages/Settings';
import TransactionFees from './pages/TransactionFees';
import AdditionalCharges from './pages/AdditionalCharges';
import ProviderCharges from './pages/ProviderCharges';
import Users from './pages/Users';
import Roles from './pages/Roles';
import Profile from './pages/Profile';
import ImportData from './pages/ImportData';
import Customers from './pages/Customers';
import Backup from './pages/Backup';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="providers" element={<Providers />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="transfers" element={<FundTransfers />} />
        <Route path="transfer-approvals" element={<TransferApprovals />} />
        <Route path="loading" element={<Loading />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="reports" element={<Reports />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="audit-logs" element={<AuditLogs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="transaction-fees" element={<TransactionFees />} />
        <Route path="additional-charges" element={<AdditionalCharges />} />
        <Route path="provider-charges" element={<ProviderCharges />} />
        <Route path="users" element={<Users />} />
        <Route path="roles" element={<Roles />} />
        <Route path="profile" element={<Profile />} />
        <Route path="import" element={<ImportData />} />
        <Route path="customers" element={<Customers />} />
        <Route path="backup" element={<Backup />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
