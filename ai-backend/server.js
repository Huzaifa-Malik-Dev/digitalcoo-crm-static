const mongoose = require('mongoose');
const app = require('./app');
const { port, mongoUri } = require('./config/env');
const { startWorker, recoverStuckJobs } = require('./services/worker');
const { startCleanupSweep } = require('./utils/cleanup');

async function start() {
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected:', mongoose.connection.name);

  await recoverStuckJobs();
  startWorker();
  startCleanupSweep();

  app.listen(port, () => console.log(`AI-Backend running on port ${port}`));
}

start().catch((err) => {
  console.error('Failed to start AI-Backend:', err);
  process.exit(1);
});
