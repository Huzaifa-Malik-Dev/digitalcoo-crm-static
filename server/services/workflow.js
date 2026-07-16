const Dsr = require('../models/Dsr');
const Pipeline = require('../models/Pipeline');
const Order = require('../models/Order');
const User = require('../models/User');
const { notify } = require('./notify');
const AppError = require('../utils/AppError');
const { logActivity } = require('../utils/activityLog');
const { generateOrderNo } = require('../utils/orderNo');
const { PIPELINE_REQUIRED_FOR_APPROVAL } = require('../utils/constants');

function missingPipelineFields(pipeline) {
  return Object.entries(PIPELINE_REQUIRED_FOR_APPROVAL)
    .filter(([key]) => {
      const value = pipeline[key];
      if (key === 'price') return !(Number(value) > 0);
      if (key === 'qty') return !(Number(value) >= 1);
      return !value || !String(value).trim();
    })
    .map(([, label]) => label);
}

// Central state machine for DSR -> Pipeline -> Order. The client never sets a stage directly;
// every transition goes through one of these functions so the rules are enforced in one place
// and every hop is written to history + notified.
//
// Pipeline has two independent axes, matching how the business actually tracks deals:
//  - `stage`: sales-progress percentage (10%-Prospect ... 100%-Deal Won / 0%-Lost), freely
//    edited by the agent/TL as the deal moves - see pipelineController.update.
//  - `approval`: an optional TL sign-off workflow (none -> pending_tl -> approved/rejected)
//    that an agent can invoke at any point to get their TL to review the deal.
// A Back Office order is opened the moment EITHER the TL approves OR the deal reaches 100% -
// whichever happens first - so both paths converge on the same order (ensureOrderForPipeline).

// Agent converts a "Lead Generated" DSR into a pipeline opportunity, starting at 10%-Prospect.
async function convertToPipeline(dsrId, extra, actor) {
  const dsr = await Dsr.findById(dsrId);
  if (!dsr) throw new AppError('DSR not found', 404);

  const allowed =
    actor.role === 'admin' ||
    [dsr.tlId, dsr.teamHeadId, dsr.salesHeadId, dsr.agentId].some((id) => String(id) === String(actor._id));
  if (!allowed) throw new AppError('You cannot convert this DSR', 403);

  if (dsr.status !== 'Lead Generated') throw new AppError('Only "Lead Generated" DSRs can be converted to pipeline', 400);
  if (dsr.convertedToPipeline) throw new AppError('This DSR is already in the pipeline', 400);

  // Atomically claim the DSR before creating the Pipeline: a matching filter on
  // convertedToPipeline:false means only one concurrent request can flip it, so a duplicate
  // Pipeline can never be created for the same DSR even under a race.
  const claimed = await Dsr.findOneAndUpdate(
    { _id: dsrId, status: 'Lead Generated', convertedToPipeline: { $ne: true } },
    { $set: { convertedToPipeline: true } },
    { new: true }
  );
  if (!claimed) throw new AppError('This DSR is already in the pipeline', 400);

  const mrc = (extra.qty || 1) * (extra.price || 0);
  let pipeline;
  try {
    pipeline = await Pipeline.create({
    dsrId: dsr._id,
    dsrNo: dsr.dsrNo,
    agentId: dsr.agentId,
    tlId: dsr.tlId,
    teamHeadId: dsr.teamHeadId,
    salesHeadId: dsr.salesHeadId,
    company: dsr.company,
    customer: dsr.customer,
    email: extra.email || '',
    cat: extra.cat || '',
    product: extra.product || '',
    sr: extra.sr || '',
    price: extra.price || 0,
    qty: extra.qty || 1,
    mrc,
    annual: mrc * 12,
    stage: '10%- Prospect',
    // Started Date is the date the deal entered the pipeline - set once here, never editable
    // afterward (see pipelineController.updateSchema).
    startedDate: new Date().toISOString().slice(0, 10),
    remarks: extra.remarks || '',
    history: [{ userId: actor._id, text: 'Converted from DSR to pipeline' }],
    });
  } catch (err) {
    // Pipeline creation failed after the DSR was already claimed — release the claim so the
    // DSR isn't left permanently locked with no pipeline behind it.
    await Dsr.updateOne({ _id: dsrId }, { $set: { convertedToPipeline: false } });
    throw err;
  }

  logActivity(actor, `converted DSR ${dsr.dsrNo} to pipeline deal — Company: ${pipeline.company}, Price: ${pipeline.price}, Qty: ${pipeline.qty}`);
  return pipeline;
}

function assertActorIsTlOrAbove(pipeline, actor) {
  const allowed = actor.role === 'admin' || String(pipeline.tlId) === String(actor._id);
  if (!allowed) throw new AppError('Only the assigned Team Leader can act on this deal', 403);
}

function assertActorIsOwnerOrAbove(pipeline, actor) {
  const allowed =
    actor.role === 'admin' || String(pipeline.tlId) === String(actor._id) || String(pipeline.agentId) === String(actor._id);
  if (!allowed) throw new AppError('You cannot act on this deal', 403);
}

// Opens (or, if one already exists for this deal, updates) the Back Office order - shared by
// both ways a deal can reach Back Office: TL approval, or hitting 100%-Deal Won.
async function ensureOrderForPipeline(pipeline, actor, reasonText) {
  let order = await Order.findOne({ pipelineId: pipeline._id });
  if (order) {
    order.qty = pipeline.qty;
    order.price = pipeline.price;
    order.mrc = order.price * order.qty;
    order.cat = pipeline.cat;
    order.product = pipeline.product;
    order.sr = pipeline.sr;
    order.history.push({ userId: actor._id, text: reasonText });
    await order.save();
    return order;
  }

  try {
    order = await Order.create({
      pipelineId: pipeline._id,
      dsrNo: pipeline.dsrNo,
      orderNo: await generateOrderNo(),
      agentId: pipeline.agentId,
      tlId: pipeline.tlId,
      teamHeadId: pipeline.teamHeadId,
      salesHeadId: pipeline.salesHeadId,
      // Customer is optional on the DSR/Pipeline (a deal can be logged before a contact name is
      // known) but required on Order - fall back to the company name rather than crash, since
      // Company is always present by this point.
      customer: pipeline.customer || pipeline.company,
      cat: pipeline.cat,
      product: pipeline.product,
      sr: pipeline.sr,
      qty: pipeline.qty,
      price: pipeline.price,
      mrc: pipeline.price * pipeline.qty,
      status: 'New',
      history: [{ userId: actor._id, text: reasonText }],
    });
  } catch (err) {
    // Unique index on pipelineId means a concurrent request already created the order — fetch
    // and return that one instead of erroring out or creating a duplicate.
    if (err.code === 11000) {
      order = await Order.findOne({ pipelineId: pipeline._id });
      if (order) return order;
    }
    throw err;
  }

  const backOfficeUsers = await User.find({ role: 'backoffice', active: true }).select('_id').lean();
  await notify(
    backOfficeUsers.map((u) => u._id),
    `New order ${pipeline.dsrNo} from ${pipeline.company} — ready to process`,
    { refType: 'order', refId: order._id }
  );
  return order;
}

// Agent asks their TL to review the deal. Independent of sales-progress stage.
async function escalateToTL(pipelineId, actor) {
  const pipeline = await Pipeline.findById(pipelineId);
  if (!pipeline) throw new AppError('Pipeline item not found', 404);
  if (pipeline.approval === 'pending_tl') throw new AppError('This deal is already awaiting Team Leader approval', 400);
  assertActorIsOwnerOrAbove(pipeline, actor);
  if (!pipeline.tlId) throw new AppError('This deal has no assigned Team Leader to escalate to', 400);

  const missing = missingPipelineFields(pipeline);
  if (missing.length) {
    throw new AppError(`Save these required fields before requesting approval: ${missing.join(', ')}`, 400);
  }

  pipeline.approval = 'pending_tl';
  pipeline.history.push({ userId: actor._id, text: 'Requested Team Leader approval' });
  await pipeline.save();

  await notify(pipeline.tlId, `${actor.name} needs your approval on ${pipeline.dsrNo} (${pipeline.company})`, {
    refType: 'pipeline',
    refId: pipeline._id,
  });
  logActivity(actor, `requested Team Leader approval on deal ${pipeline.dsrNo} (${pipeline.company})`);
  return pipeline;
}

async function tlApprove(pipelineId, actor) {
  const pipeline = await Pipeline.findById(pipelineId);
  if (!pipeline) throw new AppError('Pipeline item not found', 404);
  if (pipeline.approval !== 'pending_tl') throw new AppError('This deal is not awaiting approval', 400);
  assertActorIsTlOrAbove(pipeline, actor);

  // Order must exist before the pipeline is saved as approved — otherwise a failure here would
  // leave the deal permanently stuck "approved" with no order behind it.
  const order = await ensureOrderForPipeline(pipeline, actor, 'Order opened — Team Leader approved the deal');

  pipeline.approval = 'approved';
  // Sent-to-Back-Office is treated as 90% Closing on the sales-progress axis - unless the deal
  // already reached 100%-Deal Won on its own, in which case approval shouldn't regress it.
  if (pipeline.stage !== '100% - Deal Won') pipeline.stage = '90% - Closing';
  pipeline.history.push({ userId: actor._id, text: 'Approved by Team Leader — sent to Back Office' });
  await pipeline.save();

  await notify(pipeline.agentId, `Your deal ${pipeline.dsrNo} was approved and sent to Back Office`, {
    refType: 'pipeline',
    refId: pipeline._id,
  });

  logActivity(actor, `approved deal ${pipeline.dsrNo} (${pipeline.company}) — order opened for Back Office`);
  return { pipeline, order };
}

async function tlReject(pipelineId, actor, reason) {
  const pipeline = await Pipeline.findById(pipelineId);
  if (!pipeline) throw new AppError('Pipeline item not found', 404);
  if (pipeline.approval !== 'pending_tl') throw new AppError('This deal is not awaiting approval', 400);
  assertActorIsTlOrAbove(pipeline, actor);

  pipeline.approval = 'rejected';
  pipeline.history.push({ userId: actor._id, text: `Rejected by Team Leader${reason ? ': ' + reason : ''}` });
  await pipeline.save();

  await notify(pipeline.agentId, `Your deal ${pipeline.dsrNo} was rejected by your Team Leader`, {
    refType: 'pipeline',
    refId: pipeline._id,
  });
  logActivity(actor, `rejected deal ${pipeline.dsrNo} (${pipeline.company})${reason ? ' — Reason: ' + reason : ''}`);
  return pipeline;
}

// Back Office moves an order through its lifecycle. Any status transition is allowed here —
// UAE order processing doesn't follow a strict linear path (can go On Hold and back, etc.) —
// except once an order is 'In Line' (Etisalat has paid): it's closed, and the only further
// transition is to 'Cancelled'. Admins can still override, same as the Cheques status flow, for
// correcting a mis-marked order.
async function updateOrderStatus(orderId, status, actor, extra = {}) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);

  const allowed = actor.role === 'admin' || actor.role === 'backoffice';
  if (!allowed) throw new AppError('Only Back Office can update order status', 403);

  if (order.status === 'In Line' && actor.role !== 'admin' && status !== 'Cancelled') {
    throw new AppError('This order is In Line and closed — it can only be moved to Cancelled from here', 400);
  }
  // A pending correction request means the agent/TL is about to rework this deal in Pipeline -
  // changing the order's status in the meantime would race against that. Locked for everyone,
  // including admin: sendOrderBackToPipeline is the only sanctioned way past this.
  if (order.correctionRequested) {
    throw new AppError('This order is on hold pending a correction request — send it back to Pipeline before changing its status', 400);
  }

  const oldStatus = order.status;
  order.status = status;
  if (extra.eOrderNo !== undefined) order.eOrderNo = extra.eOrderNo;
  if (extra.actDate !== undefined) order.actDate = extra.actDate;
  if (extra.remarks !== undefined) order.remarks = extra.remarks;
  order.history.push({ userId: actor._id, text: `Status updated to ${status}` });
  await order.save();

  await notify([order.agentId, order.tlId].filter(Boolean), `Order ${order.dsrNo} is now "${status}"`, {
    refType: 'order',
    refId: order._id,
  });
  logActivity(actor, `changed order ${order.dsrNo} status: ${oldStatus} -> ${status}`);
  return order;
}

// An agent (or their TL) who spots a mistake after the deal has already locked in Back Office has
// no other way to get it fixed — this is that escape hatch. Flags the order red for Back Office
// rather than reopening anything itself; only Back Office deciding to act on it
// (sendOrderBackToPipeline) actually unlocks the underlying deal.
async function requestOrderCorrection(orderId, actor, note) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);
  if (order.status === 'Cancelled') throw new AppError('This order is cancelled — nothing to correct', 400);
  // Activated/In Line means the order has already gone live with Etisalat - it's done, not a
  // mistake to unwind through the normal correction loop. An admin can still fix a genuine error
  // directly on the order itself; this only blocks the agent-initiated request-correction path.
  if (actor.role !== 'admin' && (order.status === 'Activated' || order.status === 'In Line')) {
    throw new AppError('This order is already Activated/In Line and cannot be sent back for correction', 400);
  }

  const allowed =
    actor.role === 'admin' || String(order.agentId) === String(actor._id) || String(order.tlId) === String(actor._id);
  if (!allowed) throw new AppError('You cannot request a correction on this order', 403);
  if (order.correctionRequested) throw new AppError('A correction has already been requested for this order', 400);

  order.correctionRequested = true;
  order.correctionRequestedBy = actor._id;
  order.correctionRequestedAt = new Date();
  order.correctionNote = note || '';
  order.history.push({ userId: actor._id, text: `Requested correction${note ? ': ' + note : ''}` });
  await order.save();

  const backOfficeUsers = await User.find({ role: 'backoffice', active: true }).select('_id').lean();
  await notify(
    backOfficeUsers.map((u) => u._id),
    `${actor.name} flagged order ${order.dsrNo} as needing correction`,
    { refType: 'order', refId: order._id }
  );
  logActivity(actor, `requested correction on order ${order.dsrNo}${note ? ' — Note: ' + note : ''}`);
  return order;
}

// Back Office acting on a flagged correction request - unlocks the underlying Pipeline deal
// (resets approval so the agent/TL can edit it again through the normal flow) without touching
// the order's own status or deleting anything. The order stays exactly where it is, just marked -
// correctionCount is the durable "how many times has this happened" counter the client dims/badges
// the row with, and it survives being handled (unlike correctionRequested, which clears).
async function sendOrderBackToPipeline(orderId, actor) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);

  const allowed = actor.role === 'admin' || actor.role === 'backoffice';
  if (!allowed) throw new AppError('Only Back Office can send an order back to Pipeline', 403);
  if (!order.correctionRequested) throw new AppError('No correction has been requested for this order', 400);
  if (!order.pipelineId) throw new AppError('This order has no backing Pipeline deal to send back to (it was added directly)', 400);

  const pipeline = await Pipeline.findById(order.pipelineId);
  if (!pipeline) throw new AppError('The backing Pipeline deal no longer exists', 404);

  pipeline.approval = 'none';
  pipeline.history.push({ userId: actor._id, text: `Sent back for correction by ${actor.name} — deal is editable again` });
  await pipeline.save();

  order.correctionCount += 1;
  order.correctionRequested = false;
  order.correctionRequestedBy = null;
  order.correctionRequestedAt = null;
  order.history.push({ userId: actor._id, text: `Sent back to Pipeline stage for correction (#${order.correctionCount})` });
  await order.save();

  await notify(pipeline.agentId, `Your deal ${pipeline.dsrNo} was sent back for correction — you can edit it again`, {
    refType: 'pipeline',
    refId: pipeline._id,
  });
  logActivity(actor, `sent order ${order.dsrNo} back to Pipeline for correction (occurrence #${order.correctionCount})`);
  return order;
}

module.exports = {
  convertToPipeline,
  escalateToTL,
  tlApprove,
  tlReject,
  ensureOrderForPipeline,
  updateOrderStatus,
  requestOrderCorrection,
  sendOrderBackToPipeline,
};
