import { useMemo, useState } from 'react';
import { Title, Group, Paper, Select, Modal, Stack, TextInput, Textarea, NumberInput, ActionIcon, SimpleGrid, Button, Tooltip, Indicator, Text, Alert } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { MessageCircle, Plus, Eye, Pencil, X, AlertTriangle, Undo2, Info } from 'lucide-react';
import DataTable from '../../components/DataTable';
import ImportExportBar from '../../components/ImportExportBar';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { useThreadUnreadCounts } from '../../hooks/useNotifications';
import { fetchOrderList, updateOrderStatus, updateOrder, sendOrderBack, createDirectOrder, fetchAssignableEmployees, exportOrders, importOrders } from '../../api/orders';
import { fetchProducts } from '../../api/products';
import { markViewed } from '../../api/views';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useChat } from '../../context/ChatContext';
import { SR_TYPES } from '../../constants/pipeline';

// 'In Line' = Etisalat has paid - the order closes and locks (see workflow.updateOrderStatus /
// orderController.update, server-side): no more edits or status changes except to 'Cancelled'.
// 'Not In Line' = payment is pending/doesn't match yet - a plain flag, no lock.
const ORDER_STATUS = ['New', 'E& In-process', 'On Hold', 'Activated', 'Closed', 'Cancelled', 'In Line', 'Not In Line'];
const ETISALAT_STATUS = ['Submitted', 'In Progress', 'Pending for delivery', 'Activated', 'Rejected', 'Closed'];

const STATUS_COLOR = {
  New: 'gray',
  'E& In-process': 'blue',
  'On Hold': 'yellow',
  Activated: 'green',
  Closed: 'teal',
  Cancelled: 'red',
  'In Line': 'green',
  'Not In Line': 'orange',
};

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
  const canAddDirect = user.role === 'admin' || user.role === 'backoffice';
  // A pending correction request means the agent/TL is about to rework this deal back in
  // Pipeline - Back Office editing the order's own fields in the meantime would just create two
  // conflicting versions of the same change. Locked for everyone, including admin: "send back to
  // Pipeline" (the list row action) is the only sanctioned way forward from here, not a direct edit.
  const correctionLocked = !!editRow?.correctionRequested;
  const modalLocked = (editRow?.status === 'In Line' && !isAdmin) || correctionLocked;

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
      agentId: '', customer: '', contact: '', contactNo: '', email: '', sr: 'NEW',
      cat: '', product: '', contract: '12 Months', qty: 1, price: '', remarks: '',
    },
    validate: {
      agentId: (v) => (v ? null : 'Select who this order is for'),
      customer: (v) => (v.trim() ? null : 'Customer is required'),
    },
  });

  const editForm = useForm({
    initialValues: {
      subDate: '', contact: '', contactNo: '', email: '', pid: '', eOrderNo: '', sr: 'NEW',
      cat: '', product: '', contract: '12 Months', qty: 1, price: '', eAcctMgr: '', actDate: '', commission: '', remarks: '', etisalatStatus: '',
    },
  });

  const productsQuery = useQuery({ queryKey: ['products', 'options'], queryFn: () => fetchProducts({ limit: 200, active: true }) });
  const products = productsQuery.data?.data || [];
  // Category is free text on the Order (same reasoning as Pipeline's cat) - an order saved under
  // an older/removed category must still render instead of going blank, so the current value is
  // always included alongside whatever's pickable live from the product catalog.
  const categories = [...new Set(products.map((p) => p.cat))];
  const createCategoryOptions = createForm.values.cat && !categories.includes(createForm.values.cat) ? [...categories, createForm.values.cat] : categories;
  const editCategoryOptions = editForm.values.cat && !categories.includes(editForm.values.cat) ? [...categories, editForm.values.cat] : categories;
  // Subscription Type is a closed set (SR_TYPES), but an order saved under the old free-text
  // scheme (e.g. 'MIG') must still render instead of going blank - same pattern as Pipeline.
  const srOptions = editForm.values.sr && !SR_TYPES.includes(editForm.values.sr) ? [...SR_TYPES, editForm.values.sr] : SR_TYPES;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] });
    list.refetch();
  };

  const handleStatusChange = async (row, status) => {
    const message =
      status === 'In Line'
        ? `Mark order ${row.dsrNo} (${row.customer}) as In Line? This closes the order — no further edits will be possible except cancelling it.`
        : status === 'Cancelled' && row.status === 'In Line'
        ? `Cancel order ${row.dsrNo} (${row.customer})? It was In Line — this does not currently reverse any accounting entries.`
        : `Set order ${row.dsrNo} (${row.customer}) status from "${row.status}" to "${status}"? The agent and Team Leader will be notified.`;
    const ok = await confirm({
      title: 'Change order status?',
      message,
      confirmLabel: `Yes, set to "${status}"`,
      color: status === 'In Line' ? 'green' : status === 'Cancelled' ? 'red' : 'blue',
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
      eOrderNo: row.eOrderNo || '', sr: row.sr || 'NEW', cat: row.cat || '', product: row.product || '',
      contract: row.contract || '12 Months', qty: row.qty || 1, price: row.price || '', eAcctMgr: row.eAcctMgr || '',
      actDate: row.actDate || '', commission: row.commission || '', remarks: row.remarks || '', etisalatStatus: row.etisalatStatus || '',
    });
  };

  const handleCreateDirect = async (values) => {
    try {
      const payload = { ...values, price: values.price === '' ? 0 : values.price };
      const res = await createDirectOrder(payload);
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
        price: values.price === '' ? 0 : values.price,
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
      { accessorKey: 'product', header: 'Product' },
      { accessorKey: 'qty', header: 'Qty' },
      { accessorKey: 'mrc', header: 'MRC', cell: (info) => AED(info.getValue()) },
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
              label="Our internal fulfillment status — separate from Etisalat Status. 'In Line' means Etisalat has paid: the order closes and locks (only Cancel remains). 'Not In Line' means payment is pending or doesn't match yet."
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
          // Same "wait for it to be sent back to Pipeline first" lock as the edit modal - this
          // inline Select is a separate control from that modal, so it needs its own guard rather
          // than inheriting modalLocked (which only applies once the modal is actually open).
          if (row.correctionRequested) {
            const waitingOn = correctionWaitingOn(row);
            const requester = row.correctionRequestedBy?.name || 'someone';
            const who = waitingOn === 'agent' ? `the agent (${requester})` : waitingOn === 'tl' ? `the Team Leader (${requester})` : requester;
            return (
              <Tooltip label={`Was "${row.status}" — waiting on ${who} to fix the deal before this order can move again`} multiline w={260}>
                <Tag color="orange">On Hold</Tag>
              </Tooltip>
            );
          }
          const locked = row.status === 'In Line' && !isAdmin;
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
                row.status === 'In Line' && !isAdmin ? (
                  <Tooltip label="In Line orders are closed — cancel it if a correction is needed">
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
            {editRow?.status === 'In Line' && !isAdmin && (
              <Alert color="gray" variant="light">
                This order is In Line and closed — it can no longer be edited. Cancel it if a correction is needed.
              </Alert>
            )}
            {correctionLocked && (
              <Alert color="orange" variant="light" icon={<AlertTriangle size={16} />}>
                {(() => {
                  const waitingOn = correctionWaitingOn(editRow);
                  const requester = editRow?.correctionRequestedBy?.name || 'someone';
                  const who = waitingOn === 'agent' ? `the agent (${requester})` : waitingOn === 'tl' ? `the Team Leader (${requester})` : requester;
                  return `On hold, waiting on ${who} — this order can't be edited until it's sent back to Pipeline for correction.`;
                })()}
              </Alert>
            )}
            <SimpleGrid cols={2}>
              <TextInput type="date" label="Submission Date" disabled={!canEdit || modalLocked} {...editForm.getInputProps('subDate')} />
              <TextInput type="date" label="Activation Date" disabled={!canEdit || modalLocked} {...editForm.getInputProps('actDate')} />
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
              <Select label="Subscription Type" data={srOptions} disabled={!canEdit || modalLocked} {...editForm.getInputProps('sr')} />
              <Select label="Category" data={editCategoryOptions} disabled={!canEdit || modalLocked} {...editForm.getInputProps('cat')} />
              <TextInput label="Product" disabled={!canEdit || modalLocked} {...editForm.getInputProps('product')} />
              <TextInput label="Contract" disabled={!canEdit || modalLocked} {...editForm.getInputProps('contract')} />
              <TextInput label="e& Account Manager" disabled={!canEdit || modalLocked} {...editForm.getInputProps('eAcctMgr')} />
              <NumberInput label="Quantity" min={1} disabled={!canEdit || modalLocked} {...editForm.getInputProps('qty')} />
              <NumberInput label="Price (AED)" min={0} disabled={!canEdit || modalLocked} {...editForm.getInputProps('price')} />
              <TextInput
                label="MRC (AED)"
                value={AED((Number(editForm.values.price) || 0) * (Number(editForm.values.qty) || 0))}
                readOnly
                disabled
                description="Price × Quantity, calculated automatically"
              />
              <NumberInput label="Commission (AED)" min={0} disabled={!canEdit || modalLocked} {...editForm.getInputProps('commission')} />
            </SimpleGrid>
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
              <Select label="Subscription Type" data={SR_TYPES} {...createForm.getInputProps('sr')} />
              <Select label="Category" data={createCategoryOptions} {...createForm.getInputProps('cat')} />
              <TextInput label="Product" {...createForm.getInputProps('product')} />
              <TextInput label="Contract" {...createForm.getInputProps('contract')} />
              <NumberInput label="Quantity" min={1} {...createForm.getInputProps('qty')} />
              <NumberInput label="Price (AED)" min={0} {...createForm.getInputProps('price')} />
              <TextInput
                label="MRC (AED)"
                value={AED((Number(createForm.values.price) || 0) * (Number(createForm.values.qty) || 0))}
                readOnly
                disabled
                description="Price × Quantity, calculated automatically"
              />
            </SimpleGrid>
            <Textarea label="Remarks" {...createForm.getInputProps('remarks')} />
            <Button type="submit" mt="sm">Add Order</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
