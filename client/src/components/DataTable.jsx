import { useReactTable, getCoreRowModel, flexRender } from '@tanstack/react-table';
import { Table, Pagination, Group, Text, TextInput, Select, Loader, Center, Box, Tooltip, UnstyledButton } from '@mantine/core';
import { Search, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

// Thin wrapper around @tanstack/react-table for server-driven data: the caller owns
// page/limit/sort/search state and the fetch (via TanStack Query); this component only
// renders whatever page it's handed and emits UI events back up. Reused by every module's
// list screen (DSR, Pipeline, Back Office, MIS, ...) so pagination/search/sort behavior
// stays identical across the app.
export default function DataTable({
  columns,
  data,
  totalRowCount = 0,
  page,
  limit,
  onPageChange,
  search,
  onSearchChange,
  isLoading,
  emptyLabel = 'No records found',
  onRowClick,
  sorting = [],
  onSortingChange = () => {},
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    enableMultiSort: false,
    state: { sorting },
    onSortingChange,
  });

  const totalPages = Math.max(1, Math.ceil(totalRowCount / limit));

  return (
    <Box>
      <Group justify="space-between" mb="sm">
        <TextInput
          placeholder="Search..."
          leftSection={<Search size={14} />}
          value={search}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          w={280}
        />
        <Text size="sm" c="dimmed">{totalRowCount.toLocaleString()} records</Text>
      </Group>

      <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <Table.Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <Table.Th key={header.id} style={{ whiteSpace: 'nowrap' }}>
                      {canSort ? (
                        <UnstyledButton onClick={header.column.getToggleSortingHandler()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Text size="sm" fw={700} span>{label}</Text>
                          {sortDir === 'asc' ? <ChevronUp size={14} /> : sortDir === 'desc' ? <ChevronDown size={14} /> : <ChevronsUpDown size={14} opacity={0.4} />}
                        </UnstyledButton>
                      ) : (
                        label
                      )}
                    </Table.Th>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Thead>
          <Table.Tbody>
            {isLoading ? (
              <Table.Tr>
                <Table.Td colSpan={columns.length}>
                  <Center py="xl"><Loader size="sm" /></Center>
                </Table.Td>
              </Table.Tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={columns.length}>
                  <Center py="xl"><Text c="dimmed">{emptyLabel}</Text></Center>
                </Table.Td>
              </Table.Tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <Table.Tr
                  key={row.id}
                  style={{
                    ...(onRowClick ? { cursor: 'pointer' } : null),
                    // "New" (never viewed by this user - see server/services/recordViews.js)
                    // rows get a light tint that clears itself once the row's isNew flips false,
                    // which the View/Edit click handlers do optimistically on click.
                    ...(row.original?.isNew ? { backgroundColor: 'var(--row-new-bg)' } : null),
                  }}
                  onClick={
                    onRowClick
                      ? (e) => {
                          // Don't hijack clicks on buttons/links/inputs living inside a cell (row actions, selects, etc.)
                          if (e.target.closest('button, a, input, select, [role="button"]')) return;
                          onRowClick(row.original);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => {
                    // Long free-text columns (Remarks, notes, ...) opt into `truncate` on their
                    // column def instead of the default nowrap — otherwise one long note blows
                    // the whole table out into endless horizontal scroll. Ellipsis + hover tooltip
                    // keeps every row the same height while the full text stays one hover away.
                    const { truncate, truncateWidth } = cell.column.columnDef;
                    if (truncate) {
                      const text = String(cell.getValue() ?? '');
                      return (
                        <Table.Td key={cell.id} style={{ maxWidth: truncateWidth || 260 }}>
                          <Tooltip label={text} multiline w={320} disabled={text.length < 40} openDelay={300} withinPortal>
                            <Text size="sm" truncate="end">{text || '-'}</Text>
                          </Tooltip>
                        </Table.Td>
                      );
                    }
                    return (
                      <Table.Td key={cell.id} style={{ whiteSpace: 'nowrap' }}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Td>
                    );
                  })}
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Group justify="space-between" mt="md">
        <Group gap="xs">
          <Text size="sm" c="dimmed">Rows per page</Text>
          <Select
            data={['20', '50', '100', '200']}
            value={String(limit)}
            onChange={(v) => onPageChange(1, Number(v))}
            w={80}
            size="xs"
            aria-label="Rows per page"
          />
        </Group>
        <Pagination
          total={totalPages}
          value={page}
          onChange={(p) => onPageChange(p, limit)}
          withEdges
          size="sm"
          getControlProps={(control) => ({
            first: { 'aria-label': 'First page' },
            previous: { 'aria-label': 'Previous page' },
            next: { 'aria-label': 'Next page' },
            last: { 'aria-label': 'Last page' },
          }[control])}
        />
      </Group>
    </Box>
  );
}
