const { z } = require('zod');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { logActivity } = require('../utils/activityLog');

// Same scoping shape as leaveController.js/pipelineController.js.
function scopeFilter(user) {
  if (user.role === 'admin' || user.role === 'hr') return {};
  return { $or: [{ employee: user._id }, { tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }] };
}

async function listAttendance(req, res, next) {
  try {
    if (!req.query.year || !req.query.month) throw new AppError('year and month are required', 400);
    const start = `${req.query.year}-${req.query.month}-01`;
    const end = `${req.query.year}-${req.query.month}-31`;
    const filter = { ...scopeFilter(req.user), date: { $gte: start, $lte: end } };
    if (req.query.employee) filter.employee = req.query.employee;
    const rows = await Attendance.find(filter).populate('employee', 'name employeeId').lean();
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

const bulkEntrySchema = z.object({
  employee: z.string().min(1),
  date: z.string().min(1),
  status: z.enum(['Present', 'Absent', 'Half Day', 'On Leave', 'Holiday', 'Weekend']),
  notes: z.string().optional().default(''),
});
const bulkSchema = z.object({ entries: z.array(bulkEntrySchema).min(1) });

// Bulk upsert - kept as a bulkWrite even though the client now only ever sends one cell per call
// (immediate save-on-click, no more "Save Changes" button) since a single-entry array is just a
// 1-op bulkWrite and this stays ready for a real multi-cell case later without a second endpoint.
async function bulkUpsertAttendance(req, res, next) {
  try {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    // Attendance can only ever be marked for today - not backfilled for a day that's already
    // passed (which would let a record be quietly rewritten after the fact) and not pre-filled
    // for a day that hasn't happened yet. Enforced here, not just by graying out other cells in
    // the UI, since that's the only real enforcement point.
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.data.entries.some((e) => e.date !== today)) {
      throw new AppError('Attendance can only be marked for today', 400);
    }

    const employeeIds = [...new Set(parsed.data.entries.map((e) => e.employee))];
    const employees = await User.find({ _id: { $in: employeeIds } }).select('managerChain').lean();
    const chainById = new Map(employees.map((e) => [String(e._id), e.managerChain || []]));

    const ops = parsed.data.entries.map((e) => {
      const chain = chainById.get(e.employee) || [];
      return {
        updateOne: {
          filter: { employee: e.employee, date: e.date },
          update: {
            $set: {
              employee: e.employee,
              tlId: chain[0] || null,
              teamHeadId: chain[1] || null,
              salesHeadId: chain[2] || null,
              date: e.date,
              status: e.status,
              notes: e.notes,
              markedBy: req.user._id,
              linkedLeaveRequest: null,
            },
          },
          upsert: true,
        },
      };
    });

    const result = await Attendance.bulkWrite(ops);
    logActivity(req.user, `updated attendance for ${employeeIds.length} employee(s), ${ops.length} record(s)`);
    res.json({ data: { matched: result.matchedCount, upserted: result.upsertedCount, modified: result.modifiedCount } });
  } catch (err) {
    next(err);
  }
}

// Cycling a cell back to "blank" should mean genuinely unmarked - not a status value meaning
// "nothing" (the enum has no such value), but the record actually gone, same as a day nobody
// ever clicked. Same today-only rule as the upsert side: can't un-mark a past day either.
async function clearAttendance(req, res, next) {
  try {
    const { employeeId, date } = req.params;
    const today = new Date().toISOString().slice(0, 10);
    if (date !== today) throw new AppError('Attendance can only be changed for today', 400);

    const result = await Attendance.deleteOne({ employee: employeeId, date });
    if (result.deletedCount) logActivity(req.user, `cleared attendance mark for ${date}`);
    res.json({ data: { deleted: result.deletedCount } });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAttendance, bulkUpsertAttendance, clearAttendance };
