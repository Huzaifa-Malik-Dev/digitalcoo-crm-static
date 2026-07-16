import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, Title, TextInput, Select, NumberInput, Text, ActionIcon, Divider } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '../../utils/toast';
import { Plus, Trash2, ArrowLeft } from 'lucide-react';
import DataTable from '../../components/DataTable';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchExpenses, createExpense, fetchAccounts } from '../../api/accounting';
import { fetchEmployees } from '../../api/hr';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';

const CATEGORIES = ['Rent', 'Utilities', 'Salaries', 'Commission', 'Other'];

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canView = user.modules?.includes('accounting.expenses');
  const canEdit = user.editModules?.includes('accounting.expenses');

  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [month, setMonth] = useState('');

  const list = usePagedList(['accounting', 'expenses'], fetchExpenses, { filters: { month: month || undefined } });
  const accountsQuery = useQuery({ queryKey: ['accounting', 'accounts'], queryFn: fetchAccounts });
  const employeesQuery = useQuery({
    queryKey: ['hr', 'employees-for-select'],
    queryFn: () => fetchEmployees({ limit: 200, active: 'true' }),
    enabled: canEdit,
  });

  const accounts = accountsQuery.data?.data || [];
  const employees = employeesQuery.data?.data || [];

  const form = useForm({
    initialValues: { category: 'Rent', amount: '', date: new Date().toISOString().slice(0, 10), account: '', note: '', breakdown: [] },
  });

  const handleCreate = async (values) => {
    try {
      const payload = {
        ...values,
        breakdown: values.category === 'Salaries'
          ? values.breakdown.map((line) => ({ ...line, amount: line.amount === '' ? 0 : line.amount }))
          : [],
      };
      await createExpense(payload);
      notifications.show({ color: 'green', message: 'Expense recorded' });
      setCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: ['accounting'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const breakdownTotal = form.values.breakdown.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);

  const columns = useMemo(
    () => [
      { accessorKey: 'date', header: 'Date', cell: (info) => formatDate(info.getValue()) },
      { accessorKey: 'category', header: 'Category', cell: (info) => <Tag>{info.getValue()}</Tag> },
      { accessorKey: 'amount', header: 'Amount', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'account', header: 'Account', enableSorting: false, cell: (info) => info.getValue()?.name || '-' },
      { accessorKey: 'note', header: 'Note' },
      {
        id: 'breakdown',
        header: 'Breakdown',
        cell: (info) => {
          const b = info.row.original.breakdown || [];
          if (!b.length) return '-';
          return <Text size="xs" c="dimmed">{b.length} employee{b.length > 1 ? 's' : ''}</Text>;
        },
      },
    ],
    []
  );

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Company Expenses</Title>
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
            <Title order={1} size="h3">Company Expenses</Title>
          </Group>
        }
        actions={
          <>
            {canEdit && <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>New Expense</Button>}
            <MonthInput label="Month" placeholder="All time" value={month} onChange={setMonth} clearable />
          </>
        }
      />

      <Stack gap="md">
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
          emptyLabel="No expenses recorded yet"
        />

        <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Expense" size="md">
          <form onSubmit={form.onSubmit(handleCreate)}>
            <Stack gap="sm">
              <Select label="Category" data={CATEGORIES} required {...form.getInputProps('category')} />
              <TextInput type="date" label="Date" required {...form.getInputProps('date')} />
              <NumberInput label="Amount (AED)" min={0.01} required {...form.getInputProps('amount')} />
              <Select
                label="Paid From Account"
                description="Every expense, including salaries, must be paid from one account"
                data={accounts.map((a) => ({ value: a._id, label: a.name }))}
                required
                {...form.getInputProps('account')}
              />
              <TextInput label="Note" {...form.getInputProps('note')} />

              {form.values.category === 'Salaries' && (
                <>
                  <Divider label="Employee Breakdown (optional)" labelPosition="left" />
                  {form.values.breakdown.map((_, index) => (
                    <Group key={index} align="flex-end">
                      <Select
                        label="Employee"
                        data={employees.map((e) => ({ value: e._id, label: e.name }))}
                        style={{ flex: 1 }}
                        {...form.getInputProps(`breakdown.${index}.employee`)}
                      />
                      <NumberInput label="Amount" w={110} {...form.getInputProps(`breakdown.${index}.amount`)} />
                      <ActionIcon color="red" variant="subtle" onClick={() => form.removeListItem('breakdown', index)}>
                        <Trash2 size={16} />
                      </ActionIcon>
                    </Group>
                  ))}
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => form.insertListItem('breakdown', { employee: '', amount: '', note: '' })}
                  >
                    + Add Employee
                  </Button>
                  {form.values.breakdown.length > 0 && (
                    <Text size="xs" c={Math.abs(breakdownTotal - form.values.amount) > 0.01 ? 'red' : 'dimmed'}>
                      Breakdown total: {AED(breakdownTotal)} (must match expense amount)
                    </Text>
                  )}
                </>
              )}

              <Button type="submit" mt="sm">Save Expense</Button>
            </Stack>
          </form>
        </Modal>
      </Stack>
    </Stack>
  );
}
