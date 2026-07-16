const { nodeEnv } = require('../config/env');

// Centralized fallback — routes still try/catch and call next(err); this formats the response.
function errorHandler(err, req, res, next) {
  console.error(err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message || 'Internal server error',
    ...(nodeEnv === 'development' ? { stack: err.stack } : {}),
  });
}

module.exports = errorHandler;
