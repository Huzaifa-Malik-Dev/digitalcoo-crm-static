const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireAction } = require('../middlewares/rbac');
const { listAttendance, bulkUpsertAttendance, clearAttendance } = require('../controllers/attendanceController');

const router = express.Router();
router.use(requireAuth, requireModule('attendance'));

router.get('/', listAttendance);
router.post('/bulk', requireAction('attendance.manage'), bulkUpsertAttendance);
router.delete('/:employeeId/:date', requireAction('attendance.manage'), clearAttendance);

module.exports = router;
