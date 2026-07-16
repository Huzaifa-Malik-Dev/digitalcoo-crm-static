const { z } = require('zod');
const LeaveType = require('../models/LeaveType');
const Holiday = require('../models/Holiday');
const LeaveRequest = require('../models/LeaveRequest');
const User = require('../models/User');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { regexOr } = require('../utils/search');
const {
  computeLeaveBalance,
  createLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  revokeLeaveRequest,
} = require('../services/leave');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');

// Same shape as pipelineController.js's scopeFilter, field names adjusted for LeaveRequest -
// admin/hr see everything, everyone else sees their own requests plus anyone they're in the
// approval chain for.
function scopeFilter(user) {
  if (user.role === 'admin' || user.role === 'hr') return {};
  return { $or: [{ employee: user._id }, { tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }] };
}

// ---- Leave Types ----

const LEAVE_TYPE_FIELD_LABELS = { name: 'Name', annualDays: 'Annual Days', accrualMethod: 'Accrual Method', minServiceMonths: 'Min. Service (months)', paid: 'Paid', requiresDocument: 'Requires Document', active: 'Active' };

const leaveTypeSchema = z.object({
  name: z.string().trim().min(1),
  annualDays: z.number().min(0),
  accrualMethod: z.enum(['monthly', 'lump-sum']),
  minServiceMonths: z.number().min(0).optional().default(0),
  paid: z.boolean().optional().default(true),
  requiresDocument: z.boolean().optional().default(false),
});

async function listLeaveTypes(req, res, next) {
  try {
    const filter = {};
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const types = await LeaveType.find(filter).sort({ name: 1 }).lean();
    res.json({ data: types });
  } catch (err) {
    next(err);
  }
}

async function createLeaveType(req, res, next) {
  try {
    const parsed = leaveTypeSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const leaveType = await LeaveType.create({ ...parsed.data, createdBy: req.user._id });
    logActivity(req.user, `created leave type "${leaveType.name}" (${leaveType.annualDays} days/yr, ${leaveType.accrualMethod})`);
    res.status(201).json({ data: leaveType });
  } catch (err) {
    next(err);
  }
}

async function updateLeaveType(req, res, next) {
  try {
    const parsed = leaveTypeSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const before = await LeaveType.findById(req.params.id).lean();
    if (!before) throw new AppError('Leave type not found', 404);
    const leaveType = await LeaveType.findByIdAndUpdate(req.params.id, parsed.data, { new: true });

    const changes = diffFields(before, leaveType.toObject(), LEAVE_TYPE_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited leave type "${leaveType.name}": ${changes.join(', ')}`);
    res.json({ data: leaveType });
  } catch (err) {
    next(err);
  }
}

// ---- Holidays ----

const holidaySchema = z.object({ name: z.string().trim().min(1), date: z.string().min(1) });

async function listHolidays(req, res, next) {
  try {
    const filter = {};
    if (req.query.year) filter.date = { $gte: `${req.query.year}-01-01`, $lte: `${req.query.year}-12-31` };
    const holidays = await Holiday.find(filter).sort({ date: 1 }).lean();
    res.json({ data: holidays });
  } catch (err) {
    next(err);
  }
}

async function createHoliday(req, res, next) {
  try {
    const parsed = holidaySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    if (await Holiday.exists({ date: parsed.data.date })) throw new AppError('A holiday is already set for this date', 400);
    const holiday = await Holiday.create({ ...parsed.data, createdBy: req.user._id });
    logActivity(req.user, `added holiday "${holiday.name}" on ${holiday.date}`);
    res.status(201).json({ data: holiday });
  } catch (err) {
    next(err);
  }
}

async function deleteHoliday(req, res, next) {
  try {
    const holiday = await Holiday.findByIdAndDelete(req.params.id);
    if (!holiday) throw new AppError('Holiday not found', 404);
    logActivity(req.user, `removed holiday "${holiday.name}" on ${holiday.date}`);
    res.json({ data: { _id: holiday._id } });
  } catch (err) {
    next(err);
  }
}

// ---- Leave Balance ----

async function getLeaveBalance(req, res, next) {
  try {
    const employeeId = req.query.employee || req.user._id;
    if (String(employeeId) !== String(req.user._id) && req.user.role !== 'admin' && req.user.role !== 'hr') {
      const employeeChain = await User.findById(employeeId).select('managerChain').lean();
      const isManager = (employeeChain?.managerChain || []).map(String).includes(String(req.user._id));
      if (!isManager) throw new AppError('You cannot view this employee\'s leave balance', 403);
    }
    const employee = await User.findById(employeeId).lean();
    if (!employee) throw new AppError('Employee not found', 404);
    const types = await LeaveType.find({ active: true }).sort({ name: 1 }).lean();
    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    const balances = await Promise.all(types.map(async (t) => ({ leaveType: t, ...(await computeLeaveBalance(employee, t, asOf)) })));
    res.json({ data: balances });
  } catch (err) {
    next(err);
  }
}

// ---- Leave Requests ----

async function listMyLeaveRequests(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const employeeId = req.query.employee || req.user._id;
    if (String(employeeId) !== String(req.user._id) && req.user.role !== 'admin' && req.user.role !== 'hr') {
      throw new AppError('You can only view your own leave requests', 403);
    }
    const filter = { employee: employeeId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      // leaveType is a ref, not a plain string - a name search has to resolve to the matching
      // LeaveType _id(s) first, same reasoning as the employee-name lookup in listApprovals.
      const matchingLeaveTypes = await LeaveType.find({ name: re }).select('_id').lean();
      filter.$or = [
        ...regexOr(term, ['status', 'reason']),
        { leaveType: { $in: matchingLeaveTypes.map((t) => t._id) } },
      ];
    }
    const [data, totalRowCount] = await Promise.all([
      LeaveRequest.find(filter).populate('leaveType', 'name paid').populate('approver', 'name').sort(sort).skip(skip).limit(limit).lean(),
      LeaveRequest.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function listApprovals(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = { ...scopeFilter(req.user) };
    filter.status = req.query.status || 'pending';
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      // leaveType is a ref (not a plain string) - resolve name matches to _id(s) first, same
      // shape as the employee-name lookup below. status is deliberately left out of the $or:
      // it's already an exact top-level match from the tab filter above, so re-matching it here
      // would only ever narrow further, never surface results the tab wouldn't already show.
      const [matchingEmployees, matchingLeaveTypes] = await Promise.all([
        User.find({ name: re }).select('_id').lean(),
        LeaveType.find({ name: re }).select('_id').lean(),
      ]);
      filter.$and = [
        {
          $or: [
            ...regexOr(term, ['reason']),
            { employee: { $in: matchingEmployees.map((u) => u._id) } },
            { leaveType: { $in: matchingLeaveTypes.map((t) => t._id) } },
          ],
        },
      ];
    }
    const [data, totalRowCount] = await Promise.all([
      LeaveRequest.find(filter).populate('employee', 'name employeeId').populate('leaveType', 'name paid').populate('approver', 'name').sort(sort).skip(skip).limit(limit).lean(),
      LeaveRequest.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

const createRequestSchema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  reason: z.string().optional().default(''),
  document: z.string().optional().default(''),
  employee: z.string().optional(), // HR/Admin logging on behalf of someone else
});

async function createRequest(req, res, next) {
  try {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const employeeId = parsed.data.employee || req.user._id;
    if (String(employeeId) !== String(req.user._id) && req.user.role !== 'admin' && req.user.role !== 'hr') {
      throw new AppError('You can only request leave for yourself', 403);
    }
    const request = await createLeaveRequest(employeeId, parsed.data, req.user);
    res.status(201).json({ data: request });
  } catch (err) {
    next(err);
  }
}

async function approveRequest(req, res, next) {
  try {
    const request = await approveLeaveRequest(req.params.id, req.user);
    res.json({ data: request });
  } catch (err) {
    next(err);
  }
}

async function rejectRequest(req, res, next) {
  try {
    const request = await rejectLeaveRequest(req.params.id, req.user, req.body.reason);
    res.json({ data: request });
  } catch (err) {
    next(err);
  }
}

async function cancelRequest(req, res, next) {
  try {
    const request = await cancelLeaveRequest(req.params.id, req.user);
    res.json({ data: request });
  } catch (err) {
    next(err);
  }
}

async function revokeRequest(req, res, next) {
  try {
    const request = await revokeLeaveRequest(req.params.id, req.user, req.body.reason);
    res.json({ data: request });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  listHolidays,
  createHoliday,
  deleteHoliday,
  getLeaveBalance,
  listMyLeaveRequests,
  listApprovals,
  createRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  revokeRequest,
};
