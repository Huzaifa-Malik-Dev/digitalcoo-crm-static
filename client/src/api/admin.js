import api from './axios';

export const fetchPermissions = () => api.get('/admin/permissions').then((r) => r.data);
export const updateRolePermission = (body) => api.patch('/admin/permissions/role', body).then((r) => r.data);
export const resetRolePermission = (role) => api.post('/admin/permissions/role/reset', { role }).then((r) => r.data);
export const updateUserOverride = (body) => api.patch('/admin/permissions/user', body).then((r) => r.data);
export const clearUserOverride = (userId) => api.delete(`/admin/permissions/user/${userId}`).then((r) => r.data);
export const updateRoleImportExport = (body) => api.patch('/admin/permissions/role/import-export', body).then((r) => r.data);
export const updateUserImportExportOverride = (body) => api.patch('/admin/permissions/user/import-export', body).then((r) => r.data);
export const fetchActivityLog = (params) => api.get('/admin/activity', { params }).then((r) => r.data);
