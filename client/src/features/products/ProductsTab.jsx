import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Pencil, Trash2, Power } from 'lucide-react';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchProducts, createProduct, updateProduct, deleteProduct } from '../../api/products';
import { useConfirm } from '../../context/ConfirmContext';

export default function ProductsTab({ canEdit }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const list = usePagedList(['products'], fetchProducts);

  const form = useForm({
    initialValues: { title: '', cat: '' },
  });

  const editForm = useForm({
    initialValues: { title: '', cat: '' },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    list.refetch();
  };

  const openEdit = (row) => {
    setEditRow(row);
    editForm.setValues({
      title: row.title,
      cat: row.cat,
    });
  };

  const handleCreate = async (values) => {
    try {
      await createProduct(values);
      notifications.show({ color: 'green', message: 'Product created' });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleEdit = async (values) => {
    try {
      await updateProduct(editRow._id, values);
      notifications.show({ color: 'green', message: 'Product updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleToggleActive = async (row) => {
    const ok = await confirm({
      title: row.active ? 'Deactivate product?' : 'Activate product?',
      message: row.active
        ? `"${row.title}" will no longer be selectable when building new pipeline deals.`
        : `"${row.title}" will become selectable again in pipeline deals.`,
      confirmLabel: row.active ? 'Yes, deactivate' : 'Yes, activate',
      color: row.active ? 'red' : 'green',
    });
    if (!ok) return;
    try {
      await updateProduct(row._id, { active: !row.active });
      notifications.show({ color: 'green', message: `Product ${row.active ? 'deactivated' : 'activated'}` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Delete product?',
      message: `Permanently delete "${row.title}"? This cannot be undone. Consider deactivating instead if it may be reused later.`,
      confirmLabel: 'Yes, delete',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteProduct(row._id);
      notifications.show({ color: 'green', message: 'Product deleted' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const columns = useMemo(
    () => [
      { accessorKey: 'title', header: 'Product' },
      { accessorKey: 'cat', header: 'Category', cell: (info) => <Tag>{info.getValue()}</Tag> },
      {
        accessorKey: 'active',
        header: 'Status',
        cell: (info) => <Tag color={info.getValue() ? 'green' : 'gray'}>{info.getValue() ? 'Active' : 'Inactive'}</Tag>,
      },
      ...(canEdit
        ? [
            {
              id: 'action',
              header: 'Actions',
              cell: (info) => {
                const row = info.row.original;
                return (
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label="Edit product">
                      <ActionIcon variant="filled" size="lg" radius="md" onClick={() => openEdit(row)} aria-label="Edit product">
                        <Pencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={row.active ? 'Deactivate' : 'Activate'}>
                      <ActionIcon variant="filled" color={row.active ? 'orange' : 'green'} size="lg" radius="md" onClick={() => handleToggleActive(row)} aria-label="Toggle active">
                        <Power size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete product">
                      <ActionIcon variant="filled" color="red" size="lg" radius="md" onClick={() => handleDelete(row)} aria-label="Delete product">
                        <Trash2 size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                );
              },
            },
          ]
        : []),
    ],
    [canEdit]
  );

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div />
        {canEdit && (
          <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            Add Product
          </Button>
        )}
      </Group>

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
        emptyLabel="No products in the catalog yet"
      />

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Product" size="md">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Title" required {...form.getInputProps('title')} />
            <TextInput label="Category" placeholder="e.g. Fixed, Mobile, Digital" required {...form.getInputProps('cat')} />
            <Button type="submit" mt="sm">Save Product</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Edit Product — ${editRow?.title || ''}`} size="md">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <TextInput label="Title" required {...editForm.getInputProps('title')} />
            <TextInput label="Category" required {...editForm.getInputProps('cat')} />
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
