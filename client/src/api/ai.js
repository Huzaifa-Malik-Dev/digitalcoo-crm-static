import api from './axios';

// The real-LLM async report - createAiJob returns immediately with a jobId; the Report History
// list (fetchAiJobs) is what actually tracks/polls status from then on, newest first, last 3 days.
export const createAiJob = (body) => api.post('/ai/jobs', body).then((r) => r.data);
export const fetchAiJobs = () => api.get('/ai/jobs').then((r) => r.data);
export const deleteAiJob = (id) => api.delete(`/ai/jobs/${id}`).then((r) => r.data);
export const downloadAiJob = (jobId) => api.get(`/ai/jobs/${jobId}/download`, { responseType: 'blob' }).then((r) => r.data);
