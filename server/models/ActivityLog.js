const mongoose = require('mongoose');

// Persisted counterpart to the [ACTIVITY] console log (utils/activityLog.js still writes both -
// stdout for `pm2 logs`, this collection for the Admin > Activity Timeline UI). ip/userAgent come
// from the request-scoped AsyncLocalStorage context (middlewares/requestContext.js), not from the
// caller, so every existing logActivity(user, message) call site gets them for free.
const activityLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorLabel: { type: String, required: true },
    message: { type: String, required: true },
    module: { type: String, default: 'other' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ module: 1, createdAt: -1 });
activityLogSchema.index({ actorId: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
