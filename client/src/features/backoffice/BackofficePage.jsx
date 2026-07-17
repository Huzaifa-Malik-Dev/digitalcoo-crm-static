import { useMemo, useState } from 'react';
import { Title, Group, Paper, Select, Modal, Stack, TextInput, Textarea, NumberInput, ActionIcon, SimpleGrid, Button, Tooltip, Indicator, Text, Alert, Divider } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { MessageCircle, Plus, Eye, Pencil, X, AlertTriangle, Undo2, Info, Ban } from 'lucide-react';
import DataTable from '../../components/DataTable';
import ImportExportBar from '../../components/ImportExportBar';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import LineItemsEditor, { toFormLineItems, toApiLineItems, emptyBlock } from '../../components/LineItemsEditor';
import { usePagedList } from '../../hooks/usePagedList';
import { useThreadUnreadCounts } from '../../hooks/useNotifications';
import { fetchOrderList, updateOrderStatus, updateOrderLinked, updateOrder, sendOrderBack, createDirectOrder, fetchAssignableEmployees, requestOrderCancellation, exportOrders, importOrders } from '../../api/orders';
import { fetchProducts } from '../../api/products';
import { fetchCategories } from '../../api/catalog';
import { markViewed } from '../../api/views';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useChat } from '../../context/ChatContext';
import { ORDER_STATUS, LINKED_STATUS, ORDER_DONE_STATUSES, ETISALAT_STATUS } from '../../constants/orders';

const STATUS_COLOR = {
  New: 'gray',
  'E& In-process': 'blue',
  'On Hold': 'yellow',
  Activated: 'green',
  Closed: 'teal',
  Cancelled: 'red',
};

const LINKED_COLOR = { Linked: 'green', 'Not Linked': 'orange' };

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

// Whether the pending correction request came from the deal's agent or its Team Leader - the
// locked-order message names the actual role waiting on it, not just a name, since that's what
// tells Back Office who they're waiting to hear back from.
function correctionWaitingOn(row) {
  const requesterId = row?.correctionRequestedBy?._id;
  if (!row?.correctionRequested || !requesterId) return null;
  if (String(requesterId) === String(row.agentId?._id)) return 'agent';
  if (String(requesterId) === String(row.tlId?._id)) return 'tl';
  return null;
}

export default function BackofficePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const openChat = useChat();
  const isAdmin = user.role === 'admin';
  const canEdit = user.editModules?.includes('backoffice');
  const canChangeStatus = user.editModules?.includes('backoffice.statusChange');
  const [statusFilter, setStatusFilter] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelRow, setCancelRow] = useState(null);
  // Independent from/to ranges for the two dates an order carries - exported separately because
  // "everything submitted in June" and "everything activated in June" are different questions.
  const [exportRange, setExportRange] = useState({ subDateFrom: '', subDateTo: '', actDateFrom: '', actDateTo: '' });
  const canAddDirect = user.role === 'admin' || user.role === 'backoffice';
  // A pending correction or cancellation request means someone else is mid-decision on this order -
  // Back Office editing its fields in the meantime would just create two conflicting versions of
  // the same change. Locked for everyone, including admin: sending it back to Pipeline (correction)
  // or the Sales Head deciding (cancellation) is the only sanctioned way forward, not a direct edit.
  const correctionLocked = !!editRow?.correctionRequested;
  const cancellationLocked = !!editRow?.cancellationRequested;
  const modalLocked = (editRow?.linked === 'Linked' && !isAdmin) || correctionLocked || cancellationLocked;

  const list = usePagedList(['orders'], fetchOrderList, { filters: { status: statusFilter || undefined } });

  const visibleDsrNos = useMemo(() => (list.data || []).map((r) => r.dsrNo), [list.data]);
  const { data: unreadData } = useThreadUnreadCounts(visibleDsrNos);
  const unreadCounts = unreadData?.data || {};

  const assignableQuery = useQuery({
    queryKey: ['orders', 'assignable-employees'],
    queryFn: fetchAssignableEmployees,
    enabled: createOpen && canAddDirect,
  });
  const assignableOptions = (assignableQuery.data?.data || []).map((e) => ({ value: e._id, label: `${e.employeeId} - ${e.name}` }));

  const createForm = useForm({
    initialValues: {
      agentId: '', customer: '', contact: '', contactNo: '', email: '',
      lineItems: [emptyBlock()], contract: '12 Months', remarks: '',
    },
    validate: {
      agentId: (v) => (v ? null : 'Select who this order is for'),
      customer: (v) => (v.trim() ? null : 'Customer is required'),
    },
  });

  const editForm = useForm({
    initialValues: {
      subDate: '', contact: '', contactNo: '', email: '', pid: '', eOrderNo: '',
      lineItems: [emptyBlock()], contract: '12 Months', eAcctMgr: '', actDate: '', commission: '', remarks: '', etisalatStatus: '',
    },
  });

  const cancelForm = useForm({
    initialValues: { reason: '' },
    validate: { reason: (v) => (v?.trim() ? null : 'A reason is required to request cancellation') },
  });

  const productsQuery = useQuery({ queryKey: ['products', 'options'], queryFn: () => fetchProducts({ limit: 200, active: true }) });
  const products = productsQuery.data?.data || [];
  const categoriesQuery = useQuery({ queryKey: ['catalog', 'categories', 'active'], queryFn: () => fetchCategories({ active: true }) });
  const categories = categoriesQuery.data?.data || [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    list.refetch();
  };

  const handleStatusChange = async (row, status) => {
    const message =
      status === 'Cancelled' && row.linked === 'Linked'
        ? `Cancel order ${row.dsrNo} (${row.customer})? It is Linked — this does not currently reverse any accounting entries.`
        : `Set order ${row.dsrNo} (${row.customer}) status from "${row.status}" to "${status}"? The agent and Team Leader will be notified.`;
    const ok = await confirm({
      title: 'Change order status?',
      message,
      confirmLabel: `Yes, set to "${status}"`,
      color: status === 'Cancelled' ? 'red' : 'blue',
    });
    if (!ok) return;
    try {
      await updateOrderStatus(row._id, { status });
      notifications.show({ color: 'green', message: `${row.dsrNo} status changed to "${status}"` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  // Linked is the post-completion reconciliation check against Etisalat's own records, only
  // settable once the order is Activated/Closed. Marking it Linked closes the order for good:
  // no further edits or status changes for anyone but an admin, except cancelling it.
  const handleLinkedChange = async (row, linked) => {
    const ok = await confirm({
      title: linked === 'Linked' ? 'Mark this order as Linked?' : 'Mark this order as Not Linked?',
      message:
        linked === 'Linked'
          ? `Order ${row.dsrNo} (${row.customer}) will be closed — no further edits or status changes will be possible except cancelling it.`
          : `Order ${row.dsrNo} (${row.customer}) will be flagged as not yet matching Etisalat's records. It stays editable.`,
      confirmLabel: `Yes, mark "${linked}"`,
      color: linked === 'Linked' ? 'green' : 'orange',
    });
    if (!ok) return;
    try {
      await updateOrderLinked(row._id, linked);
      notifications.show({ color: 'green', message: `${row.dsrNo} marked "${linked}"` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  // Cancelling an order needs the Sales Head's sign-off and a mandatory reason - the order freezes
  // until they decide. Surfaced here mainly for direct orders (which have no Pipeline deal, so the
  // agent/TL can't raise it from the deal panel), but works on any order.
  const handleRequestCancellation = async (values) => {
    try {
      await requestOrderCancellation(cancelRow._id, values.reason);
      notifications.show({ color: 'green', message: 'Cancellation requested — the Sales Head has been notified' });
      setCancelRow(null);
      cancelForm.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not request cancellation', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleSendBack = async (row) => {
    const ok = await confirm({
      title: 'Send order back to Pipeline?',
      message: `Order ${row.dsrNo} (${row.customer}) was flagged by ${row.correctionRequestedBy?.name || 'someone'}${row.correctionNote ? ` — "${row.correctionNote}"` : ''}. This reopens the deal so they can edit it again; the order itself stays as-is, just marked.`,
      confirmLabel: 'Yes, send back',
      color: 'orange',
    });
    if (!ok) return;
    try {
      await sendOrderBack(row._id);
      notifications.show({ color: 'green', message: `${row.dsrNo} sent back to Pipeline for correction` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not send back', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const openEdit = (row) => {
    markViewed(queryClient, ['orders'], 'orders', row._id);
    setEditRow(row);
    editForm.setValues({
      subDate: row.subDate || '', contact: row.contact || '', contactNo: row.contactNo || '', email: row.email || '', pid: row.pid || '',
      eOrderNo: row.eOrderNo || '', lineItems: toFormLineItems(row.lineItems),
      contract: row.contract || '12 Months', eAcctMgr: row.eAcctMgr || '',
      actDate: row.actDate || '', commission: row.commission || '', remarks: row.remarks || '', etisalatStatus: row.etisalatStatus || '',
    });
  };

  const handleCreateDirect = async (values) => {
    try {
      const res = await createDirectOrder({ ...values, lineItems: toApiLineItems(values.lineItems) });
      notifications.show({ color: 'green', message: `Order ${res.data.orderNo} added` });
      setCreateOpen(false);
      createForm.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not add order', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleEdit = async (values) => {
    try {
      const payload = {
        ...values,
        lineItems: toApiLineItems(values.lineItems),
        commission: values.commission === '' ? 0 : values.commission,
      };
      await updateOrder(editRow._id, payload);
      notifications.show({ color: 'green', message: 'Order updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = useMemo(
    () => [
      {
        accessorKey: 'dsrNo',
        header: 'DSR No.',
        cell: (info) => {
          const row = info.row.original;
          return (
            <Group gap={6} wrap="nowrap">
              {row.correctionRequested && (
                <Tooltip
                  label={(() => {
                    const waitingOn = correctionWaitingOn(row);
                    const requester = row.correctionRequestedBy?.name || 'someone';
                    const who = waitingOn === 'agent' ? `the agent (${requester})` : waitingOn === 'tl' ? `the Team Leader (${requester})` : requester;
                    return `Correction requested by ${who} on ${row.correctionRequestedAt ? new Date(row.correctionRequestedAt).toLocaleString() : '-'}${row.correctionNote ? ` — "${row.correctionNote}"` : ''}`;
                  })()}
                  multiline
                  w={280}
                >
                  <AlertTriangle size={16} color="var(--mantine-color-red-6)" />
                </Tooltip>
              )}
              {row.direct ? <Tag size="xs" color="grape">Direct</Tag> : <Text size="sm">{row.dsrNo || '-'}</Text>}
            </Group>
          );
        },
      },
      {
        accessorKey: 'orderNo',
        header: 'Order No.',
        cell: (info) => {
          const row = info.row.original;
          return (
            <Group gap={6} wrap="nowrap">
              <Text size="sm">{row.orderNo || '-'}</Text>
              {row.correctionCount > 0 && (
                <Tooltip label={`Sent back to Pipeline for correction ${row.correctionCount} time(s)`}>
                  <Text size="xs" c="dimmed">↩ {row.correctionCount}x</Text>
                </Tooltip>
              )}
            </Group>
          );
        },
      },
      { accessorKey: 'customer', header: 'Customer' },
      {
        // An order can bundle several line items now - show the first, and how many more there
        // are, rather than a wall of text. The full breakdown is one click away in the edit modal.
        id: 'product',
        header: 'Product',
        enableSorting: false,
        cell: (info) => {
          const blocks = info.row.original.lineItems || [];
          if (!blocks.length) return <Text size="sm" c="dimmed">-</Text>;
          const [first, ...rest] = blocks;
          return (
            <div>
              <Text size="sm">{first.product || '-'}</Text>
              <Text size="xs" c="dimmed">
                {first.cat || '-'}
                {rest.length ? ` +${rest.length} more` : ''}
              </Text>
            </div>
          );
        },
      },
      {
        id: 'qty',
        header: 'Qty',
        enableSorting: false,
        cell: (info) =>
          (info.row.original.lineItems || []).reduce((sum, b) => sum + (b.rows || []).reduce((s, r) => s + (Number(r.qty) || 0), 0), 0),
      },
      { accessorKey: 'mrc', header: 'MRC', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'submissionMonth', header: 'Sub. Month', enableSorting: false, cell: (info) => info.getValue() || <Text size="sm" c="dimmed">-</Text> },
      { accessorKey: 'activationMonth', header: 'Act. Month', enableSorting: false, cell: (info) => info.getValue() || <Text size="sm" c="dimmed">-</Text> },
      { accessorKey: 'agentId', header: 'Agent', enableSorting: false, cell: (info) => info.getValue()?.name || '-' },
      { accessorKey: 'eOrderNo', header: 'e& Order No.' },
      {
        accessorKey: 'etisalatStatus',
        header: 'Etisalat Status',
        cell: (info) => (info.getValue() ? <Tag color="cyan">{info.getValue()}</Tag> : <Text size="sm" c="dimmed">-</Text>),
      },
      {
        accessorKey: 'status',
        header: () => (
          <Group gap={4} wrap="nowrap">
            <span>Status</span>
            <Tooltip
              label="Our internal fulfillment status — separate from Etisalat Status (e&'s own) and from Linked (the post-completion reconciliation check)."
              multiline
              w={280}
            >
              <Info size={13} style={{ opacity: 0.6, cursor: 'help' }} />
            </Tooltip>
          </Group>
        ),
        cell: (info) => {
          const row = info.row.original;
          if (!canChangeStatus) return <Tag color={STATUS_COLOR[row.status] || 'gray'}>{row.status}</Tag>;
          // These inline Selects are separate controls from the edit modal, so they need their own
          // guards rather than inheriting modalLocked (which only applies once the modal is open).
          // Labelled "Correction Pending"/"Cancellation Pending" rather than "On Hold" - On Hold is
          // a real, selectable status of its own (and an Etisalat status), so reusing it here for a
          // lock state would read as though the order had actually been moved to that status.
          if (row.correctionRequested) {
            const waitingOn = correctionWaitingOn(row);
            const requester = row.correctionRequestedBy?.name || 'someone';
            const who = waitingOn === 'agent' ? `the agent (${requester})` : waitingOn === 'tl' ? `the Team Leader (${requester})` : requester;
            return (
              <Tooltip label={`Still "${row.status}" — waiting on ${who} to fix the deal before this order can move again`} multiline w={260}>
                <Tag color="orange">Correction Pending</Tag>
              </Tooltip>
            );
          }
          if (row.cancellationRequested) {
            const requester = row.cancellationRequestedBy?.name || 'someone';
            return (
              <Tooltip
                label={`Still "${row.status}" — ${requester} asked to cancel this order${row.cancellationReason ? ` ("${row.cancellationReason}")` : ''}. Frozen until the Sales Head approves or rejects it.`}
                multiline
                w={280}
              >
                <Tag color="red">Cancellation Pending</Tag>
              </Tooltip>
            );
          }
          const locked = row.linked === 'Linked' && !isAdmin;
          if (locked) {
            return (
              <Group gap={4} wrap="nowrap">
                <Tag color={STATUS_COLOR[row.status]}>{row.status}</Tag>
                <Tooltip label="Cancel this order">
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    size="sm"
                    onClick={() => handleStatusChange(row, 'Cancelled')}
                    aria-label="Cancel order"
                  >
                    <X size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            );
          }
          return (
            <Select
              data={ORDER_STATUS}
              value={row.status}
              onChange={(v) => v && handleStatusChange(row, v)}
              size="xs"
              w={160}
              aria-label={`Change status for order ${row.eOrderNo || row._id}`}
            />
          );
        },
      },
      {
        accessorKey: 'linked',
        header: () => (
          <Group gap={4} wrap="nowrap">
            <span>Linked</span>
            <Tooltip
              label="Whether this order matches Etisalat's own records. Only settable once the order is Activated or Closed. Marking it Linked closes the order — no further edits or status changes except cancelling it."
              multiline
              w={280}
            >
              <Info size={13} style={{ opacity: 0.6, cursor: 'help' }} />
            </Tooltip>
          </Group>
        ),
        cell: (info) => {
          const row = info.row.original;
          if (!canChangeStatus || row.correctionRequested || row.cancellationRequested) {
            return row.linked ? <Tag color={LINKED_COLOR[row.linked]}>{row.linked}</Tag> : <Text size="sm" c="dimmed">-</Text>;
          }
          if (row.linked === 'Linked' && !isAdmin) return <Tag color={LINKED_COLOR.Linked}>Linked</Tag>;
          // "Post-completion" is the literal rule - the server rejects marking anything else Linked.
          if (!ORDER_DONE_STATUSES.includes(row.status)) {
            return (
              <Tooltip label={`Available once the order is ${ORDER_DONE_STATUSES.join(' or ')}`}>
                <Text size="sm" c="dimmed">-</Text>
              </Tooltip>
            );
          }
          return (
            <Select
              data={LINKED_STATUS}
              value={row.linked || null}
              placeholder="Not set"
              onChange={(v) => v && handleLinkedChange(row, v)}
              size="xs"
              w={130}
              aria-label={`Set Linked status for order ${row.orderNo || row._id}`}
            />
          );
        },
      },
      { accessorKey: 'commission', header: 'Commission', cell: (info) => AED(info.getValue()) },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => {
          const row = info.row.original;
          return (
            <Group gap="xs" wrap="nowrap">
              <Tooltip label="View this order">
                <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); openEdit(row); }} aria-label="View order">
                  <Eye size={18} />
                </ActionIcon>
              </Tooltip>
              {canChangeStatus && (
                row.linked === 'Linked' && !isAdmin ? (
                  <Tooltip label="Linked orders are closed — cancel it if a correction is needed">
                    <ActionIcon variant="filled" size="lg" radius="md" disabled aria-label="Edit disabled">
                      <Pencil size={18} />
                    </ActionIcon>
                  </Tooltip>
                ) : (
                  <Tooltip label="Edit this order">
                    <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); openEdit(row); }} aria-label="Edit order">
                      <Pencil size={18} />
                    </ActionIcon>
                  </Tooltip>
                )
              )}
              {canChangeStatus && row.correctionRequested && (
                <Tooltip label="Send this deal back to Pipeline so it can be corrected">
                  <ActionIcon color="orange" variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); handleSendBack(row); }} aria-label="Send back to Pipeline">
                    <Undo2 size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              {/* A direct order has no Pipeline deal, so its agent/TL can't raise a cancellation
                  from the deal panel - this is their only route to the Sales Head sign-off. */}
              {canEdit && row.direct && !row.cancellationRequested && !row.correctionRequested && row.status !== 'Cancelled' && (
                <Tooltip label="Request cancellation (needs Sales Head approval)">
                  <ActionIcon color="red" variant="light" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); setCancelRow(row); }} aria-label="Request cancellation">
                    <Ban size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Chat about this order (tag teammates, see full history)">
                <Indicator
                  label={unreadCounts[row.dsrNo] > 9 ? '9+' : unreadCounts[row.dsrNo]}
                  disabled={!unreadCounts[row.dsrNo]}
                  size={16}
                  color="red"
                  offset={4}
                >
                  <ActionIcon
                    variant="filled"
                    size="lg"
                    radius="md"
                    onClick={(e) => { e.stopPropagation(); openChat(row.dsrNo); }}
                    aria-label="Chat"
                  >
                    <MessageCircle size={18} />
                  </ActionIcon>
                </Indicator>
              </Tooltip>
            </Group>
          );
        },
      },
    ],
    [canEdit, canChangeStatus, isAdmin, unreadCounts]
  );

  return (
    <Stack>
      <PageToolbar
        title={<Title order={1} size="h3">Back Office / Orders</Title>}
        actions={
          <Group gap="sm">
            <Select placeholder="All statuses" data={ORDER_STATUS} value={statusFilter} onChange={setStatusFilter} clearable w={200} />
            <ImportExportBar
              moduleKey="backoffice"
              filenamePrefix="orders"
              exportFn={exportOrders}
              importFn={importOrders}
              // Blank dates are dropped rather than sent as '' — the server validates the format
              // strictly and would reject an empty string as malformed.
              exportParams={{
                status: statusFilter || undefined,
                subDateFrom: exportRange.subDateFrom || undefined,
                subDateTo: exportRange.subDateTo || undefined,
                actDateFrom: exportRange.actDateFrom || undefined,
                actDateTo: exportRange.actDateTo || undefined,
              }}
              onImported={refresh}
            />
            {canAddDirect && (
              <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
                Add Order
              </Button>
            )}
          </Group>
        }
      />

      {/* Export-only date ranges — "everything submitted in June" and "everything activated in
          June" are different questions, so the two dates filter independently and can combine. */}
      <Paper withBorder p="sm" radius="md">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <Text size="xs" c="dimmed" w="100%">Export date range (optional — leave blank to export everything)</Text>
          <TextInput
            type="date"
            label="Submitted from"
            size="xs"
            value={exportRange.subDateFrom}
            onChange={(e) => setExportRange((r) => ({ ...r, subDateFrom: e.currentTarget.value }))}
          />
          <TextInput
            type="date"
            label="Submitted to"
            size="xs"
            value={exportRange.subDateTo}
            onChange={(e) => setExportRange((r) => ({ ...r, subDateTo: e.currentTarget.value }))}
          />
          <Divider orientation="vertical" />
          <TextInput
            type="date"
            label="Activated from"
            size="xs"
            value={exportRange.actDateFrom}
            onChange={(e) => setExportRange((r) => ({ ...r, actDateFrom: e.currentTarget.value }))}
          />
          <TextInput
            type="date"
            label="Activated to"
            size="xs"
            value={exportRange.actDateTo}
            onChange={(e) => setExportRange((r) => ({ ...r, actDateTo: e.currentTarget.value }))}
          />
          {(exportRange.subDateFrom || exportRange.subDateTo || exportRange.actDateFrom || exportRange.actDateTo) && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => setExportRange({ subDateFrom: '', subDateTo: '', actDateFrom: '', actDateTo: '' })}
            >
              Clear
            </Button>
          )}
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
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
          emptyLabel="No orders yet — approve a pipeline deal to open one"
        />
      </Paper>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Order — ${editRow?.dsrNo || ''}`} size="lg">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            {editRow?.linked === 'Linked' && !isAdmin && (
              <Alert color="gray" variant="light">
                This order is Linked and closed — it can no longer be edited. Cancel it if a correction is needed.
              </Alert>
            )}
            {correctionLocked && (
              <Alert color="orange" variant="light" icon={<AlertTriangle size={16} />}>
                {(() => {
                  const waitingOn = correctionWaitingOn(editRow);
                  const requester = editRow?.correctionRequestedBy?.name || 'someone';
                  const who = waitingOn === 'agent' ? `the agent (${requester})` : waitingOn === 'tl' ? `the Team Leader (${requester})` : requester;
                  return `Correction pending, waiting on ${who} — this order can't be edited until it's sent back to Pipeline for correction.`;
                })()}
              </Alert>
            )}
            {cancellationLocked && (
              <Alert color="red" variant="light" icon={<Ban size={16} />}>
                {editRow?.cancellationRequestedBy?.name || 'Someone'} asked to cancel this order
                {editRow?.cancellationReason ? ` — "${editRow.cancellationReason}"` : ''}. It's frozen until the Sales Head approves or rejects the request.
              </Alert>
            )}
            <SimpleGrid cols={2}>
              <TextInput type="date" label="Submission Date" disabled={!canEdit || modalLocked} {...editForm.getInputProps('subDate')} />
              <TextInput type="date" label="Activation Date" disabled={!canEdit || modalLocked} {...editForm.getInputProps('actDate')} />
              <TextInput label="Submission Month" value={editRow?.submissionMonth || '-'} readOnly disabled description="Derived from Submission Date" />
              <TextInput label="Activation Month" value={editRow?.activationMonth || '-'} readOnly disabled description="Derived from Activation Date" />
              <TextInput label="Contact Person" disabled={!canEdit || modalLocked} {...editForm.getInputProps('contact')} />
              <TextInput label="Contact No." disabled={!canEdit || modalLocked} {...editForm.getInputProps('contactNo')} />
              <TextInput label="Email" disabled={!canEdit || modalLocked} {...editForm.getInputProps('email')} />
              <TextInput label="PID" disabled={!canEdit || modalLocked} {...editForm.getInputProps('pid')} />
              <TextInput label="Order No. (System)" value={editRow?.orderNo || '-'} readOnly disabled description="Auto-assigned, not editable" />
              <TextInput
                label="e& Order No."
                description="Etisalat's own order reference, once they assign one"
                disabled={!canEdit || modalLocked}
                {...editForm.getInputProps('eOrderNo')}
              />
              <Select
                label="Etisalat Status"
                description="Etisalat's own processing status — separate from the Status column in the list"
                data={ETISALAT_STATUS}
                clearable
                disabled={!canEdit || modalLocked}
                {...editForm.getInputProps('etisalatStatus')}
              />
              <TextInput label="Contract" disabled={!canEdit || modalLocked} {...editForm.getInputProps('contract')} />
              <TextInput label="e& Account Manager" disabled={!canEdit || modalLocked} {...editForm.getInputProps('eAcctMgr')} />
              <NumberInput label="Commission (AED)" min={0} disabled={!canEdit || modalLocked} {...editForm.getInputProps('commission')} />
            </SimpleGrid>
            <Divider label="Line Items" labelPosition="left" mt="xs" />
            <LineItemsEditor
              form={editForm}
              products={products}
              categories={categories}
              savedLineItems={editRow?.lineItems}
              disabled={!canEdit || modalLocked}
            />
            <Textarea label="Remarks" disabled={!canEdit || modalLocked} {...editForm.getInputProps('remarks')} />
            {canEdit && !modalLocked && <Button type="submit" mt="sm">Save changes</Button>}
          </Stack>
        </form>
      </Modal>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Order Directly" size="lg">
        <Text size="xs" c="dimmed" mb="sm">
          Skips DSR and Sales Pipeline entirely — for a deal agreed outside the normal flow. Marked "Direct" in the orders list.
        </Text>
        <form onSubmit={createForm.onSubmit(handleCreateDirect)}>
          <Stack gap="sm">
            <Select
              label="Agent / TL"
              placeholder="Select employee"
              data={assignableOptions}
              searchable
              required
              {...createForm.getInputProps('agentId')}
            />
            <SimpleGrid cols={2}>
              <TextInput label="Customer" required {...createForm.getInputProps('customer')} />
              <TextInput label="Contact Person" {...createForm.getInputProps('contact')} />
              <TextInput label="Contact No." {...createForm.getInputProps('contactNo')} />
              <TextInput label="Email" {...createForm.getInputProps('email')} />
              <TextInput label="Contract" {...createForm.getInputProps('contract')} />
            </SimpleGrid>
            <Divider label="Line Items" labelPosition="left" mt="xs" />
            <LineItemsEditor form={createForm} products={products} categories={categories} />
            <Textarea label="Remarks" {...createForm.getInputProps('remarks')} />
            <Button type="submit" mt="sm">Add Order</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!cancelRow} onClose={() => { setCancelRow(null); cancelForm.reset(); }} title="Request order cancellation" size="md">
        <form onSubmit={cancelForm.onSubmit(handleRequestCancellation)}>
          <Stack gap="sm">
            <Text size="sm">
              This asks the Sales Head to cancel order <b>{cancelRow?.orderNo || cancelRow?.dsrNo}</b> ({cancelRow?.customer}).
              The order freezes — no edits or status changes — until they approve or reject the request.
            </Text>
            <Textarea label="Why should this order be cancelled?" withAsterisk {...cancelForm.getInputProps('reason')} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => { setCancelRow(null); cancelForm.reset(); }}>Cancel</Button>
              <Button type="submit" color="red">Yes, request cancellation</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
