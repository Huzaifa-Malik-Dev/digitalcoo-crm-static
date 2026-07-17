import { useMemo, useState } from 'react';
import { Group, Stack, NumberInput, Text, ActionIcon, Tooltip, Alert } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Check, Info } from 'lucide-react';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchProducts, updateProduct } from '../../api/products';
import { fetchSubscriptionTypes } from '../../api/catalog';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

// The default Unit Price for each (Product x Subscription Type) combination - what a deal's Unit
// Price prefills to when that pair is picked. Always still editable on the deal itself.
//
// Laid out as a grid, one column per subscription type, because updating one rate is the common
// case and a modal per product would bury it. A cell only accepts a price where the product
// actually offers that type (see ProductsTab) - the server rejects a price for anything else,
// since nothing could ever select that combination.
export default function PricingTab({ canEdit }) {
  const queryClient = useQueryClient();
  const list = usePagedList(['products'], fetchProducts);
  const { data: typesData } = useQuery({ queryKey: ['catalog', 'subscription-types'], queryFn: () => fetchSubscriptionTypes() });
  // Columns are the catalog itself now, so adding a subscription type adds a column here.
  const types = (typesData?.data || []).filter((t) => t.active);

  // Keyed `${productId}:${typeId}` -> price. Only holds cells the user has actually touched.
  const [pending, setPending] = useState({});
  const [saving, setSaving] = useState(null);

  const offers = (row, typeId) => (row.subscriptionTypes || []).some((t) => t._id === typeId);
  const priceOf = (row, typeId) => {
    const key = `${row._id}:${typeId}`;
    if (key in pending) return pending[key];
    return row.pricing?.find((p) => p.subscriptionType?._id === typeId)?.defaultPrice ?? '';
  };
  const isDirty = (row) => types.some((t) => `${row._id}:${t._id}` in pending);

  const handleSave = async (row) => {
    setSaving(row._id);
    try {
      // Only types the product offers can carry a price; a blank/zero clears the preset rather
      // than storing a meaningless 0.
      const pricing = types
        .filter((t) => offers(row, t._id))
        .map((t) => ({ subscriptionType: t._id, defaultPrice: Number(priceOf(row, t._id)) || 0 }))
        .filter((p) => p.defaultPrice > 0);
      await updateProduct(row._id, { pricing });
      setPending((prev) => {
        const next = { ...prev };
        types.forEach((t) => delete next[`${row._id}:${t._id}`]);
        return next;
      });
      notifications.show({ color: 'green', message: `Pricing saved for "${row.title}"` });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      list.refetch();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save pricing', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setSaving(null);
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
          return cat ? <Tag>{cat.name}</Tag> : <Text size="xs" c="dimmed">—</Text>;
        },
      },
      ...types.map((type) => ({
        id: `price-${type._id}`,
        header: type.name,
        enableSorting: false,
        cell: (info) => {
          const row = info.row.original;
          if (!offers(row, type._id)) {
            return (
              <Tooltip label={`"${row.title}" doesn't offer ${type.name}. Assign it on the Products tab first.`} multiline w={240}>
                <Text size="sm" c="dimmed">—</Text>
              </Tooltip>
            );
          }
          if (!canEdit) {
            const v = priceOf(row, type._id);
            return v === '' ? <Text size="sm" c="dimmed">—</Text> : <Text size="sm">{AED(v)}</Text>;
          }
          return (
            <NumberInput
              size="xs"
              w={110}
              min={0}
              placeholder="—"
              value={priceOf(row, type._id)}
              onChange={(v) => setPending((prev) => ({ ...prev, [`${row._id}:${type._id}`]: v }))}
              aria-label={`${type.name} price for ${row.title}`}
            />
          );
        },
      })),
      ...(canEdit
        ? [
            {
              id: 'action',
              header: '',
              cell: (info) => {
                const row = info.row.original;
                if (!isDirty(row)) return null;
                return (
                  <Tooltip label="Save pricing for this product">
                    <ActionIcon
                      variant="filled"
                      color="green"
                      size="lg"
                      radius="md"
                      loading={saving === row._id}
                      onClick={() => handleSave(row)}
                      aria-label={`Save pricing for ${row.title}`}
                    >
                      <Check size={18} />
                    </ActionIcon>
                  </Tooltip>
                );
              },
            },
          ]
        : []),
    ],
    // types drives the columns themselves; pending/saving drive what each cell renders.
    [canEdit, types, pending, saving]
  );

  return (
    <Stack gap="md">
      <Alert color="blue" variant="light" icon={<Info size={16} />}>
        These are default prices — when someone picks this product and subscription type on a deal, the Unit Price
        starts here and stays editable. A column only accepts a price where the product offers that type; assign
        types on the Products tab. Leave a cell blank for no default.
      </Alert>

      {!types.length && (
        <Alert color="yellow" variant="light" icon={<Info size={16} />}>
          No active subscription types yet — add some on the Subscription Types tab, then assign them to categories.
        </Alert>
      )}

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
        emptyLabel="No products in the catalog yet — add one on the Products tab first"
      />
    </Stack>
  );
}
