const mongoose = require('mongoose');

const payrollRunSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, unique: true }, // 'YYYY-MM'
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    expense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    totalBasic: { type: Number, default: 0 },
    totalAllowance: { type: Number, default: 0 },
    totalCommission: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },
    totalGratuityAccrual: { type: Number, default: 0 },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Employees deliberately excluded from this specific run (e.g. on unpaid leave) - kept for
    // audit purposes, doesn't affect any other run.
    skippedEmployees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollRun', payrollRunSchema);
