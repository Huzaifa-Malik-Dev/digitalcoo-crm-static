// Production bootstrap: creates exactly one admin user, nothing else. Run once on a fresh
// database instead of seed.js (which also creates demo employees/DSRs/pipeline/orders).
// The Permission doc doesn't need seeding either - services/permissions.js creates it with
// sensible role defaults automatically on first server startup.
require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const { mongoUri } = require('./config/env');
const User = require('./models/User');
const { nextSeq } = require('./models/Counter');
const { hashPassword } = require('./utils/password');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  await mongoose.connect(mongoUri);

  const name = await ask('Full name: ');
  const username = (await ask('Username: ')).toLowerCase().trim();
  const password = await ask('Password: ');

  if (await User.exists({ username })) {
    console.error(`Username "${username}" already exists.`);
    process.exit(1);
  }

  const employeeId = 'DC' + (await nextSeq('employee'));
  const passwordHash = await hashPassword(password);

  await User.create({
    employeeId,
    name,
    username,
    passwordHash,
    role: 'admin',
    desig: 'System Administrator',
    dept: 'Management',
    reportsTo: null,
    managerChain: [],
    join: new Date().toISOString().slice(0, 10),
    status: 'Active',
    active: true,
  });

  console.log(`Admin user created: ${username} (${employeeId})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
