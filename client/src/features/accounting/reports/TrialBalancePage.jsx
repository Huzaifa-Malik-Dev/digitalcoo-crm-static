import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Stack, Title, Group, Button, Table, Text, ActionIcon } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchTrialBalance } from '../../../api/journal';
import MonthInput from '../../../components/MonthInput';
import { useAuth } from '../../../context/AuthContext';
import Tag from '../../../components/Tag';
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

export default function TrialBalancePage() {
  const { year, month } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canView = user.modules?.includes('accounting.reports');

  const periodValue = year && month ? `${year}-${pad(month)}` : currentMonth();

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'reports', 'trial-balance', year, month],
    queryFn: () => fetchTrialBalance(year && month ? `${year}-${pad(month)}` : undefined),
    enabled: canView,
  });

  if (!canView) return <Text c="dimmed">You don't have access to this page.</Text>;

  const handleMonthChange = (value) => {
    if (!value) return;
    const [y, m] = value.split('-');
    navigate(`/accounting/reports/trial-balance/${y}/${m}`);
  };

  const jumpTo = (key) => {
    navigate(year && month ? `/accounting/reports/${key}/${year}/${month}` : `/accounting/reports/${key}`);
  };

  const d = data?.data;

  const exportCsv = () => {
    if (!d) return;
    const rows = [
      ['Code', 'Name', 'Type', 'Debit', 'Credit'],
      ...d.rows.map((r) => [r.code, r.name, r.type, r.debit, r.credit]),
      ['', '', 'Total', d.totalDebit, d.totalCredit],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trial-balance-${d.month}.csv`;
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
            <Title order={1} size="h3">Trial Balance</Title>
          </Group>
        }
        actions={
          <>
            <Group gap="xs">
              {REPORTS.map((r) => (
                <Button
                  key={r.key}
                  size="xs"
                  variant={r.key === 'trial-balance' ? 'filled' : 'light'}
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
        <Stack gap="xs">
          <Text fw={700} c={d.balanced ? 'green' : 'red'}>
            {d.balanced ? 'Balanced' : 'NOT BALANCED'}
          </Text>
          <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Debit</Table.Th>
                  <Table.Th>Credit</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {d.rows.length === 0 ? (
                  <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md">No postings this period</Text></Table.Td></Table.Tr>
                ) : (
                  d.rows.map((r) => (
                    <Table.Tr key={r.code}>
                      <Table.Td>{r.code}</Table.Td>
                      <Table.Td>{r.name}</Table.Td>
                      <Table.Td><Tag>{r.type}</Tag></Table.Td>
                      <Table.Td>{r.debit ? AED(r.debit) : '-'}</Table.Td>
                      <Table.Td>{r.credit ? AED(r.credit) : '-'}</Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr style={{ borderTop: '2px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default-hover)' }}>
                  <Table.Th colSpan={3}>Total</Table.Th>
                  <Table.Th>{AED(d.totalDebit)}</Table.Th>
                  <Table.Th>{AED(d.totalCredit)}</Table.Th>
                </Table.Tr>
              </Table.Tfoot>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}
    </Stack>
  );
}
