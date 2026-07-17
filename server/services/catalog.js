const Category = require('../models/Category');
const SubscriptionType = require('../models/SubscriptionType');
const AppError = require('../utils/AppError');

// A deal/order line item stores the category and subscription type NAMES it was sold under, not
// references (see models/schemas/lineItem.js). That keeps history honest, but it means nothing at
// the schema level can validate them - a Mongoose enum would have to be a fixed list, and would
// then reject an existing deal the moment its category was renamed or retired. So the check lives
// here, at write time, against the live catalog.
//
// `previous` is the set of values already saved on the record being edited. They're always allowed
// through, even if since deactivated or renamed away: someone editing an old deal's price must not
// be forced to first re-pick a category that no longer exists. This mirrors exactly what the UI
// does (LineItemsEditor keeps a saved-but-no-longer-listed value visible in its Select).
async function assertLineItemsInCatalog(lineItems, previous = []) {
  const [categories, subscriptionTypes] = await Promise.all([
    Category.find({ active: true }).select('name').lean(),
    SubscriptionType.find({ active: true }).select('name').lean(),
  ]);

  const allowedCats = new Set(categories.map((c) => c.name));
  const allowedSrs = new Set(subscriptionTypes.map((s) => s.name));
  (previous || []).forEach((block) => {
    if (block.cat) allowedCats.add(block.cat);
    if (block.sr) allowedSrs.add(block.sr);
  });

  (lineItems || []).forEach((block, i) => {
    const label = `Line item ${i + 1}`;
    if (block.cat && !allowedCats.has(block.cat)) {
      throw new AppError(`${label}: "${block.cat}" is not a category you can sell under. Pick one from the list.`, 400);
    }
    if (block.sr && !allowedSrs.has(block.sr)) {
      throw new AppError(`${label}: "${block.sr}" is not an available subscription type. Pick one from the list.`, 400);
    }
  });
}

// Names of every active category / subscription type - used where a plain list is enough.
async function activeCatalogNames() {
  const [categories, subscriptionTypes] = await Promise.all([
    Category.find({ active: true }).sort({ name: 1 }).select('name').lean(),
    SubscriptionType.find({ active: true }).sort({ name: 1 }).select('name').lean(),
  ]);
  return { categories: categories.map((c) => c.name), subscriptionTypes: subscriptionTypes.map((s) => s.name) };
}

module.exports = { assertLineItemsInCatalog, activeCatalogNames };
