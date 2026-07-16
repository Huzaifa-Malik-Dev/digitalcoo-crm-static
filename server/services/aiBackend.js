const { aiBackendUrl, aiBackendSecret } = require('../config/env');
const AppError = require('../utils/AppError');

// Generation itself can take up to ~15 minutes on the AI-Backend's CPU-only box, but this app
// never waits on that directly - createJob/getJobStatus are both fast (the AI-Backend responds
// immediately, the actual work happens in its own background worker). A short timeout here is
// correct and intentional: if the AI-Backend droplet is unreachable, fail fast instead of hanging
// the request.
const REQUEST_TIMEOUT_MS = 15_000;

function assertConfigured() {
  if (!aiBackendUrl || !aiBackendSecret) {
    throw new AppError('AI report generation is not configured on this server (AI_BACKEND_URL / AI_BACKEND_SECRET missing)', 503);
  }
}

async function request(path, options = {}) {
  assertConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${aiBackendUrl}${path}`, {
      ...options,
      headers: { 'x-ai-secret': aiBackendSecret, ...(options.headers || {}) },
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new AppError('AI-Backend did not respond in time', 504);
    throw new AppError('Could not reach the AI-Backend service', 502);
  } finally {
    clearTimeout(timer);
  }
}

async function createJob({ prompt, format, title, requestedBy, tables }) {
  const res = await request('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, format, title, requestedBy, tables }),
  });
  const body = await res.json();
  if (!res.ok) throw new AppError(body.error || 'Could not start report generation', res.status);
  return body.data;
}

async function getJobStatus(jobId) {
  const res = await request(`/jobs/${jobId}`);
  const body = await res.json();
  if (!res.ok) throw new AppError(body.error || 'Could not fetch job status', res.status);
  return body.data;
}

// Best-effort: the caller (deleteAiJob) removes its own pointer record regardless of whether this
// succeeds, so a user can always clear an entry from their history even if the AI-Backend is
// temporarily unreachable - it just leaves an orphaned job/file there to expire on its own via
// the retention sweep instead of being removed immediately.
async function deleteJob(jobId) {
  const res = await request(`/jobs/${jobId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new AppError(body.error || 'Could not delete report', res.status);
  }
}

// Streams the AI-Backend's file response straight through to our own client rather than
// buffering the whole file in memory - reports are small (KB scale) so it barely matters here,
// but it's the same shape as every other file-serving path in this app.
async function streamDownload(jobId, res) {
  const upstream = await request(`/jobs/${jobId}/download`);
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => ({}));
    throw new AppError(body.error || 'File is not available', upstream.status);
  }
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.send(buffer);
}

module.exports = { createJob, getJobStatus, deleteJob, streamDownload };
