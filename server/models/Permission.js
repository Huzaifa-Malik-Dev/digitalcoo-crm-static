const mongoose = require('mongoose');

// Singleton doc (_id: 'access') holding runtime-editable RBAC, seeded from ACCESS_DEFAULT /
// EDIT_ACCESS_DEFAULT. Admin can tighten/loosen per role or per individual user at runtime.
const permissionSchema = new mongoose.Schema({
  _id: { type: String, default: 'access' },
  byRole: { type: mongoose.Schema.Types.Mixed, default: {} }, // { role: [key,...] } — view access; keys can be top-level modules or nested tab/action keys
  editByRole: { type: mongoose.Schema.Types.Mixed, default: {} }, // { role: [key,...] } — edit access, same key space as byRole
  importExportByRole: { type: mongoose.Schema.Types.Mixed, default: {} }, // { role: [module,...] } — bulk import/export access
  userOverrides: { type: mongoose.Schema.Types.Mixed, default: {} }, // { userId: { view:[...], edit:[...], importExport:[...] } }
}, { timestamps: true });

module.exports = mongoose.model('Permission', permissionSchema);
