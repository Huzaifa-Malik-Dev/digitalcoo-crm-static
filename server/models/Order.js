const mongoose = require('mongoose');
const { ORDER_STATUS, ETISALAT_STATUS, SR_TYPES } = require('../utils/constants');

const historyEntrySchema = new mongoose.Schema(
  { ts: { type: Date, default: Date.now }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, text: String },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // null for a directly-created order (see `direct` below) - there's no backing Pipeline deal.
    pipelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline', default: null },
    dsrNo: { type: String, required: true },
    // System-assigned, never user-editable - ORD-YYYYMMDD-001, see utils/orderNo.js. Blank on
    // orders that predate this field (no retroactive backfill).
    orderNo: { type: String, default: '' },
    // True when this order was added directly by Back Office/Admin, bypassing DSR -> Pipeline
    // -> Approval entirely - surfaced in the UI as a "Direct" marker so it's clear at a glance
    // this didn't come through the normal sales funnel.
    direct: { type: Boolean, default: false },
    // e&'s own processing status for this order, independent of `status` (this app's internal
    // fulfillment workflow) - assigned by Back Office once they have visibility into e&'s side.
    etisalatStatus: { type: String, enum: [...ETISALAT_STATUS, ''], default: '' },

    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tlId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    teamHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    salesHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    subDate: { type: String, default: '' },
    contact: { type: String, default: '' },
    contactNo: { type: String, default: '' },
    email: { type: String, default: '' },
    customer: { type: String, required: true },
    pid: { type: String, default: '' },
    eOrderNo: { type: String, default: '' },
    // Subscription type - closed set (see SR_TYPES), same as Pipeline.sr, which this is normally
    // copied from when the order opens (see workflow.ensureOrderForPipeline).
    sr: { type: String, enum: SR_TYPES, default: 'NEW' },
    cat: { type: String, default: '' },
    product: { type: String, default: '' },
    contract: { type: String, default: '12 Months' },
    qty: { type: Number, default: 1 },
    price: { type: Number, default: 0 },
    // Always derived as price * qty, recomputed server-side whenever either changes - never
    // accepted directly from client input (see orderController.js).
    mrc: { type: Number, default: 0 },
    eAcctMgr: { type: String, default: '' },
    status: { type: String, enum: ORDER_STATUS, default: 'New' },
    actDate: { type: String, default: '' },
    commission: { type: Number, default: 0 },
    remarks: { type: String, default: '' },
    // Escape hatch for an agent/TL who spots a mistake after the deal is already locked in Back
    // Office (see workflow.requestOrderCorrection/sendOrderBackToPipeline) - correctionRequested
    // is the current pending flag (cleared once Back Office actions it), correctionCount is the
    // running total across the order's whole life, kept even after the flag clears so "how many
    // times has this been sent back" survives being handled.
    correctionRequested: { type: Boolean, default: false },
    correctionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    correctionRequestedAt: { type: Date, default: null },
    correctionNote: { type: String, default: '' },
    correctionCount: { type: Number, default: 0 },
    history: [historyEntrySchema],
  },
  { timestamps: true }
);

orderSchema.index({ agentId: 1, createdAt: -1 });
orderSchema.index({ tlId: 1, status: 1, createdAt: -1 });
orderSchema.index({ teamHeadId: 1, createdAt: -1 });
orderSchema.index({ salesHeadId: 1, createdAt: -1 });
orderSchema.index({ pipelineId: 1 }, { unique: true, sparse: true });
orderSchema.index({ orderNo: 1 }, { unique: true, sparse: true });
orderSchema.index({ status: 1 });

module.exports = mongoose.model('Order', orderSchema);
