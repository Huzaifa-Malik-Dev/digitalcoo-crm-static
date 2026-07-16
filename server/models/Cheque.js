const mongoose = require('mongoose');

const chequeSchema = new mongoose.Schema(
  {
    no: { type: String, required: true, trim: true },
    date: { type: String, required: true },
    dueDate: { type: String, required: true },
    direction: { type: String, enum: ['Received', 'Issued'], required: true },
    party: { type: String, required: true, trim: true },
    amount: { type: Number, required: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    // The other side of the entry once this cheque clears — defaults client-side to Accounts
    // Receivable (Received) / Accounts Payable (Issued) but is always overridable, since a
    // cheque's party is free text with no structured link to what it's actually settling.
    contraAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    status: { type: String, enum: ['Pending', 'Deposited', 'Cleared', 'Bounced'], default: 'Pending' },
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

chequeSchema.index({ account: 1, dueDate: -1 });
chequeSchema.index({ status: 1 });

module.exports = mongoose.model('Cheque', chequeSchema);
