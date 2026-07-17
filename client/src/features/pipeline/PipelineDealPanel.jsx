import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stack, Text, Paper, Group, Button, SimpleGrid, Select, TextInput,
  Textarea, Alert, Loader, Center, Divider, Modal, Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '../../utils/toast';
import { Check, X, Send, AlertTriangle, Ban } from 'lucide-react';
import { fetchPipelineOne, updatePipeline, escalateToTL, approvePipeline, rejectPipeline, requestPipelineCorrection, requestPipelineCancellation } from '../../api/pipeline';
import { fetchProducts } from '../../api/products';
import { fetchCategories } from '../../api/catalog';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { PIPE_STAGES, APPROVAL_INFO } from '../../constants/pipeline';
import LineItemsEditor, { toFormLineItems, toApiLineItems, validateLineItems, emptyBlock } from '../../components/LineItemsEditor';

// Confirm-step copy for each action - the whole point is the user should never be surprised
// by what a click does, matching the reference prototype's descriptive button labels.
const ACTION_INFO = {
  approve: {
    title: 'Approve this deal?',
    body: 'This opens an order and notifies Back Office to start processing it, and notifies the agent that their deal was approved.',
    color: 'green',
    confirmLabel: 'Yes, approve → Back Office',
  },
  reject: {
    title: 'Reject this deal?',
    body: 'The deal is returned to the agent as rejected and they are notified. You can add an optional reason below that the agent will see in the deal history.',
    color: 'red',
    confirmLabel: 'Yes, reject → return to agent',
  },
};

// Escape hatch once a deal is locked and out of the agent's/TL's hands - flags the order red for
// Back Office rather than editing anything directly. Only Back Office deciding to send it back
// actually reopens it (see BackofficePage.jsx / server workflow.sendOrderBackToPipeline).
const CORRECTION_INFO = {
  title: 'Request a correction?',
  body: 'This flags the order for Back Office as needing a fix — they\'ll see who asked and can send the deal back to Pipeline so it becomes editable again. Add a note below explaining what needs fixing.',
  color: 'orange',
  confirmLabel: 'Yes, flag for Back Office',
};

// Unlike a correction (which loops the deal back for a fix), cancellation ends the order outright -
// so it needs the Sales Head's sign-off and a mandatory reason, and the order freezes until they
// decide. See server/services/workflow.js requestOrderCancellation.
const CANCELLATION_INFO = {
  title: 'Request order cancellation?',
  body: 'This asks the Sales Head to cancel this order. The order freezes — no edits or status changes — until they approve or reject the request. A reason is required.',
  color: 'red',
  confirmLabel: 'Yes, request cancellation',
};

// Every field must be filled in and saved before a Team Leader approval can be requested -
// `director` is deliberately excluded (optional, per business rule). Mirrors the server's own
// PIPELINE_REQUIRED_FOR_APPROVAL + line-item completeness check (services/workflow.js
// missingPipelineFields) so the disabled button and the server's 400 always agree.
const REQUIRED_FIELD_LABELS = {
  email: 'Customer Email', expectedCloseDate: 'Expected Close Date', remarks: 'Remarks',
};

function missingRequiredFields(deal) {
  const missing = Object.keys(REQUIRED_FIELD_LABELS)
    .filter((key) => !deal[key] || !String(deal[key]).trim())
    .map((key) => REQUIRED_FIELD_LABELS[key]);

  const lineItems = deal.lineItems || [];
  if (!lineItems.length) {
    missing.push('at least one line item');
    return missing;
  }
  lineItems.forEach((block, i) => {
    const label = `Line Item ${i + 1}`;
    if (!block.cat) missing.push(`${label}: Category`);
    if (!block.product) missing.push(`${label}: Product`);
    if (!block.sr) missing.push(`${label}: Subscription Type`);
    (block.rows || []).forEach((row, j) => {
      if (!(Number(row.price) > 0)) missing.push(`${label}, Row ${j + 1}: Unit Price`);
      if (!(Number(row.qty) >= 1)) missing.push(`${label}, Row ${j + 1}: Quantity`);
    });
  });
  return missing;
}

// Content-only panel (no page chrome) - rendered inside a Modal by PipelinePage so approving,
// rejecting, escalating, or editing a deal never navigates the user away from their place in the list.
export default function PipelineDealPanel({ dealId }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canEdit = user.editModules?.includes('pipeline');
  const [confirmAction, setConfirmAction] = useState(null); // 'approve' | 'reject' | 'requestCorrection' | 'requestCancellation' | null

  const { data, isLoading } = useQuery({ queryKey: ['pipeline', 'one', dealId], queryFn: () => fetchPipelineOne(dealId) });
  const deal = data?.data;

  const productsQuery = useQuery({ queryKey: ['products', 'options'], queryFn: () => fetchProducts({ limit: 200, active: true }) });
  const products = productsQuery.data?.data || [];
  const categoriesQuery = useQuery({ queryKey: ['catalog', 'categories', 'active'], queryFn: () => fetchCategories({ active: true }) });
  const categories = categoriesQuery.data?.data || [];

  // Reason is mandatory only for a cancellation request (the server hard-rejects a blank one) -
  // optional for reject/correction, matching their own server-side rules.
  const reasonForm = useForm({
    initialValues: { reason: '' },
    validate: {
      reason: (v) => (confirmAction === 'requestCancellation' && !v?.trim() ? 'A reason is required to request cancellation' : null),
    },
  });

  const editForm = useForm({
    initialValues: {
      lineItems: [emptyBlock()], stage: '10%- Prospect',
      email: '', expectedCloseDate: '', director: '', remarks: '',
    },
    // A whole-form validator rather than the per-field record style used elsewhere: lineItems is
    // variable-length, so its per-index validators can't be statically declared.
    validate: (values) => ({
      ...validateLineItems(values.lineItems),
      email: values.email?.trim() ? null : 'Customer Email is required',
      expectedCloseDate: values.expectedCloseDate?.trim() ? null : 'Expected Close Date is required',
      remarks: values.remarks?.trim() ? null : 'Remarks are required',
      // director is intentionally not validated - it's the one optional field.
    }),
  });

  useEffect(() => {
    if (deal) {
      editForm.setValues({
        lineItems: toFormLineItems(deal.lineItems), stage: deal.stage,
        email: deal.email || '', expectedCloseDate: deal.expectedCloseDate || '',
        director: deal.director || '', remarks: deal.remarks,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal?._id]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['pipeline'] });
    queryClient.invalidateQueries({ queryKey: ['pipeline', 'one', dealId] });
  };

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;
  if (!deal) return <Text c="dimmed">Deal not found</Text>;

  const isAdmin = user.role === 'admin';
  const isTl = !isAdmin && String(deal.tlId?._id || deal.tlId) === String(user.id);
  const isTlOrAdmin = isAdmin || isTl;
  const canApprove = isTlOrAdmin && user.editModules?.includes('pipeline.approve');
  const isAgentOwner = !isTlOrAdmin && String(deal.agentId?._id) === String(user.id);
  const isOwnerOrTlOrAdmin = isTlOrAdmin || isAgentOwner;
  const canAct = canEdit && isOwnerOrTlOrAdmin;
  // Once a deal is awaiting TL approval, the agent can no longer touch it (only the TL/admin
  // reviewing it can). Once the TL has approved it, it locks for EVERYONE, including admin - the
  // order Back Office now owns is the source of truth from that point on, and Request Correction
  // (which routes through Back Office sending it back) is the only sanctioned way back into an
  // editable state. No direct-edit bypass, or the correction trail means nothing.
  let canEditFields = canAct;
  if (deal.approval === 'approved') canEditFields = false;
  else if (canEditFields && !isAdmin && deal.approval === 'pending_tl' && isAgentOwner) canEditFields = false;
  const approvalInfo = APPROVAL_INFO[deal.approval] || APPROVAL_INFO.none;

  // Checked against the saved deal (not the live, possibly-unsaved form) - approval can only be
  // requested once every required field is actually filled in AND saved.
  const missingFields = missingRequiredFields(deal);
  const canRequestApproval = missingFields.length === 0;
  const missingFieldsTooltip = canRequestApproval ? '' : `Save these required fields first: ${missingFields.join(', ')}`;

  const handleSaveDeal = async (values) => {
    if (values.stage === '100% - Deal Won' && deal.stage !== '100% - Deal Won') {
      const ok = await confirm({
        title: 'Mark this deal as Won?',
        message: 'This opens an order and notifies Back Office to start processing it.',
        confirmLabel: 'Yes, mark Won',
        color: 'green',
      });
      if (!ok) return;
    }
    try {
      await updatePipeline(deal._id, { ...values, lineItems: toApiLineItems(values.lineItems) });
      notifications.show({ color: 'green', message: 'Deal updated' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleRequestApproval = async () => {
    if (!canRequestApproval) return;
    const ok = await confirm({
      title: 'Request Team Leader approval?',
      message: `This notifies ${deal.tlId?.name || 'your Team Leader'} to review this deal.`,
      confirmLabel: 'Yes, request approval',
      color: 'blue',
    });
    if (!ok) return;
    try {
      await escalateToTL(deal._id);
      notifications.show({ color: 'green', message: 'Sent to Team Leader for approval' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not request approval', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleConfirm = async (values) => {
    try {
      if (confirmAction === 'approve') {
        await approvePipeline(deal._id);
        notifications.show({ color: 'green', message: 'Approved and sent to Back Office' });
      } else if (confirmAction === 'reject') {
        await rejectPipeline(deal._id, values.reason);
        notifications.show({ color: 'green', message: 'Rejected and returned to the agent' });
      } else if (confirmAction === 'requestCorrection') {
        await requestPipelineCorrection(deal._id, values.reason);
        notifications.show({ color: 'green', message: 'Back Office has been notified' });
      } else if (confirmAction === 'requestCancellation') {
        await requestPipelineCancellation(deal._id, values.reason);
        notifications.show({ color: 'green', message: 'Cancellation requested — the Sales Head has been notified' });
      }
      setConfirmAction(null);
      reasonForm.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not complete action', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  // 90% - Closing is system-set only (Team Leader approval sends a deal there automatically) -
  // hidden from manual selection, except when the deal is already sitting at it (same
  // stale-value-still-must-render pattern LineItemsEditor uses for category/product/sr).
  const stageOptions = PIPE_STAGES.filter((s) => s !== '90% - Closing');
  if (deal.stage === '90% - Closing') stageOptions.push('90% - Closing');
  // An Activated or Linked order has already gone live with Etisalat - it's done, not a mistake to
  // unwind through the correction loop (mirrors the server's own guard in
  // workflow.requestOrderCorrection). Cancellation is still allowed, via the Sales Head.
  const orderIsLive = !!deal.orderCorrection && (deal.orderCorrection.status === 'Activated' || deal.orderCorrection.linked === 'Linked');
  const info =
    confirmAction === 'requestCorrection' ? CORRECTION_INFO
    : confirmAction === 'requestCancellation' ? CANCELLATION_INFO
    : confirmAction ? ACTION_INFO[confirmAction]
    : null;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Paper withBorder p="md" radius="md">
          <Divider label="Opportunity" labelPosition="left" mb="sm" />
          {canAct && !canEditFields && (
            <Alert color="gray" variant="light" mb="sm">
              {deal.approval === 'approved'
                ? 'This deal has been approved and sent to Back Office — it can no longer be edited here.'
                : 'This deal is awaiting Team Leader approval and cannot be edited until then.'}
            </Alert>
          )}
          <form onSubmit={editForm.onSubmit(handleSaveDeal)}>
            <Stack gap="sm">
              <Group grow>
                <div>
                  <Text size="xs" c="dimmed">Customer</Text>
                  <Text size="sm">{deal.customer || '—'}</Text>
                </div>
                <div>
                  <Text size="xs" c="dimmed">Agent</Text>
                  <Text size="sm">{deal.agentId?.name || '—'}</Text>
                </div>
              </Group>
              <Select
                label="Stage"
                description="Sales progress (10%–100%) — separate from Team Leader Approval on the right, which is a sign-off step"
                data={stageOptions}
                disabled={!canEditFields}
                {...editForm.getInputProps('stage')}
              />
              <Divider label="Line Items" labelPosition="left" mt="xs" />
              <LineItemsEditor
                form={editForm}
                products={products}
                categories={categories}
                savedLineItems={deal.lineItems}
                disabled={!canEditFields}
              />
              <Divider mt="xs" />
              <TextInput label="Customer Email" withAsterisk disabled={!canEditFields} {...editForm.getInputProps('email')} />
              <Group grow align="flex-start">
                <Tooltip label="Automatically set to the date this deal was converted from a DSR — cannot be changed" withArrow>
                  <TextInput
                    type="date"
                    label="Started Date"
                    value={deal.startedDate || ''}
                    readOnly
                    styles={{ input: { cursor: 'not-allowed' } }}
                  />
                </Tooltip>
                <TextInput type="date" label="Expected Close Date" withAsterisk disabled={!canEditFields} {...editForm.getInputProps('expectedCloseDate')} />
              </Group>
              <TextInput label="Director (optional)" disabled={!canEditFields} {...editForm.getInputProps('director')} />
              <Textarea label="Remarks" withAsterisk disabled={!canEditFields} {...editForm.getInputProps('remarks')} />
              {canEditFields && <Button type="submit">Save Changes</Button>}
            </Stack>
          </form>
        </Paper>

        <Paper withBorder p="md" radius="md">
          <Divider label="Team Leader Approval" labelPosition="left" mb="sm" />
          <Alert color={approvalInfo.color} variant="light">{approvalInfo.text}</Alert>

          <Divider label="Actions" labelPosition="left" mt="md" mb="sm" />
          {canAct ? (
            <Stack gap="xs">
              {deal.approval !== 'pending_tl' && deal.approval !== 'approved' && (
                <Tooltip label={missingFieldsTooltip} disabled={canRequestApproval} withArrow multiline w={260}>
                  <div>
                    <Button
                      variant="light"
                      leftSection={<Send size={16} />}
                      onClick={handleRequestApproval}
                      disabled={!canRequestApproval}
                      fullWidth
                    >
                      {deal.approval === 'rejected' ? 'Re-request Team Leader Approval' : 'Request Team Leader Approval'}
                    </Button>
                  </div>
                </Tooltip>
              )}
              {canApprove && deal.approval === 'pending_tl' && (
                <>
                  <Button color="green" leftSection={<Check size={16} />} onClick={() => setConfirmAction('approve')}>
                    Approve → Back Office
                  </Button>
                  <Button color="red" variant="light" leftSection={<X size={16} />} onClick={() => setConfirmAction('reject')}>
                    Reject → Return to Agent
                  </Button>
                </>
              )}
              {deal.approval === 'approved' && (
                deal.orderCancellation?.requested ? (
                  <Alert color="red" variant="light" icon={<Ban size={16} />}>
                    Cancellation requested by <b>{deal.orderCancellation.requestedBy}</b> on {new Date(deal.orderCancellation.requestedAt).toLocaleString()}
                    {deal.orderCancellation.reason ? <> — "{deal.orderCancellation.reason}"</> : null}. The order is frozen until the Sales Head approves or rejects it.
                  </Alert>
                ) : deal.orderCorrection?.requested ? (
                  <Alert color="orange" variant="light" icon={<AlertTriangle size={16} />}>
                    Correction requested by <b>{deal.orderCorrection.requestedBy}</b> on {new Date(deal.orderCorrection.requestedAt).toLocaleString()}
                    {deal.orderCorrection.note ? <> — "{deal.orderCorrection.note}"</> : null}. Waiting on Back Office to send it back to Pipeline.
                  </Alert>
                ) : (
                  <Stack gap={4}>
                    <Text size="sm" c="dimmed">Already approved and sent to Back Office — nothing more to do here.</Text>
                    {orderIsLive ? (
                      <Text size="xs" c="dimmed">
                        Order is {deal.orderCorrection.linked === 'Linked' ? 'Linked' : deal.orderCorrection.status} — already live, no further corrections can be requested.
                      </Text>
                    ) : (
                      deal.orderCorrection && (
                        <Button variant="filled" color="orange" leftSection={<AlertTriangle size={16} />} onClick={() => setConfirmAction('requestCorrection')}>
                          Request Correction
                        </Button>
                      )
                    )}
                    {/* Cancellation stays available even on a live/Linked order - unlike a correction,
                        it's the one route out of a locked order, and the Sales Head has to sign it off. */}
                    {deal.orderCorrection && deal.orderCorrection.status !== 'Cancelled' && (
                      <Button variant="light" color="red" leftSection={<Ban size={16} />} onClick={() => setConfirmAction('requestCancellation')}>
                        Request Cancellation
                      </Button>
                    )}
                    {deal.orderCancellation?.rejectionReason && (
                      <Text size="xs" c="dimmed">Last cancellation request was rejected — "{deal.orderCancellation.rejectionReason}"</Text>
                    )}
                    {deal.orderCorrection?.count > 0 && (
                      <Text size="xs" c="dimmed">Sent back for correction {deal.orderCorrection.count} time(s) before.</Text>
                    )}
                  </Stack>
                )
              )}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">Only the deal owner, their Team Leader, or an admin can act on this deal.</Text>
          )}

          <Divider label="History" labelPosition="left" mt="md" mb="sm" />
          <Stack gap={6}>
            {(deal.history || []).slice().reverse().map((h, i) => (
              <Text key={i} size="xs" c="dimmed">
                <b>{h.userId?.name || 'System'}</b> — {h.text} <Text span c="dimmed">({new Date(h.ts).toLocaleString()})</Text>
              </Text>
            ))}
          </Stack>
        </Paper>
      </SimpleGrid>

      <Modal opened={!!confirmAction} onClose={() => setConfirmAction(null)} title={info?.title} size="md">
        <form onSubmit={reasonForm.onSubmit(handleConfirm)}>
          <Stack gap="sm">
            <Text size="sm">{info?.body}</Text>
            {(confirmAction === 'reject' || confirmAction === 'escalateSalesHead') && (
              <Textarea label="Reason (optional)" {...reasonForm.getInputProps('reason')} />
            )}
            {confirmAction === 'requestCorrection' && (
              <Textarea label="What needs fixing? (optional, but helps Back Office)" {...reasonForm.getInputProps('reason')} />
            )}
            {confirmAction === 'requestCancellation' && (
              <Textarea label="Why should this order be cancelled?" withAsterisk {...reasonForm.getInputProps('reason')} />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setConfirmAction(null)}>Cancel</Button>
              <Button type="submit" color={info?.color}>{info?.confirmLabel}</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
