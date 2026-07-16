const mongoose = require('mongoose');

const historyEntrySchema = new mongoose.Schema(
  { ts: { type: Date, default: Date.now }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, text: String },
  { _id: false }
);

const leaveRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Hierarchy stamped at creation from employee.managerChain — same shape as Dsr/Pipeline/Order
    // so manager-scoped list queries are a single indexed match, and so hierarchy.js's
    // reassignment re-stamping (moveHistoricalRecords) can extend to this model unchanged.
    tlId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    teamHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    salesHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    // Recomputed on create and on any edit while status is 'pending'; frozen permanently the
    // moment it's approved (see services/leave.js) - never recomputed live after that, so a
    // later Holiday edit can't silently rewrite a historical, already-approved balance.
    days: { type: Number, required: true },
    reason: { type: String, default: '' },
    document: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled', 'revoked'], default: 'pending' },
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    revokeReason: { type: String, default: '' },
    history: [historyEntrySchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ employee: 1, status: 1, startDate: -1 });
leaveRequestSchema.index({ tlId: 1, status: 1 });
leaveRequestSchema.index({ teamHeadId: 1, status: 1 });
leaveRequestSchema.index({ salesHeadId: 1, status: 1 });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
