const mongoose = require('mongoose');

// One record per report generation this user has kicked off - the app's own history list (see
// aiReportController.listAiJobs, which only shows the last 3 days). The job's actual
// status/result/content lives on the AI-Backend itself (Job model there); this is just the
// "which jobId belongs to which user, and when" pointer, not a full mirror.
const aiReportJobSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    jobId: { type: String, required: true },
    period: { type: String, required: true },
    date: { type: String, default: '' },
    format: { type: String, required: true },
    reportType: { type: String, required: true },
  },
  { timestamps: true }
);

aiReportJobSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AiReportJob', aiReportJobSchema);
