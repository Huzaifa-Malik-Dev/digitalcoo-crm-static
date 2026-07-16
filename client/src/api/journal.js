import api from './axios';

export const fetchChartOfAccounts = (params) => api.get('/accounting/coa', { params }).then((r) => r.data);
export const createChartOfAccount = (body) => api.post('/accounting/coa', body).then((r) => r.data);
export const updateChartOfAccount = (id, body) => api.patch(`/accounting/coa/${id}`, body).then((r) => r.data);

export const fetchJournalEntries = (params) => api.get('/accounting/journal', { params }).then((r) => r.data);
export const fetchJournalEntry = (id) => api.get(`/accounting/journal/${id}`).then((r) => r.data);
export const createJournalEntry = (body) => api.post('/accounting/journal', body).then((r) => r.data);
export const reverseJournalEntry = (id, memo) => api.post(`/accounting/journal/${id}/reverse`, { memo }).then((r) => r.data);

export const fetchGeneralLedger = (coaId, { year, month } = {}) =>
  api.get(year && month ? `/accounting/ledger/${coaId}/${year}/${month}` : `/accounting/ledger/${coaId}`).then((r) => r.data);

export const fetchTrialBalance = (month) => api.get(`/accounting/reports/trial-balance${month ? '/' + month : ''}`).then((r) => r.data);
export const fetchProfitLoss = (month) => api.get(`/accounting/reports/profit-loss${month ? '/' + month : ''}`).then((r) => r.data);
export const fetchBalanceSheet = (month) => api.get(`/accounting/reports/balance-sheet${month ? '/' + month : ''}`).then((r) => r.data);
