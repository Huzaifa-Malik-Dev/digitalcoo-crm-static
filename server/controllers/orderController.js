const { z } = require('zod');
const Order = require('../models/Order');
const User = require('../models/User');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const {
  updateOrderStatus,
  sendOrderBackToPipeline,
  setOrderLinked,
  requestOrderCancellation,
  approveOrderCancellation,
  rejectOrderCancellation,
} = require('../services/workflow');
const { ORDER_STATUS, ETISALAT_STATUS, LINKED_STATUS } = require('../utils/constants');
const { assertLineItemsInCatalog } = require('../services/catalog');
const { recomputeLineItems } = require('../utils/lineItems');
const { monthLabel } = require('../utils/dateLabels');
const { sendXlsx, parseXlsxBuffer, cell } = require('../utils/importExport');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { generateOrderNo } = require('../utils/orderNo');
const { regexOr, numericRegexOr } = require('../utils/search');
const { attachIsNew, markCreatedByMe } = require('../services/recordViews');

const ORDER_FIELD_LABELS = {
  subDate: 'Submission Date', contact: 'Contact', contactNo: 'Contact No', email: 'Email', pid: 'PID',
  eOrderNo: 'e& Order No', contract: 'Contract', mrc: 'MRC', eAcctMgr: 'e& Account Manager',
  actDate: 'Activation Date', commission: 'Commission', remarks: 'Remarks', etisalatStatus: 'Etisalat Status',
};

const statusSchema = z.object({
  status: z.enum(ORDER_STATUS),
  eOrderNo: z.string().optional(),
  actDate: z.string().optional(),
  remarks: z.string().optional(),
});

const linkedSchema = z.object({ linked: z.union([z.enum(LINKED_STATUS), z.literal('')]) });

const reasonSchema = z.object({ reason: z.string().optional() });

// One {Category, Product, Subscription Type} block with one or more {price, qty} rows - see
// models/schemas/lineItem.js. mrc/blockMrc are deliberately absent: always recomputed server-side
// (utils/lineItems.js), never accepted from the client.
const lineItemsSchema = z.array(
  z.object({
    cat: z.string().optional().default(''),
    product: z.string().optional().default(''),
    sr: z.string().optional().default(''),
    rows: z
      .array(z.object({ price: z.number().min(0).optional().default(0), qty: z.number().min(1).optional().default(1) }))
      .min(1, 'Every line item needs at least one price/quantity row'),
  })
).min(1, 'At least one line item is required');

const updateSchema = z.object({
  subDate: z.string().optional(),
  contact: z.string().optional(),
  contactNo: z.string().optional(),
  email: z.string().optional(),
  pid: z.string().optional(),
  eOrderNo: z.string().optional(),
  lineItems: lineItemsSchema.optional(),
  contract: z.string().optional(),
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
  lineItems: lineItemsSchema.optional(),
  contract: z.string().optional().default('12 Months'),
  remarks: z.string().optional().default(''),
});

function scopeFilter(user) {
  if (user.role === 'admin' || user.role === 'backoffice') return {};
  if (user.role === 'agent') return { agentId: user._id };
  return {
    $or: [{ tlId: user._id }, { teamHeadId: user._id }, { salesHeadId: user._id }, { agentId: user._id }],
  };
}

// Submission/Activation Month are always derived from subDate/actDate, never stored - see
// utils/dateLabels.js for why this is a post-query enrichment rather than a Mongoose virtual.
function withMonths(order) {
  const obj = order?.toObject ? order.toObject() : order;
  if (!obj) return obj;
  return { ...obj, submissionMonth: monthLabel(obj.subDate), activationMonth: monthLabel(obj.actDate) };
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
            // product/cat/sr now live inside the lineItems array - a plain regex on the dotted
            // path matches if ANY block on the order matches, which is exactly the search
            // behaviour you want ("find orders involving product X").
            ...regexOr(term, [
              'dsrNo', 'customer', 'contact', 'contactNo', 'eOrderNo', 'pid', 'orderNo', 'status',
              'etisalatStatus', 'linked', 'lineItems.product', 'lineItems.cat', 'lineItems.sr',
            ]),
            ...numericRegexOr(term, ['mrc', 'commission']),
            { agentId: { $in: matchingAgents.map((u) => u._id) } },
          ],
        },
      ];
    }

    const [data, totalRowCount] = await Promise.all([
      Order.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('agentId', 'name')
        .populate('tlId', 'name')
        .populate('correctionRequestedBy', 'name')
        .populate('cancellationRequestedBy', 'name')
        .lean(),
      Order.countDocuments(filter),
    ]);
    const withIsNew = await attachIsNew(req.user._id, 'orders', data.map(withMonths));
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
    res.json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

// Linked gets its own endpoint rather than riding updateSchema (the way etisalatStatus does)
// because, like `status`, it carries a lock once set - see services/workflow.js setOrderLinked.
async function updateLinked(req, res, next) {
  try {
    const parsed = linkedSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const order = await setOrderLinked(req.params.id, parsed.data.linked, req.user);
    res.json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

async function sendBack(req, res, next) {
  try {
    const order = await sendOrderBackToPipeline(req.params.id, req.user);
    res.json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

// Cancellation handlers work off the order's own id, so they cover BOTH Pipeline-backed and
// directly-created orders (unlike pipelineController.requestCancellation, which can only resolve
// an order via its pipelineId). Mounted on the lightly-gated routes/orderCancellations.js router
// so a Sales Head - who has no `backoffice` module access - can still reach approve/reject.
async function requestCancellation(req, res, next) {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    const order = await requestOrderCancellation(req.params.id, req.user, parsed.success ? parsed.data.reason : undefined);
    res.json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

async function approveCancellation(req, res, next) {
  try {
    const order = await approveOrderCancellation(req.params.id, req.user);
    res.json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

async function rejectCancellation(req, res, next) {
  try {
    const parsed = reasonSchema.safeParse(req.body);
    const order = await rejectOrderCancellation(req.params.id, req.user, parsed.success ? parsed.data.reason : undefined);
    res.json({ data: withMonths(order) });
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

    if (order.linked === 'Linked' && req.user.role !== 'admin') {
      throw new AppError('This order is Linked and closed — it cannot be edited. Cancel it if a correction is needed.', 400);
    }
    // Locked for everyone, including admin, while a correction or cancellation request is pending -
    // see the matching guards in services/workflow.js's updateOrderStatus.
    if (order.correctionRequested) {
      throw new AppError('This order is on hold pending a correction request — send it back to Pipeline before editing it', 400);
    }
    if (order.cancellationRequested) {
      throw new AppError('This order is on hold pending a cancellation request — it must be approved or rejected before editing it', 400);
    }

    // Same rule as Pipeline: validated against the live catalog, with the order's own saved
    // values always allowed through. See services/catalog.js.
    if (parsed.data.lineItems !== undefined) await assertLineItemsInCatalog(parsed.data.lineItems, order.lineItems);

    const before = {};
    Object.keys(ORDER_FIELD_LABELS).forEach((k) => { before[k] = order[k]; });
    const beforeLineItems = JSON.stringify(recomputeLineItems(order.lineItems).lineItems);
    Object.assign(order, parsed.data);
    // MRC is always derived from the line items, never accepted directly from the client -
    // recompute whenever they could have changed so it never drifts out of sync with them.
    if (parsed.data.lineItems !== undefined) {
      const { lineItems, mrc } = recomputeLineItems(parsed.data.lineItems);
      order.lineItems = lineItems;
      order.mrc = mrc;
    }
    order.history.push({ userId: req.user._id, text: 'Order details edited' });
    await order.save();

    const changes = diffFields(before, order.toObject(), ORDER_FIELD_LABELS);
    // lineItems is a nested array of objects - diffFields' generic display would render it as
    // unreadable noise, so it gets its own plain marker instead of a value diff.
    if (JSON.stringify(recomputeLineItems(order.lineItems).lineItems) !== beforeLineItems) changes.push('Line items updated');
    if (changes.length) logActivity(req.user, `edited order ${order.dsrNo}: ${changes.join(', ')}`);
    res.json({ data: withMonths(order) });
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
//
// pipelineId stays null (never a synthetic/placeholder id): `direct: true` is already the flag
// every backend path uses to branch on this, the unique index on pipelineId is sparse so nulls
// don't collide, and a fake id would make Pipeline.findById(order.pipelineId) return null - turning
// sendOrderBackToPipeline's clear "it was added directly" error into a misleading "the backing
// Pipeline deal no longer exists".
async function createDirect(req, res, next) {
  try {
    const allowed = req.user.role === 'admin' || req.user.role === 'backoffice';
    if (!allowed) throw new AppError('Only Back Office can add orders directly', 403);

    const parsed = directOrderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { agentId, ...fields } = parsed.data;

    const agent = await User.findById(agentId);
    if (!agent) throw new AppError('Selected employee not found', 400);
    await assertLineItemsInCatalog(fields.lineItems);

    const orderNo = await generateOrderNo();
    const chain = agent.managerChain || [];
    const { lineItems, mrc } = recomputeLineItems(fields.lineItems);

    const order = await Order.create({
      ...fields,
      lineItems,
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
    markCreatedByMe(req.user._id, 'orders', order._id);

    logActivity(req.user, `added order ${orderNo} directly (no DSR/Pipeline) for ${agent.employeeId} (${agent.name}) — Customer: ${fields.customer}, MRC: ${mrc}`);
    res.status(201).json({ data: withMonths(order) });
  } catch (err) {
    next(err);
  }
}

// An order can carry several line-item blocks, each with several price/qty rows, but a spreadsheet
// cell is flat - so each dimension is joined into one cell rather than exploding one order across
// many rows (which would break the one-row-per-order shape every other column here assumes).
function joinBlocks(row, pick) {
  return (row.lineItems || []).map(pick).join('; ');
}
function joinRows(row, pick) {
  return (row.lineItems || []).map((b) => (b.rows || []).map(pick).join(' + ')).join('; ');
}

const EXPORT_COLUMNS = [
  { header: 'DSR No', key: 'dsrNo' },
  { header: 'Order No', key: 'orderNo' },
  { header: 'Direct?', get: (r) => (r.direct ? 'Yes' : 'No') },
  { header: 'Etisalat Status', key: 'etisalatStatus' },
  { header: 'Submission Date', key: 'subDate' },
  { header: 'Submission Month', get: (r) => monthLabel(r.subDate) },
  { header: 'Contact', key: 'contact' },
  { header: 'Contact No', key: 'contactNo' },
  { header: 'Email', key: 'email' },
  { header: 'Customer', key: 'customer' },
  { header: 'PID', key: 'pid' },
  { header: 'e& Order No', key: 'eOrderNo' },
  { header: 'SR', get: (r) => joinBlocks(r, (b) => b.sr || '') },
  { header: 'Category', get: (r) => joinBlocks(r, (b) => b.cat || '') },
  { header: 'Product', get: (r) => joinBlocks(r, (b) => b.product || '') },
  { header: 'Contract', key: 'contract' },
  { header: 'Qty', get: (r) => joinRows(r, (row) => row.qty) },
  { header: 'Price', get: (r) => joinRows(r, (row) => row.price) },
  { header: 'MRC', key: 'mrc' },
  { header: 'e& Account Manager', key: 'eAcctMgr' },
  { header: 'Status', key: 'status' },
  { header: 'Linked', key: 'linked' },
  { header: 'Activation Date', key: 'actDate' },
  { header: 'Activation Month', get: (r) => monthLabel(r.actDate) },
  { header: 'Commission', key: 'commission' },
  { header: 'Remarks', key: 'remarks' },
  { header: 'Agent', get: (r) => r.agentId?.name || '' },
];

function isValidDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// subDate/actDate are plain 'YYYY-MM-DD' strings, so they compare lexicographically - a literal
// $gte/$lte range needs no month-boundary math (unlike accountingController's monthRange helper,
// which has to derive bounds from a 'YYYY-MM' month picker). Orders with the date unset ('') fall
// outside any range automatically, which is the correct behaviour.
function dateRangeFilter(query, fromKey, toKey, label) {
  const from = query[fromKey];
  const to = query[toKey];
  if (!from && !to) return null;
  if ((from && !isValidDateStr(from)) || (to && !isValidDateStr(to))) {
    throw new AppError(`${label} range must be in YYYY-MM-DD format`, 400);
  }
  if (from && to && from > to) throw new AppError(`${label} "from" date cannot be after "to" date`, 400);
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

async function exportOrders(req, res, next) {
  try {
    const filter = { ...scopeFilter(req.user) };
    if (req.query.status) filter.status = req.query.status;
    // Two independent ranges - export by when orders were submitted, or by when they were
    // activated, or both together (they're just additional keys on the same filter).
    const subRange = dateRangeFilter(req.query, 'subDateFrom', 'subDateTo', 'Submission Date');
    if (subRange) filter.subDate = subRange;
    const actRange = dateRangeFilter(req.query, 'actDateFrom', 'actDateTo', 'Activation Date');
    if (actRange) filter.actDate = actRange;

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
//
// A spreadsheet row is flat, so an imported row can only ever describe a single line-item block -
// importing Category/Product/SR/Qty/Price REPLACES the order's line items with that one block.
// Multi-block orders are built in the UI; leave those cells empty to import the other fields
// without touching them.
const importRowSchema = z.object({
  dsrNo: z.string().trim().min(1, 'DSR No is required'),
  subDate: z.string().optional(),
  contact: z.string().optional(),
  contactNo: z.string().optional(),
  email: z.string().optional(),
  pid: z.string().optional(),
  eOrderNo: z.string().optional(),
  sr: z.string().optional(),
  cat: z.string().optional(),
  product: z.string().optional(),
  contract: z.string().optional(),
  qty: z.number().min(1).optional(),
  price: z.number().min(0).optional(),
  eAcctMgr: z.string().optional(),
  status: z.enum(ORDER_STATUS).optional(),
  linked: z.preprocess((v) => (v === '' ? undefined : v), z.enum(LINKED_STATUS, { errorMap: () => ({ message: `Linked must be one of: ${LINKED_STATUS.join(', ')}` }) }).optional()),
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
          linked: cell(raw, 'Linked'),
          actDate: cell(raw, 'Activation Date'),
          commission: numOrUndefined(cell(raw, 'Commission')),
          remarks: cell(raw, 'Remarks'),
        };
        const parsed = importRowSchema.safeParse(candidate);
        if (!parsed.success) {
          errors.push({ row: rowNum, message: parsed.error.issues[0].message });
          continue;
        }
        const { dsrNo, sr, cat, product, qty, price, ...fields } = parsed.data;
        Object.keys(fields).forEach((k) => fields[k] === '' && delete fields[k]);

        const order = await Order.findOne({ dsrNo });
        if (!order) {
          errors.push({ row: rowNum, message: `No existing order found for DSR No "${dsrNo}" — orders are opened from Pipeline, not created by import` });
          continue;
        }

        // Same rule setOrderLinked enforces - an order can't be marked Linked before it's done.
        if (fields.linked === 'Linked') {
          const finalStatus = fields.status || order.status;
          if (finalStatus !== 'Activated' && finalStatus !== 'Closed') {
            errors.push({ row: rowNum, message: `Only Activated/Closed orders can be marked Linked (status: ${finalStatus})` });
            continue;
          }
        }

        Object.assign(order, fields);
        const anyLineItemCell = [sr, cat, product, qty, price].some((v) => v !== undefined);
        if (anyLineItemCell) {
          const existing = order.lineItems?.[0];
          const existingRow = existing?.rows?.[0];
          const { lineItems, mrc } = recomputeLineItems([
            {
              cat: cat ?? existing?.cat ?? '',
              product: product ?? existing?.product ?? '',
              sr: sr ?? existing?.sr ?? '',
              rows: [{ price: price ?? existingRow?.price ?? 0, qty: qty ?? existingRow?.qty ?? 1 }],
            },
          ]);
          order.lineItems = lineItems;
          order.mrc = mrc;
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

module.exports = {
  list,
  updateStatus,
  updateLinked,
  sendBack,
  update,
  createDirect,
  assignableEmployees,
  requestCancellation,
  approveCancellation,
  rejectCancellation,
  exportOrders,
  importOrders,
  scopeFilter,
};
