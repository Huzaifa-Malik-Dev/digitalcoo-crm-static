const mongoose = require('mongoose');

const JOB_STATUS = ['pending', 'processing', 'completed', 'failed'];
const JOB_FORMAT = ['md', 'pdf', 'xlsx'];

const jobSchema = new mongoose.Schema(
  {
    status: { type: String, enum: JOB_STATUS, default: 'pending' },
    format: { type: String, enum: JOB_FORMAT, required: true },
    // The CRM app builds the actual prompt from its own data (DSR/Pipeline/Order aggregates) -
    // this service stays fully generic and never sees that schema, just text in, file out.
    prompt: { type: String, required: true },
    // Optional structured data for the xlsx format - { tables: [{ title, columns, rows }] }.
    // xlsx never uses the LLM narrative (a spreadsheet of prose defeats the point of it being a
    // spreadsheet) - when present, the worker renders this directly and skips the LLM call
    // entirely for that job, regardless of what `prompt` says.
    tables: { type: mongoose.Schema.Types.Mixed, default: null },
    title: { type: String, default: 'AI Report' },
    // Who/what requested this, purely for this service's own logs/debugging - never enforced,
    // the CRM app is the one actually authorizing its own users against this job.
    requestedBy: { type: String, default: '' },
    resultPath: { type: String, default: '' },
    // The raw LLM output, kept separately from resultPath (the compiled md/pdf/xlsx file) so the
    // requesting app can render the report inline regardless of which file format was chosen for
    // download - the compiled file is a presentation of this text, not the source of it.
    resultText: { type: String, default: '' },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Job', jobSchema);
module.exports.JOB_STATUS = JOB_STATUS;
module.exports.JOB_FORMAT = JOB_FORMAT;
