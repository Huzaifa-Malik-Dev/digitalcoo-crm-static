const { z } = require('zod');
const User = require('../models/User');
const { comparePassword, hashPassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const { nodeEnv } = require('../config/env');
const AppError = require('../utils/AppError');
const { ALL_PERMISSION_KEYS, IMPORT_EXPORT_MODULES } = require('../utils/constants');
const { canView, canEdit, canImportExport } = require('../services/permissions');
const { logActivity } = require('../utils/activityLog');

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

const COOKIE_OPTS = {
  httpOnly: true,
  secure: nodeEnv === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    username: user.username,
    role: user.role,
    desig: user.desig,
    dept: user.dept,
    reportsTo: user.reportsTo,
    // Flat list of every granted key - top-level modules AND nested tab/action keys (e.g.
    // 'hr.addEmployee') all live in the same view/edit key space, so the client checks both the
    // same way: user.modules.includes('hr') for the module, user.editModules.includes('hr.addEmployee')
    // for a specific nested capability.
    modules: ALL_PERMISSION_KEYS.filter((m) => canView(user, m)),
    editModules: ALL_PERMISSION_KEYS.filter((m) => canEdit(user, m)),
    importExportModules: IMPORT_EXPORT_MODULES.filter((m) => canImportExport(user, m)),
  };
}

async function login(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Username and password are required', 400);
    const { username, password } = parsed.data;

    const user = await User.findOne({ username: username.toLowerCase() });
    // Same error for missing user vs wrong password — do not leak which one was wrong.
    if (!user || !user.active) throw new AppError('Invalid username or password', 401);

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) throw new AppError('Invalid username or password', 401);

    const token = signToken(user._id, user.tokenVersion || 0);
    res.cookie('token', token, COOKIE_OPTS);
    logActivity(user, 'logged in');
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    // Bumping tokenVersion invalidates this token server-side, not just the client-side cookie —
    // a copy captured before logout can no longer be replayed.
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    res.clearCookie('token', { ...COOKIE_OPTS, maxAge: undefined });
    logActivity(req.user, 'logged out');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(6).optional(),
  })
  .refine((v) => !v.newPassword || !!v.currentPassword, {
    message: 'Current password is required to set a new password',
    path: ['currentPassword'],
  });

// Self-service profile update — every logged-in user can change their own display name and/or
// password here, regardless of role. Deliberately narrow: only name/password, never
// role/reportsTo/status/etc — those stay admin/HR-only via userController.update.
async function updateProfile(req, res, next) {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { name, currentPassword, newPassword } = parsed.data;

    const user = await User.findById(req.user._id);
    if (!user) throw new AppError('User not found', 404);

    if (newPassword) {
      const ok = await comparePassword(currentPassword, user.passwordHash);
      if (!ok) throw new AppError('Current password is incorrect', 400);
      user.passwordHash = await hashPassword(newPassword);
      // Changing the password invalidates every other session (including this one's old
      // token) — same server-side revocation mechanism as logout, then we issue a fresh token
      // below so the user making the change isn't logged out by their own action.
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    if (name !== undefined) user.name = name;

    await user.save();

    if (newPassword) {
      const token = signToken(user._id, user.tokenVersion);
      res.cookie('token', token, COOKIE_OPTS);
      logActivity(user, 'changed their own password');
    }
    if (name !== undefined) logActivity(user, `updated their own display name to "${name}"`);

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    res.json({ user: publicUser(req.user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, logout, me, updateProfile };
