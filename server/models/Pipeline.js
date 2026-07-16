const mongoose = require('mongoose');
const { PIPE_STAGES, APPROVAL_STATUS } = require('../utils/constants');

const historyEntrySchema = new mongoose.Schema(
  { ts: { type: Date, default: Date.now }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, text: String },
  { _id: false }
);

const pipelineSchema = new mongoose.Schema(
  {
    dsrId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dsr', required: true },
    dsrNo: { type: String, required: true },

    // Hierarchy stamped at creation time — same pattern as Dsr, keeps every rollup a single indexed match.
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tlId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    teamHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    salesHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    company: { type: String, required: true },
    customer: { type: String, default: '' },
    email: { type: String, default: '' },
    cat: { type: String, default: '' },
    product: { type: String, default: '' },
    // Subscription type - closed set (MNP / FNP / NEW), enforced by pipelineController's zod
    // schemas rather than a Mongoose-level enum here, so a pre-existing deal saved under the old
    // free-text scheme doesn't fail whole-document validation on an unrelated save (e.g. a TL
    // approval) before it's next edited through the (now-enum-gated) update endpoint.
    sr: { type: String, default: '' },
    price: { type: Number, default: 0 },
    qty: { type: Number, default: 1 },
    mrc: { type: Number, default: 0 },
    annual: { type: Number, default: 0 },

    // Sales-progress stage - the primary lifecycle field, freely editable by the agent/TL.
    stage: { type: String, enum: PIPE_STAGES, default: '10%- Prospect' },
    // The optional TL sign-off workflow - independent of stage. See services/workflow.js.
    approval: { type: String, enum: APPROVAL_STATUS, default: 'none' },

    // Set once, at conversion/import time, to the date the deal entered the pipeline - never
    // client-editable afterward (see pipelineController.updateSchema, which omits this field).
    startedDate: { type: String, default: '' },
    expectedCloseDate: { type: String, default: '' },
    director: { type: String, default: '' },

    remarks: { type: String, default: '' },
    history: [historyEntrySchema],
  },
  { timestamps: true }
);

pipelineSchema.index({ agentId: 1, createdAt: -1 });
pipelineSchema.index({ tlId: 1, approval: 1, createdAt: -1 });
pipelineSchema.index({ stage: 1 });
pipelineSchema.index({ teamHeadId: 1, createdAt: -1 });
pipelineSchema.index({ salesHeadId: 1, createdAt: -1 });
pipelineSchema.index({ dsrId: 1 }, { unique: true });

module.exports = mongoose.model('Pipeline', pipelineSchema);
