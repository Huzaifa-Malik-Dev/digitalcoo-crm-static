const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireImportExport, requireAction } = require('../middlewares/rbac');
const uploadExcel = require('../middlewares/uploadExcel');
const { list, updateStatus, sendBack, update, createDirect, assignableEmployees, exportOrders, importOrders } = require('../controllers/orderController');

const router = express.Router();
router.use(requireAuth, requireModule('backoffice'));

router.get('/export', requireImportExport('backoffice'), exportOrders);
router.post('/import', requireImportExport('backoffice'), uploadExcel.single('file'), importOrders);
router.get('/assignable-employees', assignableEmployees);
router.get('/', list);
router.post('/', requireModule('backoffice', { edit: true }), createDirect);
router.patch('/:id/status', requireModule('backoffice', { edit: true }), requireAction('backoffice.statusChange'), updateStatus);
router.post('/:id/send-back', requireModule('backoffice', { edit: true }), requireAction('backoffice.statusChange'), sendBack);
router.patch('/:id', requireModule('backoffice', { edit: true }), update);

module.exports = router;
