const RecordView = require('../models/RecordView');

// Modules this feature is wired into - kept as an explicit allowlist (not "any string goes")
// so a typo'd module name from the client fails loudly instead of silently creating junk rows.
const VIEW_TRACKED_MODULES = ['dsr', 'pipeline', 'orders'];

// Idempotent - repeat views of the same record are a no-op, not a new row or an updated
// timestamp (the first-ever view is what matters for "new", not the most recent one).
async function markViewed(userId, module, recordId) {
  await RecordView.updateOne(
    { userId, module, recordId },
    { $setOnInsert: { userId, module, recordId } },
    { upsert: true }
  );
}

// Returns the subset of recordIds this user has already viewed in this module, as a Set of
// string ids - callers treat "not in the set" as "new".
async function getViewedSet(userId, module, recordIds) {
  if (!recordIds.length) return new Set();
  const rows = await RecordView.find({ userId, module, recordId: { $in: recordIds } })
    .select('recordId')
    .lean();
  return new Set(rows.map((r) => String(r.recordId)));
}

// Attaches `isNew` to each row of an already-fetched, already-paginated list - the one call site
// every list controller needs, so nobody has to repeat the Set-building dance themselves.
async function attachIsNew(userId, module, rows) {
  const viewed = await getViewedSet(userId, module, rows.map((r) => r._id));
  return rows.map((r) => ({ ...r, isNew: !viewed.has(String(r._id)) }));
}

module.exports = { VIEW_TRACKED_MODULES, markViewed, getViewedSet, attachIsNew };
