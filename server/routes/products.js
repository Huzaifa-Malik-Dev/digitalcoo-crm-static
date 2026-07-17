const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule } = require('../middlewares/rbac');
const { list, create, update, remove } = require('../controllers/productController');
const {
  listSubscriptionTypes,
  createSubscriptionType,
  updateSubscriptionType,
  removeSubscriptionType,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
} = require('../controllers/catalogController');

const router = express.Router();
router.use(requireAuth, requireModule('products'));

// Categories and subscription types live under /products because they're the same catalog and the
// same permission - anyone who can see products needs to see the lists they're built from (the
// line-item editor reads them on every deal), and only someone who can edit products may change them.
router.get('/categories', listCategories);
router.post('/categories', requireModule('products', { edit: true }), createCategory);
router.patch('/categories/:id', requireModule('products', { edit: true }), updateCategory);
router.delete('/categories/:id', requireModule('products', { edit: true }), removeCategory);

router.get('/subscription-types', listSubscriptionTypes);
router.post('/subscription-types', requireModule('products', { edit: true }), createSubscriptionType);
router.patch('/subscription-types/:id', requireModule('products', { edit: true }), updateSubscriptionType);
router.delete('/subscription-types/:id', requireModule('products', { edit: true }), removeSubscriptionType);

router.get('/', list);
router.post('/', requireModule('products', { edit: true }), create);
router.patch('/:id', requireModule('products', { edit: true }), update);
router.delete('/:id', requireModule('products', { edit: true }), remove);

module.exports = router;
