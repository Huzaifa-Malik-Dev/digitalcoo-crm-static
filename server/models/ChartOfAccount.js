const mongoose = require('mongoose');

// Asset/Expense accounts increase with a debit; Liability/Equity/Revenue accounts increase with
// a credit — this is fixed by `type`, never chosen independently, so it can't drift out of sync.
const TYPE_NORMAL_BALANCE = {
  Asset: 'debit',
  Expense: 'debit',
  Liability: 'credit',
  Equity: 'credit',
  Revenue: 'credit',
};

const chartOfAccountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: Object.keys(TYPE_NORMAL_BALANCE), required: true },
    normalBalance: { type: String, enum: ['debit', 'credit'] },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Set only on Cash & Bank leaves — ties this ledger account 1:1 to an operational Account
    // (server/models/Account.js) so the existing bank/cash picker UI keeps working unchanged.
    // Deliberately no `default: null` — the unique+sparse index below only excludes documents
    // where this field is truly absent, and an explicit null on every other row would still
    // collide with each other as duplicate index entries.
    linkedAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
    // Seeded rows (the standard Chart of Accounts tree) can't be deleted from the UI — deleting a
    // category account that journal entries already point at would orphan those postings.
    isSystem: { type: Boolean, default: false },
    // false only on the 5 top-level type headers (1000/2000/3000/4000/5000) and the 1010 Cash &
    // Bank group header — pure groupings for the COA tree display, never a journal line target.
    // Every leaf (including per-Account Cash & Bank rows created under 1010) stays postable.
    postable: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

chartOfAccountSchema.index({ linkedAccount: 1 }, { unique: true, sparse: true });
chartOfAccountSchema.index({ type: 1, active: 1 });

chartOfAccountSchema.pre('validate', function setNormalBalance(next) {
  this.normalBalance = TYPE_NORMAL_BALANCE[this.type];
  next();
});

module.exports = mongoose.model('ChartOfAccount', chartOfAccountSchema);
module.exports.TYPE_NORMAL_BALANCE = TYPE_NORMAL_BALANCE;
