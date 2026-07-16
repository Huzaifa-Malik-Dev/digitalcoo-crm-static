import { Stack, Title, SimpleGrid, Paper, Text, Group, ThemeIcon, UnstyledButton } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Landmark, Receipt, FileSpreadsheet, ScrollText, LineChart } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { fetchSummary } from '../../api/accounting';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatCard({ label, value, sub, color }) {
  return (
    <Paper withBorder p="md" radius="md" style={{ borderLeft: `3px solid var(--mantine-color-${color}-6)` }}>
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="xl" fw={700}>{value}</Text>
      {sub && <Text size="xs" c="dimmed">{sub}</Text>}
    </Paper>
  );
}

function SectionCard({ icon: Icon, label, desc, onClick }) {
  return (
    <UnstyledButton onClick={onClick}>
      <Paper withBorder p="md" radius="md" h="100%">
        <Group>
          <ThemeIcon variant="filled" size="lg" radius="md"><Icon size={18} /></ThemeIcon>
          <div>
            <Text fw={600} size="sm">{label}</Text>
            <Text size="xs" c="dimmed">{desc}</Text>
          </div>
        </Group>
      </Paper>
    </UnstyledButton>
  );
}

// The section list every child route lives at — matches accounting.* keys in utils/constants.js
// PERMISSION_TREE. Journal/Reports/COA+Banking each get their own routed page (not a Tabs
// `?tab=` switch) so period/record drill-downs get real, shareable URLs.
const SECTIONS = [
  { permKey: 'accounting.chartOfAccounts', label: 'Chart of Accounts', desc: 'Full ledger tree, add categories', icon: BookOpen, path: '/accounting/chart-of-accounts' },
  { permKey: 'accounting.chartOfAccounts', label: 'Banking', desc: 'Bank/cash accounts, record transactions', icon: Landmark, path: '/accounting/banking' },
  { permKey: 'accounting.expenses', label: 'Company Expenses', desc: 'Rent, utilities, salaries, commission', icon: Receipt, path: '/accounting/expenses' },
  { permKey: 'accounting.cheques', label: 'Cheques', desc: 'Post-dated cheques received/issued', icon: FileSpreadsheet, path: '/accounting/cheques' },
  { permKey: 'accounting.journal', label: 'Journal Entries', desc: 'Every posting, by month/day', icon: ScrollText, path: '/accounting/journal' },
  { permKey: 'accounting.reports', label: 'Financial Reports', desc: 'Trial Balance, P&L, Balance Sheet', icon: LineChart, path: '/accounting/reports/trial-balance' },
];

export default function AccountingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const summaryQuery = useQuery({ queryKey: ['accounting', 'summary'], queryFn: fetchSummary });
  const s = summaryQuery.data?.data;

  const sections = SECTIONS.filter((sec) => user.modules?.includes(sec.permKey));

  return (
    <Stack>
      <Title order={1} size="h3">Accounting</Title>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
        <StatCard label="Total Cash & Bank" value={AED(s?.totalCash)} sub={`${s?.accountsCount || 0} accounts`} color="green" />
        <StatCard label="Expenses This Month" value={AED(s?.totalExpensesThisMonth)} color="red" />
        <StatCard label="Pending Cheques" value={s?.pendingCheques ?? 0} sub="Deposited or awaiting clearance" color="blue" />
        <StatCard label="Bounced Cheques" value={s?.bouncedCheques ?? 0} sub="Needs follow-up" color={s?.bouncedCheques ? 'red' : 'green'} />
      </SimpleGrid>

      {sections.length === 0 ? (
        <Text c="dimmed" size="sm">You don't have access to any Accounting sections.</Text>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {sections.map((sec) => (
            <SectionCard key={sec.path} icon={sec.icon} label={sec.label} desc={sec.desc} onClick={() => navigate(sec.path)} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
