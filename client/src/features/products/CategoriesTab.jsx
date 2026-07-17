import { useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, MultiSelect, ActionIcon, Tooltip, Table, Text, Alert, Loader, Center } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Pencil, Trash2, Power, Info } from 'lucide-react';
import Tag from '../../components/Tag';
import { fetchCategories, createCategory, updateCategory, deleteCategory, fetchSubscriptionTypes } from '../../api/catalog';
import { useConfirm } from '../../context/ConfirmContext';

// A category owns the set of subscription types sellable under it. A product in that category can
// narrow the set but never widen it (enforced server-side in productController), so this screen is
// where "what can we sell as what" is actually decided.
export default function CategoriesTab({ canEdit }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['catalog', 'categories'], queryFn: () => fetchCategories() });
  const rows = data?.data || [];
  const { data: typesData } = useQuery({ queryKey: ['catalog', 'subscription-types'], queryFn: () => fetchSubscriptionTypes() });
  // Only active types are offerable; an inactive one already assigned still shows on its category
  // below, it just can't be newly picked here.
  const typeOptions = (typesData?.data || []).filter((t) => t.active).map((t) => ({ value: t._id, label: t.name }));

  const blank = { name: '', subscriptionTypes: [] };
  const form = useForm({ initialValues: blank, validate: { name: (v) => (v.trim() ? null : 'Name is required') } });
  const editForm = useForm({ initialValues: blank, validate: { name: (v) => (v.trim() ? null : 'Name is required') } });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['catalog'] });

  const handleCreate = async (values) => {
    try {
      await createCategory(values);
      notifications.show({ color: 'green', message: `Category "${values.name}" added` });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const openEdit = (row) => {
    setEditRow(row);
    editForm.setValues({ name: row.name, subscriptionTypes: (row.subscriptionTypes || []).map((t) => t._id) });
  };

  const handleEdit = async (values) => {
    // Removing a type here also unassigns it from every product in the category (the server does
    // the cleanup) - worth warning about, since it silently changes those products' pricing too.
    const removed = (editRow.subscriptionTypes || []).filter((t) => !values.subscriptionTypes.includes(t._id));
    if (removed.length) {
      const ok = await confirm({
        title: 'Remove subscription type(s) from this category?',
        message: `${removed.map((t) => t.name).join(', ')} will also be unassigned from every product in "${editRow.name}", along with any prices set for them. Deals already sold under them are unaffected.`,
        confirmLabel: 'Yes, remove',
        color: 'red',
      });
      if (!ok) return;
    }
    try {
      await updateCategory(editRow._id, values);
      notifications.show({ color: 'green', message: 'Category updated' });
      setEditRow(null);
      queryClient.invalidateQueries({ queryKey: ['products'] });
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
        : `"${row.name}" becomes selectable on new deals again.`,
      confirmLabel: row.active ? 'Yes, deactivate' : 'Yes, reactivate',
      color: row.active ? 'red' : 'green',
    });
    if (!ok) return;
    try {
      await updateCategory(row._id, { active: !row.active });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: `Delete "${row.name}"?`,
      message: 'This only works while the category has no products in it. Deactivate it instead if it\'s been used.',
      confirmLabel: 'Yes, delete',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteCategory(row._id);
      notifications.show({ color: 'green', message: 'Category deleted' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  return (
    <Stack gap="md">
      <Alert color="blue" variant="light" icon={<Info size={16} />}>
        A category decides which subscription types can be sold under it. Products in the category can then offer
        any of those (or fewer) — never more.
      </Alert>

      {canEdit && (
        <Group justify="flex-end">
          <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add Category</Button>
        </Group>
      )}

      <Table.ScrollContainer minWidth={560}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Category</Table.Th>
              <Table.Th>Assignable Subscription Types</Table.Th>
              <Table.Th>Status</Table.Th>
              {canEdit && <Table.Th w={140}>Actions</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {!rows.length && (
              <Table.Tr><Table.Td colSpan={4}><Text c="dimmed" size="sm" ta="center" py="md">No categories yet — add one to start building the catalog</Text></Table.Td></Table.Tr>
            )}
            {rows.map((row) => (
              <Table.Tr key={row._id}>
                <Table.Td><Text size="sm" fw={500}>{row.name}</Text></Table.Td>
                <Table.Td>
                  {row.subscriptionTypes?.length ? (
                    <Group gap={4}>
                      {row.subscriptionTypes.map((t) => (
                        <Tag key={t._id} size="xs" color={t.active ? 'blue' : 'gray'}>{t.name}</Tag>
                      ))}
                    </Group>
                  ) : (
                    <Text size="xs" c="dimmed">None assigned — nothing can be sold under this category yet</Text>
                  )}
                </Table.Td>
                <Table.Td><Tag color={row.active ? 'green' : 'gray'}>{row.active ? 'Active' : 'Inactive'}</Tag></Table.Td>
                {canEdit && (
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Tooltip label="Edit name / assigned types">
                        <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="Edit category">
                          <Pencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={row.active ? 'Deactivate' : 'Reactivate'}>
                        <ActionIcon variant="filled" color={row.active ? 'orange' : 'green'} size="lg" radius="md" onClick={() => handleToggle(row)} aria-label="Toggle active">
                          <Power size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon variant="filled" color="red" size="lg" radius="md" onClick={() => handleDelete(row)} aria-label="Delete category">
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

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Category" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Name" placeholder="e.g. GSM, FIXED, DIGITAL" required {...form.getInputProps('name')} />
            <MultiSelect
              label="Assignable subscription types"
              description="What can be sold under this category. You can add more later."
              data={typeOptions}
              searchable
              {...form.getInputProps('subscriptionTypes')}
            />
            <Button type="submit" mt="sm">Save</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Edit Category — ${editRow?.name || ''}`} size="md">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <TextInput label="Name" required {...editForm.getInputProps('name')} />
            <MultiSelect
              label="Assignable subscription types"
              description="Removing one also unassigns it from every product in this category."
              data={typeOptions}
              searchable
              {...editForm.getInputProps('subscriptionTypes')}
            />
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
