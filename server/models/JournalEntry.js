const mongoose = require('mongoose');

const journalLineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const journalEntrySchema = new mongoose.Schema(
  {
    // System-assigned, sequential per calendar month — JE-YYYYMM-001 (see utils/journalNo.js),
    // same monthly-reset counter pattern as Order's orderNo.
    entryNo: { type: String, required: true, unique: true },
    date: { type: String, required: true },
    memo: { type: String, default: '' },
    // What business event produced this entry, if any — 'Manual' for freeform entries posted
    // directly from the Journal screen (e.g. recording Etisalat commission revenue by hand).
    refType: { type: String, enum: ['Order', 'Expense', 'Cheque', 'Payroll', 'LedgerEntry', 'Account', 'Manual'], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lines: { type: [journalLineSchema], validate: (v) => v.length >= 2 },
    totalDebit: { type: Number, required: true },
    totalCredit: { type: Number, required: true },
    // A posted entry is never edited or hard-deleted (except by the same request that just
    // created it, on a downstream failure) — corrections go through a reversing entry instead,
    // preserving full history. reversalOf points a reversal at what it undoes; reversedBy is set
    // on the original once something has reversed it.
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

journalEntrySchema.index({ date: -1, createdAt: -1 });
journalEntrySchema.index({ refType: 1, refId: 1 });
journalEntrySchema.index({ 'lines.account': 1, date: 1 });

// Every line must be one-sided (debit XOR credit, never both, never neither) and the entry as a
// whole must balance — this is what makes double-entry self-checking. Enforced here (not just in
// the service layer) so no code path — including a future one nobody thought to gate — can ever
// persist an unbalanced entry.
journalEntrySchema.pre('validate', function enforceBalance(next) {
  for (const line of this.lines) {
    const hasDebit = line.debit > 0;
    const hasCredit = line.credit > 0;
    if (hasDebit === hasCredit) {
      return next(new Error('Each journal line must have exactly one of debit or credit greater than zero'));
    }
  }
  const totalDebit = this.lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = this.lines.reduce((sum, l) => sum + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return next(new Error(`Journal entry does not balance: debit ${totalDebit} vs credit ${totalCredit}`));
  }
  this.totalDebit = totalDebit;
  this.totalCredit = totalCredit;
  next();
});

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
