import api from './axios';

export const fetchAttendance = (params) => api.get('/attendance', { params }).then((r) => r.data);
export const bulkUpsertAttendance = (entries) => api.post('/attendance/bulk', { entries }).then((r) => r.data);
export const clearAttendance = (employeeId, date) => api.delete(`/attendance/${employeeId}/${date}`).then((r) => r.data);
