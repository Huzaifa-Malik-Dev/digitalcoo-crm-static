import { useMemo, useState } from 'react';
import { Title, Group, Paper, Select, Stack, Text, Tooltip, Modal, ActionIcon, Indicator } from '@mantine/core';
import { Bell, MessageCircle, Eye, Pencil } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import DataTable from '../../components/DataTable';
import ImportExportBar from '../../components/ImportExportBar';
import PageToolbar from '../../components/PageToolbar';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { useThreadUnreadCounts } from '../../hooks/useNotifications';
import { fetchPipelineList, exportPipeline, importPipeline } from '../../api/pipeline';
import { markViewed } from '../../api/views';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import PipelineDealPanel from './PipelineDealPanel';
import { PIPE_STAGES, STAGE_COLOR, APPROVAL_COLOR, APPROVAL_LABEL, APPROVAL_OPTIONS } from '../../constants/pipeline';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

export default function PipelinePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [stageFilter, setStageFilter] = useState(null);
  const [approvalFilter, setApprovalFilter] = useState(null);
  const [openDealId, setOpenDealId] = useState(null);
  const openChat = useChat();

  const list = usePagedList(['pipeline'], fetchPipelineList, {
    filters: { stage: stageFilter || undefined, approval: approvalFilter || undefined },
  });

  const visibleDsrNos = useMemo(() => (list.data || []).map((r) => r.dsrNo), [list.data]);
  const { data: unreadData } = useThreadUnreadCounts(visibleDsrNos);
  const unreadCounts = unreadData?.data || {};

  const openDeal = (row) => {
    markViewed(queryClient, ['pipeline'], 'pipeline', row._id);
    setOpenDealId(row._id);
  };

  const columns = useMemo(
    () => [
      {
        id: 'needsMe',
        header: 'Alert',
        cell: (info) => {
          const row = info.row.original;
          const needsMe = row.approval === 'pending_tl' && (user.role === 'admin' || String(row.tlId) === String(user.id));
          return needsMe ? (
            <Tooltip label="Awaiting your approval">
              <Bell size={14} color="var(--mantine-color-yellow-6)" />
            </Tooltip>
          ) : null;
        },
      },
      { accessorKey: 'dsrNo', header: 'DSR No.' },
      { accessorKey: 'company', header: 'Company' },
      { accessorKey: 'customer', header: 'Customer' },
      {
        // Category folded into the Product column (as dimmed subtext) instead of its own
        // column — the two are almost always read together, and one fewer column leaves more
        // horizontal room for the rest on narrower laptop screens.
        id: 'product',
        header: 'Product',
        cell: (info) => {
          const row = info.row.original;
          return (
            <div>
              <Text size="sm">{row.product || '—'}</Text>
              {row.cat && <Text size="xs" c="dimmed">{row.cat}</Text>}
            </div>
          );
        },
      },
      { accessorKey: 'qty', header: 'Qty' },
      // Annual is just MRC × 12 — showing both is redundant column space; Annual still shows in
      // the deal detail modal for anyone who wants it broken out.
      { accessorKey: 'mrc', header: 'MRC', cell: (info) => AED(info.getValue()) },
      { accessorKey: 'agentId', header: 'Agent', cell: (info) => info.getValue()?.name || '-', enableSorting: false },
      {
        accessorKey: 'stage',
        header: 'Stage',
        cell: (info) => <Tag color={STAGE_COLOR[info.getValue()]}>{info.getValue()}</Tag>,
      },
      {
        accessorKey: 'approval',
        header: 'Approval',
        cell: (info) => {
          const row = info.row.original;
          return APPROVAL_LABEL[row.approval] ? (
            <Tag color={APPROVAL_COLOR[row.approval]}>{APPROVAL_LABEL[row.approval]}</Tag>
          ) : (
            <Text size="xs" c="dimmed">—</Text>
          );
        },
      },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => {
          const row = info.row.original;
          const canEditRow =
            user.editModules?.includes('pipeline') &&
            (user.role === 'admin' || String(row.tlId) === String(user.id) || String(row.agentId?._id) === String(user.id));
          return (
            <Group gap="xs" wrap="nowrap">
              <Tooltip label="View this deal">
                <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); openDeal(row); }} aria-label="View deal">
                  <Eye size={18} />
                </ActionIcon>
              </Tooltip>
              {canEditRow && (
                <Tooltip label="Edit this deal">
                  <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); openDeal(row); }} aria-label="Edit deal">
                    <Pencil size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Chat about this deal (tag teammates, see full history)">
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
    [user.id, user.role, user.editModules, unreadCounts]
  );

  return (
    <Stack>
      <PageToolbar
        title={<Title order={1} size="h3">Sales Pipeline</Title>}
        subtitle="Use the View or Edit icons to open a deal's details or move it through the approval workflow."
        actions={
          <>
            <Select placeholder="All stages" data={PIPE_STAGES} value={stageFilter} onChange={setStageFilter} clearable w={200} />
            <Select placeholder="All approval states" data={APPROVAL_OPTIONS} value={approvalFilter} onChange={setApprovalFilter} clearable w={200} />
            <ImportExportBar
              moduleKey="pipeline"
              filenamePrefix="pipeline"
              exportFn={exportPipeline}
              importFn={importPipeline}
              onImported={() => { queryClient.invalidateQueries({ queryKey: ['pipeline'] }); list.refetch(); }}
            />
          </>
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
          emptyLabel="No deals in the pipeline yet — convert an Interested DSR to get started"
        />
      </Paper>

      <Modal
        opened={!!openDealId}
        onClose={() => setOpenDealId(null)}
        title="Deal Details"
        size="70rem"
      >
        {openDealId && <PipelineDealPanel dealId={openDealId} />}
      </Modal>
    </Stack>
  );
}
