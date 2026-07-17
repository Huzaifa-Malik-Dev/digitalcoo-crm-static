import { useMemo, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput, Select, MultiSelect, ActionIcon, Tooltip, Text, Alert } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, Pencil, Trash2, Power, Info } from 'lucide-react';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchProducts, createProduct, updateProduct, deleteProduct } from '../../api/products';
import { fetchCategories } from '../../api/catalog';
import { useConfirm } from '../../context/ConfirmContext';

export default function ProductsTab({ canEdit }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const list = usePagedList(['products'], fetchProducts);
  const { data: catData } = useQuery({ queryKey: ['catalog', 'categories'], queryFn: () => fetchCategories() });
  const categories = catData?.data || [];
  const activeCategories = categories.filter((c) => c.active);

  const blank = { title: '', category: '', subscriptionTypes: [] };
  const form = useForm({
    initialValues: blank,
    validate: { title: (v) => (v.trim() ? null : 'Title is required'), category: (v) => (v ? null : 'Category is required') },
  });
  const editForm = useForm({
    initialValues: blank,
    validate: { title: (v) => (v.trim() ? null : 'Title is required'), category: (v) => (v ? null : 'Category is required') },
  });

  // A product can only offer what its category allows, so the options come from the chosen
  // category - not the full type list. The server enforces the same rule (productController).
  const typeOptionsFor = (categoryId) => {
    const cat = categories.find((c) => c._id === categoryId);
    return (cat?.subscriptionTypes || []).map((t) => ({ value: t._id, label: t.name }));
  };
  const createTypeOptions = typeOptionsFor(form.values.category);
  const editTypeOptions = typeOptionsFor(editForm.values.category);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] });
    list.refetch();
  };

  const openEdit = (row) => {
    setEditRow(row);
    editForm.setValues({
      title: row.title,
      category: row.category?._id || '',
      subscriptionTypes: (row.subscriptionTypes || []).map((t) => t._id),
    });
  };

  const handleCreate = async (values) => {
    try {
      await createProduct(values);
      notifications.show({ color: 'green', message: `Product "${values.title}" added` });
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
        ? `"${row.title}" will no longer be selectable when building new deals. Deals that already include it are unaffected.`
        : `"${row.title}" will become selectable again in deals.`,
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
      {
        id: 'category',
        header: 'Category',
        enableSorting: false,
        cell: (info) => {
          const cat = info.row.original.category;
          return cat ? <Tag color={cat.active ? 'blue' : 'gray'}>{cat.name}</Tag> : <Text size="xs" c="dimmed">—</Text>;
        },
      },
      {
        id: 'subscriptionTypes',
        header: 'Subscription Types',
        enableSorting: false,
        cell: (info) => {
          const types = info.row.original.subscriptionTypes || [];
          if (!types.length) return <Text size="xs" c="dimmed">None — not sellable yet</Text>;
          return (
            <Group gap={4}>
              {types.map((t) => <Tag key={t._id} size="xs" color={t.active ? 'cyan' : 'gray'}>{t.name}</Tag>)}
            </Group>
          );
        },
      },
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
    [canEdit, categories]
  );

  const noCategories = !activeCategories.length;

  return (
    <Stack gap="md">
      {noCategories && (
        <Alert color="yellow" variant="light" icon={<Info size={16} />}>
          There are no active categories yet. Add one on the Categories tab first — every product belongs to a category.
        </Alert>
      )}

      <Group justify="space-between">
        <div />
        {canEdit && (
          <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)} disabled={noCategories}>
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
            <Select
              label="Category"
              data={activeCategories.map((c) => ({ value: c._id, label: c.name }))}
              required
              searchable
              {...form.getInputProps('category')}
              onChange={(v) => {
                form.setFieldValue('category', v);
                // Types are category-specific, so anything already picked may no longer be allowed.
                form.setFieldValue('subscriptionTypes', []);
              }}
            />
            <MultiSelect
              label="Subscription types this product offers"
              description={
                form.values.category
                  ? 'Only what the chosen category allows. Add more to the category to widen this.'
                  : 'Pick a category first.'
              }
              data={createTypeOptions}
              disabled={!form.values.category}
              searchable
              {...form.getInputProps('subscriptionTypes')}
            />
            <Button type="submit" mt="sm">Save Product</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Edit Product — ${editRow?.title || ''}`} size="md">
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <TextInput label="Title" required {...editForm.getInputProps('title')} />
            <Select
              label="Category"
              // A product sitting in a since-deactivated category must still show it rather than
              // going blank - same stale-value pattern used across the app.
              data={(editRow?.category && !activeCategories.some((c) => c._id === editRow.category._id)
                ? [...activeCategories, editRow.category]
                : activeCategories
              ).map((c) => ({ value: c._id, label: c.name }))}
              required
              searchable
              {...editForm.getInputProps('category')}
              onChange={(v) => {
                editForm.setFieldValue('category', v);
                if (v !== editRow?.category?._id) editForm.setFieldValue('subscriptionTypes', []);
              }}
            />
            <MultiSelect
              label="Subscription types this product offers"
              description="Only what its category allows. Removing one also drops its price preset."
              data={editTypeOptions}
              searchable
              {...editForm.getInputProps('subscriptionTypes')}
            />
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
