// Shared by Pipeline.js and Order.js - a deal/order is one or more "blocks" (Category + Product +
// Subscription Type), each carrying one or more price/qty "rows" (e.g. 3 units at 100 AED and 2
// units at 150 AED under the same block). Extracted into its own file (unlike the trivial
// per-model historyEntrySchema) because the two models must never drift on this shape and the
// recompute rules are more than a one-liner - see utils/lineItems.js.
const mongoose = require('mongoose');

const lineItemRowSchema = new mongoose.Schema({
  price: { type: Number, default: 0, min: 0 },
  qty: { type: Number, default: 1, min: 1 },
  // Always recomputed server-side as price * qty (see utils/lineItems.js) - never trusted from
  // client input, same rule the old top-level Pipeline/Order.mrc already followed.
  mrc: { type: Number, default: 0 },
});

// cat/product/sr are stored as plain NAMES, and deliberately carry no enum: they're a record of
// what was actually sold, not a live reference into the catalog (models/Category.js,
// models/SubscriptionType.js). Two reasons this matters:
//   - Mongoose validates the WHOLE document on every save, so an enum here would reject an
//     existing deal the moment its category was renamed or retired - even for an unrelated edit
//     like a price correction.
//   - Renaming a category shouldn't silently rewrite what past deals say they sold.
// Validation happens at write time instead, against the live catalog, in services/catalog.js.
const lineItemBlockSchema = new mongoose.Schema({
  cat: { type: String, default: '' },
  product: { type: String, default: '' },
  sr: { type: String, default: '' },
  rows: { type: [lineItemRowSchema], default: () => [{ price: 0, qty: 1, mrc: 0 }] },
  // Sum of rows[].mrc - a convenience per-block subtotal recomputed alongside rows[].mrc so the
  // UI never has to re-derive it.
  blockMrc: { type: Number, default: 0 },
});

module.exports = { lineItemRowSchema, lineItemBlockSchema };
