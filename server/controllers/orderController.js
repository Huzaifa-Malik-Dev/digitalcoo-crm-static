const { z } = require('zod');
const Order = require('../models/Order');
const User = require('../models/User');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { updateOrderStatus, sendOrderBackToPipeline } = require('../services/workflow');
const { ORDER_STATUS, ETISALAT_STATUS, SR_TYPES } = require('../utils/constants');
const { sendXlsx, parseXlsxBuffer, cell } = require('../utils/importExport');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { generateOrderNo } = require('../utils/orderNo');
const { regexOr, numericRegexOr } = require('../utils/search');
const { attachIsNew } = require('../services/recordViews');

const ORDER_FIELD_LABELS = {
  subDate: 'Submission Date', contact: 'Contact', contactNo: 'Contact No', email: 'Email', pid: 'PID',
  eOrderNo: 'e& Order No', sr: 'SR', cat: 'Category', product: 'Product', contract: 'Contract',
  qty: 'Qty', price: 'Price', mrc: 'MRC', eAcctMgr: 'e& Account Manager', actDate: 'Activation Date', commission: 'Commission',
  remarks: 'Remarks', etisalatStatus: 'Etisalat Status',
};

const statusSchema = z.object({
  status: z.enum(ORDER_STATUS),
  eOrderNo: z.string().optional(),
  actDate: z.string().optional(),
  remarks: z.string().optional(),
});

const updateSchema = z.object({
  subDate: z.string().optional(),
  contact: z.string().optional(),
  contactNo: z.string().optional(),
  email: z.string().optional(),
  pid: z.string().optional(),
  eOrderNo: z.string().optional(),
  sr: z.enum(SR_TYPES).optional(),
  cat: z.string().optional(),
  product: z.string().optional(),
  contract: z.string().optional(),
  qty: z.number().min(1).optional(),
  price: z.number().min(0).optional(),
  eAcctMgr: z.string().optional(),
  actDate: z.string().optional(),
  commission: z.number().min(0).optional(),
  remarks: z.string().optional(),
  // '' means "not set yet" (the Select's cleared state) - always present in the submitted form
  // body even when untouched, so it must be accepted alongside the real enum values, not just
  // omittable.
  etisalatStatus: z.union([z.enum(ETISALAT_STATUS), z.literal('')]).optional(),
});

// Every field a directly-created order (no DSR/Pipeline behind it) needs up front.
const directOrderSchema = z.object({
  agentId: z.string().min(1),
  customer: z.string().trim().min(1),
  contact: z.string().optional().default(''),
  contactNo: z.string().optional().default(''),
  email: z.string().optional().default(''),
  sr: z.enum(SR_TYPES).optional().default('NEW'),
  cat: z.string().optional().default(''),
  product: z.string().optional().default(''),
  contract: z.string().optional().default('12 Months'),
  qty: z.number().min(1).optional().default(1),
  price: z.number().min(0).optional().default(0),
  remarks: z.string().optional().default(''),
});

function scopeFilter(user) {
  if (user.role === 'admin' || user.role === 'backoffice') return {};
  if (user.role === 'agent') return { agentId: user._id };
  return {
    $or: [{ tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }, { agentId: user._id }],
  };
}

async function list(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = { ...scopeFilter(req.user) };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      const matchingAgents = await User.find({ name: re }).select('_id').lean();
      filter.$and = [
        {
          $or: [
            ...regexOr(term, ['dsrNo', 'customer', 'contact', 'contactNo', 'eOrderNo', 'pid', 'product', 'orderNo', 'status', 'etisalatStatus']),
            ...numericRegexOr(term, ['qty', 'mrc', 'commission']),
            { agentId: { $in: matchingAgents.map((u) => u._id) } },
          ],
        },
      ];
    }

    const [data, totalRowCount] = await Promise.all([
      Order.find(filter).sort(sort).skip(skip).limit(limit).populate('agentId', 'name').populate('tlId', 'name').populate('correctionRequestedBy', 'name').lean(),
      Order.countDocuments(filter),
    ]);
    const withIsNew = await attachIsNew(req.user._id, 'orders', data);
    res.json(buildPageResponse(withIsNew, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function updateStatus(req, res, next) {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { status, ...extra } = parsed.data;
    const order = await updateOrderStatus(req.params.id, status, req.user, extra);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

async function sendBack(req, res, next) {
  try {
    const order = await sendOrderBackToPipeline(req.params.id, req.user);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const allowed = req.user.role === 'admin' || req.user.role === 'backoffice';
    if (!allowed) throw new AppError('Only Back Office can edit orders', 403);

    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError('Order not found', 404);

    if (order.status === 'In Line' && req.user.role !== 'admin') {
      throw new AppError('This order is In Line and closed — it cannot be edited. Cancel it if a correction is needed.', 400);
    }
    // Locked for everyone, including admin, while a correction request is pending - see the
    // matching guard in services/workflow.js's updateOrderStatus.
    if (order.correctionRequested) {
      throw new AppError('This order is on hold pending a correction request — send it back to Pipeline before editing it', 400);
    }

    const before = {};
    Object.keys(ORDER_FIELD_LABELS).forEach((k) => { before[k] = order[k]; });
    Object.assign(order, parsed.data);
    // MRC is always derived, never accepted directly from the client - recompute whenever price
    // or qty could have changed so it never drifts out of sync with them.
    if (parsed.data.price !== undefined || parsed.data.qty !== undefined) {
      order.mrc = order.price * order.qty;
    }
    order.history.push({ userId: req.user._id, text: 'Order details edited' });
    await order.save();

    const changes = diffFields(before, order.toObject(), ORDER_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited order ${order.dsrNo}: ${changes.join(', ')}`);
    res.json({ data: order });
  } catch (err) {
    next(err);
  }
}

// Who can be attributed as the agent/TL on a directly-created order - unlike DSR's own
// loggable-employees (scoped to the creator's subtree, since a TL only logs for their own
// team), Back Office/Admin need to attribute a direct order to ANY active sales-side employee,
// since fulfillment isn't scoped to one team.
async function assignableEmployees(req, res, next) {
  try {
    const allowed = req.user.role === 'admin' || req.user.role === 'backoffice';
    if (!allowed) throw new AppError('Only Back Office can add orders directly', 403);
    const employees = await User.find({ active: true }).select('employeeId name role').sort({ name: 1 }).lean();
    res.json({ data: employees });
  } catch (err) {
    next(err);
  }
}

// Adds an order straight into Back Office, bypassing DSR -> Pipeline -> Approval entirely - for
// deals negotiated/agreed outside the normal funnel. No Dsr or Pipeline record is created; the
// generated internal orderNo doubles as this order's dsrNo (the field every other record type,
// chat thread, and export already keys off), and `direct: true` marks it clearly in the UI so
// it's never mistaken for a deal that actually came through the funnel.
async function createDirect(req, res, next) {
  try {
    const allowed = req.user.role === 'admin' || req.user.role === 'backoffice';
    if (!allowed) throw new AppError('Only Back Office can add orders directly', 403);

    const parsed = directOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { agentId, ...fields } = parsed.data;

    const agent = await User.findById(agentId);
    if (!agent) throw new AppError('Selected employee not found', 400);

    const orderNo = await generateOrderNo();
    const chain = agent.managerChain || [];
    const mrc = fields.price * fields.qty;

    const order = await Order.create({
      ...fields,
      mrc,
      pipelineId: null,
      dsrNo: orderNo,
      orderNo,
      direct: true,
      agentId: agent._id,
      tlId: chain[0] || null,
      teamHeadId: chain[1] || null,
      salesHeadId: chain[2] || null,
      status: 'New',
      history: [{ userId: req.user._id, text: `Order added directly by ${req.user.name} — no DSR/Pipeline` }],
    });

    logActivity(req.user, `added order ${orderNo} directly (no DSR/Pipeline) for ${agent.employeeId} (${agent.name}) — Customer: ${fields.customer}, Price: ${fields.price}, Qty: ${fields.qty}, MRC: ${mrc}`);
    res.status(201).json({ data: order });
  } catch (err) {
    next(err);
  }
}

const EXPORT_COLUMNS = [
  { header: 'DSR No', key: 'dsrNo' },
  { header: 'Order No', key: 'orderNo' },
  { header: 'Direct?', get: (r) => (r.direct ? 'Yes' : 'No') },
  { header: 'Etisalat Status', key: 'etisalatStatus' },
  { header: 'Submission Date', key: 'subDate' },
  { header: 'Contact', key: 'contact' },
  { header: 'Contact No', key: 'contactNo' },
  { header: 'Email', key: 'email' },
  { header: 'Customer', key: 'customer' },
  { header: 'PID', key: 'pid' },
  { header: 'e& Order No', key: 'eOrderNo' },
  { header: 'SR', key: 'sr' },
  { header: 'Category', key: 'cat' },
  { header: 'Product', key: 'product' },
  { header: 'Contract', key: 'contract' },
  { header: 'Qty', key: 'qty' },
  { header: 'Price', key: 'price' },
  { header: 'MRC', key: 'mrc' },
  { header: 'e& Account Manager', key: 'eAcctMgr' },
  { header: 'Status', key: 'status' },
  { header: 'Activation Date', key: 'actDate' },
  { header: 'Commission', key: 'commission' },
  { header: 'Remarks', key: 'remarks' },
  { header: 'Agent', get: (r) => r.agentId?.name || '' },
];

async function exportOrders(req, res, next) {
  try {
    const filter = { ...scopeFilter(req.user) };
    if (req.query.status) filter.status = req.query.status;
    const rows = await Order.find(filter).sort({ createdAt: -1 }).populate('agentId', 'name').lean();
    sendXlsx(res, `orders-export-${Date.now()}.xlsx`, rows, EXPORT_COLUMNS, 'Orders');
  } catch (err) {
    next(err);
  }
}

// Orders can't be created out of thin air on import — every order is tied to a Pipeline deal
// that opened it (see services/workflow.js ensureOrderForPipeline). So import here is an UPDATE
// of Back Office fulfillment fields on an *existing* order, matched by its DSR No — this mirrors
// how Back Office actually works from their tracker (fill in PID/order no./commission etc. for
// deals that already came through), not how new orders get created.
const importRowSchema = z.object({
  dsrNo: z.string().trim().min(1, 'DSR No is required'),
  subDate: z.string().optional(),
  contact: z.string().optional(),
  contactNo: z.string().optional(),
  email: z.string().optional(),
  pid: z.string().optional(),
  eOrderNo: z.string().optional(),
  sr: z.enum(SR_TYPES).optional(),
  cat: z.string().optional(),
  product: z.string().optional(),
  contract: z.string().optional(),
  qty: z.number().min(1).optional(),
  price: z.number().min(0).optional(),
  eAcctMgr: z.string().optional(),
  status: z.enum(ORDER_STATUS).optional(),
  actDate: z.string().optional(),
  commission: z.number().min(0).optional(),
  remarks: z.string().optional(),
});

function numOrUndefined(v) {
  return v === '' ? undefined : Number(v);
}

async function importOrders(req, res, next) {
  try {
    const allowed = req.user.role === 'admin' || req.user.role === 'backoffice';
    if (!allowed) throw new AppError('Only Back Office can import orders', 403);

    if (!req.file) throw new AppError('No file uploaded', 400);
    const rawRows = parseXlsxBuffer(req.file.buffer);
    if (!rawRows.length) throw new AppError('The file has no data rows', 400);

    const errors = [];
    let updated = 0;

    for (let i = 0; i < rawRows.length; i += 1) {
      const raw = rawRows[i];
      const rowNum = i + 2;
      try {
        const candidate = {
          dsrNo: cell(raw, 'DSR No'),
          subDate: cell(raw, 'Submission Date'),
          contact: cell(raw, 'Contact'),
          contactNo: cell(raw, 'Contact No'),
          email: cell(raw, 'Email'),
          pid: cell(raw, 'PID'),
          eOrderNo: cell(raw, 'e& Order No'),
          sr: cell(raw, 'SR'),
          cat: cell(raw, 'Category'),
          product: cell(raw, 'Product'),
          contract: cell(raw, 'Contract'),
          qty: numOrUndefined(cell(raw, 'Qty')),
          price: numOrUndefined(cell(raw, 'Price')),
          eAcctMgr: cell(raw, 'e& Account Manager'),
          status: cell(raw, 'Status') || undefined,
          actDate: cell(raw, 'Activation Date'),
          commission: numOrUndefined(cell(raw, 'Commission')),
          remarks: cell(raw, 'Remarks'),
        };
        const parsed = importRowSchema.safeParse(candidate);
        if (!parsed.success) {
          errors.push({ row: rowNum, message: parsed.error.issues[0].message });
          continue;
        }
        const { dsrNo, ...fields } = parsed.data;
        Object.keys(fields).forEach((k) => fields[k] === '' && delete fields[k]);

        const order = await Order.findOne({ dsrNo });
        if (!order) {
          errors.push({ row: rowNum, message: `No existing order found for DSR No "${dsrNo}" — orders are opened from Pipeline, not created by import` });
          continue;
        }

        Object.assign(order, fields);
        if (fields.price !== undefined || fields.qty !== undefined) {
          order.mrc = order.price * order.qty;
        }
        order.history.push({ userId: req.user._id, text: 'Order details updated via spreadsheet import' });
        await order.save();
        updated += 1;
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message || 'Unexpected error' });
      }
    }

    logActivity(req.user, `imported order updates from spreadsheet: ${updated} updated, ${errors.length} failed, ${rawRows.length} rows total`);
    res.json({ data: { total: rawRows.length, updated, failed: errors.length, errors } });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, updateStatus, sendBack, update, createDirect, assignableEmployees, exportOrders, importOrders };
