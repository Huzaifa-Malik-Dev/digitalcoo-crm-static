import { useState } from 'react';
import { Stack, Title, Text, Group, Button, Modal, Textarea, Select } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchLeaveApprovals, approveLeaveRequest, rejectLeaveRequest, revokeLeaveRequest } from '../../api/leave';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';
import LeaveSubNav from './LeaveSubNav';

const STATUS_COLOR = { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'gray', revoked: 'orange' };

// Confirm-step copy for each action, mirroring PipelineDealPanel.jsx's ACTION_INFO pattern - the
// user should never be surprised by what a click does.
const ACTION_INFO = {
  approve: { title: 'Approve this leave request?', color: 'green', confirmLabel: 'Yes, approve', needsReason: false },
  reject: { title: 'Reject this leave request?', color: 'red', confirmLabel: 'Yes, reject', needsReason: true },
  revoke: { title: 'Revoke this approved leave?', color: 'orange', confirmLabel: 'Yes, revoke', needsReason: true },
};

export default function LeaveApprovalsPage() {
  const { user } = useAuth();
  const canApprove = user.editModules?.includes('leave.approve');
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [action, setAction] = useState(null); // { type: 'approve'|'reject'|'revoke', request }
  const reasonForm = useForm({ initialValues: { reason: '' } });

  const list = usePagedList(['leave', 'approvals', status], fetchLeaveApprovals, { filters: { status } });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['leave'] });
    list.refetch();
  };

  const handleConfirm = async (values) => {
    try {
      if (action.type === 'approve') {
        await approveLeaveRequest(action.request._id);
        notifications.show({ color: 'green', message: 'Leave request approved' });
      } else if (action.type === 'reject') {
        await rejectLeaveRequest(action.request._id, values.reason);
        notifications.show({ color: 'green', message: 'Leave request rejected' });
      } else if (action.type === 'revoke') {
        await revokeLeaveRequest(action.request._id, values.reason);
        notifications.show({ color: 'green', message: 'Approved leave revoked' });
      }
      setAction(null);
      reasonForm.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not complete action', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = [
    { accessorKey: 'employee', header: 'Employee', cell: (info) => info.getValue()?.name || '-', enableSorting: false },
    { accessorKey: 'leaveType', header: 'Type', cell: (info) => info.getValue()?.name || '-' },
    { accessorKey: 'startDate', header: 'From', cell: (info) => formatDate(info.getValue()) },
    { accessorKey: 'endDate', header: 'To', cell: (info) => formatDate(info.getValue()) },
    { accessorKey: 'days', header: 'Days' },
    { accessorKey: 'reason', header: 'Reason', truncate: true },
    { accessorKey: 'status', header: 'Status', cell: (info) => <Tag color={STATUS_COLOR[info.getValue()]}>{info.getValue()}</Tag> },
    {
      id: 'response',
      header: 'Approver Note',
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
        if (!canApprove) return null;
        if (row.status === 'pending') {
          return (
            <Group gap={4}>
              <Button size="compact-xs" color="green" onClick={() => setAction({ type: 'approve', request: row })}>Approve</Button>
              <Button size="compact-xs" variant="light" color="red" onClick={() => setAction({ type: 'reject', request: row })}>Reject</Button>
            </Group>
          );
        }
        if (row.status === 'approved') {
          return <Button size="compact-xs" variant="subtle" color="orange" onClick={() => setAction({ type: 'revoke', request: row })}>Revoke</Button>;
        }
        return null;
      },
    },
  ];

  if (!user.modules?.includes('leave')) {
    return (
      <Stack>
        <Title order={1} size="h3">Leave Approvals</Title>
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      </Stack>
    );
  }

  const info = action ? ACTION_INFO[action.type] : null;

  return (
    <Stack gap="md">
      <LeaveSubNav />
      <PageToolbar
        title={<Title order={1} size="h3">Leave Approvals</Title>}
        actions={
          <Select
            data={['pending', 'approved', 'rejected', 'cancelled', 'revoked']}
            value={status}
            onChange={setStatus}
            w={160}
          />
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
        emptyLabel="No requests found"
      />

      <Modal opened={!!action} onClose={() => setAction(null)} title={info?.title} size="md">
        <form onSubmit={reasonForm.onSubmit(handleConfirm)}>
          <Stack gap="sm">
            {action?.request && (
              <Text size="sm" c="dimmed">
                {action.request.employee?.name} — {action.request.leaveType?.name} — {formatDate(action.request.startDate)} to {formatDate(action.request.endDate)} ({action.request.days} day(s))
              </Text>
            )}
            {info?.needsReason && <Textarea label="Reason" required {...reasonForm.getInputProps('reason')} />}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setAction(null)}>Cancel</Button>
              <Button color={info?.color} type="submit">{info?.confirmLabel}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
