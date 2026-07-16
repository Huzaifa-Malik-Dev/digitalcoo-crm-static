const axios = require('axios');
const { ollamaUrl, ollamaModel, ollamaNumCtx } = require('../config/env');

// Generous timeout - a 7B model on 4 CPU-only vCPUs genuinely can take up to 15+ minutes for a
// long analytical report (this is the whole reason the job-queue design exists, not a bug to
// tune away). stream: false means the full response comes back in one shot rather than chunked -
// simpler to handle, at the cost of no incremental progress feedback (job status stays
// "processing" with no partial output until it's done).
const OLLAMA_TIMEOUT_MS = 20 * 60 * 1000;

async function generate(prompt) {
  const startedAt = Date.now();
  console.log(`[ollama] generating with ${ollamaModel} (num_ctx=${ollamaNumCtx}, prompt=${prompt.length} chars)`);
  try {
    const res = await axios.post(
      `${ollamaUrl}/api/generate`,
      {
        model: ollamaModel,
        prompt,
        stream: false,
        options: { num_ctx: ollamaNumCtx },
      },
      { timeout: OLLAMA_TIMEOUT_MS }
    );
    console.log(`[ollama] responded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${res.data.response.length} chars)`);
    return res.data.response;
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}` : err.message;
    console.error(`[ollama] failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${detail}`);
    throw err;
  }
}

module.exports = { generate };
