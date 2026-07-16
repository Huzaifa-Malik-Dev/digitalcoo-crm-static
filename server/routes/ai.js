const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule } = require('../middlewares/rbac');
const { createAiJob, listAiJobs, deleteAiJob, downloadAiJob } = require('../controllers/aiReportController');

const router = express.Router();
router.use(requireAuth, requireModule('ai'));

router.get('/jobs', listAiJobs);
router.post('/jobs', createAiJob);
router.delete('/jobs/:id', deleteAiJob);
router.get('/jobs/:id/download', downloadAiJob);

module.exports = router;
