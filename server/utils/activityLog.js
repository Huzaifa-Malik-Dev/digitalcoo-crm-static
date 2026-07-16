// Human-readable action log to stdout (PM2 captures this) AND to the ActivityLog collection (for
// Admin > Activity Timeline). Every stdout line is tagged [ACTIVITY] so it's easy to isolate from
// morgan/mongoose/etc noise:
//   pm2 logs digitalcoo-crm | grep ACTIVITY
//   grep ACTIVITY ~/.pm2/logs/digitalcoo-crm-out.log
const { getRequestContext } = require('../middlewares/requestContext');

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return `${pad(d.getDate())}:${pad(d.getMonth() + 1)}:${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function actorLabel(user) {
  if (!user) return 'SYSTEM';
  return user.employeeId ? `${user.employeeId} (${user.name})` : user.name || 'UNKNOWN';
}

// user: the acting User doc (req.user) - message: what happened, already human-readable.
// Fire-and-forget: never awaited by any of its ~40 call sites, so the DB write happens in the
// background and a logging failure can never fail the request it's describing.
function logActivity(user, message) {
  console.log(`[ACTIVITY] [${timestamp()}] ${actorLabel(user)} ${message}`);

  // require()'d here, not at module load, to dodge a require-cycle: models pull in mongoose only,
  // but keeping the DB dependency out of this file's top-level import list is one less thing this
  // near-universally-imported utility can break on if the model file ever changes.
  const ActivityLog = require('../models/ActivityLog');
  const { ip, userAgent, module } = getRequestContext();
  ActivityLog.create({
    actorId: user?._id || null,
    actorLabel: actorLabel(user),
    message,
    module: module || 'other',
    ip,
    userAgent,
  }).catch((err) => console.error('[ACTIVITY] failed to persist to DB:', err.message));
}

function displayValue(v) {
  if (v === undefined || v === null || v === '') return '(empty)';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(empty)';
  return String(v);
}

// Compares `before`/`after` on the keys of `labels` ({ field: 'Readable Label' }) and returns
// "Label: old -> new" strings for only the fields that actually changed - never lists untouched
// fields, so an edit that only changes one thing doesn't produce a wall of no-op noise.
function diffFields(before, after, labels) {
  const parts = [];
  for (const [key, label] of Object.entries(labels)) {
    const oldVal = displayValue(before?.[key]);
    const newVal = displayValue(after?.[key]);
    if (oldVal !== newVal) parts.push(`${label}: ${oldVal} -> ${newVal}`);
  }
  return parts;
}

// Renders a details object as "Label: value, Label: value" for creation logs (no before/after,
// just what was set).
function describeFields(data, labels) {
  return Object.entries(labels)
    .map(([key, label]) => `${label}: ${displayValue(data?.[key])}`)
    .join(', ');
}

module.exports = { logActivity, diffFields, describeFields, actorLabel };
