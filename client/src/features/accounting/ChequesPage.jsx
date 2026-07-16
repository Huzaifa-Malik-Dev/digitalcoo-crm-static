import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, Title, TextInput, Select, NumberInput, Textarea, Text, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '../../utils/toast';
import { Plus, X, Pencil, ArrowLeft } from 'lucide-react';
import DataTable from '../../components/DataTable';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchCheques, createCheque, updateCheque, updateChequeStatus, fetchAccounts } from '../../api/accounting';
import { fetchChartOfAccounts } from '../../api/journal';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { formatDate } from '../../utils/date';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_COLOR = { Pending: 'gray', Deposited: 'blue', Cleared: 'green', Bounced: 'red' };
const NEXT_STATUS = { Pending: 'Deposited', Deposited: 'Cleared' };
const ALL_STATUSES = ['Pending', 'Deposited', 'Cleared', 'Bounced'];

// Only 'Cleared' actually posts a journal entry (accountingController.updateChequeStatus) - the
// other transitions just relabel the cheque. Confirmation messages say so explicitly, since that's
// the whole reason a confirm step was asked for here.
const STATUS_CONFIRM = {
  Deposited: { title: 'Mark cheque as Deposited?', message: 'Confirms this cheque has been taken to the bank. No journal entry is posted yet - that only happens once it clears.', color: 'blue' },
  Cleared: { title: 'Mark cheque as Cleared?', message: 'This posts a journal entry moving the cheque amount between accounts and cannot be edited afterward.', color: 'green' },
  Bounced: { title: 'Mark cheque as Bounced?', message: 'This is final for this cheque - no journal entry is posted. You will need to record a replacement cheque separately.', color: 'red' },
  Pending: { title: 'Reset cheque to Pending?', message: 'Moves the cheque back to not-yet-actioned. No journal entry is posted.', color: 'gray' },
};

export default function ChequesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user.role === 'admin';
  const canView = user.modules?.includes('accounting.cheques');
  const canEdit = user.editModules?.includes('accounting.cheques');

  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [month, setMonth] = useState('');

  const list = usePagedList(['accounting', 'cheques'], fetchCheques, { filters: { month: month || undefined } });
  const accountsQuery = useQuery({ queryKey: ['accounting', 'accounts'], queryFn: fetchAccounts });
  const accounts = accountsQuery.data?.data || [];
  const coaQuery = useQuery({
    queryKey: ['accounting', 'coa', { postable: true }],
    queryFn: () => fetchChartOfAccounts({ postable: true }),
    enabled: canEdit,
  });
  const coaAccounts = coaQuery.data?.data || [];

  const form = useForm({
    initialValues: {
      no: '', date: new Date().toISOString().slice(0, 10), dueDate: '', direction: 'Received',
      party: '', amount: '', account: '', note: '', contraAccount: '',
    },
  });

  const editForm = useForm({
    initialValues: {
      no: '', date: '', dueDate: '', direction: 'Received',
      party: '', amount: '', account: '', note: '', contraAccount: '',
    },
  });

  const openEdit = (row) => {
    editForm.setValues({
      no: row.no,
      date: row.date,
      dueDate: row.dueDate,
      direction: row.direction,
      party: row.party,
      amount: row.amount,
      account: row.account?._id || '',
      note: row.note || '',
      contraAccount: row.contraAccount?._id || '',
    });
    setEditTarget(row);
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['accounting'] });
    list.refetch();
  };

  const handleCreate = async (values) => {
    try {
      const { contraAccount, ...rest } = values;
      const payload = contraAccount ? { ...rest, contraAccount } : rest;
      await createCheque(payload);
      notifications.show({ color: 'green', message: 'Cheque added' });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleEdit = async (values) => {
    try {
      const { contraAccount, ...rest } = values;
      const payload = contraAccount ? { ...rest, contraAccount } : rest;
      await updateCheque(editTarget._id, payload);
      notifications.show({ color: 'green', message: 'Cheque updated' });
      setEditTarget(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleStatus = async (id, status) => {
    const ok = await confirm(STATUS_CONFIRM[status]);
    if (!ok) return;
    try {
      await updateChequeStatus(id, status);
      notifications.show({ color: 'green', message: `Cheque marked ${status}` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = useMemo(
    () => [
      { accessorKey: 'no', header: 'No.' },
      { accessorKey: 'date', header: 'Date', cell: (info) => formatDate(info.getValue()) },
      { accessorKey: 'dueDate', header: 'Due Date', cell: (info) => formatDate(info.getValue()) },
      { accessorKey: 'direction', header: 'Direction', cell: (info) => <Tag>{info.getValue()}</Tag> },
      { accessorKey: 'party', header: 'Party' },
      { accessorKey: 'amount', header: 'Amount', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'account', header: 'Account', enableSorting: false, cell: (info) => info.getValue()?.name || '-' },
      {
        accessorKey: 'contraAccount',
        header: 'Contra Account',
        enableSorting: false,
        cell: (info) => {
          const c = info.getValue();
          return c ? `${c.code} ${c.name}` : '-';
        },
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: (info) => <Tag color={STATUS_COLOR[info.getValue()]}>{info.getValue()}</Tag>,
      },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => {
          const row = info.row.original;
          if (!canEdit) return null;
          const terminal = row.status === 'Cleared' || row.status === 'Bounced';
          const editIcon = terminal ? (
            <Tooltip label="Cannot edit a cleared or bounced cheque">
              <ActionIcon variant="filled" size="lg" radius="md" disabled aria-label="Edit disabled">
                <Pencil size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <Tooltip label="Edit this cheque">
              <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="Edit cheque">
                <Pencil size={16} />
              </ActionIcon>
            </Tooltip>
          );
          if (isAdmin) {
            return (
              <Group gap={4} wrap="nowrap">
                <Select
                  size="xs"
                  w={130}
                  data={ALL_STATUSES}
                  value={row.status}
                  onChange={(value) => value && handleStatus(row._id, value)}
                  allowDeselect={false}
                />
                {editIcon}
              </Group>
            );
          }
          if (terminal) return editIcon;
          return (
            <Group gap={4} wrap="nowrap">
              <Button size="compact-xs" variant="light" onClick={() => handleStatus(row._id, NEXT_STATUS[row.status])}>
                Mark {NEXT_STATUS[row.status]}
              </Button>
              <Button size="compact-xs" variant="subtle" color="red" leftSection={<X size={12} />} onClick={() => handleStatus(row._id, 'Bounced')}>
                Bounced
              </Button>
              {editIcon}
            </Group>
          );
        },
      },
    ],
    [canEdit, isAdmin]
  );

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Cheques</Title>
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
            <Title order={1} size="h3">Cheques</Title>
          </Group>
        }
        actions={
          <>
            {canEdit && <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>New Cheque</Button>}
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
          emptyLabel="No cheques recorded yet"
        />

        <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Cheque" size="md">
          <form onSubmit={form.onSubmit(handleCreate)}>
            <Stack gap="sm">
              <Group grow>
                <TextInput label="Cheque No." required {...form.getInputProps('no')} />
                <Select label="Direction" data={['Received', 'Issued']} required {...form.getInputProps('direction')} />
              </Group>
              <TextInput label="Party" placeholder="Customer / Vendor / Landlord" required {...form.getInputProps('party')} />
              <Group grow>
                <TextInput type="date" label="Date" description="When the cheque is dated / recorded" required {...form.getInputProps('date')} />
                <TextInput type="date" label="Due Date" description="When it can actually be deposited" required {...form.getInputProps('dueDate')} />
              </Group>
              <Group grow>
                <NumberInput label="Amount (AED)" min={0.01} required {...form.getInputProps('amount')} />
                <Select label="Account" data={accounts.map((a) => ({ value: a._id, label: a.name }))} required {...form.getInputProps('account')} />
              </Group>
              <Select
                label="Contra Account"
                description="Defaults to Accounts Receivable for Received / Accounts Payable for Issued if left blank"
                data={coaAccounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))}
                clearable
                {...form.getInputProps('contraAccount')}
              />
              <Textarea label="Note" rows={2} {...form.getInputProps('note')} />
              <Button type="submit" mt="sm">Save Cheque</Button>
            </Stack>
          </form>
        </Modal>

        <Modal opened={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Cheque" size="md">
          <form onSubmit={editForm.onSubmit(handleEdit)}>
            <Stack gap="sm">
              <Group grow>
                <TextInput label="Cheque No." required {...editForm.getInputProps('no')} />
                <Select label="Direction" data={['Received', 'Issued']} required {...editForm.getInputProps('direction')} />
              </Group>
              <TextInput label="Party" placeholder="Customer / Vendor / Landlord" required {...editForm.getInputProps('party')} />
              <Group grow>
                <TextInput type="date" label="Date" description="When the cheque is dated / recorded" required {...editForm.getInputProps('date')} />
                <TextInput type="date" label="Due Date" description="When it can actually be deposited" required {...editForm.getInputProps('dueDate')} />
              </Group>
              <Group grow>
                <NumberInput label="Amount (AED)" min={0.01} required {...editForm.getInputProps('amount')} />
                <Select label="Account" data={accounts.map((a) => ({ value: a._id, label: a.name }))} required {...editForm.getInputProps('account')} />
              </Group>
              <Select
                label="Contra Account"
                description="Defaults to Accounts Receivable for Received / Accounts Payable for Issued if left blank"
                data={coaAccounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))}
                clearable
                {...editForm.getInputProps('contraAccount')}
              />
              <Textarea label="Note" rows={2} {...editForm.getInputProps('note')} />
              <Button type="submit" mt="sm">Save Changes</Button>
            </Stack>
          </form>
        </Modal>
      </Stack>
    </Stack>
  );
}
