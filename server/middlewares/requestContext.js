const { AsyncLocalStorage } = require('async_hooks');

// Makes the current request's IP/User-Agent/module available to anything running inside this
// request's call stack - specifically utils/activityLog.js - without threading `req` through
// every controller function and the dozens of existing logActivity(user, message) call sites.
// One middleware here instead of a signature change everywhere those are called.
const storage = new AsyncLocalStorage();

// Route mount points (server/app.js) double as the "module" a logged action belongs to, mapped
// to the same module keys the rest of the app already uses (Admin > Permissions, nav, etc.) so
// the Activity Timeline's module filter lines up with names admins already recognize.
const MODULE_BY_MOUNT = {
  dsr: 'dsr', pipeline: 'pipeline', orders: 'backoffice', users: 'hr', payroll: 'payroll',
  accounting: 'accounting', admin: 'admin', products: 'products', leave: 'leave',
  attendance: 'attendance', threads: 'dsr', auth: 'auth',
};

function requestContext(req, res, next) {
  const mount = req.path.split('/')[1] || req.baseUrl.split('/')[1] || '';
  const module = MODULE_BY_MOUNT[mount] || mount || 'other';
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  const userAgent = req.get('user-agent') || '';
  storage.run({ ip, userAgent, module }, () => next());
}

function getRequestContext() {
  return storage.getStore() || {};
}

module.exports = { requestContext, getRequestContext };
