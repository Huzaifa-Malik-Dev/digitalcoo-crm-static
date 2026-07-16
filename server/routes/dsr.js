const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireImportExport } = require('../middlewares/rbac');
const uploadExcel = require('../middlewares/uploadExcel');
const { list, create, updateStatus, update, getOne, exportDsr, importDsr, autocomplete, loggableEmployees } = require('../controllers/dsrController');

const router = express.Router();
router.use(requireAuth, requireModule('dsr'));

router.get('/export', requireImportExport('dsr'), exportDsr);
router.post('/import', requireImportExport('dsr'), uploadExcel.single('file'), importDsr);
router.get('/autocomplete', autocomplete);
router.get('/loggable-employees', loggableEmployees);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireModule('dsr', { edit: true }), create);
router.patch('/:id/status', requireModule('dsr', { edit: true }), updateStatus);
router.patch('/:id', requireModule('dsr', { edit: true }), update);

module.exports = router;
