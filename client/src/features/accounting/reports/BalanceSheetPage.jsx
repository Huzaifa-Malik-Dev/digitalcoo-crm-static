import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Stack, Title, Group, Button, Table, Text, ActionIcon } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchBalanceSheet } from '../../../api/journal';
import MonthInput from '../../../components/MonthInput';
import { useAuth } from '../../../context/AuthContext';
import PageToolbar from '../../../components/PageToolbar';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function pad(m) {
  return String(m).padStart(2, '0');
}

const REPORTS = [
  { key: 'trial-balance', label: 'Trial Balance' },
  { key: 'profit-loss', label: 'Profit & Loss' },
  { key: 'balance-sheet', label: 'Balance Sheet' },
];

function ReportSection({ title, rows, total }) {
  return (
    <Stack gap={4}>
      <Text fw={600} size="sm">{title}</Text>
      <Table.ScrollContainer minWidth={500} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr><Table.Th>Code</Table.Th><Table.Th>Name</Table.Th><Table.Th>Amount</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 ? (
              <Table.Tr><Table.Td colSpan={3}><Text c="dimmed" ta="center" py="sm">No entries</Text></Table.Td></Table.Tr>
            ) : (
              rows.map((r) => (
                <Table.Tr key={r.code}>
                  <Table.Td>{r.code}</Table.Td>
                  <Table.Td>{r.name}</Table.Td>
                  <Table.Td>{AED(r.amount)}</Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr style={{ borderTop: '2px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default-hover)' }}>
              <Table.Th colSpan={2}>Subtotal</Table.Th>
              <Table.Th>{AED(total)}</Table.Th>
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

export default function BalanceSheetPage() {
  const { year, month } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canView = user.modules?.includes('accounting.reports');

  const periodValue = year && month ? `${year}-${pad(month)}` : currentMonth();

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'reports', 'balance-sheet', year, month],
    queryFn: () => fetchBalanceSheet(year && month ? `${year}-${pad(month)}` : undefined),
    enabled: canView,
  });

  if (!canView) return <Text c="dimmed">You don't have access to this page.</Text>;

  const handleMonthChange = (value) => {
    if (!value) return;
    const [y, m] = value.split('-');
    navigate(`/accounting/reports/balance-sheet/${y}/${m}`);
  };

  const jumpTo = (key) => {
    navigate(year && month ? `/accounting/reports/${key}/${year}/${month}` : `/accounting/reports/${key}`);
  };

  const d = data?.data;

  const exportCsv = () => {
    if (!d) return;
    const rows = [
      ['Section', 'Code', 'Name', 'Amount'],
      ...d.assets.map((r) => ['Assets', r.code, r.name, r.amount]),
      ['Assets', '', 'Subtotal', d.totalAssets],
      ...d.liabilities.map((r) => ['Liabilities', r.code, r.name, r.amount]),
      ['Liabilities', '', 'Subtotal', d.totalLiabilities],
      ...d.equity.map((r) => ['Equity', r.code, r.name, r.amount]),
      ['Equity', '', 'Subtotal', d.totalEquity],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `balance-sheet-${d.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack gap="md">
      <PageToolbar
        title={
          <Group gap="xs">
            <ActionIcon variant="subtle" onClick={() => navigate('/accounting')} aria-label="Back to Accounting">
              <ArrowLeft size={18} />
            </ActionIcon>
            <Title order={1} size="h3">Balance Sheet</Title>
          </Group>
        }
        actions={
          <>
            <Group gap="xs">
              {REPORTS.map((r) => (
                <Button
                  key={r.key}
                  size="xs"
                  variant={r.key === 'balance-sheet' ? 'filled' : 'light'}
                  onClick={() => jumpTo(r.key)}
                >
                  {r.label}
                </Button>
              ))}
            </Group>
            <MonthInput label="Period" value={periodValue} onChange={handleMonthChange} w={180} />
            <Button variant="light" onClick={exportCsv} disabled={!d}>Export CSV</Button>
          </>
        }
      />

      {isLoading || !d ? (
        <Text c="dimmed">Loading...</Text>
      ) : (
        <Stack gap="md">
          <ReportSection title="Assets" rows={d.assets} total={d.totalAssets} />
          <ReportSection title="Liabilities" rows={d.liabilities} total={d.totalLiabilities} />
          <ReportSection title="Equity" rows={d.equity} total={d.totalEquity} />
          <Group justify="space-between" mt="xs">
            <Text fw={700}>Total Assets: {AED(d.totalAssets)}</Text>
            <Text fw={700}>Total Liabilities + Equity: {AED(d.totalLiabilities + d.totalEquity)}</Text>
            <Text fw={700} c={d.balanced ? 'green' : 'red'}>
              {d.balanced ? 'Balanced' : 'NOT BALANCED'}
            </Text>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
