import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Stack, Title, Group, Text, Table, Loader, Center, ActionIcon } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchGeneralLedger } from '../../api/journal';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pad(m) {
  return String(m).padStart(2, '0');
}

export default function GeneralLedgerPage() {
  const { coaAccountId, year, month } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Reached from two different list pages (Chart of Accounts, Banking) - back has to return to
  // whichever one actually linked here, not a single hardcoded parent. Driven by an explicit
  // state value set at link time (see ChartOfAccountsPage.jsx / BankingPage.jsx), not history
  // depth, so it stays correct no matter how the user got to this URL. Defaults to Chart of
  // Accounts (the canonical owner of every ledger account) if state is missing, e.g. a direct link.
  const cameFromBanking = location.state?.from === 'banking';
  const backTo = cameFromBanking ? '/accounting/banking' : '/accounting/chart-of-accounts';
  const backLabel = cameFromBanking ? 'Back to Banking' : 'Back to Chart of Accounts';
  const { user } = useAuth();
  const canView = user.modules?.includes('accounting.chartOfAccounts');

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'ledger', coaAccountId, year, month],
    queryFn: () => fetchGeneralLedger(coaAccountId, { year, month }),
    enabled: canView,
  });

  if (!canView) return <Text c="dimmed">You don't have access to this page.</Text>;
  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  const d = data?.data;
  if (!d) return <Text c="dimmed">Account not found.</Text>;

  const { account, openingBalance, rows, closingBalance } = d;
  const periodValue = year && month ? `${year}-${pad(month)}` : '';

  const handleMonthChange = (value) => {
    if (!value) return;
    const [y, m] = value.split('-');
    navigate(`/accounting/ledger/${coaAccountId}/${y}/${m}`);
  };

  return (
    <Stack gap="md">
      <Group gap="xs">
        <ActionIcon variant="subtle" onClick={() => navigate(backTo)} aria-label={backLabel}>
          <ArrowLeft size={18} />
        </ActionIcon>
        <Title order={1} size="h3">General Ledger</Title>
      </Group>

      <PageToolbar
        title={
          <div>
            <Group gap="xs">
              <Text fw={700} size="lg">{account.code} — {account.name}</Text>
              <Tag>{account.type}</Tag>
            </Group>
            {year && month && (
              <Text
                size="sm"
                c="blue"
                style={{ cursor: 'pointer', width: 'fit-content' }}
                onClick={() => navigate(`/accounting/ledger/${coaAccountId}`)}
              >
                View Full History
              </Text>
            )}
          </div>
        }
        actions={<MonthInput label="Period" placeholder="Full History" value={periodValue} onChange={handleMonthChange} w={180} />}
      />

      <Text size="sm">Opening Balance: <Text span fw={600}>{AED(openingBalance)}</Text></Text>

      <Table.ScrollContainer minWidth={800} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Entry No</Table.Th>
              <Table.Th>Memo</Table.Th>
              <Table.Th>Ref Type</Table.Th>
              <Table.Th>Debit</Table.Th>
              <Table.Th>Credit</Table.Th>
              <Table.Th>Running Balance</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 ? (
              <Table.Tr><Table.Td colSpan={7}><Text c="dimmed" ta="center" py="md">No entries in this period</Text></Table.Td></Table.Tr>
            ) : (
              rows.map((r) => (
                <Table.Tr key={r._id}>
                  <Table.Td>{formatDate(r.date)}</Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      c="blue"
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/accounting/journal/${r._id}`)}
                    >
                      {r.entryNo}
                    </Text>
                  </Table.Td>
                  <Table.Td>{r.memo}</Table.Td>
                  <Table.Td><Tag>{r.refType}</Tag></Table.Td>
                  <Table.Td>{r.debit ? AED(r.debit) : '-'}</Table.Td>
                  <Table.Td>{r.credit ? AED(r.credit) : '-'}</Table.Td>
                  <Table.Td>{AED(r.runningBalance)}</Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Text ta="right" fw={700}>Closing Balance: {AED(closingBalance)}</Text>
    </Stack>
  );
}
