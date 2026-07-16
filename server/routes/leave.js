const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireAction } = require('../middlewares/rbac');
const {
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  listHolidays,
  createHoliday,
  deleteHoliday,
  getLeaveBalance,
  listMyLeaveRequests,
  listApprovals,
  createRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  revokeRequest,
} = require('../controllers/leaveController');

const router = express.Router();
router.use(requireAuth, requireModule('leave'));

router.get('/types', listLeaveTypes);
router.post('/types', requireAction('leave.settings'), createLeaveType);
router.patch('/types/:id', requireAction('leave.settings'), updateLeaveType);

router.get('/holidays', listHolidays);
router.post('/holidays', requireAction('leave.settings'), createHoliday);
router.delete('/holidays/:id', requireAction('leave.settings'), deleteHoliday);

router.get('/balance', getLeaveBalance);

router.get('/requests', listMyLeaveRequests);
router.post('/requests', requireModule('leave', { edit: true }), createRequest);
router.post('/requests/:id/cancel', requireModule('leave', { edit: true }), cancelRequest);

router.get('/approvals', requireAction('leave.approve'), listApprovals);
router.post('/requests/:id/approve', requireAction('leave.approve'), approveRequest);
router.post('/requests/:id/reject', requireAction('leave.approve'), rejectRequest);
router.post('/requests/:id/revoke', requireAction('leave.approve'), revokeRequest);

module.exports = router;
