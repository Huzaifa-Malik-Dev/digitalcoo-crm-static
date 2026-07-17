const { z } = require('zod');
const Product = require('../models/Product');
const Category = require('../models/Category');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');

const PRODUCT_FIELD_LABELS = { title: 'Title', active: 'Active' };

const pricingSchema = z
  .array(z.object({ subscriptionType: z.string().min(1), defaultPrice: z.number().min(0) }))
  .refine((rows) => new Set(rows.map((r) => r.subscriptionType)).size === rows.length, {
    message: 'Each subscription type can only have one price preset',
  });

const createSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  category: z.string().min(1, 'Category is required'),
  subscriptionTypes: z.array(z.string()).optional().default([]),
  pricing: pricingSchema.optional().default([]),
  active: z.boolean().optional().default(true),
});

const updateSchema = createSchema.partial();

// A product may only offer subscription types its category allows - the category is the source of
// truth for what's sellable under it, and a product narrows that set rather than widening it.
// Without this a product could be configured to sell a type its own category doesn't recognise.
//
// Pricing is held to the same rule: a preset for a type this product doesn't offer is unreachable
// (nothing could ever pick that combination), so it's rejected rather than stored as dead data.
async function assertWithinCategory(categoryId, subscriptionTypes = [], pricing = []) {
  const category = await Category.findById(categoryId).select('name subscriptionTypes').lean();
  if (!category) throw new AppError('Category not found', 400);

  const allowed = new Set((category.subscriptionTypes || []).map(String));
  const offending = subscriptionTypes.filter((id) => !allowed.has(String(id)));
  if (offending.length) {
    throw new AppError(`Category "${category.name}" doesn't allow one or more of those subscription types. Add it to the category first.`, 400);
  }

  const offered = new Set(subscriptionTypes.map(String));
  const strayPricing = pricing.filter((p) => !offered.has(String(p.subscriptionType)));
  if (strayPricing.length) {
    throw new AppError('You set a price for a subscription type this product does not offer. Assign the type to the product first.', 400);
  }
  return category;
}

async function list(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};

    if (req.query.category) filter.category = req.query.category;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';
    if (req.query.search) {
      const re = new RegExp(req.query.search.trim(), 'i');
      // Category is a reference now, so a search for its name has to resolve to ids first.
      const matchingCats = await Category.find({ name: re }).select('_id').lean();
      filter.$or = [{ title: re }, { category: { $in: matchingCats.map((c) => c._id) } }];
    }

    const [data, totalRowCount] = await Promise.all([
      Product.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('category', 'name active')
        .populate('subscriptionTypes', 'name active')
        .populate('pricing.subscriptionType', 'name')
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const category = await assertWithinCategory(parsed.data.category, parsed.data.subscriptionTypes, parsed.data.pricing);
    const product = await Product.create(parsed.data);
    logActivity(req.user, `added product "${product.title}" to category "${category.name}"`);
    res.status(201).json({ data: product });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);

    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404);

    // Validate against whichever category the product will end up in, not just the one it's in now -
    // a request can move it and change its types in the same call.
    const nextCategory = parsed.data.category ?? product.category;
    const nextTypes = parsed.data.subscriptionTypes ?? product.subscriptionTypes.map(String);
    const nextPricing = parsed.data.pricing ?? product.pricing.map((p) => ({ subscriptionType: String(p.subscriptionType), defaultPrice: p.defaultPrice }));
    await assertWithinCategory(nextCategory, nextTypes, nextPricing);

    const before = { title: product.title, active: product.active };
    const pricingChanged = parsed.data.pricing !== undefined && JSON.stringify(product.pricing) !== JSON.stringify(parsed.data.pricing);
    Object.assign(product, parsed.data);
    await product.save();

    const changes = diffFields(before, product.toObject(), PRODUCT_FIELD_LABELS);
    // pricing/subscriptionTypes are arrays of objects/refs - diffFields' generic display would
    // render them as unreadable noise, so they get plain markers instead of a value diff.
    if (pricingChanged) changes.push('Pricing updated');
    if (parsed.data.subscriptionTypes) changes.push('Subscription types updated');
    if (changes.length) logActivity(req.user, `edited product "${product.title}": ${changes.join(', ')}`);
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw new AppError('Product not found', 404);

    await product.deleteOne();
    logActivity(req.user, `deleted product "${product.title}"`);
    res.json({ data: { _id: req.params.id } });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove };
