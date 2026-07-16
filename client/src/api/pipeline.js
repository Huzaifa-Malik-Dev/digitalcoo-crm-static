import api from './axios';

export const fetchPipelineList = (params) => api.get('/pipeline', { params }).then((r) => r.data);
export const fetchPipelineOne = (id) => api.get(`/pipeline/${id}`).then((r) => r.data);
export const convertToPipeline = (body) => api.post('/pipeline', body).then((r) => r.data);
export const updatePipeline = (id, body) => api.patch(`/pipeline/${id}`, body).then((r) => r.data);
export const escalateToTL = (id) => api.post(`/pipeline/${id}/escalate-tl`).then((r) => r.data);
export const approvePipeline = (id) => api.post(`/pipeline/${id}/approve`).then((r) => r.data);
export const rejectPipeline = (id, reason) => api.post(`/pipeline/${id}/reject`, { reason }).then((r) => r.data);
export const requestPipelineCorrection = (id, reason) => api.post(`/pipeline/${id}/request-correction`, { reason }).then((r) => r.data);
export const exportPipeline = (params) => api.get('/pipeline/export', { params, responseType: 'blob' }).then((r) => r.data);
export const importPipeline = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/pipeline/import', form).then((r) => r.data);
};
