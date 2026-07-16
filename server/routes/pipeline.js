const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireImportExport, requireAction } = require('../middlewares/rbac');
const uploadExcel = require('../middlewares/uploadExcel');
const {
  list,
  getOne,
  create,
  update,
  escalateTl,
  approve,
  reject,
  requestCorrection,
  exportPipeline,
  importPipeline,
} = require('../controllers/pipelineController');

const router = express.Router();
router.use(requireAuth, requireModule('pipeline'));

router.get('/export', requireImportExport('pipeline'), exportPipeline);
router.post('/import', requireImportExport('pipeline'), uploadExcel.single('file'), importPipeline);
router.get('/', list);
router.get('/:id', getOne);
router.post('/', requireModule('pipeline', { edit: true }), create);
router.patch('/:id', requireModule('pipeline', { edit: true }), update);
router.post('/:id/escalate-tl', requireModule('pipeline', { edit: true }), escalateTl);
router.post('/:id/approve', requireModule('pipeline', { edit: true }), requireAction('pipeline.approve'), approve);
router.post('/:id/reject', requireModule('pipeline', { edit: true }), requireAction('pipeline.approve'), reject);
router.post('/:id/request-correction', requireModule('pipeline', { edit: true }), requestCorrection);

module.exports = router;
