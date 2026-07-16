import api from './axios';

export const fetchOrderList = (params) => api.get('/orders', { params }).then((r) => r.data);
export const createDirectOrder = (body) => api.post('/orders', body).then((r) => r.data);
export const fetchAssignableEmployees = () => api.get('/orders/assignable-employees').then((r) => r.data);
export const updateOrderStatus = (id, body) => api.patch(`/orders/${id}/status`, body).then((r) => r.data);
export const sendOrderBack = (id) => api.post(`/orders/${id}/send-back`).then((r) => r.data);
export const updateOrder = (id, body) => api.patch(`/orders/${id}`, body).then((r) => r.data);
export const exportOrders = (params) => api.get('/orders/export', { params, responseType: 'blob' }).then((r) => r.data);
export const importOrders = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/orders/import', form).then((r) => r.data);
};
