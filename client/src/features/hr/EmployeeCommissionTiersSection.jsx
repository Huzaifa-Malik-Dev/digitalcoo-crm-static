import { useState } from 'react';
import { Table, Button, Group, Modal, Stack, NumberInput, Text, ActionIcon, Tooltip, Alert, Divider, Paper } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchCommissionTiers, createCommissionTier, updateCommissionTier, deleteCommissionTier } from '../../api/payroll';
import { useConfirm } from '../../context/ConfirmContext';

// Leave Max % blank for an open-ended top tier ("125%+").
const EMPTY_VALUES = { minPct: '', maxPct: '', rate: '' };

function rangeLabel(t) {
  return t.maxPct == null ? `${t.minPct}%+` : `${t.minPct}% – ${t.maxPct}%`;
}

// Each commission-eligible employee has their own independent tier set - this section only
// appears on their profile once Pay Type is Commission or Salary + Commission, right where that
// pay type was set, rather than in a separate global admin screen no longer tied to any one
// person's actual scale.
export default function EmployeeCommissionTiersSection({ employeeId, canEdit }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const tiersQuery = useQuery({
    queryKey: ['payroll', 'commission-tiers', employeeId],
    queryFn: () => fetchCommissionTiers(employeeId),
  });
  const tiers = tiersQuery.data?.data || [];

  const form = useForm({ initialValues: EMPTY_VALUES });
  const editForm = useForm({ initialValues: EMPTY_VALUES });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['payroll', 'commission-tiers', employeeId] });

  const toBody = (values) => ({
    employee: employeeId,
    minPct: Number(values.minPct),
    maxPct: values.maxPct === '' || values.maxPct === null ? null : Number(values.maxPct),
    rate: Number(values.rate),
  });

  const openCreate = () => {
    form.reset();
    setCreateOpen(true);
  };

  const openEdit = (row) => {
    setEditRow(row);
    editForm.setValues({ minPct: row.minPct, maxPct: row.maxPct ?? '', rate: row.rate });
  };

  const handleCreate = async (values) => {
    try {
      await createCommissionTier(toBody(values));
      notifications.show({ color: 'green', message: 'Commission tier added' });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleEdit = async (values) => {
    try {
      await updateCommissionTier(editRow._id, toBody(values));
      notifications.show({ color: 'green', message: 'Commission tier updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Delete this commission tier?',
      message: `Removing the ${rangeLabel(row)} → ${row.rate}% tier only affects payroll runs processed after this. Already-processed runs keep the rate they used.`,
      confirmLabel: 'Yes, delete it',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteCommissionTier(row._id);
      notifications.show({ color: 'green', message: 'Commission tier deleted' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Divider label="Commission Rules" labelPosition="left" flex={1} mr="md" />
        {canEdit && (
          <Button size="xs" variant="light" leftSection={<Plus size={14} />} onClick={openCreate}>
            Add Tier
          </Button>
        )}
      </Group>

      <Alert color="blue" variant="light" mb="sm">
        Earns a % of achieved MRC for the month, based on which bracket their target achievement %
        falls into. If this person manages a team, they're scored against their whole team's
        achieved MRC vs their own target. Changing these tiers only affects payroll runs processed
        from now on — already-processed runs keep the rate they were calculated with.
      </Alert>

      <Table.ScrollContainer minWidth={400} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Commission tiers, scrollable' } }}>
        <Table striped verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Achievement Range</Table.Th>
              <Table.Th>Commission Rate</Table.Th>
              {canEdit && <Table.Th>Actions</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tiers.map((t) => (
              <Table.Tr key={t._id}>
                <Table.Td>{rangeLabel(t)}</Table.Td>
                <Table.Td fw={600}>{t.rate}%</Table.Td>
                {canEdit && (
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Tooltip label="Edit tier">
                        <ActionIcon variant="filled" size="sm" radius="md" onClick={() => openEdit(t)} aria-label="Edit tier">
                          <Pencil size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete tier">
                        <ActionIcon variant="filled" color="red" size="sm" radius="md" onClick={() => handleDelete(t)} aria-label="Delete tier">
                          <Trash2 size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
            {tiers.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={canEdit ? 3 : 2}>
                  <Text c="dimmed" ta="center" py="md">No commission tiers configured yet — this employee will earn 0% commission until one is added.</Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Commission Tier" size="sm">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <NumberInput label="Min Achievement %" required min={0} {...form.getInputProps('minPct')} />
            <NumberInput label="Max Achievement %" placeholder="No upper bound" min={0} {...form.getInputProps('maxPct')} />
            <NumberInput label="Commission Rate %" required min={0} {...form.getInputProps('rate')} />
            <Button type="submit" mt="sm">Save Tier</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={editRow ? `Edit Tier — ${rangeLabel(editRow)}` : ''} size="sm">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <NumberInput label="Min Achievement %" required min={0} {...editForm.getInputProps('minPct')} />
            <NumberInput label="Max Achievement %" placeholder="No upper bound" min={0} {...editForm.getInputProps('maxPct')} />
            <NumberInput label="Commission Rate %" required min={0} {...editForm.getInputProps('rate')} />
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Paper>
  );
}
