import api from './axios';

export const fetchLeaveTypes = (params) => api.get('/leave/types', { params }).then((r) => r.data);
export const createLeaveType = (body) => api.post('/leave/types', body).then((r) => r.data);
export const updateLeaveType = (id, body) => api.patch(`/leave/types/${id}`, body).then((r) => r.data);

export const fetchHolidays = (params) => api.get('/leave/holidays', { params }).then((r) => r.data);
export const createHoliday = (body) => api.post('/leave/holidays', body).then((r) => r.data);
export const deleteHoliday = (id) => api.delete(`/leave/holidays/${id}`).then((r) => r.data);

export const fetchLeaveBalance = (params) => api.get('/leave/balance', { params }).then((r) => r.data);

export const fetchMyLeaveRequests = (params) => api.get('/leave/requests', { params }).then((r) => r.data);
export const createLeaveRequest = (body) => api.post('/leave/requests', body).then((r) => r.data);
export const cancelLeaveRequest = (id) => api.post(`/leave/requests/${id}/cancel`).then((r) => r.data);

export const fetchLeaveApprovals = (params) => api.get('/leave/approvals', { params }).then((r) => r.data);
export const approveLeaveRequest = (id) => api.post(`/leave/requests/${id}/approve`).then((r) => r.data);
export const rejectLeaveRequest = (id, reason) => api.post(`/leave/requests/${id}/reject`, { reason }).then((r) => r.data);
export const revokeLeaveRequest = (id, reason) => api.post(`/leave/requests/${id}/revoke`, { reason }).then((r) => r.data);
