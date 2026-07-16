import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';

const DEFAULT_LIMIT = Number(import.meta.env.VITE_PAGE_SIZE) || 50;

// Standard paged-list state machine: page/limit/search/extra-filters -> query key -> fetch.
// - search is debounced before it ever touches the query key, so typing doesn't refetch per keystroke.
// - placeholderData: keepPreviousData keeps the old page visible while the next one loads,
//   instead of flashing empty/loading and jumping the table.
export function usePagedList(queryKeyBase, fetchFn, { filters = {} } = {}) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  // TanStack sorting-state shape ([{id, desc}]), single-column only - matches the backend's
  // single-field `sort`/`-sort` query param (server/utils/pagination.js).
  const [sorting, setSorting] = useState([]);
  const sort = sorting.length ? (sorting[0].desc ? `-${sorting[0].id}` : sorting[0].id) : undefined;

  const query = useQuery({
    queryKey: [...queryKeyBase, { page, limit, search: debouncedSearch, sort, ...filters }],
    queryFn: () => fetchFn({ page, limit, search: debouncedSearch || undefined, sort, ...filters }),
    placeholderData: keepPreviousData,
  });

  const onPageChange = (nextPage, nextLimit) => {
    if (nextLimit !== limit) {
      setLimit(nextLimit);
      setPage(1);
    } else {
      setPage(nextPage);
    }
  };

  const onSearchChange = (value) => {
    setSearch(value);
    setPage(1);
  };

  const onSortingChange = (updater) => {
    setSorting(updater);
    setPage(1);
  };

  return {
    data: query.data?.data || [],
    totalRowCount: query.data?.meta?.totalRowCount || 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    page,
    limit,
    search,
    sorting,
    onPageChange,
    onSearchChange,
    onSortingChange,
    refetch: query.refetch,
  };
}
