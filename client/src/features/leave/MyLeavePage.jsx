import { useState } from 'react';
import { Stack, Title, SimpleGrid, Paper, Text, Group, Button, Modal, Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { notifications } from '../../utils/toast';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchLeaveBalance, fetchLeaveTypes, fetchMyLeaveRequests, createLeaveRequest, cancelLeaveRequest } from '../../api/leave';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';
import LeaveSubNav from './LeaveSubNav';

const STATUS_COLOR = { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'gray', revoked: 'orange' };

export default function MyLeavePage() {
  const { user } = useAuth();
  const canView = user.modules?.includes('leave');
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const balanceQuery = useQuery({ queryKey: ['leave', 'balance', user._id], queryFn: () => fetchLeaveBalance({}), enabled: canView });
  const typesQuery = useQuery({ queryKey: ['leave', 'types', { active: true }], queryFn: () => fetchLeaveTypes({ active: true }), enabled: canView });
  const list = usePagedList(['leave', 'requests', user._id], fetchMyLeaveRequests);

  const balances = balanceQuery.data?.data || [];
  const types = typesQuery.data?.data || [];

  const form = useForm({
    initialValues: { leaveTypeId: '', startDate: '', endDate: '', reason: '', document: '' },
    validate: {
      leaveTypeId: (v) => (!v ? 'Select a leave type' : null),
      startDate: (v) => (!v ? 'Start date is required' : null),
      endDate: (v) => (!v ? 'End date is required' : null),
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['leave'] });
    list.refetch();
  };

  const handleCreate = async (values) => {
    try {
      await createLeaveRequest(values);
      notifications.show({ color: 'green', message: 'Leave request submitted' });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not submit', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleCancel = async (id) => {
    try {
      await cancelLeaveRequest(id);
      notifications.show({ color: 'green', message: 'Request cancelled' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not cancel', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const selectedType = types.find((t) => t._id === form.values.leaveTypeId);

  const columns = [
    { accessorKey: 'leaveType', header: 'Type', cell: (info) => info.getValue()?.name || '-' },
    { accessorKey: 'startDate', header: 'From', cell: (info) => formatDate(info.getValue()) },
    { accessorKey: 'endDate', header: 'To', cell: (info) => formatDate(info.getValue()) },
    { accessorKey: 'days', header: 'Days' },
    { accessorKey: 'status', header: 'Status', cell: (info) => <Tag color={STATUS_COLOR[info.getValue()]}>{info.getValue()}</Tag> },
    { accessorKey: 'reason', header: 'Reason', truncate: true },
    {
      id: 'response',
      header: 'Approver Note',
      // Rejected/revoked requests carry a reason the approver typed - otherwise it's captured
      // server-side (LeaveRequest.rejectionReason/revokeReason) but never shown anywhere, so the
      // employee has no way to find out why. Shown as plain text, not behind a hover/click -
      // nothing about "why was my leave rejected" should require discovering an interaction.
      cell: (info) => {
        const row = info.row.original;
        const reason = row.status === 'rejected' ? row.rejectionReason : row.status === 'revoked' ? row.revokeReason : null;
        return reason ? <Text size="sm" c="dimmed">{reason}</Text> : null;
      },
      enableSorting: false,
    },
    {
      id: 'action',
      header: 'Actions',
      cell: (info) => {
        const row = info.row.original;
        if (row.status === 'pending') {
          return <Button size="compact-xs" variant="subtle" color="red" onClick={() => handleCancel(row._id)}>Cancel</Button>;
        }
        return null;
      },
    },
  ];

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">My Leave</Title>
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <LeaveSubNav />
      <PageToolbar
        title={<Title order={1} size="h3">My Leave</Title>}
        actions={<Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Request Leave</Button>}
      />

      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
        {balances.map((b) => (
          <Paper key={b.leaveType._id} withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">{b.leaveType.name}</Text>
            <Text size="xl" fw={700}>{b.remaining} <Text span size="sm" c="dimmed">/ {b.entitled} days left</Text></Text>
            <Text size="xs" c="dimmed">{b.used} used{b.pending ? `, ${b.pending} pending` : ''}</Text>
          </Paper>
        ))}
      </SimpleGrid>

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
        emptyLabel="No leave requests yet"
      />

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Request Leave" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <Select
              label="Leave Type"
              data={types.map((t) => ({ value: t._id, label: t.name }))}
              required
              {...form.getInputProps('leaveTypeId')}
            />
            <Group grow>
              <TextInput type="date" label="From" required {...form.getInputProps('startDate')} />
              <TextInput type="date" label="To" required {...form.getInputProps('endDate')} />
            </Group>
            <Textarea label="Reason" rows={2} {...form.getInputProps('reason')} />
            {selectedType?.requiresDocument && (
              <TextInput label="Document Reference" description="e.g. medical certificate reference — attach the physical copy with HR" {...form.getInputProps('document')} />
            )}
            <Button type="submit" mt="sm">Submit Request</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
