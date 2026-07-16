const Dsr = require('../models/Dsr');
const Pipeline = require('../models/Pipeline');
const Order = require('../models/Order');
const User = require('../models/User');
const AiReportJob = require('../models/AiReportJob');
const aiBackend = require('../services/aiBackend');
const AppError = require('../utils/AppError');
const { logActivity } = require('../utils/activityLog');
const { PIPE_STAGES, APPROVAL_STATUS, AI_REPORT_TYPES, AI_TEAM_REPORT_ROLES } = require('../utils/constants');

function scopeFilter(user) {
  if (user.role === 'admin' || user.role === 'backoffice') return {};
  if (user.role === 'agent') return { agentId: user._id };
  return { $or: [{ tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }, { agentId: user._id }] };
}

// dateParam anchors the range to a specific day/week/month the user picked on the frontend,
// instead of always being relative to "right now" - e.g. period='weekly' with dateParam='2026-06-15'
// means the 7 days ending 2026-06-15, not the 7 days ending today. Falls back to now when
// dateParam is missing/malformed, which reproduces the old always-relative-to-now behaviour
// exactly (Today / Last 7 Days / This Month).
function periodRange(periodParam, dateParam) {
  const now = new Date();
  const validAnchor = typeof dateParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00`) : null;
  const anchor = validAnchor && !Number.isNaN(validAnchor.getTime()) ? validAnchor : now;
  const isToday = anchor.toDateString() === now.toDateString();

  let start;
  let end;
  let label;
  let period = periodParam;
  if (period === 'weekly') {
    end = new Date(anchor);
    end.setHours(23, 59, 59, 999);
    start = new Date(anchor);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    label = isToday ? 'Last 7 Days' : `Week ending ${anchor.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  } else if (period === 'monthly') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    end = monthEnd < now ? new Date(monthEnd.getTime() - 1) : now;
    label = start.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  } else {
    period = 'daily';
    start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    end = new Date(anchor);
    end.setHours(23, 59, 59, 999);
    label = isToday ? 'Today' : anchor.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return { start, end, label, period };
}

// ---- Data gathering, one function per report type ----

async function gatherPerformanceStats(user, periodParam, dateParam) {
  const { start, end, label, period } = periodRange(periodParam, dateParam);
  const scope = scopeFilter(user);
  const startDateStr = start.toISOString().slice(0, 10);

  const [dsrCount, interestedCount, notInterestedCount, pipelineCreated, pipelineApproved, pipelineRejected, activatedAgg, ordersOnHold] =
    await Promise.all([
      Dsr.countDocuments({ ...scope, date: { $gte: startDateStr } }),
      Dsr.countDocuments({ ...scope, status: 'Interested', date: { $gte: startDateStr } }),
      Dsr.countDocuments({ ...scope, status: 'Not interested', date: { $gte: startDateStr } }),
      Pipeline.countDocuments({ ...scope, createdAt: { $gte: start, $lte: end } }),
      Pipeline.countDocuments({ ...scope, approval: 'approved', createdAt: { $gte: start, $lte: end } }),
      Pipeline.countDocuments({ ...scope, approval: 'rejected', createdAt: { $gte: start, $lte: end } }),
      // actDate (real activation date) not createdAt — matches the DSR queries above, which
      // already filter on their own business date field rather than record-insert time.
      Order.aggregate([
        { $match: { ...scope, status: 'Activated', actDate: { $gte: startDateStr, $lte: end.toISOString().slice(0, 10) } } },
        { $group: { _id: null, count: { $sum: 1 }, mrc: { $sum: '$mrc' }, commission: { $sum: '$commission' } } },
      ]),
      Order.countDocuments({ ...scope, status: 'On Hold' }),
    ]);

  const activated = activatedAgg[0] || { count: 0, mrc: 0, commission: 0 };
  const conversionPct = dsrCount ? Math.round((interestedCount / dsrCount) * 100) : 0;
  const approvalPct = pipelineCreated ? Math.round((pipelineApproved / pipelineCreated) * 100) : 0;

  return {
    label,
    period,
    dsrCount,
    interestedCount,
    notInterestedCount,
    conversionPct,
    pipelineCreated,
    pipelineApproved,
    pipelineRejected,
    approvalPct,
    activatedCount: activated.count,
    activatedMrc: activated.mrc,
    commission: activated.commission,
    ordersOnHold,
  };
}

async function gatherPipelineStats(user, periodParam, dateParam) {
  const { start, end, label, period } = periodRange(periodParam, dateParam);
  const scope = scopeFilter(user);

  const [byStage, byApproval, openDeals] = await Promise.all([
    Pipeline.aggregate([
      { $match: { ...scope, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$stage', count: { $sum: 1 }, value: { $sum: '$mrc' } } },
    ]),
    Pipeline.aggregate([
      { $match: { ...scope, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$approval', count: { $sum: 1 } } },
    ]),
    // Oldest still-open deals overall (not just this period) — a deal opened last month and
    // still stuck is exactly the kind of thing a pipeline analysis should surface.
    Pipeline.find({ ...scope, stage: { $nin: ['100% - Deal Won', '0% - Lost'] } })
      .sort({ createdAt: 1 })
      .limit(5)
      .select('company customer product stage createdAt')
      .lean(),
  ]);

  const stageMap = Object.fromEntries(byStage.map((r) => [r._id, r]));
  const stageBreakdown = PIPE_STAGES.map((s) => ({ stage: s, count: stageMap[s]?.count || 0, value: stageMap[s]?.value || 0 }));

  const approvalMap = Object.fromEntries(byApproval.map((r) => [r._id, r]));
  const approvalBreakdown = APPROVAL_STATUS.map((s) => ({ status: s, count: approvalMap[s]?.count || 0 }));

  const now = Date.now();
  const stuckDeals = openDeals.map((d) => ({
    name: d.company || d.customer || 'Unnamed deal',
    product: d.product || 'n/a',
    stage: d.stage,
    daysOpen: Math.floor((now - new Date(d.createdAt).getTime()) / 86400000),
  }));

  return { label, period, stageBreakdown, approvalBreakdown, stuckDeals };
}

async function gatherFinancialStats(user, periodParam, dateParam) {
  const { start, end, label, period } = periodRange(periodParam, dateParam);
  const scope = scopeFilter(user);
  const startDateStr = start.toISOString().slice(0, 10);
  const endDateStr = end.toISOString().slice(0, 10);
  const activatedMatch = { ...scope, status: 'Activated', actDate: { $gte: startDateStr, $lte: endDateStr } };

  const [activatedAgg, byCategory, onHoldAgg] = await Promise.all([
    Order.aggregate([{ $match: activatedMatch }, { $group: { _id: null, count: { $sum: 1 }, mrc: { $sum: '$mrc' }, commission: { $sum: '$commission' } } }]),
    Order.aggregate([
      { $match: activatedMatch },
      { $group: { _id: '$cat', count: { $sum: 1 }, mrc: { $sum: '$mrc' } } },
      { $sort: { mrc: -1 } },
      { $limit: 5 },
    ]),
    Order.aggregate([{ $match: { ...scope, status: 'On Hold' } }, { $group: { _id: null, count: { $sum: 1 }, mrc: { $sum: '$mrc' } } }]),
  ]);

  const activated = activatedAgg[0] || { count: 0, mrc: 0, commission: 0 };
  const onHold = onHoldAgg[0] || { count: 0, mrc: 0 };
  const topCategories = byCategory.map((c) => ({ category: c._id || 'Uncategorized', count: c.count, mrc: c.mrc }));

  return {
    label,
    period,
    activatedCount: activated.count,
    activatedMrc: activated.mrc,
    commission: activated.commission,
    onHoldCount: onHold.count,
    onHoldMrc: onHold.mrc,
    topCategories,
  };
}

async function agentsInScope(user) {
  if (user.role === 'admin' || user.role === 'backoffice') return User.find({ role: 'agent', active: true }).lean();
  return User.find({ role: 'agent', active: true, managerChain: user._id }).lean();
}

async function gatherTeamStats(user, periodParam, dateParam) {
  const { start, end, label, period } = periodRange(periodParam, dateParam);
  const startDateStr = start.toISOString().slice(0, 10);
  const endDateStr = end.toISOString().slice(0, 10);

  const agents = await agentsInScope(user);
  const agentIds = agents.map((a) => a._id);

  const [dsrAgg, interestedAgg, pipelineCreatedAgg, pipelineApprovedAgg, activatedAgg] = await Promise.all([
    Dsr.aggregate([{ $match: { agentId: { $in: agentIds }, date: { $gte: startDateStr, $lte: endDateStr } } }, { $group: { _id: '$agentId', count: { $sum: 1 } } }]),
    Dsr.aggregate([
      { $match: { agentId: { $in: agentIds }, status: 'Interested', date: { $gte: startDateStr, $lte: endDateStr } } },
      { $group: { _id: '$agentId', count: { $sum: 1 } } },
    ]),
    Pipeline.aggregate([{ $match: { agentId: { $in: agentIds }, createdAt: { $gte: start, $lte: end } } }, { $group: { _id: '$agentId', count: { $sum: 1 } } }]),
    Pipeline.aggregate([
      { $match: { agentId: { $in: agentIds }, approval: 'approved', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$agentId', count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { agentId: { $in: agentIds }, status: 'Activated', actDate: { $gte: startDateStr, $lte: endDateStr } } },
      { $group: { _id: '$agentId', count: { $sum: 1 }, mrc: { $sum: '$mrc' }, commission: { $sum: '$commission' } } },
    ]),
  ]);

  const mapOf = (arr) => Object.fromEntries(arr.map((r) => [String(r._id), r]));
  const dsrMap = mapOf(dsrAgg);
  const intMap = mapOf(interestedAgg);
  const pcMap = mapOf(pipelineCreatedAgg);
  const paMap = mapOf(pipelineApprovedAgg);
  const actMap = mapOf(activatedAgg);

  const rows = agents.map((a) => {
    const calls = dsrMap[String(a._id)]?.count || 0;
    const interested = intMap[String(a._id)]?.count || 0;
    return {
      name: a.name,
      desig: a.desig || 'Sales Agent',
      calls,
      interested,
      conversionPct: calls ? Math.round((interested / calls) * 100) : 0,
      pipelineCreated: pcMap[String(a._id)]?.count || 0,
      pipelineApproved: paMap[String(a._id)]?.count || 0,
      activatedCount: actMap[String(a._id)]?.count || 0,
      activatedMrc: actMap[String(a._id)]?.mrc || 0,
      commission: actMap[String(a._id)]?.commission || 0,
    };
  });
  rows.sort((x, y) => y.activatedMrc - x.activatedMrc);

  return { label, period, rows };
}

// ---- Prompt building, one function per report type ----

const GUARDRAIL =
  'Write a clear, specific analytical report using short "#" headings for sections. Base every statement strictly on the figures given below — never invent numbers. ' +
  'If the figures show little or no activity, say so plainly in one or two sentences and stop there — do not pad the report with speculation, hypothetical causes, or generic advice unrelated to the actual numbers given.';

function buildPerformancePrompt(stats, user) {
  return [
    `You are writing a performance report for ${user.name} (${user.desig || user.role}) at a UAE Etisalat channel partner sales CRM.`,
    `Period: ${stats.label}.`,
    '',
    'Raw figures for this period:',
    `- Calls logged: ${stats.dsrCount} (${stats.interestedCount} marked Interested, ${stats.notInterestedCount} Not Interested, ${stats.conversionPct}% interest rate)`,
    `- Deals entered the pipeline: ${stats.pipelineCreated} (${stats.pipelineApproved} approved by Team Leader, ${stats.pipelineRejected} rejected, ${stats.approvalPct}% approval rate)`,
    `- Orders activated: ${stats.activatedCount} worth AED ${stats.activatedMrc.toLocaleString()} MRC (AED ${stats.commission.toLocaleString()} commission)`,
    `- Orders currently On Hold: ${stats.ordersOnHold}`,
    '',
    `${GUARDRAIL} Cover what's working, what needs attention, and one or two concrete recommendations grounded in the figures above.`,
  ].join('\n');
}

function buildPipelinePrompt(stats, user) {
  const stageLines = stats.stageBreakdown.map((s) => `  - ${s.stage}: ${s.count} deal${s.count === 1 ? '' : 's'} (AED ${s.value.toLocaleString()} MRC)`);
  const approvalLines = stats.approvalBreakdown.map((a) => `  - ${a.status}: ${a.count}`);
  const stuckLines = stats.stuckDeals.length
    ? stats.stuckDeals.map((d) => `  - ${d.name} (${d.product}) — stuck at ${d.stage}, open ${d.daysOpen} day${d.daysOpen === 1 ? '' : 's'}`)
    : ['  - None — no deals currently open outside Won/Lost.'];

  return [
    `You are writing a Sales Pipeline Analysis for ${user.name} (${user.desig || user.role}) at a UAE Etisalat channel partner sales CRM.`,
    `Period: ${stats.label}.`,
    '',
    'Deals by stage (this period):',
    ...stageLines,
    '',
    'Team Leader approval status (this period):',
    ...approvalLines,
    '',
    'Oldest deals still open (not limited to this period):',
    ...stuckLines,
    '',
    `${GUARDRAIL} Cover where deals are concentrated, any bottleneck stage, the approval/rejection pattern, and what to do about the oldest stuck deals.`,
  ].join('\n');
}

function buildFinancialPrompt(stats, user) {
  const catLines = stats.topCategories.length
    ? stats.topCategories.map((c) => `  - ${c.category}: ${c.count} order${c.count === 1 ? '' : 's'}, AED ${c.mrc.toLocaleString()} MRC`)
    : ['  - None activated this period.'];

  return [
    `You are writing a Financial / Revenue Report for ${user.name} (${user.desig || user.role}) at a UAE Etisalat channel partner sales CRM.`,
    `Period: ${stats.label}.`,
    '',
    'Raw figures for this period:',
    `- Orders activated: ${stats.activatedCount} worth AED ${stats.activatedMrc.toLocaleString()} MRC (AED ${stats.commission.toLocaleString()} commission)`,
    `- Orders currently On Hold: ${stats.onHoldCount} (AED ${stats.onHoldMrc.toLocaleString()} MRC at risk)`,
    'Top revenue categories this period:',
    ...catLines,
    '',
    `${GUARDRAIL} Cover total revenue generated, which categories are driving it, and the revenue currently at risk from On Hold orders.`,
  ].join('\n');
}

function buildTeamPrompt(stats, user) {
  const rowLines = stats.rows.length
    ? stats.rows.map(
        (r) =>
          `  - ${r.name} (${r.desig}): ${r.calls} calls, ${r.interested} interested (${r.conversionPct}%), ${r.pipelineCreated} deals entered (${r.pipelineApproved} approved), ${r.activatedCount} activated worth AED ${r.activatedMrc.toLocaleString()} MRC`
      )
    : ['  - No agents in scope.'];

  return [
    `You are writing a Team Comparison Report for ${user.name} (${user.desig || user.role}) at a UAE Etisalat channel partner sales CRM, covering the agents reporting to them.`,
    `Period: ${stats.label}.`,
    '',
    'Per-agent figures for this period (already sorted by activated MRC, highest first):',
    ...rowLines,
    '',
    `${GUARDRAIL} Identify the top and bottom performers by activated MRC, note any agent with unusually low call volume or conversion, and give one or two concrete coaching recommendations.`,
  ].join('\n');
}

// ---- Excel table building, one function per report type ----
// Excel never uses the LLM narrative - a spreadsheet of prose defeats the point of it being a
// spreadsheet. These build real Metric/Value or multi-column tables straight from the same
// `stats` the prompt functions above read, so numbers in the .xlsx always match the numbers the
// narrative talks about (both come from one gather() call, never recomputed separately).

function buildPerformanceTable(stats) {
  return {
    tables: [
      {
        title: `Performance Summary — ${stats.label}`,
        columns: ['Metric', 'Value'],
        rows: [
          ['Calls Logged', stats.dsrCount],
          ['Interested', stats.interestedCount],
          ['Not Interested', stats.notInterestedCount],
          ['Interest Rate', `${stats.conversionPct}%`],
          ['Deals Entered Pipeline', stats.pipelineCreated],
          ['Deals Approved by Team Leader', stats.pipelineApproved],
          ['Deals Rejected by Team Leader', stats.pipelineRejected],
          ['Approval Rate', `${stats.approvalPct}%`],
          ['Orders Activated', stats.activatedCount],
          ['Activated MRC (AED)', stats.activatedMrc],
          ['Commission (AED)', stats.commission],
          ['Orders On Hold', stats.ordersOnHold],
        ],
      },
    ],
  };
}

function buildPipelineTable(stats) {
  return {
    tables: [
      {
        title: `Deals by Stage — ${stats.label}`,
        columns: ['Stage', 'Count', 'Value (AED)'],
        rows: stats.stageBreakdown.map((s) => [s.stage, s.count, s.value]),
      },
      {
        title: 'Team Leader Approval Status',
        columns: ['Status', 'Count'],
        rows: stats.approvalBreakdown.map((a) => [a.status, a.count]),
      },
      {
        title: 'Oldest Deals Still Open',
        columns: ['Deal', 'Product', 'Stage', 'Days Open'],
        rows: stats.stuckDeals.length ? stats.stuckDeals.map((d) => [d.name, d.product, d.stage, d.daysOpen]) : [['None', '', '', '']],
      },
    ],
  };
}

function buildFinancialTable(stats) {
  return {
    tables: [
      {
        title: `Financial Summary — ${stats.label}`,
        columns: ['Metric', 'Value'],
        rows: [
          ['Orders Activated', stats.activatedCount],
          ['Activated MRC (AED)', stats.activatedMrc],
          ['Commission (AED)', stats.commission],
          ['Orders On Hold', stats.onHoldCount],
          ['On-Hold MRC at Risk (AED)', stats.onHoldMrc],
        ],
      },
      {
        title: 'Top Revenue Categories',
        columns: ['Category', 'Orders', 'MRC (AED)'],
        rows: stats.topCategories.length ? stats.topCategories.map((c) => [c.category, c.count, c.mrc]) : [['None activated this period', '', '']],
      },
    ],
  };
}

function buildTeamTable(stats) {
  return {
    tables: [
      {
        title: `Team Comparison — ${stats.label}`,
        columns: ['Agent', 'Designation', 'Calls', 'Interested', 'Conversion %', 'Deals Entered', 'Deals Approved', 'Activated Orders', 'Activated MRC (AED)', 'Commission (AED)'],
        rows: stats.rows.length
          ? stats.rows.map((r) => [r.name, r.desig, r.calls, r.interested, r.conversionPct, r.pipelineCreated, r.pipelineApproved, r.activatedCount, r.activatedMrc, r.commission])
          : [['No agents in scope', '', '', '', '', '', '', '', '', '']],
      },
    ],
  };
}

const REPORT_TYPE_HANDLERS = {
  performance: { gather: gatherPerformanceStats, prompt: buildPerformancePrompt, table: buildPerformanceTable, title: (s) => `${s.label} Performance Report` },
  pipeline: { gather: gatherPipelineStats, prompt: buildPipelinePrompt, table: buildPipelineTable, title: (s) => `${s.label} Sales Pipeline Analysis` },
  financial: { gather: gatherFinancialStats, prompt: buildFinancialPrompt, table: buildFinancialTable, title: (s) => `${s.label} Financial Report` },
  team: { gather: gatherTeamStats, prompt: buildTeamPrompt, table: buildTeamTable, title: (s) => `${s.label} Team Comparison Report` },
};

const FORMAT_LABELS = { md: 'Markdown', pdf: 'PDF', xlsx: 'Excel' };
const REPORT_TYPE_LABELS = { performance: 'Performance Summary', pipeline: 'Sales Pipeline Analysis', financial: 'Financial Report', team: 'Team Comparison' };

async function createAiJob(req, res, next) {
  try {
    const user = req.user;
    const { period, format, reportType, date } = req.body || {};
    if (!['md', 'pdf', 'xlsx'].includes(format)) throw new AppError('format must be one of: md, pdf, xlsx', 400);
    if (!AI_REPORT_TYPES.includes(reportType)) throw new AppError(`reportType must be one of: ${AI_REPORT_TYPES.join(', ')}`, 400);
    if (reportType === 'team' && !AI_TEAM_REPORT_ROLES.includes(user.role)) {
      throw new AppError('Team Comparison reports are not available for your role', 403);
    }

    // handler.gather is always called with `user` first and scopes every query to that user's
    // access level (see scopeFilter/agentsInScope above) before a single number is read - the
    // prompt built from `stats` right after can only ever contain data the requesting user is
    // already allowed to see. There is no path from raw collections to the LLM that skips this.
    const handler = REPORT_TYPE_HANDLERS[reportType];
    const stats = await handler.gather(user, period, date);
    const prompt = handler.prompt(stats, user);
    const title = handler.title(stats);
    // Only built/sent for xlsx - cheap to compute either way, but no reason to ship an unused
    // payload on every md/pdf request.
    const tables = format === 'xlsx' ? handler.table(stats) : undefined;

    const job = await aiBackend.createJob({ prompt, format, title, requestedBy: user.name, tables });

    // A new history entry every time, not an overwrite - the Report History list below shows the
    // last 3 days of these, newest first.
    await AiReportJob.create({ user: user._id, jobId: job.jobId, period: stats.period, date: date || '', format, reportType });

    logActivity(user, `requested a full AI report (${FORMAT_LABELS[format]}, ${REPORT_TYPE_LABELS[reportType]}, ${stats.label})`);
    res.status(201).json({ data: job });
  } catch (err) {
    next(err);
  }
}

const HISTORY_WINDOW_DAYS = 3;

async function listAiJobs(req, res, next) {
  try {
    const cutoff = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const pointers = await AiReportJob.find({ user: req.user._id, createdAt: { $gte: cutoff } })
      .sort({ createdAt: -1 })
      .lean();

    // Per-item, not Promise.all-and-fail-all: one job the AI-Backend can't find/report on
    // shouldn't blank out the rest of an otherwise-healthy history list.
    const jobs = await Promise.all(
      pointers.map(async (p) => {
        try {
          const job = await aiBackend.getJobStatus(p.jobId);
          return { ...job, _id: p._id, period: p.period, date: p.date, format: p.format, reportType: p.reportType, createdAt: p.createdAt };
        } catch {
          return null;
        }
      })
    );

    res.json({ data: jobs.filter(Boolean) });
  } catch (err) {
    next(err);
  }
}

async function deleteAiJob(req, res, next) {
  try {
    const pointer = await AiReportJob.findOne({ _id: req.params.id, user: req.user._id });
    if (!pointer) throw new AppError('Report not found', 404);
    await aiBackend.deleteJob(pointer.jobId).catch(() => {});
    await pointer.deleteOne();
    logActivity(req.user, `deleted an AI report (${REPORT_TYPE_LABELS[pointer.reportType] || pointer.reportType}, ${pointer.format})`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

async function downloadAiJob(req, res, next) {
  try {
    await aiBackend.streamDownload(req.params.id, res);
  } catch (err) {
    next(err);
  }
}

module.exports = { createAiJob, listAiJobs, deleteAiJob, downloadAiJob };
