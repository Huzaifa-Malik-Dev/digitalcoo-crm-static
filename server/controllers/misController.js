const User = require('../models/User');
const Dsr = require('../models/Dsr');
const Pipeline = require('../models/Pipeline');
const Order = require('../models/Order');
const AppError = require('../utils/AppError');

// month is optional 'YYYY-MM'. Without it, rollups are lifetime totals (seed data was inserted
// in a single batch, so createdAt-based month filtering only becomes meaningful for records
// created going forward through normal use).
function monthRange(monthStr) {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) return null;
  const [y, m] = monthStr.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start, end };
}

async function agentsInScope(user) {
  if (user.role === 'agent') return User.find({ _id: user._id }).lean();
  if (user.role === 'admin' || user.role === 'backoffice') return User.find({ role: 'agent', active: true }).lean();
  return User.find({ role: 'agent', active: true, managerChain: user._id }).lean();
}

async function buildRollup(user, monthStr) {
  const range = monthRange(monthStr);
  const agents = await agentsInScope(user);
  const agentIds = agents.map((a) => a._id);
  // Pipeline's overall count/value rollup below has no business "created" date of its own, so
  // createdAt is the best available signal there. Dsr, and the Submissions/Activated pipeline
  // stages, all have a real business date to filter on instead of record-insert time
  // (`date` for Dsr, `startedDate` — the date a deal entered the pipeline — for Pipeline), so
  // backfilled or edited rows land in the month they actually happened, not the month they were saved.
  const createdAtMatch = range ? { createdAt: { $gte: range.start, $lt: range.end } } : {};
  const dsrDateMatch = range ? { date: { $gte: range.start.toISOString().slice(0, 10), $lt: range.end.toISOString().slice(0, 10) } } : {};
  const pipelineDateMatch = range ? { startedDate: { $gte: range.start.toISOString().slice(0, 10), $lt: range.end.toISOString().slice(0, 10) } } : {};

  const [interestedCounts, pipelineCounts, submissionsAgg, activatedAgg, correctionsAgg] = await Promise.all([
    Dsr.aggregate([
      { $match: { agentId: { $in: agentIds }, status: 'Interested', ...dsrDateMatch } },
      { $group: { _id: '$agentId', count: { $sum: 1 } } },
    ]),
    Pipeline.aggregate([
      { $match: { agentId: { $in: agentIds }, ...createdAtMatch } },
      { $group: { _id: '$agentId', count: { $sum: 1 }, value: { $sum: '$mrc' } } },
    ]),
    // Submissions = deals at 90% - Closing (sent to Back Office, pending final activation).
    Pipeline.aggregate([
      { $match: { agentId: { $in: agentIds }, stage: '90% - Closing', ...pipelineDateMatch } },
      { $group: { _id: '$agentId', count: { $sum: 1 } } },
    ]),
    // Activated = deals at 100% - Deal Won. Achieved MRC tracks the same set, for consistency.
    Pipeline.aggregate([
      { $match: { agentId: { $in: agentIds }, stage: '100% - Deal Won', ...pipelineDateMatch } },
      { $group: { _id: '$agentId', count: { $sum: 1 }, mrc: { $sum: '$mrc' } } },
    ]),
    // How many times this agent's orders have been sent back to Pipeline for correction (see
    // workflow.sendOrderBackToPipeline) - summed across every order, not just currently-flagged
    // ones, since correctionCount is durable even after a request is handled.
    Order.aggregate([
      { $match: { agentId: { $in: agentIds }, correctionCount: { $gt: 0 }, ...createdAtMatch } },
      { $group: { _id: '$agentId', count: { $sum: '$correctionCount' } } },
    ]),
  ]);

  const mapOf = (arr) => Object.fromEntries(arr.map((r) => [String(r._id), r]));
  const intMap = mapOf(interestedCounts);
  const pipeMap = mapOf(pipelineCounts);
  const subMap = mapOf(submissionsAgg);
  const actMap = mapOf(activatedAgg);
  const corrMap = mapOf(correctionsAgg);

  const rows = agents.map((a) => {
    const target = a.target || 0;
    const achieved = actMap[String(a._id)]?.mrc || 0;
    return {
      agentId: a._id,
      name: a.name,
      desig: a.desig,
      target,
      submissions: subMap[String(a._id)]?.count || 0,
      interested: intMap[String(a._id)]?.count || 0,
      pipelineCount: pipeMap[String(a._id)]?.count || 0,
      pipelineValue: pipeMap[String(a._id)]?.value || 0,
      activatedCount: actMap[String(a._id)]?.count || 0,
      achieved,
      achievementPct: target ? Math.round((achieved / target) * 100) : achieved > 0 ? 100 : 0,
      corrections: corrMap[String(a._id)]?.count || 0,
    };
  });
  rows.sort((a, b) => b.achieved - a.achieved);
  return rows;
}

function sumTotals(rows) {
  const totals = rows.reduce(
    (acc, r) => ({
      target: acc.target + r.target,
      submissions: acc.submissions + r.submissions,
      interested: acc.interested + r.interested,
      pipelineCount: acc.pipelineCount + r.pipelineCount,
      pipelineValue: acc.pipelineValue + r.pipelineValue,
      activatedCount: acc.activatedCount + r.activatedCount,
      achieved: acc.achieved + r.achieved,
      corrections: acc.corrections + r.corrections,
    }),
    { target: 0, submissions: 0, interested: 0, pipelineCount: 0, pipelineValue: 0, activatedCount: 0, achieved: 0, corrections: 0 }
  );
  totals.achievementPct = totals.target ? Math.round((totals.achieved / totals.target) * 100) : 0;
  return totals;
}

async function rollup(req, res, next) {
  try {
    const rows = await buildRollup(req.user, req.query.month);
    res.json({ data: { rows, totals: sumTotals(rows), month: req.query.month || null } });
  } catch (err) {
    next(err);
  }
}

// The list-view rollup only ever shows counts and sums - genuinely useful to a Team Leader
// deciding what to actually chase is the underlying records themselves, not another repaint of
// the same numbers. Capped (most-recent-first) rather than paginated since this is a drill-down
// summary, not a full list page - `truncated` tells the client whether more exist.
const RECORD_CAP = 100;

async function buildRecords(agentIds, monthStr) {
  const range = monthRange(monthStr);
  const dsrDateMatch = range ? { date: { $gte: range.start.toISOString().slice(0, 10), $lt: range.end.toISOString().slice(0, 10) } } : {};
  const pipelineDateMatch = range ? { startedDate: { $gte: range.start.toISOString().slice(0, 10), $lt: range.end.toISOString().slice(0, 10) } } : {};

  const [dsrTotal, dsrDocs, pipelineTotal, pipelineDocs] = await Promise.all([
    Dsr.countDocuments({ agentId: { $in: agentIds }, status: 'Interested', ...dsrDateMatch }),
    Dsr.find({ agentId: { $in: agentIds }, status: 'Interested', ...dsrDateMatch })
      .sort({ date: -1 })
      .limit(RECORD_CAP)
      .populate('agentId', 'name')
      .select('dsrNo company customer contactNo date agentId')
      .lean(),
    Pipeline.countDocuments({ agentId: { $in: agentIds }, ...pipelineDateMatch }),
    Pipeline.find({ agentId: { $in: agentIds }, ...pipelineDateMatch })
      .sort({ startedDate: -1 })
      .limit(RECORD_CAP)
      .populate('agentId', 'name')
      .select('dsrNo company customer product cat stage approval mrc agentId')
      .lean(),
  ]);

  return {
    dsrRecords: dsrDocs.map((d) => ({
      dsrNo: d.dsrNo, company: d.company, customer: d.customer, contactNo: d.contactNo, date: d.date, agentName: d.agentId?.name,
    })),
    dsrTotal,
    dsrTruncated: dsrTotal > dsrDocs.length,
    pipelineRecords: pipelineDocs.map((p) => ({
      dsrNo: p.dsrNo, company: p.company, customer: p.customer, product: p.product, cat: p.cat,
      stage: p.stage, approval: p.approval, mrc: p.mrc, agentName: p.agentId?.name,
    })),
    pipelineTotal,
    pipelineTruncated: pipelineTotal > pipelineDocs.length,
  };
}

// One person's (or, for a manager, their whole subtree's) target/achievement detail - the
// "click a MIS row" drill-down. Scope is built from the TARGET employee's own managerChain
// (via buildRollup/agentsInScope), not the requester's - the requester just needs permission
// to view it: admin, themselves, or anyone above them in the chain.
async function getAgentDetail(req, res, next) {
  try {
    const target = await User.findById(req.params.id).select('-passwordHash').lean();
    if (!target) throw new AppError('Employee not found', 404);

    const requester = req.user;
    const allowed =
      requester.role === 'admin' ||
      String(requester._id) === String(target._id) ||
      (target.managerChain || []).some((id) => String(id) === String(requester._id));
    if (!allowed) throw new AppError("You do not have access to this employee's performance data", 403);

    const agents = await agentsInScope(target);
    const agentIds = agents.map((a) => a._id);
    const rows = await buildRollup(target, req.query.month);
    const records = await buildRecords(agentIds, req.query.month);

    res.json({
      data: {
        person: { _id: target._id, name: target.name, desig: target.desig, role: target.role, employeeId: target.employeeId, target: target.target },
        rows,
        totals: sumTotals(rows),
        month: req.query.month || null,
        ...records,
      },
    });
  } catch (err) {
    next(err);
  }
}

function toCsv(rows) {
  const header = ['Agent', 'Designation', 'Target', 'Submissions', 'Interested', 'Pipeline Count', 'Pipeline Value', 'Activated Deals', 'MRC Achieved (AED)', 'Achievement %', 'Corrections Requested'];
  const esc = (v) => (typeof v === 'string' && (v.includes(',') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header.join(',')];
  rows.forEach((r) => {
    lines.push(
      [r.name, r.desig, r.target, r.submissions, r.interested, r.pipelineCount, r.pipelineValue, r.activatedCount, r.achieved, r.achievementPct, r.corrections]
        .map(esc)
        .join(',')
    );
  });
  return lines.join('\n');
}

async function exportCsv(req, res, next) {
  try {
    const rows = await buildRollup(req.user, req.query.month);
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="mis-${req.query.month || 'lifetime'}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = { rollup, exportCsv, getAgentDetail };
