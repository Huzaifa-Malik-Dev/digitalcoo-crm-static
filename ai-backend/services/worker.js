const { EventEmitter } = require('events');
const Job = require('../models/Job');
const { generate } = require('./ollama');
const { compile } = require('./fileCompiler');

// Enforces the hard "1 job at a time" constraint the droplet's 4 vCPUs / 8GB RAM require - not a
// queue library's job, just a module-scoped flag, since there's never more than one worker
// process in this service (single PM2 instance, no horizontal scaling planned).
let isProcessing = false;
const bus = new EventEmitter();

// Woken on every POST /jobs, plus a periodic safety-net poll below in case an event was ever
// missed (e.g. this process restarted with jobs already queued from before).
function notify() {
  bus.emit('check');
}

async function runNext() {
  if (isProcessing) return;
  const job = await Job.findOneAndUpdate(
    { status: 'pending' },
    { status: 'processing', startedAt: new Date() },
    { sort: { createdAt: 1 }, new: true }
  );
  if (!job) return;

  isProcessing = true;
  const startedAt = Date.now();
  const skipLlm = job.format === 'xlsx' && job.tables;
  console.log(`[worker] job ${job._id} started (format=${job.format}, ${skipLlm ? 'structured tables, no LLM call' : `prompt=${job.prompt.length} chars`}, requestedBy=${job.requestedBy || 'unknown'})`);
  try {
    // xlsx renders straight from structured `tables` data, never the LLM narrative (a spreadsheet
    // of prose defeats the point) - skip the slow LLM call entirely for these, not just the text.
    const text = job.format === 'xlsx' && job.tables ? '' : await generate(job.prompt);
    const fileName = await compile(job._id.toString(), job.format, text, job.title, job.tables);
    job.status = 'completed';
    job.resultPath = fileName;
    job.resultText = text;
    job.completedAt = new Date();
    await job.save();
    console.log(`[worker] job ${job._id} completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${fileName}`);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message || 'Generation failed';
    job.completedAt = new Date();
    await job.save();
    console.error(`[worker] job ${job._id} failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${err.message}`);
  } finally {
    isProcessing = false;
    // A later job may already be queued - keep draining instead of waiting for the next event/poll.
    setImmediate(runNext);
  }
}

// Crash recovery: a job stuck 'processing' with nobody actually processing it (this process just
// restarted) can't be resumed mid-generation - fail it cleanly so it doesn't sit stuck forever,
// and let whoever asked for it see a real error instead of a silent hang.
async function recoverStuckJobs() {
  const { modifiedCount } = await Job.updateMany(
    { status: 'processing' },
    { status: 'failed', error: 'Interrupted by a service restart — please try again.', completedAt: new Date() }
  );
  if (modifiedCount > 0) console.log(`[worker] recovered ${modifiedCount} job(s) stuck 'processing' from before this restart`);
}

function startWorker() {
  bus.on('check', runNext);
  // Safety-net poll - covers the case where a job was inserted before this process was up to
  // receive the event (e.g. right after a restart, jobs recovered as failed above but a fresh
  // one lands before the first `notify()` call would naturally fire).
  setInterval(runNext, 10_000);
  runNext();
  console.log('[worker] armed — polling for pending jobs every 10s plus on-demand notify()');
}

module.exports = { startWorker, notify, recoverStuckJobs };
