const { z } = require('zod');
const { getPermissions, setPermissions } = require('../services/permissions');
const {
  MODULES,
  ALL_PERMISSION_KEYS,
  PERMISSION_TREE,
  ROLES,
  IMPORT_EXPORT_MODULES,
  ACCESS_DEFAULT,
  EDIT_ACCESS_DEFAULT,
  IMPORT_EXPORT_DEFAULT,
} = require('../utils/constants');
const AppError = require('../utils/AppError');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { logActivity } = require('../utils/activityLog');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { regexOr } = require('../utils/search');

async function userLabel(userId) {
  const u = await User.findById(userId).select('employeeId name').lean();
  return u ? `${u.employeeId} (${u.name})` : userId;
}

async function getPermissionsDoc(req, res, next) {
  try {
    const perms = getPermissions();
    res.json({ data: { ...perms, modules: MODULES, tree: PERMISSION_TREE, roles: ROLES, importExportModules: IMPORT_EXPORT_MODULES } });
  } catch (err) {
    next(err);
  }
}

const levelSchema = z.enum(['none', 'view', 'edit']);
// Accepts top-level modules AND nested tab/action keys (e.g. 'hr.addEmployee') - both live in the
// same flat view/edit lists, so a single key space covers both.
const moduleSchema = z.enum(ALL_PERMISSION_KEYS);

// Adds/removes `key` from a view list and an edit list so the result matches `level`
// ('edit' implies 'view', same as every other view/edit gate in this app).
function applyLevel(viewList, editList, key, level) {
  const view = new Set(viewList || []);
  const edit = new Set(editList || []);
  if (level === 'none') {
    view.delete(key);
    edit.delete(key);
  } else if (level === 'view') {
    view.add(key);
    edit.delete(key);
  } else {
    view.add(key);
    edit.add(key);
  }
  return { view: [...view], edit: [...edit] };
}

// A nested key can never have MORE access than its parent module, and lowering a module must
// bring every child down with it - otherwise the stored data (and the admin UI) can show a
// child as "Edit" while its parent sits at "None", which is exactly the confusing, meaningless
// state this cascade prevents. canView/canEdit already enforce this at read time as a backstop,
// but keeping the stored data itself consistent means the UI never displays a lie.
function applyLevelWithCascade(viewList, editList, key, level) {
  const { view, edit } = applyLevel(viewList, editList, key, level);
  const viewSet = new Set(view);
  const editSet = new Set(edit);

  if (key.includes('.')) {
    const parentKey = key.split('.')[0];
    if (!viewSet.has(parentKey)) {
      viewSet.delete(key);
      editSet.delete(key);
    } else if (!editSet.has(parentKey)) {
      editSet.delete(key);
    }
  } else {
    const section = PERMISSION_TREE.find((m) => m.key === key);
    (section?.children || []).forEach((c) => {
      if (!viewSet.has(key)) {
        viewSet.delete(c.key);
        editSet.delete(c.key);
      } else if (!editSet.has(key)) {
        editSet.delete(c.key);
      }
    });
  }

  return { view: [...viewSet], edit: [...editSet] };
}

// Guards against an admin editing their own way into a state where nobody (including them)
// can manage permissions anymore - the only recovery from that is direct DB surgery.
// `resultingEdit` is the edit-list this specific change would produce for the affected
// role/override; if that change is the one the acting user actually relies on for their own
// admin-module edit access, and it would drop 'admin' from it, we block the request.
function assertNotSelfLockout(req, { affectsRole, affectsUserId, resultingEdit }) {
  const actingUserId = String(req.user._id);
  const perms = getPermissions();
  const actingHasOwnOverride = !!perms.userOverrides?.[actingUserId];

  const changeAffectsActingUser =
    (affectsUserId && affectsUserId === actingUserId) ||
    (affectsRole && affectsRole === req.user.role && !actingHasOwnOverride);

  if (changeAffectsActingUser && !resultingEdit.includes('admin')) {
    throw new AppError('You cannot remove your own admin edit access - this would lock everyone out of managing permissions', 400);
  }
}

const roleUpdateSchema = z.object({
  role: z.enum(Object.keys(ROLES)),
  module: moduleSchema,
  level: levelSchema,
});

async function updateRolePermission(req, res, next) {
  try {
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { role, module, level } = parsed.data;

    const perms = getPermissions();
    const { view, edit } = applyLevelWithCascade(perms.byRole[role], perms.editByRole[role], module, level);

    if (module === 'admin') assertNotSelfLockout(req, { affectsRole: role, resultingEdit: edit });

    // Explicit $set on the dotted path - the safe, unambiguous way to update one key of a
    // Mixed-type field without touching the rest of the document.
    const updated = await setPermissions({
      $set: { [`byRole.${role}`]: view, [`editByRole.${role}`]: edit },
    });
    logActivity(req.user, `set role "${role}" permission for "${module}" to: ${level}`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

const roleResetSchema = z.object({ role: z.enum(Object.keys(ROLES)) });

// Resets one role's view/edit/import-export grants back to the shipped system defaults -
// the role-mode equivalent of "Reset to role default" for a person override. Any per-user
// overrides for people in this role are untouched (that's a separate, per-person axis).
async function resetRolePermission(req, res, next) {
  try {
    const parsed = roleResetSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { role } = parsed.data;

    const defaultView = ACCESS_DEFAULT[role] || [];
    const defaultEdit = EDIT_ACCESS_DEFAULT[role] || [];
    const defaultImportExport = IMPORT_EXPORT_DEFAULT[role] || [];

    assertNotSelfLockout(req, { affectsRole: role, resultingEdit: defaultEdit });

    const updated = await setPermissions({
      $set: {
        [`byRole.${role}`]: defaultView,
        [`editByRole.${role}`]: defaultEdit,
        [`importExportByRole.${role}`]: defaultImportExport,
      },
    });
    logActivity(req.user, `reset role "${role}" permissions to system defaults`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

const importExportModuleSchema = z.enum(IMPORT_EXPORT_MODULES);

const roleImportExportSchema = z.object({
  role: z.enum(Object.keys(ROLES)),
  module: importExportModuleSchema,
  enabled: z.boolean(),
});

function toggleModule(list, moduleKey, enabled) {
  const set = new Set(list || []);
  if (enabled) set.add(moduleKey);
  else set.delete(moduleKey);
  return [...set];
}

async function updateRoleImportExport(req, res, next) {
  try {
    const parsed = roleImportExportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { role, module, enabled } = parsed.data;

    const perms = getPermissions();
    const list = toggleModule(perms.importExportByRole?.[role], module, enabled);

    const updated = await setPermissions({ $set: { [`importExportByRole.${role}`]: list } });
    logActivity(req.user, `${enabled ? 'enabled' : 'disabled'} Import/Export on "${module}" for role "${role}"`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

const userImportExportSchema = z.object({
  userId: z.string().min(1),
  module: importExportModuleSchema,
  enabled: z.boolean(),
  role: z.enum(Object.keys(ROLES)),
});

async function updateUserImportExportOverride(req, res, next) {
  try {
    const parsed = userImportExportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { userId, module, enabled, role } = parsed.data;

    const perms = getPermissions();
    const existing = perms.userOverrides?.[userId];
    // Keep this user's existing view/edit override (or their role default) intact - only
    // the importExport list changes here.
    const view = existing?.view ?? perms.byRole[role] ?? [];
    const edit = existing?.edit ?? perms.editByRole[role] ?? [];
    const baseImportExport = existing?.importExport ?? perms.importExportByRole?.[role] ?? [];
    const importExport = toggleModule(baseImportExport, module, enabled);

    const updated = await setPermissions({
      $set: { [`userOverrides.${userId}`]: { view, edit, importExport } },
    });
    logActivity(req.user, `${enabled ? 'enabled' : 'disabled'} Import/Export on "${module}" for ${await userLabel(userId)} (person override)`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

const userUpdateSchema = z.object({
  userId: z.string().min(1),
  module: moduleSchema,
  level: levelSchema,
  role: z.enum(Object.keys(ROLES)), // the user's current role, to seed the override on first use
});

async function updateUserOverride(req, res, next) {
  try {
    const parsed = userUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { userId, module, level, role } = parsed.data;

    const perms = getPermissions();
    // First override for this person starts from their current role default, not from
    // scratch - so toggling one module doesn't silently strip every other module.
    const existing = perms.userOverrides?.[userId];
    const baseView = existing?.view ?? perms.byRole[role] ?? [];
    const baseEdit = existing?.edit ?? perms.editByRole[role] ?? [];
    const { view, edit } = applyLevelWithCascade(baseView, baseEdit, module, level);
    // importExport is a separate axis (see updateUserImportExportOverride) — preserve whatever
    // this user already has instead of dropping it every time view/edit changes.
    const importExport = existing?.importExport ?? perms.importExportByRole?.[role] ?? [];

    if (module === 'admin') assertNotSelfLockout(req, { affectsUserId: userId, resultingEdit: edit });

    const updated = await setPermissions({
      $set: { [`userOverrides.${userId}`]: { view, edit, importExport } },
    });
    logActivity(req.user, `set permission override for ${await userLabel(userId)} on "${module}" to: ${level}`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

async function clearUserOverride(req, res, next) {
  try {
    const { userId } = req.params;

    if (userId === String(req.user._id)) {
      const roleDefaultEdit = getPermissions().editByRole[req.user.role] || [];
      if (!roleDefaultEdit.includes('admin')) {
        throw new AppError('Resetting to your role default would remove your own admin edit access - blocked', 400);
      }
    }

    const updated = await setPermissions({ $unset: { [`userOverrides.${userId}`]: '' } });
    logActivity(req.user, `cleared permission override for ${await userLabel(userId)} — back to role default`);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

async function listActivity(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (req.query.module) filter.module = req.query.module;
    if (req.query.actorId) filter.actorId = req.query.actorId;
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      const [y, m] = req.query.month.split('-').map(Number);
      filter.createdAt = { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
    }
    if (req.query.search) {
      const term = req.query.search.trim();
      filter.$or = regexOr(term, ['actorLabel', 'message']);
    }

    const [data, totalRowCount] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ActivityLog.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPermissionsDoc,
  updateRolePermission,
  resetRolePermission,
  updateUserOverride,
  clearUserOverride,
  updateRoleImportExport,
  updateUserImportExportOverride,
  listActivity,
};
