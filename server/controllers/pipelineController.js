const { z } = require('zod');
const Pipeline = require('../models/Pipeline');
const Dsr = require('../models/Dsr');
const Order = require('../models/Order');
const User = require('../models/User');
const { nextSeq } = require('../models/Counter');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { regexOr, numericRegexOr } = require('../utils/search');
const {
  convertToPipeline,
  escalateToTL,
  tlApprove,
  tlReject,
  ensureOrderForPipeline,
  requestOrderCorrection,
} = require('../services/workflow');
const { PIPE_STAGES, SR_TYPES } = require('../utils/constants');
const { sendXlsx, parseXlsxBuffer, cell, resolveAgentFromRow } = require('../utils/importExport');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { attachIsNew } = require('../services/recordViews');

const PIPELINE_FIELD_LABELS = {
  cat: 'Category', product: 'Product', sr: 'SR', price: 'Price', qty: 'Qty', email: 'Email',
  stage: 'Stage', startedDate: 'Started Date', expectedCloseDate: 'Expected Close Date',
  director: 'Director', remarks: 'Remarks',
};

const convertSchema = z.object({
  dsrId: z.string().min(1),
  cat: z.string().optional(),
  product: z.string().optional(),
  sr: z.enum(SR_TYPES).optional(),
  price: z.number().optional(),
  qty: z.number().optional(),
  email: z.string().optional(),
  remarks: z.string().optional(),
});

const reasonSchema = z.object({ reason: z.string().optional() });

// startedDate is deliberately absent - it's system-set at conversion/import time and can never be
// changed via this endpoint (unknown keys are stripped by zod's default object() behavior, so a
// client that still sends it is silently ignored rather than erroring).
const updateSchema = z.object({
  cat: z.string().trim().min(1, 'Category is required'),
  product: z.string().trim().min(1, 'Product is required'),
  sr: z.enum(SR_TYPES, { errorMap: () => ({ message: 'Subscription Type is required' }) }),
  price: z.number().positive('Price is required'),
  qty: z.number().min(1, 'Quantity is required'),
  email: z.string().trim().min(1, 'Customer Email is required'),
  stage: z.enum(PIPE_STAGES).optional(),
  expectedCloseDate: z.string().trim().min(1, 'Expected Close Date is required'),
  director: z.string().optional(),
  remarks: z.string().trim().min(1, 'Remarks are required'),
});

function scopeFilter(user) {
  if (user.role === 'admin') return {};
  if (user.role === 'agent') return { agentId: user._id };
  return {
    $or: [{ tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }, { agentId: user._id }],
  };
}

async function list(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = { ...scopeFilter(req.user) };
    if (req.query.stage) filter.stage = req.query.stage;
    if (req.query.approval) filter.approval = req.query.approval;
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      const matchingAgents = await User.find({ name: re }).select('_id').lean();
      filter.$and = [
        { $or: [
            ...regexOr(term, ['dsrNo', 'company', 'customer', 'product', 'stage', 'approval']),
            ...numericRegexOr(term, ['qty', 'mrc']),
            { agentId: { $in: matchingAgents.map((u) => u._id) } },
        ] },
      ];
    }

    const [data, totalRowCount] = await Promise.all([
      Pipeline.find(filter).sort(sort).skip(skip).limit(limit).populate('agentId', 'name').lean(),
      Pipeline.countDocuments(filter),
    ]);
    const withIsNew = await attachIsNew(req.user._id, 'pipeline', data);
    res.json(buildPageResponse(withIsNew, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const pipeline = await Pipeline.findById(req.params.id)
      .populate('agentId', 'name')
      .populate('tlId', 'name')
      .populate('history.userId', 'name')
      .lean();
    if (!pipeline) throw new AppError('Pipeline item not found', 404);

    const scope = scopeFilter(req.user);
    if (Object.keys(scope).length) {
      const inScope =
        req.user.role === 'agent'
          ? String(pipeline.agentId?._id) === String(req.user._id)
          : [pipeline.tlId?._id, pipeline.teamHeadId, pipeline.salesHeadId, pipeline.agentId?._id].some(
              (id) => String(id) === String(req.user._id)
            );
      if (!inScope) throw new AppError('You do not have access to this deal', 403);
    }

    // Surfaced so the deal panel can show correction status without the client needing to know
    // an order id it was never given (see requestCorrection above, which resolves the same way).
    const order = await Order.findOne({ pipelineId: pipeline._id })
      .select('status correctionRequested correctionRequestedBy correctionRequestedAt correctionNote correctionCount')
      .populate('correctionRequestedBy', 'name')
      .lean();
    pipeline.orderCorrection = order
      ? {
          status: order.status,
          requested: order.correctionRequested,
          requestedBy: order.correctionRequestedBy?.name || null,
          requestedAt: order.correctionRequestedAt,
          note: order.correctionNote,
          count: order.correctionCount,
        }
      : null;

    res.json({ data: pipeline });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const parsed = convertSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const pipeline = await convertToPipeline(parsed.data.dsrId, parsed.data, req.user);
    res.status(201).json({ data: pipeline });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const pipeline = await Pipeline.findById(req.params.id);
    if (!pipeline) throw new AppError('Pipeline item not found', 404);

    const isAdmin = req.user.role === 'admin';
    const isTl = String(pipeline.tlId) === String(req.user._id);
    const isAgentOwner = String(pipeline.agentId) === String(req.user._id);

    const allowed = isAdmin || isAgentOwner || isTl;
    if (!allowed) throw new AppError('You cannot edit this deal', 403);

    // Once a deal is awaiting TL approval, the agent who owns it can no longer change it (only
    // the TL/admin reviewing it can) - and once the TL has approved it, nobody can edit it here
    // at all, since the order that Back Office now owns is the source of truth from that point.
    if (!isAdmin) {
      if (pipeline.approval === 'approved') {
        throw new AppError('This deal has been approved and sent to Back Office — it can no longer be edited here', 400);
      }
      if (pipeline.approval === 'pending_tl' && isAgentOwner && !isTl) {
        throw new AppError('This deal is awaiting Team Leader approval and cannot be edited until then', 400);
      }
    }

    const fields = parsed.data;
    const before = {};
    Object.keys(PIPELINE_FIELD_LABELS).forEach((k) => { before[k] = pipeline[k]; });
    const oldStage = pipeline.stage;
    Object.assign(pipeline, fields);
    const price = fields.price ?? pipeline.price;
    const qty = fields.qty ?? pipeline.qty;
    if (fields.price !== undefined || fields.qty !== undefined) {
      pipeline.mrc = price * qty;
      pipeline.annual = pipeline.mrc * 12;
    }
    pipeline.history.push({ userId: req.user._id, text: 'Deal details edited' });
    await pipeline.save();

    const changes = diffFields(before, pipeline.toObject(), PIPELINE_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited deal ${pipeline.dsrNo} (${pipeline.company}): ${changes.join(', ')}`);

    // Reaching 100% opens (or updates) the Back Office order, same as a TL approval does -
    // whichever path gets there first.
    if (fields.stage === '100% - Deal Won' && oldStage !== '100% - Deal Won') {
      await ensureOrderForPipeline(pipeline, req.user, 'Order opened — deal marked Won (100%)');
    }

    res.json({ data: pipeline });
  } catch (err) {
    next(err);
  }
}

async function escalateTl(req, res, next) {
  try {
    const pipeline = await escalateToTL(req.params.id, req.user);
    res.json({ data: pipeline });
  } catch (err) {
    next(err);
  }
}

async function approve(req, res, next) {
  try {
    const result = await tlApprove(req.params.id, req.user);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

async function reject(req, res, next) {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    const pipeline = await tlReject(req.params.id, req.user, parsed.success ? parsed.data.reason : undefined);
    res.json({ data: pipeline });
  } catch (err) {
    next(err);
  }
}

// The agent/TL's own view of this deal is the Pipeline record, not the Order Back Office owns
// (which they typically can't even see) - so the "something's wrong, please fix it" trigger lives
// here and resolves to the linked order internally, rather than asking the client to know an
// order id it was never given.
async function requestCorrection(req, res, next) {
  try {
    const order = await Order.findOne({ pipelineId: req.params.id });
    if (!order) throw new AppError('No Back Office order exists yet for this deal', 404);
    const parsed = reasonSchema.safeParse(req.body);
    const result = await requestOrderCorrection(order._id, req.user, parsed.success ? parsed.data.reason : undefined);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

const EXPORT_COLUMNS = [
  { header: 'DSR No', key: 'dsrNo' },
  { header: 'Company', key: 'company' },
  { header: 'Customer', key: 'customer' },
  { header: 'Email', key: 'email' },
  { header: 'Category', key: 'cat' },
  { header: 'Product', key: 'product' },
  { header: 'SR', key: 'sr' },
  { header: 'Price', key: 'price' },
  { header: 'Qty', key: 'qty' },
  { header: 'MRC', key: 'mrc' },
  { header: 'Annual', key: 'annual' },
  { header: 'Stage', key: 'stage' },
  { header: 'Approval', key: 'approval' },
  { header: 'Started Date', key: 'startedDate' },
  { header: 'Expected Close Date', key: 'expectedCloseDate' },
  { header: 'Director', key: 'director' },
  { header: 'Remarks', key: 'remarks' },
  { header: 'Agent', get: (r) => r.agentId?.name || '' },
  { header: 'Agent Email', get: (r) => r.agentId?.email || '' },
  { header: 'Agent Username', get: (r) => r.agentId?.username || '' },
];

async function exportPipeline(req, res, next) {
  try {
    const filter = { ...scopeFilter(req.user) };
    if (req.query.stage) filter.stage = req.query.stage;
    if (req.query.approval) filter.approval = req.query.approval;
    const rows = await Pipeline.find(filter).sort({ createdAt: -1 }).populate('agentId', 'name email username').lean();
    sendXlsx(res, `pipeline-export-${Date.now()}.xlsx`, rows, EXPORT_COLUMNS, 'Pipeline');
  } catch (err) {
    next(err);
  }
}

// A Pipeline deal always needs a backing DSR (dsrId is required — see models/Pipeline.js), so an
// imported row gets a minimal companion "Lead Generated" DSR created for it first, same as a real
// agent would log a call before converting it — this keeps every rollup/history path consistent.
const importRowSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  contactNo: z.string().trim().min(1, 'Contact No is required'),
  email: z.string().optional().default(''),
  customer: z.string().optional().default(''),
  cat: z.string().optional().default(''),
  product: z.string().optional().default(''),
  sr: z.preprocess((v) => (v === '' ? undefined : v), z.enum(SR_TYPES, { errorMap: () => ({ message: `SR must be one of: ${SR_TYPES.join(', ')}` }) }).optional()),
  price: z.number().min(0).optional().default(0),
  qty: z.number().min(1).optional().default(1),
  stage: z.enum(PIPE_STAGES, { errorMap: () => ({ message: `Stage must be one of: ${PIPE_STAGES.join(', ')}` }) }).optional().default('10%- Prospect'),
  expectedCloseDate: z.string().optional().default(''),
  director: z.string().optional().default(''),
  remarks: z.string().optional().default(''),
});

async function importPipeline(req, res, next) {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);
    const rawRows = parseXlsxBuffer(req.file.buffer);
    if (!rawRows.length) throw new AppError('The file has no data rows', 400);

    const errors = [];
    let created = 0;

    for (let i = 0; i < rawRows.length; i += 1) {
      const raw = rawRows[i];
      const rowNum = i + 2;
      try {
        const priceRaw = cell(raw, 'Price');
        const qtyRaw = cell(raw, 'Qty');
        const candidate = {
          company: cell(raw, 'Company'),
          contactNo: cell(raw, 'Contact No'),
          email: cell(raw, 'Email'),
          customer: cell(raw, 'Customer'),
          cat: cell(raw, 'Category'),
          product: cell(raw, 'Product'),
          sr: cell(raw, 'SR'),
          price: priceRaw === '' ? undefined : Number(priceRaw),
          qty: qtyRaw === '' ? undefined : Number(qtyRaw),
          stage: cell(raw, 'Stage') || undefined,
          expectedCloseDate: cell(raw, 'Expected Close Date'),
          director: cell(raw, 'Director'),
          remarks: cell(raw, 'Remarks'),
        };
        const parsed = importRowSchema.safeParse(candidate);
        if (!parsed.success) {
          errors.push({ row: rowNum, message: parsed.error.issues[0].message });
          continue;
        }
        const body = parsed.data;

        const { agent, error: agentError } = await resolveAgentFromRow(raw, req.user, User);
        if (agentError) {
          errors.push({ row: rowNum, message: agentError });
          continue;
        }

        const chain = agent.managerChain || [];
        const seq = await nextSeq('dsr');
        const dsrNo = 'DSR-' + String(seq).padStart(5, '0');

        const dsr = await Dsr.create({
          dsrNo,
          date: new Date().toISOString().slice(0, 10),
          company: body.company,
          contactNo: body.contactNo,
          email: body.email,
          customer: body.customer,
          status: 'Lead Generated',
          connected: 'YES',
          agentId: agent._id,
          tlId: chain[0] || null,
          teamHeadId: chain[1] || null,
          salesHeadId: chain[2] || null,
          convertedToPipeline: true,
          history: [{ userId: req.user._id, text: 'DSR auto-created for imported pipeline deal' }],
        });

        const mrc = body.qty * body.price;
        await Pipeline.create({
          dsrId: dsr._id,
          dsrNo: dsr.dsrNo,
          agentId: agent._id,
          tlId: chain[0] || null,
          teamHeadId: chain[1] || null,
          salesHeadId: chain[2] || null,
          company: body.company,
          customer: body.customer,
          email: body.email,
          cat: body.cat,
          product: body.product,
          sr: body.sr,
          price: body.price,
          qty: body.qty,
          mrc,
          annual: mrc * 12,
          stage: body.stage,
          // Same rule as a normal DSR conversion - startedDate is always system-set to when the
          // deal entered the pipeline, never taken from the imported sheet.
          startedDate: new Date().toISOString().slice(0, 10),
          expectedCloseDate: body.expectedCloseDate,
          director: body.director,
          remarks: body.remarks,
          history: [{ userId: req.user._id, text: 'Deal imported from spreadsheet' }],
        });
        created += 1;
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message || 'Unexpected error' });
      }
    }

    logActivity(req.user, `imported pipeline deals from spreadsheet: ${created} created, ${errors.length} failed, ${rawRows.length} rows total`);
    res.json({ data: { total: rawRows.length, created, failed: errors.length, errors } });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, create, update, escalateTl, approve, reject, requestCorrection, exportPipeline, importPipeline };
