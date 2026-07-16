const express = require('express');
const requireSharedSecret = require('../middlewares/auth');
const { createJob, getJob, deleteJob, downloadJob } = require('../controllers/jobController');

const router = express.Router();
router.use(requireSharedSecret);

router.post('/', createJob);
router.get('/:id', getJob);
router.delete('/:id', deleteJob);
router.get('/:id/download', downloadJob);

module.exports = router;
