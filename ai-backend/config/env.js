require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || '4100', 10),
  mongoUri: required('MONGO_URI'),
  sharedSecret: required('AI_SHARED_SECRET'),
  nodeEnv: process.env.NODE_ENV || 'development',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  // Ollama's own default context window - raise via OLLAMA_NUM_CTX if prompts start truncating,
  // but every step up costs more RAM (KV cache scales with context size), so don't raise this
  // without re-checking `ollama ps` / `free -h` against the droplet's actual headroom.
  ollamaNumCtx: parseInt(process.env.OLLAMA_NUM_CTX || '4096', 10),
  // Matches the single-vCPU-friendly design - one job in flight at a time, enforced in
  // services/worker.js regardless of how many requests hit POST /jobs concurrently.
  filesDir: process.env.FILES_DIR || 'files',
  fileRetentionHours: parseInt(process.env.FILE_RETENTION_HOURS || '48', 10),
};
