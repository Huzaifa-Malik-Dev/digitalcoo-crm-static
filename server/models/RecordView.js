const mongoose = require('mongoose');

// Generic "has this user seen this record" tracker, shared across every module rather than a
// per-model viewedBy array - one collection, keyed by (userId, module, recordId), works for any
// new table without a schema change. Drives the "new/unread" row highlight on list pages; a
// missing row here just means "never viewed by this user", nothing more.
const recordViewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    module: { type: String, required: true }, // 'dsr' | 'pipeline' | 'orders' | ...
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

recordViewSchema.index({ userId: 1, module: 1, recordId: 1 }, { unique: true });

module.exports = mongoose.model('RecordView', recordViewSchema);
