import { Stack, Paper, Group, Text, Select, NumberInput, Button, ActionIcon, Tooltip, SimpleGrid } from '@mantine/core';
import { Plus, Trash2, X } from 'lucide-react';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

export const emptyRow = () => ({ price: '', qty: 1 });
export const emptyBlock = () => ({ cat: '', product: '', sr: '', rows: [emptyRow()] });

// A saved deal/order's lineItems (server shape) -> the shape this editor's form state expects.
// Falls back to a single blank block so a record with no line items still renders an editable row
// rather than an empty void.
export function toFormLineItems(lineItems) {
  if (!lineItems?.length) return [emptyBlock()];
  return lineItems.map((b) => ({
    cat: b.cat || '',
    product: b.product || '',
    sr: b.sr || '',
    rows: b.rows?.length ? b.rows.map((r) => ({ price: r.price ?? '', qty: r.qty ?? 1 })) : [emptyRow()],
  }));
}

// Strips the editor's display-only quirks (blank price === "not filled in yet") before submit.
// mrc/blockMrc are never sent - the server always recomputes them (server/utils/lineItems.js).
export function toApiLineItems(lineItems) {
  return (lineItems || []).map((b) => ({
    cat: b.cat || '',
    product: b.product || '',
    sr: b.sr || '',
    rows: (b.rows || []).map((r) => ({ price: r.price === '' ? 0 : Number(r.price), qty: Number(r.qty) || 1 })),
  }));
}

export function totalMrc(lineItems) {
  return (lineItems || []).reduce(
    (sum, b) => sum + (b.rows || []).reduce((s, r) => s + (Number(r.price) || 0) * (Number(r.qty) || 0), 0),
    0
  );
}

// Validates a variable-length lineItems array into Mantine's flat FormErrors shape
// ({ 'lineItems.0.rows.1.price': 'message' }) - getInputProps picks each error up automatically by
// the same path. Has to be done in a whole-form `validate` function rather than the per-field
// record style used elsewhere, since you can't statically declare a validator per array index.
export function validateLineItems(lineItems, path = 'lineItems') {
  const errors = {};
  (lineItems || []).forEach((block, i) => {
    if (!block.cat) errors[`${path}.${i}.cat`] = 'Required';
    if (!block.product) errors[`${path}.${i}.product`] = 'Required';
    if (!block.sr) errors[`${path}.${i}.sr`] = 'Required';
    (block.rows || []).forEach((row, j) => {
      if (!(Number(row.price) > 0)) errors[`${path}.${i}.rows.${j}.price`] = 'Required';
      if (!(Number(row.qty) >= 1)) errors[`${path}.${i}.rows.${j}.qty`] = 'Required';
    });
  });
  return errors;
}

// Repeatable line items for a Pipeline deal / Back Office order. Two nesting levels:
//   BLOCK = one {Category, Product, Subscription Type} combination
//     ROW  = one {Unit Price, Quantity} pair within it
// so a single deal can bundle several products, and one product can be sold at several price
// points (e.g. 3 units at 100 and 2 at 150). Total MRC sums every row of every block.
//
// Shared by PipelineDealPanel and BackofficePage so the two can never drift apart on the shape or
// the arithmetic. Deliberately uses plain conditional rendering rather than Mantine's <Collapse>,
// which is broken on this React 19 + Mantine 9.4.1 combination (renders to the DOM but stays
// permanently height:0/display:none regardless of the `in` prop).
//
// Category, product and subscription type all come from the admin-managed catalog (Products page),
// not a hardcoded list - so `categories` and `products` are passed in from whatever the page
// fetched. A block's Subscription Type options are narrowed to the ones its chosen PRODUCT offers
// (which the product's category in turn allows), so an impossible combination can't be picked.
//
// `savedLineItems` is the record as last saved, used only for the stale-value fallback: a block
// saved under a category/product/type that's since been renamed, deactivated or removed from the
// catalog must still display, since Mantine's Select only renders a value present in its `data`
// and would otherwise go blank - which reads as data loss rather than "not in the current
// catalog". The server applies the same tolerance on write (services/catalog.js).
export default function LineItemsEditor({ form, path = 'lineItems', products = [], categories = [], savedLineItems = [], disabled = false }) {
  const blocks = form.values[path] || [];
  const total = totalMrc(blocks);

  const addBlock = () => form.insertListItem(path, emptyBlock());
  const removeBlock = (i) => form.removeListItem(path, i);
  const addRow = (i) => form.insertListItem(`${path}.${i}.rows`, emptyRow());
  const removeRow = (i, j) => form.removeListItem(`${path}.${i}.rows`, j);

  // Picking a Category/Product/Subscription Type combination prefills Unit Price from the
  // product's preset (Products > Pricing), if one is configured. Only ever fills a row the user
  // hasn't typed into - never overwrites a price they entered themselves.
  const applyPricePreset = (i, patch) => {
    const block = { ...blocks[i], ...patch };
    if (!block.product || !block.sr) return;
    // Line items carry catalog NAMES (a record of what was sold), while pricing is keyed by the
    // subscription type's record - so the preset is matched by name.
    const preset = products
      .find((p) => p.title === block.product)
      ?.pricing?.find((pr) => pr.subscriptionType?.name === block.sr);
    if (!preset) return;
    (block.rows || []).forEach((row, j) => {
      if (row.price === '' || row.price === 0) form.setFieldValue(`${path}.${i}.rows.${j}.price`, preset.defaultPrice);
    });
  };

  return (
    <Stack gap="sm">
      <Paper
        withBorder
        radius="md"
        p="sm"
        style={{ borderLeft: '4px solid var(--mantine-color-grape-6)' }}
      >
        <Group justify="space-between" align="center">
          <div>
            <Text size="xs" c="dimmed">Total MRC / month</Text>
            <Text size="lg" fw={700}>{AED(total)}</Text>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Text size="xs" c="dimmed">Annual</Text>
            <Text size="sm" fw={600}>{AED(total * 12)}</Text>
          </div>
        </Group>
      </Paper>

      {blocks.map((block, i) => {
        const saved = savedLineItems?.[i];
        const categoryNames = categories.map((c) => c.name);
        const categoryOptions = saved?.cat && !categoryNames.includes(saved.cat) ? [...categoryNames, saved.cat] : categoryNames;

        const productsInCat = products.filter((p) => !block.cat || p.category?.name === block.cat);
        const productOptions = productsInCat.map((p) => p.title);
        if (saved?.product && !productOptions.includes(saved.product)) productOptions.push(saved.product);

        // Only what the chosen product actually offers - which its category had to allow first.
        // Before a product is picked there's nothing to narrow by, so fall back to the category's
        // own list (and to every type if even that isn't chosen yet).
        const chosenProduct = products.find((p) => p.title === block.product);
        const chosenCategory = categories.find((c) => c.name === block.cat);
        const srSource = chosenProduct?.subscriptionTypes || chosenCategory?.subscriptionTypes || [];
        const srNames = srSource.map((t) => t.name);
        const srOptions = saved?.sr && !srNames.includes(saved.sr) ? [...srNames, saved.sr] : srNames;
        const blockMrc = (block.rows || []).reduce((s, r) => s + (Number(r.price) || 0) * (Number(r.qty) || 0), 0);

        return (
          <Paper
            key={i}
            withBorder
            radius="md"
            p="md"
            style={{ borderLeft: '4px solid var(--mantine-color-blue-6)' }}
          >
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>Line Item {i + 1}</Text>
              {!disabled && (
                <Tooltip label={blocks.length === 1 ? 'At least one line item is required' : 'Remove this line item'} withArrow>
                  <div>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => removeBlock(i)}
                      disabled={blocks.length === 1}
                      aria-label="Remove line item"
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </div>
                </Tooltip>
              )}
            </Group>

            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" mb="sm">
              <Select
                label="Category"
                withAsterisk
                data={categoryOptions}
                disabled={disabled}
                {...form.getInputProps(`${path}.${i}.cat`)}
                onChange={(v) => {
                  form.setFieldValue(`${path}.${i}.cat`, v);
                  // The chosen product may not exist under the new category - clear it rather than
                  // leave a mismatched pair saved.
                  if (block.product && !products.some((p) => p.title === block.product && p.category?.name === v)) {
                    form.setFieldValue(`${path}.${i}.product`, '');
                  }
                }}
              />
              <Select
                label="Product"
                withAsterisk
                data={productOptions}
                searchable
                disabled={disabled}
                {...form.getInputProps(`${path}.${i}.product`)}
                onChange={(v) => {
                  form.setFieldValue(`${path}.${i}.product`, v);
                  // Subscription types are per-product, so one already picked may not be on offer
                  // for the new product - clear it rather than leave an unsellable pair saved.
                  const nextOffers = products.find((p) => p.title === v)?.subscriptionTypes || [];
                  if (block.sr && !nextOffers.some((t) => t.name === block.sr)) {
                    form.setFieldValue(`${path}.${i}.sr`, '');
                    return;
                  }
                  applyPricePreset(i, { product: v });
                }}
              />
              <Select
                label="Subscription Type"
                withAsterisk
                data={srOptions}
                disabled={disabled}
                {...form.getInputProps(`${path}.${i}.sr`)}
                onChange={(v) => {
                  form.setFieldValue(`${path}.${i}.sr`, v);
                  applyPricePreset(i, { sr: v });
                }}
              />
            </SimpleGrid>

            <Stack gap="xs">
              {(block.rows || []).map((row, j) => (
                <Paper
                  key={j}
                  radius="sm"
                  p="xs"
                  // A theme-aware token, not a hardcoded grey - the nested row must stay legible
                  // against both the light and dark app backgrounds.
                  style={{ background: 'var(--mantine-color-default-hover)' }}
                >
                  <Group align="flex-end" wrap="nowrap" gap="xs">
                    <NumberInput
                      label="Unit Price"
                      withAsterisk
                      min={0}
                      disabled={disabled}
                      style={{ flex: 1 }}
                      {...form.getInputProps(`${path}.${i}.rows.${j}.price`)}
                    />
                    <NumberInput
                      label="Quantity"
                      withAsterisk
                      min={1}
                      disabled={disabled}
                      style={{ flex: 1 }}
                      {...form.getInputProps(`${path}.${i}.rows.${j}.qty`)}
                    />
                    <div style={{ flex: 1 }}>
                      <Text size="xs" c="dimmed">Subtotal</Text>
                      <Text size="sm" fw={600}>{AED((Number(row.price) || 0) * (Number(row.qty) || 0))}</Text>
                    </div>
                    {!disabled && (
                      <Tooltip label={block.rows.length === 1 ? 'At least one row is required' : 'Remove this row'} withArrow>
                        <div>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => removeRow(i, j)}
                            disabled={block.rows.length === 1}
                            aria-label="Remove row"
                          >
                            <X size={16} />
                          </ActionIcon>
                        </div>
                      </Tooltip>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>

            <Group justify="space-between" mt="xs">
              {!disabled ? (
                <Button variant="subtle" size="xs" leftSection={<Plus size={14} />} onClick={() => addRow(i)}>
                  Add price / quantity row
                </Button>
              ) : <div />}
              <Text size="xs" c="dimmed">Line item subtotal: <b>{AED(blockMrc)}</b></Text>
            </Group>
          </Paper>
        );
      })}

      {!disabled && (
        <Button variant="light" leftSection={<Plus size={16} />} onClick={addBlock}>
          Add line item
        </Button>
      )}
    </Stack>
  );
}
