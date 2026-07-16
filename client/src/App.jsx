import { Routes, Route } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './components/AppLayout';
import LoginPage from './features/auth/LoginPage';
import DsrPage from './features/dsr/DsrPage';
import PipelinePage from './features/pipeline/PipelinePage';
import BackofficePage from './features/backoffice/BackofficePage';
import DashboardPage from './features/dashboard/DashboardPage';
import MisPage from './features/mis/MisPage';
import AgentPerformancePage from './features/mis/AgentPerformancePage';
import AiReportPage from './features/ai/AiReportPage';
import HrPage from './features/hr/HrPage';
import EmployeeDetailPage from './features/hr/EmployeeDetailPage';
import EmployeeLedgerPage from './features/hr/EmployeeLedgerPage';
import AddEmployeePage from './features/hr/AddEmployeePage';
import ComplianceDetailPage from './features/hr/ComplianceDetailPage';
import AccountingPage from './features/accounting/AccountingPage';
import ChartOfAccountsPage from './features/accounting/ChartOfAccountsPage';
import BankingPage from './features/accounting/BankingPage';
import ExpensesPage from './features/accounting/ExpensesPage';
import ChequesPage from './features/accounting/ChequesPage';
import JournalPage from './features/accounting/JournalPage';
import JournalEntryDetailPage from './features/accounting/JournalEntryDetailPage';
import GeneralLedgerPage from './features/accounting/GeneralLedgerPage';
import TrialBalancePage from './features/accounting/reports/TrialBalancePage';
import ProfitLossPage from './features/accounting/reports/ProfitLossPage';
import BalanceSheetPage from './features/accounting/reports/BalanceSheetPage';
import PayrollPage from './features/payroll/PayrollPage';
import PayrollRunDetailPage from './features/payroll/PayrollRunDetailPage';
import AdminPage from './features/admin/AdminPage';
import ProductsPage from './features/products/ProductsPage';
import MyLeavePage from './features/leave/MyLeavePage';
import LeaveApprovalsPage from './features/leave/LeaveApprovalsPage';
import HolidayCalendarPage from './features/leave/HolidayCalendarPage';
import LeaveTypesPage from './features/leave/LeaveTypesPage';
import AttendanceRegisterPage from './features/leave/AttendanceRegisterPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route element={<ProtectedRoute module="dsr" />}>
            <Route path="/dsr" element={<DsrPage />} />
          </Route>
          <Route element={<ProtectedRoute module="pipeline" />}>
            <Route path="/pipeline" element={<PipelinePage />} />
          </Route>
          <Route element={<ProtectedRoute module="backoffice" />}>
            <Route path="/backoffice" element={<BackofficePage />} />
          </Route>
          <Route element={<ProtectedRoute module="mis" />}>
            <Route path="/mis" element={<MisPage />} />
            <Route path="/mis/:id" element={<AgentPerformancePage />} />
          </Route>
          <Route element={<ProtectedRoute module="ai" />}>
            <Route path="/ai" element={<AiReportPage />} />
          </Route>
          <Route element={<ProtectedRoute module="hr" />}>
            <Route path="/hr" element={<HrPage />} />
            <Route path="/hr/new" element={<AddEmployeePage />} />
            <Route path="/hr/employees/:employeeId" element={<EmployeeDetailPage />} />
            <Route path="/hr/employees/:employeeId/ledger" element={<EmployeeLedgerPage />} />
            <Route path="/hr/compliance/:category" element={<ComplianceDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute module="accounting" />}>
            <Route path="/accounting" element={<AccountingPage />} />
            <Route path="/accounting/chart-of-accounts" element={<ChartOfAccountsPage />} />
            <Route path="/accounting/banking" element={<BankingPage />} />
            <Route path="/accounting/expenses" element={<ExpensesPage />} />
            <Route path="/accounting/cheques" element={<ChequesPage />} />
            <Route path="/accounting/journal" element={<JournalPage />} />
            <Route path="/accounting/journal/:year/:month" element={<JournalPage />} />
            <Route path="/accounting/journal/:year/:month/:day" element={<JournalPage />} />
            <Route path="/accounting/journal/:id" element={<JournalEntryDetailPage />} />
            <Route path="/accounting/ledger/:coaAccountId" element={<GeneralLedgerPage />} />
            <Route path="/accounting/ledger/:coaAccountId/:year/:month" element={<GeneralLedgerPage />} />
            <Route path="/accounting/reports/trial-balance" element={<TrialBalancePage />} />
            <Route path="/accounting/reports/trial-balance/:year/:month" element={<TrialBalancePage />} />
            <Route path="/accounting/reports/profit-loss" element={<ProfitLossPage />} />
            <Route path="/accounting/reports/profit-loss/:year/:month" element={<ProfitLossPage />} />
            <Route path="/accounting/reports/balance-sheet" element={<BalanceSheetPage />} />
            <Route path="/accounting/reports/balance-sheet/:year/:month" element={<BalanceSheetPage />} />
          </Route>
          <Route element={<ProtectedRoute module="payroll" />}>
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/payroll/runs/:runId" element={<PayrollRunDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute module="leave" />}>
            <Route path="/leave" element={<MyLeavePage />} />
            <Route path="/leave/approvals" element={<LeaveApprovalsPage />} />
            <Route path="/leave/calendar" element={<HolidayCalendarPage />} />
            <Route path="/leave/settings" element={<LeaveTypesPage />} />
          </Route>
          <Route element={<ProtectedRoute module="attendance" />}>
            <Route path="/attendance" element={<AttendanceRegisterPage />} />
          </Route>
          <Route element={<ProtectedRoute module="products" />}>
            <Route path="/products" element={<ProductsPage />} />
          </Route>
          <Route element={<ProtectedRoute module="admin" />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
