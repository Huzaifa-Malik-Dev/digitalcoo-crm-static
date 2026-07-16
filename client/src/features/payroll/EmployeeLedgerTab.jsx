import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, Select, Radio, NumberInput, TextInput, Text, Checkbox, Alert, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchLedger, createLedgerEntry, updateLedgerEntry, deleteLedgerEntry } from '../../api/payroll';
import { fetchEmployees } from '../../api/hr';
import { fetchAccounts } from '../../api/accounting';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { formatDate } from '../../utils/date';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_COLOR = { Open: 'yellow', Settled: 'green' };
const TYPE_COLOR = { Advance: 'blue', Loan: 'violet', Deduction: 'gray', Salary: 'green', Bonus: 'teal', Reimbursement: 'cyan' };
// Same simplification as the per-employee Ledger section: Deduct -> Deduction (open debit,
// auto-collected next payroll run), Add -> Bonus (settled credit) with the reason as the note.
const ACTION_TO_TYPE = { deduct: 'Deduction', add: 'Bonus' };
// For editing an existing entry, any pre-existing type outside the simplified 2-action set (e.g.
// a legacy Advance/Loan/Reimbursement/Salary) is treated as "Add" - saving without changing the
// action normalizes it to Bonus, same as a fresh entry would be.
const typeToAction = (type) => (type === 'Deduction' ? 'deduct' : 'add');

export default function EmployeeLedgerTab() {
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('payroll.ledger');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const list = usePagedList(['payroll', 'ledger'], fetchLedger);
  const employeesQuery = useQuery({
    queryKey: ['hr', 'employees-for-select'],
    queryFn: () => fetchEmployees({ limit: 200, active: 'true' }),
    enabled: canEdit,
  });
  const employees = employeesQuery.data?.data || [];
  const accountsQuery = useQuery({ queryKey: ['accounting', 'accounts'], queryFn: fetchAccounts, enabled: canEdit });
  const accounts = accountsQuery.data?.data || [];

  const ledgerFormValidate = {
    amount: (v) => (v === '' || v === null ? 'Amount is required' : null),
    note: (v, values) => (values.action === 'add' && !v.trim() ? 'Reason is required' : null),
    account: (v, values) => (values.postToAccounts && !v ? 'Pick a funding account, or uncheck "Adjust in Accounts"' : null),
  };

  const form = useForm({
    initialValues: { employee: '', date: new Date().toISOString().slice(0, 10), action: 'deduct', amount: '', note: '', postToAccounts: false, account: '' },
    validate: ledgerFormValidate,
  });
  const editForm = useForm({
    initialValues: { date: '', action: 'deduct', amount: '', note: '', postToAccounts: false, account: '' },
    validate: ledgerFormValidate,
  });

  const handleCreate = async (values) => {
    try {
      const type = ACTION_TO_TYPE[values.action];
      await createLedgerEntry({
        employee: values.employee,
        date: values.date,
        amount: values.amount,
        note: values.note,
        type,
        postToAccounts: values.postToAccounts,
        account: values.postToAccounts ? values.account : undefined,
      });
      notifications.show({ color: 'green', message: `${type} recorded` });
      setCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: ['payroll', 'ledger'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const openEdit = (row) => {
    editForm.setValues({
      date: row.date?.slice(0, 10) || '',
      action: typeToAction(row.type),
      amount: row.amount,
      note: row.note || '',
      postToAccounts: row.postToAccounts || false,
      account: row.account || '',
    });
    setEditRow(row);
  };

  const handleEditSave = async (values) => {
    try {
      const type = ACTION_TO_TYPE[values.action];
      await updateLedgerEntry(editRow._id, {
        date: values.date,
        amount: values.amount,
        note: values.note,
        type,
        postToAccounts: values.postToAccounts,
        account: values.postToAccounts ? values.account : undefined,
      });
      notifications.show({ color: 'green', message: 'Ledger entry updated' });
      setEditRow(null);
      queryClient.invalidateQueries({ queryKey: ['payroll', 'ledger'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Delete this ledger entry?',
      message: `Remove this ${row.type} entry for ${row.employee?.name || 'this employee'}?`,
      confirmLabel: 'Yes, delete',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteLedgerEntry(row._id);
      notifications.show({ color: 'green', message: 'Ledger entry deleted' });
      queryClient.invalidateQueries({ queryKey: ['payroll', 'ledger'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = useMemo(
    () => [
      { accessorKey: 'date', header: 'Date', cell: (info) => formatDate(info.getValue()) },
      { accessorKey: 'employee', header: 'Employee', cell: (info) => info.getValue()?.name || '-', enableSorting: false },
      { accessorKey: 'type', header: 'Type', cell: (info) => <Tag color={TYPE_COLOR[info.getValue()]}>{info.getValue()}</Tag> },
      { accessorKey: 'amount', header: 'Amount', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'remaining', header: 'Remaining', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'status', header: 'Status', cell: (info) => <Tag color={STATUS_COLOR[info.getValue()]}>{info.getValue()}</Tag> },
      { accessorKey: 'note', header: 'Note' },
      ...(canEdit
        ? [
            {
              id: 'action',
              header: 'Actions',
              cell: (info) => {
                const row = info.row.original;
                return (
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label="Edit ledger entry">
                      <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="Edit ledger entry">
                        <Pencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete ledger entry">
                      <ActionIcon variant="filled" color="red" size="lg" radius="md" onClick={() => handleDelete(row)} aria-label="Delete ledger entry">
                        <Trash2 size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                );
              },
            },
          ]
        : []),
    ],
    [canEdit]
  );

  return (
    <Stack gap="md">
      {canEdit && (
        <Group>
          <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add Ledger Entry</Button>
        </Group>
      )}

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
        emptyLabel="No ledger entries yet"
      />

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Ledger Entry" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <Select label="Employee" data={employees.map((e) => ({ value: e._id, label: `${e.employeeId} - ${e.name}` }))} required {...form.getInputProps('employee')} />
            <Radio.Group label="Action" required {...form.getInputProps('action')}>
              <Group mt={4}>
                <Radio value="deduct" label="Deduct Amount" />
                <Radio value="add" label="Add Amount" />
              </Group>
            </Radio.Group>
            <Text size="xs" c="dimmed">
              {form.values.action === 'deduct'
                ? 'Deducted in full from this employee\'s next payroll run.'
                : 'Recorded as already paid to this employee.'}
            </Text>
            <TextInput type="date" label="Date" required {...form.getInputProps('date')} />
            <NumberInput label="Amount (AED)" min={0} required {...form.getInputProps('amount')} />
            <TextInput
              label={form.values.action === 'add' ? 'Reason' : 'Note (optional)'}
              placeholder={form.values.action === 'add' ? 'e.g. Bonus, Reimbursement...' : undefined}
              required={form.values.action === 'add'}
              {...form.getInputProps('note')}
            />
            <Checkbox
              label="Adjust in Accounts"
              description="Post this as a real journal entry against a bank/cash account"
              {...form.getInputProps('postToAccounts', { type: 'checkbox' })}
            />
            {form.values.postToAccounts ? (
              <Select
                label="Funding Account"
                data={accounts.map((a) => ({ value: a._id, label: a.name }))}
                required
                {...form.getInputProps('account')}
              />
            ) : (
              <Alert icon={<AlertTriangle size={16} />} color="yellow" variant="light">
                Not linked to a cash account — this entry won't be reflected in Accounting or affect any account balance.
              </Alert>
            )}
            <Button type="submit" mt="sm">Save</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title="Edit Ledger Entry" size="md">
        <form onSubmit={editForm.onSubmit(handleEditSave)}>
          <Stack gap="sm">
            <Radio.Group label="Action" required {...editForm.getInputProps('action')}>
              <Group mt={4}>
                <Radio value="deduct" label="Deduct Amount" />
                <Radio value="add" label="Add Amount" />
              </Group>
            </Radio.Group>
            <Text size="xs" c="dimmed">
              {editForm.values.action === 'deduct'
                ? 'Deducted in full from this employee\'s next payroll run.'
                : 'Recorded as already paid to this employee.'}
            </Text>
            <TextInput type="date" label="Date" required {...editForm.getInputProps('date')} />
            <NumberInput label="Amount (AED)" min={0} required {...editForm.getInputProps('amount')} />
            <TextInput
              label={editForm.values.action === 'add' ? 'Reason' : 'Note (optional)'}
              placeholder={editForm.values.action === 'add' ? 'e.g. Bonus, Reimbursement...' : undefined}
              required={editForm.values.action === 'add'}
              {...editForm.getInputProps('note')}
            />
            <Checkbox
              label="Adjust in Accounts"
              description="Post this as a real journal entry against a bank/cash account"
              {...editForm.getInputProps('postToAccounts', { type: 'checkbox' })}
            />
            {editForm.values.postToAccounts ? (
              <Select
                label="Funding Account"
                data={accounts.map((a) => ({ value: a._id, label: a.name }))}
                required
                {...editForm.getInputProps('account')}
              />
            ) : (
              <Alert icon={<AlertTriangle size={16} />} color="yellow" variant="light">
                Not linked to a cash account — this entry won't be reflected in Accounting or affect any account balance.
              </Alert>
            )}
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
