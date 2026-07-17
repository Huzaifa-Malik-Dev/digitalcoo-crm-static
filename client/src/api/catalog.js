import api from './axios';

// Categories and subscription types are admin-managed records (server/models/Category.js,
// SubscriptionType.js), not code constants - so every dropdown that used to read a hardcoded list
// reads these instead. They live under /products because they're the same catalog and the same
// permission: viewing needs `products` view, changing needs `products` edit.

export const fetchCategories = (params) => api.get('/products/categories', { params }).then((r) => r.data);
export const createCategory = (body) => api.post('/products/categories', body).then((r) => r.data);
export const updateCategory = (id, body) => api.patch(`/products/categories/${id}`, body).then((r) => r.data);
export const deleteCategory = (id) => api.delete(`/products/categories/${id}`).then((r) => r.data);

export const fetchSubscriptionTypes = (params) => api.get('/products/subscription-types', { params }).then((r) => r.data);
export const createSubscriptionType = (body) => api.post('/products/subscription-types', body).then((r) => r.data);
export const updateSubscriptionType = (id, body) => api.patch(`/products/subscription-types/${id}`, body).then((r) => r.data);
export const deleteSubscriptionType = (id) => api.delete(`/products/subscription-types/${id}`).then((r) => r.data);
