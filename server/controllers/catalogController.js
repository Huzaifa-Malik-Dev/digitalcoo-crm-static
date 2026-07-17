const { z } = require('zod');
const Category = require('../models/Category');
const SubscriptionType = require('../models/SubscriptionType');
const Product = require('../models/Product');
const AppError = require('../utils/AppError');
const { logActivity } = require('../utils/activityLog');

const subscriptionTypeSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  active: z.boolean().optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  subscriptionTypes: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

// Both lists are short (a handful of rows each) and every screen needs all of them at once, so
// they're returned whole rather than paginated - same call powers the admin tabs and the
// line-item editor's dropdowns.
async function listSubscriptionTypes(req, res, next) {
  try {
    const filter = {};
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const data = await SubscriptionType.find(filter).sort({ name: 1 }).lean();
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

async function createSubscriptionType(req, res, next) {
  try {
    const parsed = subscriptionTypeSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const exists = await SubscriptionType.findOne({ name: parsed.data.name }).lean();
    if (exists) throw new AppError(`A subscription type called "${parsed.data.name}" already exists`, 409);

    const doc = await SubscriptionType.create(parsed.data);
    logActivity(req.user, `added subscription type "${doc.name}"`);
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
}

async function updateSubscriptionType(req, res, next) {
  try {
    const parsed = subscriptionTypeSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const doc = await SubscriptionType.findById(req.params.id);
    if (!doc) throw new AppError('Subscription type not found', 404);
    if (parsed.data.name && parsed.data.name !== doc.name) {
      const clash = await SubscriptionType.findOne({ name: parsed.data.name, _id: { $ne: doc._id } }).lean();
      if (clash) throw new AppError(`A subscription type called "${parsed.data.name}" already exists`, 409);
    }

    const before = { name: doc.name, active: doc.active };
    Object.assign(doc, parsed.data);
    await doc.save();

    // Renaming deliberately does NOT touch deals already sold under the old name - they're a
    // historical record, not a live reference (see services/catalog.js).
    if (before.name !== doc.name) logActivity(req.user, `renamed subscription type "${before.name}" to "${doc.name}"`);
    if (before.active !== doc.active) logActivity(req.user, `${doc.active ? 'reactivated' : 'deactivated'} subscription type "${doc.name}"`);
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
}

// Hard delete only while genuinely unused. Once a type is assigned to a category or product,
// removing it would silently strip it from those records - deactivating keeps every existing deal
// readable and just stops it being offered on new ones.
async function removeSubscriptionType(req, res, next) {
  try {
    const doc = await SubscriptionType.findById(req.params.id);
    if (!doc) throw new AppError('Subscription type not found', 404);

    const [usedByCategory, usedByProduct] = await Promise.all([
      Category.findOne({ subscriptionTypes: doc._id }).select('name').lean(),
      Product.findOne({ subscriptionTypes: doc._id }).select('title').lean(),
    ]);
    if (usedByCategory || usedByProduct) {
      const where = usedByCategory ? `category "${usedByCategory.name}"` : `product "${usedByProduct.title}"`;
      throw new AppError(`"${doc.name}" is still assigned to ${where}. Deactivate it instead, or unassign it first.`, 400);
    }

    await doc.deleteOne();
    logActivity(req.user, `deleted subscription type "${doc.name}"`);
    res.json({ data: { _id: req.params.id } });
  } catch (err) {
    next(err);
  }
}

async function listCategories(req, res, next) {
  try {
    const filter = {};
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    const data = await Category.find(filter).sort({ name: 1 }).populate('subscriptionTypes', 'name active').lean();
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

// Everything assignable under a category must be a real subscription type - otherwise a product
// could later be "narrowed" to a type that doesn't exist.
async function assertTypesExist(ids) {
  if (!ids?.length) return;
  const found = await SubscriptionType.countDocuments({ _id: { $in: ids } });
  if (found !== new Set(ids.map(String)).size) throw new AppError('One or more subscription types do not exist', 400);
}

async function createCategory(req, res, next) {
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const exists = await Category.findOne({ name: parsed.data.name }).lean();
    if (exists) throw new AppError(`A category called "${parsed.data.name}" already exists`, 409);
    await assertTypesExist(parsed.data.subscriptionTypes);

    const doc = await Category.create(parsed.data);
    logActivity(req.user, `added category "${doc.name}"`);
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
}

async function updateCategory(req, res, next) {
  try {
    const parsed = categorySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const doc = await Category.findById(req.params.id);
    if (!doc) throw new AppError('Category not found', 404);
    if (parsed.data.name && parsed.data.name !== doc.name) {
      const clash = await Category.findOne({ name: parsed.data.name, _id: { $ne: doc._id } }).lean();
      if (clash) throw new AppError(`A category called "${parsed.data.name}" already exists`, 409);
    }
    await assertTypesExist(parsed.data.subscriptionTypes);

    const before = { name: doc.name, active: doc.active, types: (doc.subscriptionTypes || []).map(String) };
    Object.assign(doc, parsed.data);
    await doc.save();

    // Narrowing a category's types can orphan a product that still offers one of the removed
    // types - clean those up rather than leaving a product configured to sell something its
    // category no longer allows (the subset rule productController enforces on write).
    if (parsed.data.subscriptionTypes) {
      const nowAllowed = doc.subscriptionTypes.map(String);
      const removed = before.types.filter((t) => !nowAllowed.includes(t));
      if (removed.length) {
        const affected = await Product.updateMany(
          { category: doc._id, subscriptionTypes: { $in: removed } },
          { $pull: { subscriptionTypes: { $in: removed }, pricing: { subscriptionType: { $in: removed } } } }
        );
        if (affected.modifiedCount) {
          logActivity(req.user, `removed subscription type(s) from category "${doc.name}" — also unassigned them from ${affected.modifiedCount} product(s) in it`);
        }
      }
    }

    if (before.name !== doc.name) logActivity(req.user, `renamed category "${before.name}" to "${doc.name}"`);
    if (before.active !== doc.active) logActivity(req.user, `${doc.active ? 'reactivated' : 'deactivated'} category "${doc.name}"`);
    res.json({ data: doc });
  } catch (err) {
    next(err);
  }
}

// Same rule as subscription types: only deletable while nothing depends on it.
async function removeCategory(req, res, next) {
  try {
    const doc = await Category.findById(req.params.id);
    if (!doc) throw new AppError('Category not found', 404);

    const productCount = await Product.countDocuments({ category: doc._id });
    if (productCount) {
      throw new AppError(`"${doc.name}" still has ${productCount} product(s) in it. Deactivate it instead, or move those products first.`, 400);
    }

    await doc.deleteOne();
    logActivity(req.user, `deleted category "${doc.name}"`);
    res.json({ data: { _id: req.params.id } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listSubscriptionTypes,
  createSubscriptionType,
  updateSubscriptionType,
  removeSubscriptionType,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
};
