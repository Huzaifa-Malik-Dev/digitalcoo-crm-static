const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const path = require('path');

const { clientOrigin, uploadDir } = require('./config/env');
const errorHandler = require('./middlewares/errorHandler');
const requireAuth = require('./middlewares/auth');
const { requestContext } = require('./middlewares/requestContext');

const authRoutes = require('./routes/auth');
const dsrRoutes = require('./routes/dsr');
const notificationRoutes = require('./routes/notifications');
const userRoutes = require('./routes/users');
const pipelineRoutes = require('./routes/pipeline');
const orderRoutes = require('./routes/orders');
const accountingRoutes = require('./routes/accounting');
const payrollRoutes = require('./routes/payroll');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');
const misRoutes = require('./routes/mis');
const aiRoutes = require('./routes/ai');
const threadRoutes = require('./routes/threads');
const productRoutes = require('./routes/products');
const leaveRoutes = require('./routes/leave');
const attendanceRoutes = require('./routes/attendance');
const viewRoutes = require('./routes/views');

const app = express();

app.use(helmet());
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(requestContext);
// Successful GET requests are routine polling (notifications, list views, etc.) and add no
// tracing value — only log GETs that errored, plus every mutating request (POST/PATCH/PUT/
// DELETE) regardless of outcome. Meaningful business events are already covered by the
// [ACTIVITY] log (utils/activityLog.js); this is just enough HTTP-level detail to debug errors.
app.use(morgan('dev', { skip: (req, res) => req.method === 'GET' && res.statusCode < 400 }));

// Uploaded files include HR compliance documents and chat attachments — never public.
// Any authenticated user may fetch by path (matches the app's general auth model; the paths
// themselves are only ever handed out to users who already had access to the owning record).
// Helmet's default Cross-Origin-Resource-Policy (same-origin) blocks the client from embedding
// these as <img> thumbnails whenever client and API aren't on the exact same origin (e.g. the
// separate Vite dev server port) — relax it to cross-origin for this route only. This doesn't
// widen who can fetch a file: the cors() + requireAuth checks above still gate that; it only lets
// an already-authorized fetch be rendered inline instead of forcing a new-tab navigation.
app.use('/uploads', requireAuth, helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }), express.static(path.join(__dirname, uploadDir)));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/dsr', dsrRoutes);
app.use('/notifications', notificationRoutes);
app.use('/users', userRoutes);
app.use('/pipeline', pipelineRoutes);
app.use('/orders', orderRoutes);
app.use('/accounting', accountingRoutes);
app.use('/payroll', payrollRoutes);
app.use('/admin', adminRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/mis', misRoutes);
app.use('/ai', aiRoutes);
app.use('/threads', threadRoutes);
app.use('/products', productRoutes);
app.use('/leave', leaveRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/views', viewRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
