const express = require('express');
const requireAuth = require('../middlewares/auth');
const { markViewed } = require('../controllers/viewController');

// No requireModule here - this is cross-module by design (dsr/pipeline/orders all share it), so
// per-module access is whatever the caller already had to reach that record in the first place;
// this just records that they looked at it.
const router = express.Router();
router.use(requireAuth);

router.post('/:module/:id', markViewed);

module.exports = router;
