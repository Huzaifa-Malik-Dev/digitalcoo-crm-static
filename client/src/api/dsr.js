import api from './axios';

export const fetchDsrList = (params) => api.get('/dsr', { params }).then((r) => r.data);
export const fetchDsrOne = (id) => api.get(`/dsr/${id}`).then((r) => r.data);
export const createDsr = (body) => api.post('/dsr', body).then((r) => r.data);
export const updateDsrStatus = (id, body) => api.patch(`/dsr/${id}/status`, body).then((r) => r.data);
export const updateDsr = (id, body) => api.patch(`/dsr/${id}`, body).then((r) => r.data);
export const exportDsr = (params) => api.get('/dsr/export', { params, responseType: 'blob' }).then((r) => r.data);
export const importDsr = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/dsr/import', form).then((r) => r.data);
};
export const fetchDsrAutocomplete = (params) => api.get('/dsr/autocomplete', { params }).then((r) => r.data);
export const fetchLoggableEmployees = () => api.get('/dsr/loggable-employees').then((r) => r.data);
