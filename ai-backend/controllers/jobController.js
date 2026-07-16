const fs = require('fs');
const path = require('path');
const Job = require('../models/Job');
const AppError = require('../utils/AppError');
const { notify } = require('../services/worker');
const { filesRoot } = require('../services/fileCompiler');
const { JOB_FORMAT } = require('../models/Job');

async function createJob(req, res, next) {
  try {
    const { prompt, format, title, requestedBy, tables } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('prompt is required', 400);
    }
    if (!JOB_FORMAT.includes(format)) {
      throw new AppError(`format must be one of: ${JOB_FORMAT.join(', ')}`, 400);
    }

    const job = await Job.create({
      prompt,
      format,
      tables: tables && typeof tables === 'object' ? tables : null,
      title: title || 'AI Report',
      requestedBy: requestedBy || '',
    });

    notify(); // wake the worker immediately rather than waiting for the next poll tick
    res.status(201).json({ data: { jobId: job._id, status: job.status } });
  } catch (err) {
    next(err);
  }
}

async function getJob(req, res, next) {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw new AppError('Job not found', 404);
    res.json({
      data: {
        jobId: job._id,
        status: job.status,
        format: job.format,
        title: job.title,
        error: job.error || null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        downloadReady: job.status === 'completed' && !!job.resultPath,
        content: job.status === 'completed' ? job.resultText : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function deleteJob(req, res, next) {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(204).end(); // already gone - deleting a missing job is a no-op success, not an error
    if (job.resultPath) {
      fs.unlink(path.join(filesRoot, job.resultPath), () => {}); // best-effort - file may already be swept by the retention job
    }
    await job.deleteOne();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

async function downloadJob(req, res, next) {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw new AppError('Job not found', 404);
    if (job.status !== 'completed' || !job.resultPath) {
      throw new AppError('This job has no file ready yet', 400);
    }
    const filePath = path.join(filesRoot, job.resultPath);
    res.download(filePath, job.resultPath, (err) => {
      if (err) next(new AppError('File is no longer available — it may have expired', 404));
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { createJob, getJob, deleteJob, downloadJob };
