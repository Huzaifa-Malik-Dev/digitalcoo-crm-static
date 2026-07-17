const mongoose = require('mongoose');

// Admin-managed list of subscription types (NEW, MIG, MNP, FNP, ADD ON, P2P, ...) - was a fixed
// SR_TYPES constant until the business needed to add its own without a code deploy.
//
// Deals/orders store the NAME they were sold under, not a reference here (see
// models/schemas/lineItem.js): a line item is a historical record of what was sold, so renaming a
// type must never rewrite past deals. That's also why nothing cascades from this collection.
const subscriptionTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    // Deactivate rather than delete once a type has been used - it stops being offered on new
    // deals while every existing one keeps reading correctly.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

subscriptionTypeSchema.index({ active: 1 });

module.exports = mongoose.model('SubscriptionType', subscriptionTypeSchema);
