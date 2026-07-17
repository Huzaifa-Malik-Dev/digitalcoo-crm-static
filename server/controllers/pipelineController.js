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
  requestOrderCancellation,
} = require('../services/workflow');
const { PIPE_STAGES } = require('../utils/constants');
const { assertLineItemsInCatalog } = require('../services/catalog');
const { recomputeLineItems } = require('../utils/lineItems');
const { sendXlsx, parseXlsxBuffer, cell, resolveAgentFromRow } = require('../utils/importExport');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { attachIsNew, markManyViewed } = require('../services/recordViews');

const PIPELINE_FIELD_LABELS = {
  email: 'Email', contactNo: 'Contact No', stage: 'Stage', startedDate: 'Started Date',
  expectedCloseDate: 'Expected Close Date', director: 'Director', remarks: 'Remarks',
};

// One {Category, Product, Subscription Type} block with one or more {price, qty} rows - see
// models/schemas/lineItem.js. mrc/blockMrc are deliberately absent: always recomputed server-side
// (utils/lineItems.js), never accepted from the client.
const lineItemsSchema = z.array(
  z.object({
    cat: z.string().trim().min(1, 'Category is required on every line item'),
    product: z.string().trim().min(1, 'Product is required on every line item'),
    sr: z.string().trim().min(1, 'Subscription Type is required on every line item'),
    rows: z
      .array(z.object({ price: z.number().positive('Unit Price is required on every row'), qty: z.number().min(1, 'Quantity is required on every row') }))
      .min(1, 'Every line item needs at least one price/quantity row'),
  })
).min(1, 'At least one line item is required');

// Lenient counterpart for the initial DSR->Pipeline conversion, where a deal is legitimately
// created before its line items are known (the agent fills them in afterward).
const draftLineItemsSchema = z.array(
  z.object({
    cat: z.string().optional().default(''),
    product: z.string().optional().default(''),
    sr: z.string().optional().default(''),
    rows: z.array(z.object({ price: z.number().min(0).optional().default(0), qty: z.number().min(1).optional().default(1) })).optional(),
  })
);

const convertSchema = z.object({
  dsrId: z.string().min(1),
  lineItems: draftLineItemsSchema.optional(),
  email: z.string().optional(),
  remarks: z.string().optional(),
});

const reasonSchema = z.object({ reason: z.string().optional() });

// startedDate is deliberately absent - it's system-set at conversion/import time and can never be
// changed via this endpoint (unknown keys are stripped by zod's default object() behavior, so a
// client that still sends it is silently ignored rather than erroring).
const updateSchema = z.object({
  lineItems: lineItemsSchema,
  email: z.string().trim().min(1, 'Customer Email is required'),
  contactNo: z.string().optional(),
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
            // product/cat/sr now live inside the lineItems array - a plain regex on the dotted
            // path matches if ANY block in the deal matches, which is exactly the search
            // behaviour you want ("find deals involving product X").
            ...regexOr(term, ['dsrNo', 'company', 'customer', 'lineItems.product', 'lineItems.cat', 'lineItems.sr', 'stage', 'approval']),
            ...numericRegexOr(term, ['mrc']),
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

    // Surfaced so the deal panel can show correction/cancellation status without the client needing
    // to know an order id it was never given (see requestCorrection below, which resolves the same way).
    const order = await Order.findOne({ pipelineId: pipeline._id })
      .select(
        'status linked correctionRequested correctionRequestedBy correctionRequestedAt correctionNote correctionCount ' +
          'cancellationRequested cancellationRequestedBy cancellationRequestedAt cancellationReason cancellationRejectionReason'
      )
      .populate('correctionRequestedBy', 'name')
      .populate('cancellationRequestedBy', 'name')
      .lean();
    pipeline.orderCorrection = order
      ? {
          status: order.status,
          linked: order.linked,
          requested: order.correctionRequested,
          requestedBy: order.correctionRequestedBy?.name || null,
          requestedAt: order.correctionRequestedAt,
          note: order.correctionNote,
          count: order.correctionCount,
        }
      : null;
    pipeline.orderCancellation = order
      ? {
          requested: order.cancellationRequested,
          requestedBy: order.cancellationRequestedBy?.name || null,
          requestedAt: order.cancellationRequestedAt,
          reason: order.cancellationReason,
          rejectionReason: order.cancellationRejectionReason,
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
    // the TL/admin reviewing it can) - and once the TL has approved it, the order Back Office now
    // owns is the source of truth, so nobody but an admin can edit it here. An admin still can
    // (for correcting a genuine error without the full send-back-for-correction ceremony), but
    // every such edit is labelled as an override in history/activity log rather than looking like
    // a routine edit - see adminOverride below.
    if (!isAdmin) {
      if (pipeline.approval === 'approved') {
        throw new AppError('This deal has been approved and sent to Back Office — it can no longer be edited here', 400);
      }
      if (pipeline.approval === 'pending_tl' && isAgentOwner && !isTl) {
        throw new AppError('This deal is awaiting Team Leader approval and cannot be edited until then', 400);
      }
    }
    const adminOverride = isAdmin && pipeline.approval === 'approved';

    const fields = parsed.data;
    // Validated here rather than by a schema enum: the catalog is admin-editable, and the deal's
    // own saved values are always allowed through so a retired category can't block an unrelated
    // edit to an old deal. See services/catalog.js.
    await assertLineItemsInCatalog(fields.lineItems, pipeline.lineItems);

    const before = {};
    Object.keys(PIPELINE_FIELD_LABELS).forEach((k) => { before[k] = pipeline[k]; });
    const beforeLineItems = JSON.stringify(recomputeLineItems(pipeline.lineItems).lineItems);
    const oldStage = pipeline.stage;
    Object.assign(pipeline, fields);
    const { lineItems, mrc } = recomputeLineItems(fields.lineItems);
    pipeline.lineItems = lineItems;
    pipeline.mrc = mrc;
    pipeline.annual = mrc * 12;
    pipeline.history.push({
      userId: req.user._id,
      text: adminOverride ? 'Admin override edit while approved' : 'Deal details edited',
    });
    await pipeline.save();

    const changes = diffFields(before, pipeline.toObject(), PIPELINE_FIELD_LABELS);
    // lineItems is a nested array of objects - diffFields' generic display would render it as
    // unreadable noise, so it gets its own plain marker instead of a value diff.
    if (JSON.stringify(lineItems) !== beforeLineItems) changes.push('Line items updated');
    if (changes.length) {
      const prefix = adminOverride ? 'ADMIN OVERRIDE — edited approved deal' : 'edited deal';
      logActivity(req.user, `${prefix} ${pipeline.dsrNo} (${pipeline.company}): ${changes.join(', ')}`);
    }

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

// Same reasoning as requestCorrection above - the agent/TL only knows their Pipeline deal, so this
// resolves the linked order internally. Directly-created Back Office orders (no pipelineId) can't
// reach this route at all; they use routes/orderCancellations.js, which works off an order id.
async function requestCancellation(req, res, next) {
  try {
    const order = await Order.findOne({ pipelineId: req.params.id });
    if (!order) throw new AppError('No Back Office order exists yet for this deal', 404);
    const parsed = reasonSchema.safeParse(req.body);
    const result = await requestOrderCancellation(order._id, req.user, parsed.success ? parsed.data.reason : undefined);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}


// A deal can carry several line-item blocks, each with several price/qty rows, but a spreadsheet
// cell is flat - so each dimension is joined into one cell rather than exploding one deal across
// many rows (which would break the one-row-per-deal shape every other column here assumes).
function joinBlocks(row, pick) {
  return (row.lineItems || []).map(pick).join('; ');
}
function joinRows(row, pick) {
  return (row.lineItems || []).map((b) => (b.rows || []).map(pick).join(' + ')).join('; ');
}

const EXPORT_COLUMNS = [
  { header: 'DSR No', key: 'dsrNo' },
  { header: 'Company', key: 'company' },
  { header: 'Customer', key: 'customer' },
  { header: 'Email', key: 'email' },
  { header: 'Contact No', key: 'contactNo' },
  { header: 'Category', get: (r) => joinBlocks(r, (b) => b.cat || '') },
  { header: 'Product', get: (r) => joinBlocks(r, (b) => b.product || '') },
  { header: 'SR', get: (r) => joinBlocks(r, (b) => b.sr || '') },
  { header: 'Price', get: (r) => joinRows(r, (row) => row.price) },
  { header: 'Qty', get: (r) => joinRows(r, (row) => row.qty) },
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
// A spreadsheet row is inherently flat, so an imported row always becomes a deal with exactly one
// line-item block/row - multi-block deals are built in the UI afterward, not imported.
const importRowSchema = z.object({
  company: z.string().trim().min(1, 'Company is required'),
  contactNo: z.string().trim().min(1, 'Contact No is required'),
  email: z.string().optional().default(''),
  customer: z.string().optional().default(''),
  cat: z.string().optional(),
  product: z.string().optional().default(''),
  sr: z.string().optional(),
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
    const createdIds = []; // marked viewed for the importer in one bulk write at the end

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

        const { lineItems, mrc } = recomputeLineItems([
          { cat: body.cat || '', product: body.product, sr: body.sr || '', rows: [{ price: body.price, qty: body.qty }] },
        ]);
        const importedDeal = await Pipeline.create({
          dsrId: dsr._id,
          dsrNo: dsr.dsrNo,
          agentId: agent._id,
          tlId: chain[0] || null,
          teamHeadId: chain[1] || null,
          salesHeadId: chain[2] || null,
          company: body.company,
          customer: body.customer,
          email: body.email,
          contactNo: body.contactNo,
          lineItems,
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
        createdIds.push(importedDeal._id);
        created += 1;
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message || 'Unexpected error' });
      }
    }

    // The importer created these, so they must not come back highlighted as new to them.
    await markManyViewed(req.user._id, 'pipeline', createdIds);

    logActivity(req.user, `imported pipeline deals from spreadsheet: ${created} created, ${errors.length} failed, ${rawRows.length} rows total`);
    res.json({ data: { total: rawRows.length, created, failed: errors.length, errors } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  getOne,
  create,
  update,
  escalateTl,
  approve,
  reject,
  requestCorrection,
  requestCancellation,
  exportPipeline,
  importPipeline,
  scopeFilter,
};
