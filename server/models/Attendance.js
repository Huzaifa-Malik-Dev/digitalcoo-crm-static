const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Same hierarchy-stamping reasoning as LeaveRequest.js.
    tlId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    teamHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    salesHeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    date: { type: String, required: true }, // 'YYYY-MM-DD'
    status: { type: String, enum: ['Present', 'Absent', 'Half Day', 'On Leave', 'Holiday', 'Weekend'], required: true },
    // Set only when this row was auto-created by an approved LeaveRequest - lets revocation find
    // and remove exactly these rows (see services/leave.js revokeLeaveRequest) rather than
    // guessing which cells to touch.
    linkedLeaveRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest', default: null },
    notes: { type: String, default: '' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });
attendanceSchema.index({ tlId: 1, date: 1 });
attendanceSchema.index({ teamHeadId: 1, date: 1 });
attendanceSchema.index({ salesHeadId: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
