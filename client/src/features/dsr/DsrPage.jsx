import { useMemo, useRef, useState } from 'react';
import {
  Title, Group, Button, Paper, Select, Modal, Stack, TextInput, Textarea, ActionIcon, Tooltip,
  Autocomplete, SimpleGrid, Divider, Indicator, CopyButton, Text,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '../../utils/toast';
import { Plus, ArrowRightCircle, Pencil, Eye, MessageCircle, Calendar, Building2, MapPin, Phone, Mail, User, Copy, Check } from 'lucide-react';
import DataTable from '../../components/DataTable';
import ImportExportBar from '../../components/ImportExportBar';
import FlexDateInput from '../../components/FlexDateInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { usePagedList } from '../../hooks/usePagedList';
import { useThreadUnreadCounts } from '../../hooks/useNotifications';
import { fetchDsrList, createDsr, updateDsrStatus, updateDsr, exportDsr, importDsr, fetchDsrAutocomplete, fetchLoggableEmployees } from '../../api/dsr';
import { convertToPipeline } from '../../api/pipeline';
import { markViewed } from '../../api/views';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useChat } from '../../context/ChatContext';
import { formatDate } from '../../utils/date';

// Grouped so the Select shows the common outcomes first instead of one long alphabetical list —
// mirrors how agents actually work through a call (talked to someone? doing what? or never reached them).
const CALL_STATUS_GROUPS = [
  { group: 'Reached — positive', items: ['Interested', 'Lead Generated', 'Connected', 'Using etisalat', 'Using DU'] },
  { group: 'Reached — follow up', items: ['FollowUp', '10% Followup Customer', 'Given to TL Followup', 'Call back later', 'Online meeting', 'Visited Face to Face', 'Cold calling visit'] },
  { group: 'Not connected', items: ['No answer', 'Voicemail', 'Not Connected', 'Switch off', 'No response', 'Number not in use'] },
  { group: 'Reached — negative', items: ['Not interested'] },
];

const CALL_STATUS = CALL_STATUS_GROUPS.flatMap((g) => g.items);

// Loose on purpose - just enough to catch the two most common data-entry accidents (a phone
// number that lost digits, e.g. Excel dropping a leading 0, and a typo'd email) without
// rejecting valid international formats.
const dsrValidation = {
  contactNo: (v) => (v.replace(/\D/g, '').length >= 7 ? null : 'Looks too short for a phone number'),
  email: (v) => (!v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Not a valid email address'),
};

const STATUS_COLOR = {
  Interested: 'green',
  'Lead Generated': 'green',
  Connected: 'teal',
  'Using etisalat': 'cyan',
  'Using DU': 'cyan',
  FollowUp: 'yellow',
  '10% Followup Customer': 'yellow',
  'Given to TL Followup': 'yellow',
  'Call back later': 'yellow',
  'Online meeting': 'blue',
  'Visited Face to Face': 'blue',
  'Cold calling visit': 'blue',
  'No answer': 'gray',
  Voicemail: 'gray',
  'Not Connected': 'gray',
  'Switch off': 'gray',
  'No response': 'gray',
  'Number not in use': 'gray',
  'Not interested': 'red',
};

// Shared layout for the Log Call / Edit DSR modals — grouped into short, labelled sections with
// field icons instead of one long column of lookalike inputs, per UX research on reducing
// perceived form complexity (group by intent, icon each field, keep sections short).
function DsrFormFields({ form, companySlot, agentSlot, disabled = false }) {
  return (
    <Stack gap="md">
      <div>
        <Divider label="When & Outcome" labelPosition="left" mb="sm" />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <FlexDateInput label="Date" required readOnly={disabled} value={form.values.date} onChange={(v) => form.setFieldValue('date', v)} />
          <Select label="Status" data={CALL_STATUS_GROUPS} required searchable disabled={disabled} {...form.getInputProps('status')} />
        </SimpleGrid>
        {agentSlot && <div style={{ marginTop: 'var(--mantine-spacing-sm)' }}>{agentSlot}</div>}
      </div>

      <div>
        <Divider label="Where" labelPosition="left" mb="sm" />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {companySlot}
          <TextInput
            label="Building"
            description="Optional — the tower/building you visited, if this was a door-to-door call"
            placeholder="e.g. Bin Dasmal Tower"
            leftSection={<MapPin size={16} />}
            disabled={disabled}
            {...form.getInputProps('building')}
          />
        </SimpleGrid>
      </div>

      <div>
        <Divider label="Who to Contact" labelPosition="left" mb="sm" />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Contact Person" leftSection={<User size={16} />} disabled={disabled} {...form.getInputProps('customer')} />
          <TextInput label="Contact No." required leftSection={<Phone size={16} />} disabled={disabled} {...form.getInputProps('contactNo')} />
          <TextInput label="Email" leftSection={<Mail size={16} />} disabled={disabled} {...form.getInputProps('email')} />
        </SimpleGrid>
      </div>

      <div>
        <Divider label="Notes" labelPosition="left" mb="sm" />
        <Textarea label="Remarks" autosize minRows={2} disabled={disabled} {...form.getInputProps('remarks')} />
      </div>
    </Stack>
  );
}

export default function DsrPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const openChat = useChat();
  const canEdit = user.editModules?.includes('dsr');
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [companyQuery, setCompanyQuery] = useState('');
  const [debouncedCompanyQuery] = useDebouncedValue(companyQuery, 250);
  const keepOpenRef = useRef(false);

  const list = usePagedList(['dsr'], fetchDsrList);

  const visibleDsrNos = useMemo(() => (list.data || []).map((r) => r.dsrNo), [list.data]);
  const { data: unreadData } = useThreadUnreadCounts(visibleDsrNos);
  const unreadCounts = unreadData?.data || {};

  // Powers the Company autocomplete below — picking a suggestion auto-fills Building/Contact/Email
  // so logging a repeat call to the same company takes one click instead of retyping everything.
  const suggestQuery = useQuery({
    queryKey: ['dsr', 'autocomplete', debouncedCompanyQuery],
    queryFn: () => fetchDsrAutocomplete({ q: debouncedCompanyQuery }),
    enabled: createOpen && debouncedCompanyQuery.trim().length >= 2,
  });
  const suggestions = suggestQuery.data?.data || [];

  const companyInputRef = useRef(null);

  // Only fetched for anyone above agent level - the whole point of this selector is that they're
  // logging a call on someone else's behalf (or their own), not just always themselves.
  const loggableEmployeesQuery = useQuery({
    queryKey: ['dsr', 'loggable-employees'],
    queryFn: fetchLoggableEmployees,
    enabled: user.role !== 'agent',
  });
  const loggableEmployees = loggableEmployeesQuery.data?.data || [];
  const agentOptions = loggableEmployees.map((e) => ({ value: e._id, label: `${e.employeeId} - ${e.name}` }));

  const form = useForm({
    initialValues: { date: new Date().toISOString().slice(0, 10), company: '', building: '', contactNo: '', email: '', customer: '', status: 'Interested', remarks: '', agentId: '' },
    validate: {
      ...dsrValidation,
      agentId: (v) => (user.role !== 'agent' && !v ? 'Select who this call is for' : null),
    },
  });

  const applyCompanySuggestion = (companyName) => {
    const match = suggestions.find((s) => s.company === companyName);
    form.setFieldValue('company', companyName);
    if (match) {
      if (match.building) form.setFieldValue('building', match.building);
      if (match.contactNo) form.setFieldValue('contactNo', match.contactNo);
      if (match.email) form.setFieldValue('email', match.email);
      if (match.customer) form.setFieldValue('customer', match.customer);
    }
  };

  // Same company + same number already on file for this contact - not blocked (a genuine
  // repeat follow-up call is normal), just flagged so an accidental double-entry is noticed
  // before saving instead of after.
  const possibleDuplicate =
    form.values.company.trim().length > 1 &&
    form.values.contactNo.trim().length > 0 &&
    suggestions.some(
      (s) => s.company.toLowerCase() === form.values.company.trim().toLowerCase() && s.contactNo === form.values.contactNo.trim()
    );

  const editForm = useForm({
    initialValues: { date: '', company: '', building: '', contactNo: '', email: '', customer: '', status: 'Interested', remarks: '' },
    validate: dsrValidation,
  });

  const openEdit = (row) => {
    markViewed(queryClient, ['dsr'], 'dsr', row._id);
    setEditRow(row);
    editForm.setValues({
      date: row.date,
      company: row.company,
      building: row.building,
      contactNo: row.contactNo,
      email: row.email || '',
      customer: row.customer,
      status: row.status,
      remarks: row.remarks,
    });
  };

  // The View icon opens this same modal for anyone who can see the row, including non-owners -
  // gate every field read-only unless the viewer is the owning agent or an admin, matching the
  // access rule the Edit icon (and the backend's `update()`) already enforce.
  const editIsOwner = canEdit && String(editRow?.agentId?._id) === String(user.id);
  const editIsAdmin = user.role === 'admin';
  // Locked only once the deal is actually sent to Back Office, not the moment it enters the
  // Pipeline - see dsrController.isSentToBackOffice for why convertedToPipeline alone is too early.
  const canEditFields = !!editRow && (editIsOwner || editIsAdmin) && (editIsAdmin || !editRow.sentToBackOffice);

  const handleEdit = async (values) => {
    try {
      await updateDsr(editRow._id, values);
      notifications.show({ color: 'green', message: 'DSR updated' });
      setEditRow(null);
      queryClient.invalidateQueries({ queryKey: ['dsr'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleCreate = async (values) => {
    try {
      await createDsr(values);
      queryClient.invalidateQueries({ queryKey: ['dsr'] });
      list.refetch();
      if (keepOpenRef.current) {
        // Quick-entry mode: keep the modal open, keep today's date, clear everything else so
        // the agent can log the next call immediately without reopening the form.
        form.setValues({ date: values.date, company: '', building: '', contactNo: '', email: '', customer: '', status: 'Interested', remarks: '', agentId: values.agentId });
        setCompanyQuery('');
        notifications.show({ color: 'green', message: `${values.company} logged — ready for the next call` });
        // Cursor back in Company so the next call can be typed immediately, no click required -
        // this is the whole point of "Save & Log Another" for someone doing dozens a day.
        companyInputRef.current?.focus();
      } else {
        notifications.show({ color: 'green', message: 'DSR logged' });
        setCreateOpen(false);
        form.reset();
      }
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleStatusChange = async (id, status) => {
    try {
      await updateDsrStatus(id, { status });
      notifications.show({ color: 'green', message: `Status updated to "${status}"` });
      queryClient.invalidateQueries({ queryKey: ['dsr'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleConvert = async (dsr) => {
    const ok = await confirm({
      title: 'Convert to pipeline?',
      message: `Move ${dsr.dsrNo} (${dsr.company}) into the Sales Pipeline? This notifies your Team Leader for approval.`,
      confirmLabel: 'Yes, convert',
      color: 'blue',
    });
    if (!ok) return;
    try {
      await convertToPipeline({ dsrId: dsr._id, price: 100, qty: 1 });
      notifications.show({ color: 'green', message: `${dsr.dsrNo} moved to pipeline` });
      queryClient.invalidateQueries({ queryKey: ['dsr'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not convert', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = useMemo(
    () => [
      { accessorKey: 'dsrNo', header: 'DSR No.' },
      { accessorKey: 'date', header: 'Date', cell: (info) => formatDate(info.getValue()) },
      {
        // Building folded in as dimmed subtext under Company (like Sales Pipeline's Product/Category)
        // instead of its own column — it was previously captured on the form but never shown
        // anywhere, so agents had no way to tell it mattered. This is its first real surface.
        id: 'company',
        header: 'Company',
        cell: (info) => {
          const row = info.row.original;
          return (
            <div>
              <Text size="sm">{row.company || '—'}</Text>
              {row.building && <Text size="xs" c="dimmed">{row.building}</Text>}
            </div>
          );
        },
      },
      {
        accessorKey: 'contactNo',
        header: 'Contact No.',
        cell: (info) => {
          const value = info.getValue();
          if (!value) return '-';
          return (
            <Group gap={6} wrap="nowrap">
              <Text size="sm">{value}</Text>
              <CopyButton value={value}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy number'}>
                    <ActionIcon
                      variant="subtle"
                      color={copied ? 'teal' : 'gray'}
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); copy(); }}
                      aria-label="Copy contact number"
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          );
        },
      },
      { accessorKey: 'customer', header: 'Contact Person' },
      {
        accessorKey: 'agentId',
        header: 'Agent',
        enableSorting: false,
        cell: (info) => info.getValue()?.name || '-',
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: (info) => {
          const row = info.row.original;
          if (!canEdit || String(row.agentId?._id) !== String(user.id) || row.sentToBackOffice) {
            return <Tag color={STATUS_COLOR[row.status] || 'gray'}>{row.status}</Tag>;
          }
          return (
            <Select
              data={CALL_STATUS_GROUPS}
              value={row.status}
              onChange={(v) => v && handleStatusChange(row._id, v)}
              size="xs"
              w={190}
            />
          );
        },
      },
      { accessorKey: 'remarks', header: 'Remarks', truncate: true, truncateWidth: 240 },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => {
          const row = info.row.original;
          const isOwner = canEdit && String(row.agentId?._id) === String(user.id);
          const isAdmin = user.role === 'admin';
          return (
            <Group gap="xs" wrap="nowrap">
              {row.status === 'Lead Generated' && !row.convertedToPipeline && (
                <Button size="compact-xs" variant="light" leftSection={<ArrowRightCircle size={14} />} onClick={() => handleConvert(row)}>
                  To Pipeline
                </Button>
              )}
              <Tooltip label="View this DSR record">
                <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="View DSR">
                  <Eye size={18} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Chat about this DSR (tag teammates, see full history)">
                <Indicator
                  label={unreadCounts[row.dsrNo] > 9 ? '9+' : unreadCounts[row.dsrNo]}
                  disabled={!unreadCounts[row.dsrNo]}
                  size={16}
                  color="red"
                  offset={4}
                >
                  <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openChat(row.dsrNo)} aria-label="Chat">
                    <MessageCircle size={18} />
                  </ActionIcon>
                </Indicator>
              </Tooltip>
              {(isOwner || isAdmin) && (isAdmin || !row.sentToBackOffice) && (
                <Tooltip label="Edit this DSR record (company, contact, remarks, status)">
                  <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="Edit DSR">
                    <Pencil size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              {isOwner && !isAdmin && row.sentToBackOffice && (
                <Tooltip label="This deal has been sent to Back Office — the DSR record can no longer be edited here">
                  <ActionIcon variant="filled" size="lg" radius="md" disabled aria-label="Edit disabled">
                    <Pencil size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          );
        },
      },
    ],
    [canEdit, user.id, user.role, unreadCounts]
  );

  return (
    <Stack>
      <PageToolbar
        title={<Title order={1} size="h3">DSR — Agent Calling List</Title>}
        actions={
          <Group gap="sm">
            <ImportExportBar
              moduleKey="dsr"
              filenamePrefix="dsr"
              exportFn={exportDsr}
              importFn={importDsr}
              onImported={() => { queryClient.invalidateQueries({ queryKey: ['dsr'] }); list.refetch(); }}
            />
            {canEdit && (
              <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
                Log Call
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
          emptyLabel="No DSR calls logged yet"
        />
      </Paper>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Log a call (DSR)" size="lg">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <DsrFormFields
            form={form}
            agentSlot={
              user.role !== 'agent' && (
                <Select
                  label="Logging this call for"
                  placeholder="Select employee"
                  data={agentOptions}
                  searchable
                  required
                  leftSection={<User size={16} />}
                  {...form.getInputProps('agentId')}
                />
              )
            }
            companySlot={
              <Autocomplete
                ref={companyInputRef}
                label="Company"
                placeholder="Start typing — past companies suggest"
                required
                leftSection={<Building2 size={16} />}
                data={suggestions.map((s) => s.company)}
                value={form.values.company}
                onChange={(v) => { form.setFieldValue('company', v); setCompanyQuery(v); }}
                onOptionSubmit={applyCompanySuggestion}
              />
            }
          />
          {possibleDuplicate && (
            <Text size="xs" c="yellow.6" mt={4}>
              You've already logged a call for this company &amp; number before — check it isn't a duplicate entry.
            </Text>
          )}
          <Group grow mt="md">
            <Button type="submit" variant="light" onClick={() => { keepOpenRef.current = true; }}>
              Save &amp; Log Another
            </Button>
            <Button type="submit" onClick={() => { keepOpenRef.current = false; }}>
              Save &amp; Close
            </Button>
          </Group>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`${canEditFields ? 'Edit' : 'View'} DSR — ${editRow?.dsrNo || ''}`} size="lg">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <DsrFormFields
            form={editForm}
            disabled={!canEditFields}
            companySlot={<TextInput label="Company" required leftSection={<Building2 size={16} />} disabled={!canEditFields} {...editForm.getInputProps('company')} />}
          />
          {canEditFields && <Button type="submit" mt="md" fullWidth>Save changes</Button>}
        </form>
      </Modal>
    </Stack>
  );
}
