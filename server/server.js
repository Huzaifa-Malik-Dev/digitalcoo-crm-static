const app = require('./app');
const connectDB = require('./config/db');
const { port } = require('./config/env');
const { loadPermissions } = require('./services/permissions');
const { seedChartOfAccounts } = require('./services/journal');

async function start() {
  await connectDB();
  await loadPermissions();
  // Idempotent (upsert by code) — safe to run on every boot, so new standard accounts (e.g. a
  // future Chart of Accounts addition) reach an already-deployed install without needing the
  // destructive full reseed (server/seed.js), which wipes all transactional data.
  await seedChartOfAccounts();
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
