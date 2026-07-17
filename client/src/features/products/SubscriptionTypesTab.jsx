import { useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, ActionIcon, Tooltip, Table, Text, Alert, Loader, Center } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Pencil, Trash2, Power, Info } from 'lucide-react';
import Tag from '../../components/Tag';
import { fetchSubscriptionTypes, createSubscriptionType, updateSubscriptionType, deleteSubscriptionType } from '../../api/catalog';
import { useConfirm } from '../../context/ConfirmContext';

// A short reference list (a handful of rows), so a plain Table rather than the paginated/searchable
// DataTable the product catalog uses - same call the line-item editor's dropdowns read.
export default function SubscriptionTypesTab({ canEdit }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['catalog', 'subscription-types'], queryFn: () => fetchSubscriptionTypes() });
  const rows = data?.data || [];

  const form = useForm({ initialValues: { name: '' }, validate: { name: (v) => (v.trim() ? null : 'Name is required') } });
  const editForm = useForm({ initialValues: { name: '' }, validate: { name: (v) => (v.trim() ? null : 'Name is required') } });

  // Categories embed these, and every deal's dropdown reads them - invalidate the whole catalog.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catalog'] });

  const handleCreate = async (values) => {
    try {
      await createSubscriptionType(values);
      notifications.show({ color: 'green', message: `Subscription type "${values.name}" added` });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleEdit = async (values) => {
    try {
      await updateSubscriptionType(editRow._id, values);
      notifications.show({ color: 'green', message: 'Subscription type updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleToggle = async (row) => {
    const ok = await confirm({
      title: row.active ? `Deactivate "${row.name}"?` : `Reactivate "${row.name}"?`,
      message: row.active
        ? `"${row.name}" will no longer be offered on new deals. Deals already sold under it keep it exactly as they are.`
        : `"${row.name}" becomes available again wherever it's assigned.`,
      confirmLabel: row.active ? 'Yes, deactivate' : 'Yes, reactivate',
      color: row.active ? 'red' : 'green',
    });
    if (!ok) return;
    try {
      await updateSubscriptionType(row._id, { active: !row.active });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: `Delete "${row.name}"?`,
      message: 'This only works while it isn\'t assigned to any category or product. Deactivate it instead if it\'s been used.',
      confirmLabel: 'Yes, delete',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteSubscriptionType(row._id);
      notifications.show({ color: 'green', message: 'Subscription type deleted' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  return (
    <Stack gap="md">
      <Alert color="blue" variant="light" icon={<Info size={16} />}>
        The subscription types a deal can be sold under (NEW, MIG, MNP…). Assign them to a category on the
        Categories tab — a product can then offer any of the ones its category allows.
      </Alert>

      {canEdit && (
        <Group justify="flex-end">
          <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add Subscription Type</Button>
        </Group>
      )}

      <Table.ScrollContainer minWidth={420}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Status</Table.Th>
              {canEdit && <Table.Th w={140}>Actions</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {!rows.length && (
              <Table.Tr><Table.Td colSpan={3}><Text c="dimmed" size="sm" ta="center" py="md">No subscription types yet</Text></Table.Td></Table.Tr>
            )}
            {rows.map((row) => (
              <Table.Tr key={row._id}>
                <Table.Td><Text size="sm" fw={500}>{row.name}</Text></Table.Td>
                <Table.Td><Tag color={row.active ? 'green' : 'gray'}>{row.active ? 'Active' : 'Inactive'}</Tag></Table.Td>
                {canEdit && (
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Tooltip label="Rename">
                        <ActionIcon variant="filled" size="lg" radius="md" onClick={() => { setEditRow(row); editForm.setValues({ name: row.name }); }} aria-label="Rename subscription type">
                          <Pencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={row.active ? 'Deactivate' : 'Reactivate'}>
                        <ActionIcon variant="filled" color={row.active ? 'orange' : 'green'} size="lg" radius="md" onClick={() => handleToggle(row)} aria-label="Toggle active">
                          <Power size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon variant="filled" color="red" size="lg" radius="md" onClick={() => handleDelete(row)} aria-label="Delete subscription type">
                          <Trash2 size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Subscription Type" size="sm">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Name" placeholder="e.g. NEW, MIG, P2P" required {...form.getInputProps('name')} />
            <Button type="submit" mt="sm">Save</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Rename — ${editRow?.name || ''}`} size="sm">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <TextInput label="Name" required {...editForm.getInputProps('name')} />
            <Text size="xs" c="dimmed">
              Renaming doesn't change deals already sold under the old name — they record what was sold at the time.
            </Text>
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
