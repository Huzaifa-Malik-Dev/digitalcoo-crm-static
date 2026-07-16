const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const { nodeEnv } = require('./config/env');
const errorHandler = require('./middlewares/errorHandler');
const jobRoutes = require('./routes/jobs');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '256kb' }));
app.use(morgan(nodeEnv === 'production' ? 'combined' : 'dev'));

// Unauthenticated on purpose - the main CRM app's own health/monitoring hits this to confirm the
// AI-Backend droplet is reachable before it tries to submit a job.
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/jobs', jobRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
