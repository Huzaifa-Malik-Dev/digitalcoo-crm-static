const mongoose = require('mongoose');

// Admin-managed product categories (DIGITAL, FIXED, GSM, WIRELESS, ...) - was a fixed CATEGORIES
// constant until the business needed to add its own without a code deploy.
//
// `subscriptionTypes` is the set assignable anywhere under this category. A product in it may
// narrow that set further but can never widen it (enforced in productController), so adding a type
// here makes it available to every product in the category at once, and nonsense combinations
// (a GSM-only type on a FIXED product) can't be configured.
//
// Deals/orders store the category NAME they were sold under, not a reference here - see
// models/schemas/lineItem.js for why.
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    subscriptionTypes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionType' }],
    // Deactivate rather than delete once a category has been used - it stops being offered on new
    // deals while every existing one keeps reading correctly.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

categorySchema.index({ active: 1 });

module.exports = mongoose.model('Category', categorySchema);
