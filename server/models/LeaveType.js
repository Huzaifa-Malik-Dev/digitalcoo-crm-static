const mongoose = require('mongoose');

const leaveTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    annualDays: { type: Number, required: true },
    accrualMethod: { type: String, enum: ['monthly', 'lump-sum'], required: true },
    // Employee must have this many months of service (vs User.join) before any balance accrues.
    minServiceMonths: { type: Number, default: 0 },
    // Reserved for a future phase — capped carry-forward of unused days into the next policy
    // year needs a materialized per-year checkpoint, not a running balance; not implemented yet.
    carryForwardCap: { type: Number, default: 0 },
    paid: { type: Boolean, default: true },
    requiresDocument: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    // Seeded defaults (Annual/Sick/Emergency/Unpaid) — protected from deletion, same convention
    // as ChartOfAccount.isSystem.
    isSystem: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveType', leaveTypeSchema);
