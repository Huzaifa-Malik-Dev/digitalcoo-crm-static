const Permission = require('../models/Permission');
const { ACCESS_DEFAULT, EDIT_ACCESS_DEFAULT, IMPORT_EXPORT_DEFAULT } = require('../utils/constants');

// In-memory cache of the single permissions doc — it's tiny and read on every request,
// so we keep it in memory and refresh it whenever an admin edits it (see setPermissions).
let cache = null;

async function loadPermissions() {
  let doc = await Permission.findById('access');
  if (!doc) {
    doc = await Permission.create({
      _id: 'access',
      byRole: ACCESS_DEFAULT,
      editByRole: EDIT_ACCESS_DEFAULT,
      importExportByRole: IMPORT_EXPORT_DEFAULT,
      userOverrides: {},
    });
  }
  cache = doc.toObject();
  return cache;
}

function getPermissions() {
  return cache;
}

async function setPermissions(update) {
  const doc = await Permission.findByIdAndUpdate('access', update, { new: true, upsert: true });
  cache = doc.toObject();
  return cache;
}

// A nested key (e.g. 'hr.addEmployee') is capped by its parent module's own level - granting
// the child directly can never give MORE access than the parent module allows, so "HR: None"
// always means every HR sub-item is also effectively None, regardless of what's individually
// stored for it. Recursing into the parent re-checks the exact same override/role list, so this
// stays correct however the child ended up with a stray grant (stale data, direct DB edit, etc).
function canView(user, key) {
  const perms = cache;
  if (!perms) return false;
  const override = perms.userOverrides?.[String(user._id)]?.view;
  const list = override || perms.byRole[user.role] || [];
  if (!list.includes(key)) return false;
  const parentKey = key.includes('.') ? key.split('.')[0] : null;
  return parentKey ? canView(user, parentKey) : true;
}

// Team Leaders always get full edit rights on DSR and Pipeline records, no matter how admin has
// configured the Permissions screen (role list or per-user override) - this is a floor, not a
// default, so it's checked before any override/role-list lookup rather than being encoded as
// seed data an admin could still narrow away. Deliberately doesn't cover pipeline.approve (a
// separate, still-overridable permission) or any other module.
const TL_UNCONDITIONAL_EDIT = ['dsr', 'pipeline'];

function canEdit(user, key) {
  if (user.role === 'team_leader' && TL_UNCONDITIONAL_EDIT.includes(key)) return true;
  const perms = cache;
  if (!perms) return false;
  const override = perms.userOverrides?.[String(user._id)]?.edit;
  const list = override || perms.editByRole[user.role] || [];
  if (!list.includes(key)) return false;
  const parentKey = key.includes('.') ? key.split('.')[0] : null;
  return parentKey ? canEdit(user, parentKey) : true;
}

function canImportExport(user, moduleKey) {
  const perms = cache;
  if (!perms) return false;
  const override = perms.userOverrides?.[String(user._id)]?.importExport;
  const list = override || perms.importExportByRole?.[user.role] || [];
  return list.includes(moduleKey);
}

module.exports = { loadPermissions, getPermissions, setPermissions, canView, canEdit, canImportExport };
