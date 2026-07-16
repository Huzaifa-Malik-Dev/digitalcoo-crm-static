import api from './axios';

// Marks a record viewed by the current user (see server/services/recordViews.js) and
// optimistically clears its `isNew` flag in every cached list matching queryKeyBase, so the row's
// highlight (DataTable.jsx) disappears immediately on click instead of waiting for a refetch.
// Fire-and-forget on the network call - a missed "mark viewed" is a cosmetic no-op, never worth
// blocking or erroring the click that opened the record.
export function markViewed(queryClient, queryKeyBase, module, id) {
  api.post(`/views/${module}/${id}`).catch(() => {});
  queryClient.setQueriesData({ queryKey: queryKeyBase }, (old) => {
    // queryKeyBase is a prefix match, not an exact one - it can also catch a single-record query
    // sharing the same base key (e.g. Pipeline's ['pipeline', 'one', dealId], whose `data` is one
    // object, not a list). Only touch entries that are actually the paginated list shape.
    if (!Array.isArray(old?.data)) return old;
    return { ...old, data: old.data.map((r) => (String(r._id) === String(id) ? { ...r, isNew: false } : r)) };
  });
}
