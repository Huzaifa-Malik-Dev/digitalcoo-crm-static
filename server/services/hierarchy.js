const User = require('../models/User');
const AssignmentHistory = require('../models/AssignmentHistory');
const Dsr = require('../models/Dsr');
const Pipeline = require('../models/Pipeline');
const Order = require('../models/Order');
const LeaveRequest = require('../models/LeaveRequest');
const Attendance = require('../models/Attendance');
const AppError = require('../utils/AppError');

// Walks reportsTo up to the top and returns the ancestor chain as an array of ObjectIds,
// immediate manager first. This is stamped onto the user so role-scoped queries
// (e.g. "everyone under this Team Head") are a single indexed match, never a recursive walk.
async function buildManagerChain(reportsToId) {
  const chain = [];
  let current = reportsToId;
  let guard = 0;
  while (current && guard < 10) {
    const manager = await User.findById(current).select('reportsTo').lean();
    if (!manager) break;
    chain.push(manager._id);
    current = manager.reportsTo;
    guard += 1;
  }
  return chain;
}

// Re-stamps managerChain (current-state only, not history) for every descendant of a user
// whose position in the chain changed — so live rollup queries stay correct immediately.
async function rebuildDescendantChains(userId) {
  const directReports = await User.find({ reportsTo: userId }).select('_id').lean();
  for (const report of directReports) {
    const chain = await buildManagerChain(userId);
    await User.updateOne({ _id: report._id }, { managerChain: [userId, ...chain] });
    await rebuildDescendantChains(report._id);
  }
}

// Opens the first AssignmentHistory row for a brand-new user (called from user creation / seed).
async function createInitialAssignment(user, changedBy = null) {
  await AssignmentHistory.create({
    userId: user._id,
    role: user.role,
    reportsTo: user.reportsTo || null,
    startDate: user.join ? new Date(user.join) : new Date(),
    endDate: null,
    changedBy,
  });
}

// Re-stamps tlId/teamHeadId/salesHeadId on this one employee's own DSR/Pipeline/Order/
// LeaveRequest/Attendance records dated on/after effectiveDate to match their new managerChain —
// everything before that date is left untouched, preserving the historically-accurate "who they
// reported to at the time". Scoped to agentId/employee only, deliberately not cascaded to
// descendants (a TL's own agents keep their own history unless each of them is separately
// reassigned).
async function moveHistoricalRecords(agentId, chain, effectiveDate) {
  const [tlId, teamHeadId, salesHeadId] = chain;
  const stamp = { tlId: tlId || null, teamHeadId: teamHeadId || null, salesHeadId: salesHeadId || null };
  const dateStr = effectiveDate.toISOString().slice(0, 10);

  const [dsrRes, pipelineRes, orderRes, leaveRes, attendanceRes] = await Promise.all([
    Dsr.updateMany({ agentId, date: { $gte: dateStr } }, { $set: stamp }),
    Pipeline.updateMany({ agentId, createdAt: { $gte: effectiveDate } }, { $set: stamp }),
    Order.updateMany({ agentId, createdAt: { $gte: effectiveDate } }, { $set: stamp }),
    LeaveRequest.updateMany({ employee: agentId, startDate: { $gte: dateStr } }, { $set: stamp }),
    Attendance.updateMany({ employee: agentId, date: { $gte: dateStr } }, { $set: stamp }),
  ]);
  return {
    dsr: dsrRes.modifiedCount,
    pipeline: pipelineRes.modifiedCount,
    order: orderRes.modifiedCount,
    leave: leaveRes.modifiedCount,
    attendance: attendanceRes.modifiedCount,
  };
}

// The single entry point for changing a user's role and/or manager. Closes the currently-open
// history row, opens a new one, updates the live User doc, and re-stamps descendants' chains.
// Never mutate role/reportsTo directly on User outside this function — history would go stale.
//
// A team move (reportsTo actually changing) requires an effectiveDate — the real-world date the
// move took effect, today or earlier (see the future-date guard below; this is a retroactive
// correction tool, not a scheduler). That date is used both for the AssignmentHistory period
// boundary and to decide which of the employee's own historical DSR/Pipeline/Order rows get
// re-stamped with the new team (see moveHistoricalRecords). A pure role change with no manager
// change doesn't need one — it defaults to now, matching the previous behavior.
async function reassignUser(userId, { role, reportsTo, effectiveDate }, changedBy = null) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const newRole = role || user.role;
  const newReportsTo = reportsTo !== undefined ? reportsTo : user.reportsTo;
  const isTeamMove = reportsTo !== undefined && String(reportsTo || '') !== String(user.reportsTo || '');

  if (newReportsTo) {
    if (String(newReportsTo) === String(userId)) {
      throw new AppError('A user cannot report to themselves', 400);
    }
    // Walk the proposed manager's own chain up to the top — if this user appears anywhere in
    // it, assigning them would create a cycle (this user would end up reporting to their own
    // descendant), which buildManagerChain's depth guard would otherwise mask instead of reject.
    let current = newReportsTo;
    let guard = 0;
    while (current && guard < 20) {
      if (String(current) === String(userId)) {
        throw new AppError('This assignment would create a reporting-chain cycle', 400);
      }
      const manager = await User.findById(current).select('reportsTo').lean();
      if (!manager) break;
      current = manager.reportsTo;
      guard += 1;
    }
  }

  let effDate = new Date();
  if (isTeamMove) {
    if (!effectiveDate) throw new AppError('Assignment date is required when changing a team', 400);
    effDate = new Date(effectiveDate);
    if (Number.isNaN(effDate.getTime())) throw new AppError('Invalid assignment date', 400);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (effDate > endOfToday) throw new AppError('Assignment date cannot be in the future', 400);

    const openAssignment = await AssignmentHistory.findOne({ userId: user._id, endDate: null }).sort({ startDate: -1 }).lean();
    if (openAssignment && effDate < openAssignment.startDate) {
      throw new AppError(
        `Assignment date cannot be before ${openAssignment.startDate.toISOString().slice(0, 10)}, when this employee's current assignment began`,
        400
      );
    }
  }

  await AssignmentHistory.updateMany(
    { userId: user._id, endDate: null },
    { endDate: effDate }
  );
  await AssignmentHistory.create({
    userId: user._id,
    role: newRole,
    reportsTo: newReportsTo || null,
    startDate: effDate,
    endDate: null,
    changedBy,
  });

  const chain = await buildManagerChain(newReportsTo);
  user.role = newRole;
  user.reportsTo = newReportsTo || null;
  user.managerChain = chain;
  await user.save();

  await rebuildDescendantChains(user._id);

  const movedCounts = isTeamMove ? await moveHistoricalRecords(user._id, chain, effDate) : { dsr: 0, pipeline: 0, order: 0, leave: 0, attendance: 0 };
  return { user, movedCounts };
}

module.exports = { buildManagerChain, rebuildDescendantChains, createInitialAssignment, reassignUser };
