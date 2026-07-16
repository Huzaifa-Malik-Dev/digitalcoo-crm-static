const User = require('../models/User');
const LeaveType = require('../models/LeaveType');
const LeaveRequest = require('../models/LeaveRequest');
const Holiday = require('../models/Holiday');
const Attendance = require('../models/Attendance');
const { notify } = require('./notify');
const { logActivity } = require('../utils/activityLog');
const { countWorkDays, isWeekend } = require('../utils/workdays');
const AppError = require('../utils/AppError');

function monthsBetween(fromDate, toDate) {
  let months = (toDate.getFullYear() - fromDate.getFullYear()) * 12 + (toDate.getMonth() - fromDate.getMonth());
  if (toDate.getDate() < fromDate.getDate()) months -= 1;
  return Math.max(0, months);
}

async function holidaySetForRange(startDate, endDate) {
  const rows = await Holiday.find({ date: { $gte: startDate, $lte: endDate } }).select('date').lean();
  return new Set(rows.map((r) => r.date));
}

// Whole manager chain, not just the immediate manager - a Team Leader's own leave still needs
// someone above them (or HR) able to act on it. HR/Admin have blanket authority regardless of
// where they sit in (or outside) the chain.
function isAuthorizedApprover(employee, actor) {
  if (actor.role === 'admin' || actor.role === 'hr') return true;
  const chain = (employee.managerChain || []).map(String);
  return chain.includes(String(actor._id));
}

// Immediate manager if the employee has one; otherwise every HR/Admin, since a lot of non-sales
// employees today have no `reportsTo` set and an empty managerChain must not mean "notify nobody".
async function approverTargets(employee) {
  if (employee.managerChain && employee.managerChain.length) return [employee.managerChain[0]];
  const hrAndAdmin = await User.find({ role: { $in: ['admin', 'hr'] }, active: true }).select('_id').lean();
  return hrAndAdmin.map((u) => u._id);
}

// Live-computed, not stored - matches this codebase's existing pattern for bounded aggregates
// (payroll.js's computeAgentAchievement). Policy year is the calendar year `asOfDate` falls in.
// No carry-forward yet (LeaveType.carryForwardCap is reserved but unused) - see plan notes.
async function computeLeaveBalance(employee, leaveType, asOfDate = new Date()) {
  if (!employee.join) return { entitled: 0, used: 0, pending: 0, remaining: 0 };
  const joinDate = new Date(employee.join);
  const monthsOfService = monthsBetween(joinDate, asOfDate);
  if (monthsOfService < leaveType.minServiceMonths) return { entitled: 0, used: 0, pending: 0, remaining: 0 };

  let entitled;
  if (leaveType.accrualMethod === 'lump-sum') {
    entitled = leaveType.annualDays;
  } else {
    const yearStart = new Date(asOfDate.getFullYear(), 0, 1);
    const accrualStart = joinDate > yearStart ? joinDate : yearStart;
    entitled = Math.min(leaveType.annualDays, Math.round((monthsBetween(accrualStart, asOfDate) * leaveType.annualDays) / 12));
  }

  const yearStart = `${asOfDate.getFullYear()}-01-01`;
  const yearEnd = `${asOfDate.getFullYear()}-12-31`;
  const [approvedRows, pendingRows] = await Promise.all([
    LeaveRequest.find({ employee: employee._id, leaveType: leaveType._id, status: 'approved', startDate: { $lte: yearEnd }, endDate: { $gte: yearStart } }).select('days').lean(),
    LeaveRequest.find({ employee: employee._id, leaveType: leaveType._id, status: 'pending', startDate: { $lte: yearEnd }, endDate: { $gte: yearStart } }).select('days').lean(),
  ]);
  const used = approvedRows.reduce((sum, r) => sum + r.days, 0);
  const pending = pendingRows.reduce((sum, r) => sum + r.days, 0);

  return { entitled, used, pending, remaining: entitled - used };
}

async function createLeaveRequest(employeeId, { leaveTypeId, startDate, endDate, reason, document }, actor) {
  const employee = await User.findById(employeeId);
  if (!employee) throw new AppError('Employee not found', 404);
  const leaveType = await LeaveType.findById(leaveTypeId);
  if (!leaveType || !leaveType.active) throw new AppError('Leave type not found or inactive', 400);
  if (new Date(endDate) < new Date(startDate)) throw new AppError('End date cannot be before start date', 400);

  const holidays = await holidaySetForRange(startDate, endDate);
  const days = countWorkDays(startDate, endDate, holidays);
  if (days <= 0) throw new AppError('This date range has no working days to request leave for', 400);

  // Soft check for immediate UX feedback - the real gate is re-checked at approval time, since
  // this can't see requests that get approved later, after this one is submitted.
  const overlap = await LeaveRequest.findOne({
    employee: employeeId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  }).lean();
  if (overlap) throw new AppError('This overlaps an existing pending or approved leave request', 400);

  const chain = employee.managerChain || [];
  const request = await LeaveRequest.create({
    employee: employeeId,
    tlId: chain[0] || null,
    teamHeadId: chain[1] || null,
    salesHeadId: chain[2] || null,
    leaveType: leaveTypeId,
    startDate,
    endDate,
    days,
    reason: reason || '',
    document: document || '',
    history: [{ userId: actor._id, text: `Requested ${days} day(s) of ${leaveType.name}` }],
    createdBy: actor._id,
  });

  const targets = await approverTargets(employee);
  await notify(targets, `${employee.name} requested ${days} day(s) of ${leaveType.name}`, { refType: 'leave', refId: request._id });
  logActivity(actor, `requested ${days} day(s) of ${leaveType.name} for ${employee.name} (${startDate} to ${endDate})`);
  return request;
}

async function approveLeaveRequest(requestId, actor) {
  const request = await LeaveRequest.findById(requestId);
  if (!request) throw new AppError('Leave request not found', 404);
  if (request.status !== 'pending') throw new AppError('Only a pending request can be approved', 400);

  const employee = await User.findById(request.employee);
  if (!employee) throw new AppError('Employee not found', 404);
  if (!isAuthorizedApprover(employee, actor)) throw new AppError('You are not authorized to approve this request', 403);

  const leaveType = await LeaveType.findById(request.leaveType);
  if (!leaveType) throw new AppError('Leave type not found', 404);

  // Re-check overlap against requests that may have been approved after this one was submitted.
  const overlap = await LeaveRequest.findOne({
    _id: { $ne: request._id },
    employee: request.employee,
    status: 'approved',
    startDate: { $lte: request.endDate },
    endDate: { $gte: request.startDate },
  }).lean();
  if (overlap) throw new AppError('This would overlap an already-approved leave request for this employee', 400);

  // Final recompute against the current Holiday calendar, then freeze - see LeaveRequest.js.
  const holidays = await holidaySetForRange(request.startDate, request.endDate);
  const recomputedDays = countWorkDays(request.startDate, request.endDate, holidays);
  if (recomputedDays !== request.days) {
    request.history.push({ userId: actor._id, text: `Days recalculated ${request.days} -> ${recomputedDays} (holiday calendar changed since submission)` });
    request.days = recomputedDays;
  }

  // The real balance gate - closes the window where two individually-fittable pending requests
  // would together exceed the employee's balance.
  const balance = await computeLeaveBalance(employee, leaveType, new Date());
  if (balance.remaining - recomputedDays < 0) {
    throw new AppError(`Approving this would exceed ${employee.name}'s remaining ${leaveType.name} balance (${balance.remaining} day(s) left)`, 400);
  }

  request.status = 'approved';
  request.approver = actor._id;
  request.approvedAt = new Date();
  request.history.push({ userId: actor._id, text: `Approved by ${actor.name}` });
  await request.save();

  const chain = employee.managerChain || [];
  const cursor = new Date(request.startDate);
  const end = new Date(request.endDate);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!isWeekend(iso) && !holidays.has(iso)) {
      await Attendance.findOneAndUpdate(
        { employee: request.employee, date: iso },
        {
          employee: request.employee,
          tlId: chain[0] || null,
          teamHeadId: chain[1] || null,
          salesHeadId: chain[2] || null,
          date: iso,
          status: 'On Leave',
          linkedLeaveRequest: request._id,
          markedBy: actor._id,
        },
        { upsert: true, new: true }
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  await notify(request.employee, `Your ${leaveType.name} request (${request.startDate} to ${request.endDate}) was approved`, { refType: 'leave', refId: request._id });
  logActivity(actor, `approved ${employee.name}'s ${leaveType.name} request (${request.startDate} to ${request.endDate}, ${request.days} day(s))`);
  return request;
}

async function rejectLeaveRequest(requestId, actor, reason) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to reject a leave request', 400);
  const request = await LeaveRequest.findById(requestId);
  if (!request) throw new AppError('Leave request not found', 404);
  if (request.status !== 'pending') throw new AppError('Only a pending request can be rejected', 400);
  const employee = await User.findById(request.employee);
  if (!employee) throw new AppError('Employee not found', 404);
  if (!isAuthorizedApprover(employee, actor)) throw new AppError('You are not authorized to act on this request', 403);

  request.status = 'rejected';
  request.rejectedAt = new Date();
  request.rejectionReason = reason;
  request.history.push({ userId: actor._id, text: `Rejected by ${actor.name} — ${reason}` });
  await request.save();

  const leaveType = await LeaveType.findById(request.leaveType).select('name').lean();
  await notify(request.employee, `Your ${leaveType?.name || 'leave'} request was rejected — ${reason}`, { refType: 'leave', refId: request._id });
  logActivity(actor, `rejected ${employee.name}'s leave request (${request.startDate} to ${request.endDate}) — ${reason}`);
  return request;
}

async function cancelLeaveRequest(requestId, actor) {
  const request = await LeaveRequest.findById(requestId);
  if (!request) throw new AppError('Leave request not found', 404);
  if (request.status !== 'pending') throw new AppError('Only a pending request can be cancelled', 400);
  const isOwn = String(request.employee) === String(actor._id);
  if (!isOwn && actor.role !== 'admin' && actor.role !== 'hr') throw new AppError('You can only cancel your own request', 403);

  request.status = 'cancelled';
  request.history.push({ userId: actor._id, text: `Cancelled by ${actor.name}` });
  await request.save();
  logActivity(actor, `cancelled a leave request (${request.startDate} to ${request.endDate})`);
  return request;
}

async function revokeLeaveRequest(requestId, actor, reason) {
  if (!reason || !reason.trim()) throw new AppError('A reason is required to revoke an approved leave request', 400);
  const request = await LeaveRequest.findById(requestId);
  if (!request) throw new AppError('Leave request not found', 404);
  if (request.status !== 'approved') throw new AppError('Only an approved request can be revoked', 400);
  const employee = await User.findById(request.employee);
  if (!employee) throw new AppError('Employee not found', 404);
  if (!isAuthorizedApprover(employee, actor)) throw new AppError('You are not authorized to act on this request', 403);

  request.status = 'revoked';
  request.revokedAt = new Date();
  request.revokeReason = reason;
  request.history.push({ userId: actor._id, text: `Revoked by ${actor.name} — ${reason}` });
  await request.save();

  // Delete rather than "un-mark" the linked Attendance rows - a blank cell obviously needs
  // HR's attention; a silently-reverted one could look like nothing ever happened.
  const removed = await Attendance.deleteMany({ linkedLeaveRequest: request._id });

  const leaveType = await LeaveType.findById(request.leaveType).select('name').lean();
  await notify(request.employee, `Your approved ${leaveType?.name || 'leave'} (${request.startDate} to ${request.endDate}) was revoked — ${reason}`, { refType: 'leave', refId: request._id });
  logActivity(actor, `revoked ${employee.name}'s approved leave request (${request.startDate} to ${request.endDate}) — ${reason}, cleared ${removed.deletedCount} attendance record(s)`);
  return request;
}

module.exports = {
  computeLeaveBalance,
  createLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  revokeLeaveRequest,
  holidaySetForRange,
  isAuthorizedApprover,
};
