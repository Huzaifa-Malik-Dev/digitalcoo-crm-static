const mongoose = require('mongoose');

// Pricing preset for one (this product x subscription type) pair - what a deal's Unit Price
// prefills to when that combination is picked (see client/src/components/LineItemsEditor.jsx).
// Always just a starting point: the price stays editable on the deal itself.
const pricingEntrySchema = new mongoose.Schema(
  {
    subscriptionType: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionType', required: true },
    defaultPrice: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    // A real reference now, not free text - a category rename follows through to its products
    // automatically. (Deals keep the name they were sold under instead; see schemas/lineItem.js.)
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    // Which of the category's assignable subscription types THIS product actually offers - always
    // a subset of category.subscriptionTypes, enforced in productController. Empty means the
    // product offers none yet and won't be sellable until one is assigned.
    subscriptionTypes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionType' }],
    pricing: { type: [pricingEntrySchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ category: 1 });
productSchema.index({ active: 1 });

// Defense in depth alongside productController's own Zod-level uniqueness check.
productSchema.pre('validate', function enforceUniquePricingTypes(next) {
  const seen = new Set();
  for (const entry of this.pricing) {
    const key = String(entry.subscriptionType);
    if (seen.has(key)) return next(new Error('Each subscription type can only have one price preset'));
    seen.add(key);
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
