import api from './axios';

export const fetchSummary = () => api.get('/accounting/summary').then((r) => r.data);

export const fetchAccounts = () => api.get('/accounting/accounts').then((r) => r.data);
export const createAccount = (body) => api.post('/accounting/accounts', body).then((r) => r.data);
export const updateAccount = (id, body) => api.patch(`/accounting/accounts/${id}`, body).then((r) => r.data);
export const recordTransaction = (body) => api.post('/accounting/transactions', body).then((r) => r.data);

export const fetchExpenses = (params) => api.get('/accounting/expenses', { params }).then((r) => r.data);
export const createExpense = (body) => api.post('/accounting/expenses', body).then((r) => r.data);

export const fetchCheques = (params) => api.get('/accounting/cheques', { params }).then((r) => r.data);
export const createCheque = (body) => api.post('/accounting/cheques', body).then((r) => r.data);
export const updateCheque = (id, body) => api.patch(`/accounting/cheques/${id}`, body).then((r) => r.data);
export const updateChequeStatus = (id, status) => api.patch(`/accounting/cheques/${id}/status`, { status }).then((r) => r.data);
