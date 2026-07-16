import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Group, Modal, Stack, Title, TextInput, Select, NumberInput, Text, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Trash2, Eye, ArrowLeft } from 'lucide-react';
import DataTable from '../../components/DataTable';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchJournalEntries, createJournalEntry, fetchChartOfAccounts } from '../../api/journal';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const EMPTY_LINE = { account: '', debit: '', credit: '', note: '' };

export default function JournalPage() {
  const { year, month, day } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canView = user.modules?.includes('accounting.journal');
  const canEdit = user.editModules?.includes('accounting.journal');

  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const list = usePagedList(
    ['accounting', 'journal', year, month, day],
    fetchJournalEntries,
    { filters: { year, month, day } }
  );

  const coaQuery = useQuery({
    queryKey: ['accounting', 'coa', { postable: true }],
    queryFn: () => fetchChartOfAccounts({ postable: true }),
    enabled: canEdit,
  });
  const coaAccounts = coaQuery.data?.data || [];

  const form = useForm({
    initialValues: {
      date: new Date().toISOString().slice(0, 10),
      memo: '',
      lines: [{ ...EMPTY_LINE }, { ...EMPTY_LINE }],
    },
    validate: {
      memo: (v) => (!v.trim() ? 'Memo is required' : null),
    },
  });

  const totalDebit = form.values.lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredit = form.values.lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const balanced = totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.01;

  const handleCreate = async (values) => {
    try {
      const lines = values.lines.map((l) => ({
        account: l.account,
        debit: l.debit === '' ? 0 : Number(l.debit),
        credit: l.credit === '' ? 0 : Number(l.credit),
        note: l.note || undefined,
      }));
      await createJournalEntry({ date: values.date, memo: values.memo, lines });
      notifications.show({ color: 'green', message: 'Journal entry posted' });
      setCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: ['accounting'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const monthValue = year && month ? `${year}-${month}` : '';
  const handleMonthChange = (v) => {
    if (!v) return;
    const [y, m] = v.split('-');
    navigate(`/accounting/journal/${y}/${m}`);
  };

  const subtitle =
    year && month && day
      ? new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      : year && month
      ? `${MONTH_NAMES[Number(month) - 1]} ${year}`
      : 'All Entries';

  const columns = useMemo(
    () => [
      { accessorKey: 'date', header: 'Date', cell: (info) => formatDate(info.getValue()) },
      { accessorKey: 'entryNo', header: 'Entry No' },
      { accessorKey: 'memo', header: 'Memo', truncate: true },
      { accessorKey: 'refType', header: 'Ref Type', cell: (info) => <Tag>{info.getValue()}</Tag> },
      { accessorKey: 'totalDebit', header: 'Total Debit', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'totalCredit', header: 'Total Credit', cell: (info) => AED(info.getValue()) },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => (
          <Tooltip label="View this journal entry">
            <ActionIcon variant="filled" size="lg" radius="md" onClick={() => navigate(`/accounting/journal/${info.row.original._id}`)} aria-label="View journal entry">
              <Eye size={18} />
            </ActionIcon>
          </Tooltip>
        ),
      },
    ],
    []
  );

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Journal Entries</Title>
        <Text c="dimmed" size="sm">You don't have access to this section.</Text>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageToolbar
        title={
          <Group gap="xs">
            <ActionIcon variant="subtle" onClick={() => navigate('/accounting')} aria-label="Back to Accounting">
              <ArrowLeft size={18} />
            </ActionIcon>
            <Title order={1} size="h3">Journal Entries</Title>
          </Group>
        }
        subtitle={subtitle}
        actions={
          <>
            <MonthInput label="Jump to month" value={monthValue} onChange={handleMonthChange} w={170} />
            {(year || month || day) && (
              <Button variant="subtle" size="compact-sm" onClick={() => navigate('/accounting/journal')}>View All Entries</Button>
            )}
            {canEdit && (
              <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>New Journal Entry</Button>
            )}
          </>
        }
      />

      <DataTable
        columns={columns}
        data={list.data}
        totalRowCount={list.totalRowCount}
        page={list.page}
        limit={list.limit}
        onPageChange={list.onPageChange}
        search={list.search}
        onSearchChange={list.onSearchChange}
        sorting={list.sorting}
        onSortingChange={list.onSortingChange}
        isLoading={list.isLoading}
        emptyLabel="No journal entries found"
      />

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Journal Entry" size="lg">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput type="date" label="Date" required {...form.getInputProps('date')} />
            <TextInput label="Memo" required {...form.getInputProps('memo')} />

            <Text size="sm" fw={600} mt="xs">Lines</Text>
            {form.values.lines.map((_, index) => (
              <Group key={index} align="flex-end" wrap="nowrap">
                <Select
                  label="Account"
                  data={coaAccounts.map((a) => ({ value: a._id, label: `${a.code} - ${a.name}` }))}
                  style={{ flex: 2 }}
                  required
                  {...form.getInputProps(`lines.${index}.account`)}
                />
                <NumberInput label="Debit" min={0} w={110} {...form.getInputProps(`lines.${index}.debit`)} />
                <NumberInput label="Credit" min={0} w={110} {...form.getInputProps(`lines.${index}.credit`)} />
                <TextInput label="Note" style={{ flex: 1 }} {...form.getInputProps(`lines.${index}.note`)} />
                <ActionIcon
                  color="red"
                  variant="subtle"
                  disabled={form.values.lines.length <= 2}
                  onClick={() => form.removeListItem('lines', index)}
                >
                  <Trash2 size={16} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              size="xs"
              variant="light"
              onClick={() => form.insertListItem('lines', { ...EMPTY_LINE })}
            >
              + Add Line
            </Button>

            <Text size="sm" fw={600} c={balanced ? 'green' : 'red'}>
              Total Debit: {AED(totalDebit)} · Total Credit: {AED(totalCredit)}
            </Text>

            <Button type="submit" mt="sm" disabled={!balanced}>Post Journal Entry</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
