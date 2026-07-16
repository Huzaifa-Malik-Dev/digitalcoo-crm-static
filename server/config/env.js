require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || '5600', 10),
  mongoUri: required('MONGO_URI'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  pageSizeDefault: parseInt(process.env.PAGE_SIZE_DEFAULT || '50', 10),
  pageSizeMax: parseInt(process.env.PAGE_SIZE_MAX || '200', 10),
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  uploadMaxKb: parseInt(process.env.UPLOAD_MAX_KB || '5120', 10),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  loginRateLimitWindowMin: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MIN || '15', 10),
  loginRateLimitMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '20', 10),
  // Optional, not required() - the AI Reports "quick summary" (aiReportController.getReport)
  // works without these; only the async full-report job endpoints need them, and fail with a
  // clear error (not a boot crash) if they're unset. Keeps local dev working with no AI-Backend
  // droplet at all.
  aiBackendUrl: process.env.AI_BACKEND_URL || '',
  aiBackendSecret: process.env.AI_BACKEND_SECRET || '',
};
