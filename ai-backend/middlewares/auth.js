const { sharedSecret } = require('../config/env');
const AppError = require('../utils/AppError');

// No end users ever call this service directly - only the main CRM's Node backend, over the
// DigitalOcean private network. A shared secret is enough; there's no session/user concept here
// at all, matching the client-server split decided for this service (CRM app owns auth/data,
// this service only ever sees a prompt + format).
function requireSharedSecret(req, res, next) {
  const provided = req.headers['x-ai-secret'];
  if (!provided || provided !== sharedSecret) {
    return next(new AppError('Not authorized', 401));
  }
  next();
}

module.exports = requireSharedSecret;
