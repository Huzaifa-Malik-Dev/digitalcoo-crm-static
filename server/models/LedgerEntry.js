const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    // Advance/Loan/Deduction = money the employee owes back (deducted from a future payroll
    // run). Salary/Bonus/Reimbursement = money paid to the employee (informational, always
    // created already-Settled - there's nothing left to deduct against).
    type: { type: String, enum: ['Advance', 'Loan', 'Deduction', 'Salary', 'Bonus', 'Reimbursement'], required: true },
    amount: { type: Number, required: true },
    // No installment concept - an Open entry's full remaining balance is auto-deducted on
    // the employee's next payroll run, then the entry is settled.
    remaining: { type: Number, default: 0 },
    status: { type: String, enum: ['Open', 'Settled'], default: 'Open' },
    note: { type: String, default: '' },
    // Off-cycle entries (outside a payroll run) have no cash movement by default — they're just a
    // record of what's owed. Checking "Adjust in Accounts" and picking a funding account posts a
    // real journal entry instead; left unchecked, this stays a paperwork-only note (surfaced to
    // the user as an explicit warning on the form, since it means the number won't show up
    // anywhere in Accounting).
    postToAccounts: { type: Boolean, default: false },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    // Set when postToAccounts posted a journal entry for this row — lets edit/delete find and
    // reverse/remove exactly that entry.
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // set on auto-generated Deduction rows, pointing back at the Advance/Loan they paid down
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'LedgerEntry', default: null },
    // set on any entry a payroll run auto-created (settlement Deductions and the Salary payout
    // row) - lets deletePayrollRun find and cleanly reverse/remove exactly those rows.
    payrollRun: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', default: null },
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ employee: 1, date: -1 });
ledgerEntrySchema.index({ status: 1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
