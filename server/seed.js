// Wipes and reseeds the demo dataset — mirrors the original prototype's seed() employees/roles,
// with the hierarchy correctly built via services/hierarchy.js (managerChain + AssignmentHistory).
require('dotenv').config();
const mongoose = require('mongoose');
const { mongoUri } = require('./config/env');

const User = require('./models/User');
const Dsr = require('./models/Dsr');
const Pipeline = require('./models/Pipeline');
const Order = require('./models/Order');
const Notification = require('./models/Notification');
const AssignmentHistory = require('./models/AssignmentHistory');
const Permission = require('./models/Permission');
const Account = require('./models/Account');
const ChartOfAccount = require('./models/ChartOfAccount');
const JournalEntry = require('./models/JournalEntry');
const Cheque = require('./models/Cheque');
const Expense = require('./models/Expense');
const LedgerEntry = require('./models/LedgerEntry');
const PayrollRun = require('./models/PayrollRun');
const PayrollLine = require('./models/PayrollLine');
const Product = require('./models/Product');
const Category = require('./models/Category');
const SubscriptionType = require('./models/SubscriptionType');
const LeaveType = require('./models/LeaveType');
const Holiday = require('./models/Holiday');
const LeaveRequest = require('./models/LeaveRequest');
const Attendance = require('./models/Attendance');
const ActivityLog = require('./models/ActivityLog');
const RecordView = require('./models/RecordView');
const { Counter, nextSeq } = require('./models/Counter');
const { seedChartOfAccounts, ensureLinkedAccount, postJournalEntry, requireCoaByCode, CODES, EXPENSE_CATEGORY_TO_CODE } = require('./services/journal');
const { processPayrollRun } = require('./services/payroll');
const { createLeaveRequest, approveLeaveRequest } = require('./services/leave');

const { hashPassword } = require('./utils/password');
const { buildManagerChain, createInitialAssignment } = require('./services/hierarchy');
const { convertToPipeline, escalateToTL, tlApprove } = require('./services/workflow');
const { PIPE_STAGES } = require('./utils/constants');
const { ACCESS_DEFAULT, EDIT_ACCESS_DEFAULT, IMPORT_EXPORT_DEFAULT, CALL_STATUS } = require('./utils/constants');

const defUser = (name) => name.toLowerCase().replace(/[^a-z]/g, '');

async function createUser(data) {
  const managerChain = data.reportsTo ? await buildManagerChain(data.reportsTo) : [];
  const passwordHash = await hashPassword(defUser(data.name) + '@2026');
  const employeeId = 'DC' + (await nextSeq('employee'));
  const user = await User.create({
    ...data,
    employeeId,
    username: defUser(data.name),
    passwordHash,
    managerChain,
    active: true,
    compliance: {
      dob: '1992-04-12',
      nationality: 'India',
      passportNo: 'P' + data.name.slice(0, 3).toUpperCase() + '1234',
      passportExpiry: '2029-01-01',
      visaCompany: 'Digitalcoo Technologies LLC',
      visaExpiry: '2027-06-01',
      eid: '784-1992-XXXXXXX-1',
      eidIssue: '2024-01-01',
      eidExpiry: '2027-06-01',
      labourCardNo: 'LC-' + data.name.slice(0, 3).toUpperCase(),
      labourCardIssue: '2024-01-01',
      labourCardExpiry: '2027-06-01',
      insuranceIssue: '2026-01-01',
      insuranceExpiry: '2027-01-01',
      legalCaseStatus: 'No',
      legalCaseNote: '',
      abscondingMohre: 'No',
      abscondingMohreNote: '',
      abscondingGdrfa: 'No',
      abscondingGdrfaNote: '',
    },
  });
  await createInitialAssignment(user, null);
  return user;
}

async function run() {
  await mongoose.connect(mongoUri);
  console.log('Connected:', mongoose.connection.name);

  console.log('Wiping demo collections...');
  await Promise.all([
    User.deleteMany({}),
    Dsr.deleteMany({}),
    // Wiped like everything else - these are (userId, module, recordId) rows, so leaving them
    // behind across a reseed strands them pointing at records that no longer exist.
    RecordView.deleteMany({}),
    Category.deleteMany({}),
    SubscriptionType.deleteMany({}),
    Pipeline.deleteMany({}),
    Order.deleteMany({}),
    Notification.deleteMany({}),
    AssignmentHistory.deleteMany({}),
    Permission.deleteMany({}),
    Counter.deleteMany({}),
    Account.deleteMany({}),
    ChartOfAccount.deleteMany({}),
    JournalEntry.deleteMany({}),
    Cheque.deleteMany({}),
    Expense.deleteMany({}),
    LedgerEntry.deleteMany({}),
    PayrollRun.deleteMany({}),
    PayrollLine.deleteMany({}),
    Product.deleteMany({}),
    LeaveType.deleteMany({}),
    Holiday.deleteMany({}),
    LeaveRequest.deleteMany({}),
    Attendance.deleteMany({}),
    ActivityLog.deleteMany({}),
  ]);

  console.log('Seeding subscription types + categories...');
  // Categories and subscription types are admin-managed records now (Products > Categories /
  // Subscription Types), not code constants - these are just the starting set the business
  // already uses, and can be added to/renamed in the UI from here on.
  const srTypeNames = ['NEW', 'MIG', 'MNP', 'FNP', 'ADD ON', 'P2P'];
  const srTypes = await SubscriptionType.insertMany(srTypeNames.map((name) => ({ name, active: true })));
  const srTypeByName = Object.fromEntries(srTypes.map((t) => [t.name, t._id]));

  // Which subscription types each category actually allows - the whole point of assigning them per
  // category. Number portability (MNP/FNP) only makes sense where there's a number to port, so it
  // isn't offered on DIGITAL or WIRELESS.
  const categoryDefs = [
    { name: 'DIGITAL', types: ['NEW', 'MIG', 'ADD ON'] },
    { name: 'FIXED', types: ['NEW', 'MIG', 'MNP', 'FNP', 'ADD ON', 'P2P'] },
    { name: 'GSM', types: ['NEW', 'MIG', 'MNP', 'FNP', 'ADD ON'] },
    { name: 'WIRELESS', types: ['NEW', 'MIG', 'ADD ON', 'P2P'] },
  ];
  const categories = await Category.insertMany(
    categoryDefs.map((c) => ({ name: c.name, subscriptionTypes: c.types.map((t) => srTypeByName[t]), active: true }))
  );
  const categoryByName = Object.fromEntries(categories.map((c) => [c.name, c]));
  const allowedTypesFor = (catName) => categoryDefs.find((c) => c.name === catName).types;

  console.log('Seeding permissions...');
  await Permission.create({
    _id: 'access',
    byRole: ACCESS_DEFAULT,
    editByRole: EDIT_ACCESS_DEFAULT,
    importExportByRole: IMPORT_EXPORT_DEFAULT,
    userOverrides: {},
  });

  console.log('Seeding users (top-down, so reportsTo always exists first)...');
  const admin = await createUser({ name: 'Admin', role: 'admin', desig: 'System Administrator', dept: 'Management', reportsTo: null, target: 0, salary: 0, join: '2025-01-01' });
  const amir = await createUser({ name: 'Amir Qadri', role: 'sales_head', desig: 'Sales Head', dept: 'e& Sales', reportsTo: null, target: 150000, salary: 20000, join: '2025-01-01' });
  const sana = await createUser({ name: 'Sana', role: 'teams_head', desig: 'Teams Head — Group 1', dept: 'e& Sales', reportsTo: amir._id, target: 75000, salary: 12000, join: '2025-02-01' });
  const joy = await createUser({ name: 'Joy', role: 'team_leader', desig: 'Team Leader — Team A', dept: 'e& Sales', reportsTo: sana._id, target: 25000, salary: 8000, join: '2025-06-01' });
  const maria = await createUser({ name: 'Maria', role: 'team_leader', desig: 'Team Leader — Team B', dept: 'e& Sales', reportsTo: sana._id, target: 30000, salary: 8500, join: '2025-03-01' });
  const rahul = await createUser({ name: 'Rahul', role: 'team_leader', desig: 'Team Leader — Team C', dept: 'e& Sales', reportsTo: sana._id, target: 20000, salary: 8000, join: '2026-01-20' });

  const hira = await createUser({ name: 'Hira', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: joy._id, target: 5000, salary: 4000, join: '2026-01-05' });
  const vani = await createUser({ name: 'Vani', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: joy._id, target: 5000, salary: 4000, join: '2026-01-15' });
  const naushad = await createUser({ name: 'Naushad', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: joy._id, target: 5000, salary: 4000, join: '2026-05-01' });
  const obina = await createUser({ name: 'Obina', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: joy._id, target: 5000, salary: 4000, join: '2026-02-01' });
  const ob = await createUser({ name: 'OB', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: maria._id, target: 7000, salary: 4500, join: '2025-11-10' });
  const samjith = await createUser({ name: 'Samjith', role: 'agent', desig: 'Sr. Sales Agent', dept: 'e& Sales', reportsTo: maria._id, target: 6000, salary: 5000, join: '2025-09-01' });
  const kiran = await createUser({ name: 'Kiran', role: 'agent', desig: 'Sales Agent', dept: 'e& Sales', reportsTo: rahul._id, target: 5000, salary: 4000, join: '2026-02-01' });

  await createUser({ name: 'Ansari', role: 'backoffice', desig: 'Back Office Executive', dept: 'Operations', reportsTo: amir._id, target: 0, salary: 5500, join: '2025-08-01' });
  await createUser({ name: 'ABC', role: 'accountant', desig: 'Accountant', dept: 'Finance', reportsTo: admin._id, target: 0, salary: 9000, join: '2025-05-01' });
  await createUser({ name: 'Fatima', role: 'hr', desig: 'HR Officer', dept: 'HR', reportsTo: admin._id, target: 0, salary: 8500, join: '2025-04-01' });

  console.log('Seeding DSR calling logs...');
  const agents = [hira, vani, ob, samjith, kiran, naushad, obina];
  const companies = ['PURE EARTH EQUIPMENT', 'LUTECH COMPOSITES', 'AL SAMIAH CARPETS', 'DARK REAL ESTATE', 'TRUSV AIR DUCT', 'PACKNEXA INDUSTRIES', 'MEAMAR BUILDING', 'SUNLUX ELECTROMECH', 'TECTONIC ELECTROMECH', 'SKY & SEA INTL', 'BRAVA TECHNO', 'LIVENDO PROPERTIES'];
  const remarksPool = ['Using etisalat already', 'He is busy, call later', 'Interested in 3 SIM cards', 'Wants data plan 30GB', 'Voicemail left', 'Asked to send proposal', 'Number not in use', 'Already with DU wireless'];
  const customers = ['Mr Ali', 'Anjlika', 'Usman', 'Eylan', 'Neha', 'Akbar'];

  const leadGeneratedDsrs = [];
  const total = 300;
  for (let i = 0; i < total; i += 1) {
    const agent = agents[i % agents.length];
    const status = CALL_STATUS[i % CALL_STATUS.length];
    const d = new Date(2026, 3 + (i % 4), 1 + (i % 27));
    const chain = agent.managerChain;
    const seq = await nextSeq('dsr');
    const dsrNo = 'DSR-' + String(seq).padStart(5, '0');
    const dsr = await Dsr.create({
      dsrNo,
      date: d.toISOString().slice(0, 10),
      agentId: agent._id,
      tlId: chain[0] || null,
      teamHeadId: chain[1] || null,
      salesHeadId: chain[2] || null,
      company: `${companies[i % companies.length]} ${i + 1}`,
      building: ['Abdul Razaq Ali', 'Bin Dasmal', 'Microbuilt', 'Advance Tech'][i % 4],
      contactNo: '9715' + String(20000000 + i * 131),
      customer: customers[i % customers.length],
      status,
      remarks: remarksPool[i % remarksPool.length],
      connected: ['No answer', 'Voicemail', 'Number not in use'].includes(status) ? 'NO' : 'YES',
      history: [{ userId: agent._id, text: `DSR created · status set to ${status}` }],
    });
    if (status === 'Lead Generated') leadGeneratedDsrs.push(dsr);
  }

  console.log(`Seeding pipeline from ${leadGeneratedDsrs.length} lead-generated DSRs...`);
  // Titles/categories here match real entries in the product catalog seeded further below, so a
  // seeded deal's Product/Category Selects resolve against the catalog rather than relying on the
  // stale-value fallback.
  const products = [
    { cat: 'FIXED', product: 'Business Pro New', price: 400 },
    { cat: 'GSM', product: 'ATL Plans', price: 125 },
    { cat: 'DIGITAL', product: 'Cloud', price: 900 },
  ];
  // Deal detail fields beyond the line items are all mandatory to save a Pipeline record (see
  // pipelineController.updateSchema) - fill them in here so seeded deals are immediately eligible
  // for the escalate/approve calls below, matching what a real agent would have to do on the deal
  // panel before requesting Team Leader approval. Every seeded deal gets a single line-item block
  // with one price/qty row; multi-block deals are a UI-built thing, not worth seeding.
  const pipelines = [];
  for (let i = 0; i < leadGeneratedDsrs.length; i += 1) {
    const dsr = leadGeneratedDsrs[i];
    const agent = agents.find((a) => String(a._id) === String(dsr.agentId));
    const pr = products[i % products.length];
    const pipeline = await convertToPipeline(
      dsr._id,
      {
        lineItems: [
          // Pick a subscription type the deal's own category actually allows - cycling the full
          // list blindly would seed impossible combinations (a DIGITAL deal sold as MNP), which
          // the catalog rules would never let anyone create through the UI.
          { cat: pr.cat, product: pr.product, sr: allowedTypesFor(pr.cat)[i % allowedTypesFor(pr.cat).length], rows: [{ price: pr.price, qty: 1 + (i % 4) }] },
        ],
        email: `${agent.username}@example.com`,
        remarks: 'Seed demo deal',
      },
      agent
    );
    await Pipeline.updateOne({ _id: pipeline._id }, { expectedCloseDate: '2026-08-15' });
    pipelines.push(pipeline);
  }

  console.log('Moving pipeline deals through stage/approval so the demo shows a realistic spread...');
  const tlByName = { Hira: joy, Vani: joy, Naushad: joy, Obina: joy, OB: maria, Samjith: maria, Kiran: rahul };
  const midStages = PIPE_STAGES.filter((s) => !s.startsWith('0%') && !s.startsWith('100%'));
  let orderCount = 0;
  for (let i = 0; i < pipelines.length; i += 1) {
    const pipeline = pipelines[i];
    const agent = agents.find((a) => String(a._id) === String(pipeline.agentId));
    const tl = tlByName[agent.name];
    if (i % 3 === 0) {
      // TL-approved -> order opened, deal well along (90% Closing).
      await Pipeline.updateOne({ _id: pipeline._id }, { stage: '90% - Closing' });
      await escalateToTL(pipeline._id, agent);
      await tlApprove(pipeline._id, tl);
      orderCount += 1;
    } else if (i % 3 === 1) {
      // Sitting in the TL's approval queue.
      await escalateToTL(pipeline._id, agent);
      await Pipeline.updateOne({ _id: pipeline._id }, { stage: midStages[i % midStages.length] });
    } else {
      // Still being worked, no approval requested yet.
      await Pipeline.updateOne({ _id: pipeline._id }, { stage: midStages[i % midStages.length] });
    }
  }

  console.log('Activating half the orders with commission (for payroll commission demo)...');
  const allOrders = await Order.find().select('_id mrc');
  for (let i = 0; i < allOrders.length; i += 1) {
    if (i % 2 !== 0) continue;
    await Order.updateOne(
      { _id: allOrders[i]._id },
      { status: 'Activated', actDate: '2026-06-15', commission: Math.round(allOrders[i].mrc * 0.15) }
    );
  }

  console.log('Seeding chart of accounts...');
  await seedChartOfAccounts();
  const bank = await Account.create({ name: 'Main Bank Account - ADCB', type: 'Bank', opening: 50000, createdBy: admin._id });
  const cash = await Account.create({ name: 'Petty Cash', type: 'Cash', opening: 5000, createdBy: admin._id });
  // Creates the linked Cash & Bank leaf + posts each account's opening-balance entry —
  // same call accountingController.createAccount makes for a real request.
  const bankCoa = await ensureLinkedAccount(bank, admin);
  await ensureLinkedAccount(cash, admin);

  console.log('Seeding sample expenses (each debits one account)...');
  const rentExpense = await Expense.create({
    category: 'Rent', amount: 18000, date: '2026-06-05', account: bank._id,
    note: 'Office Rent - Business Bay', createdBy: admin._id,
  });
  const rentCoa = await requireCoaByCode(EXPENSE_CATEGORY_TO_CODE.Rent);
  await postJournalEntry({
    date: '2026-06-05', memo: 'Rent - Office Rent - Business Bay', refType: 'Expense', refId: rentExpense._id,
    lines: [{ account: rentCoa._id, debit: 18000, credit: 0 }, { account: bankCoa._id, debit: 0, credit: 18000 }],
    actor: admin,
  });

  const utilExpense = await Expense.create({
    category: 'Utilities', amount: 3200, date: '2026-06-10', account: bank._id,
    note: 'Telecom & Internet', createdBy: admin._id,
  });
  const utilCoa = await requireCoaByCode(EXPENSE_CATEGORY_TO_CODE.Utilities);
  await postJournalEntry({
    date: '2026-06-10', memo: 'Utilities - Telecom & Internet', refType: 'Expense', refId: utilExpense._id,
    lines: [{ account: utilCoa._id, debit: 3200, credit: 0 }, { account: bankCoa._id, debit: 0, credit: 3200 }],
    actor: admin,
  });

  console.log('Seeding employee ledger (advance) ahead of the payroll run...');
  await LedgerEntry.create({
    employee: vani._id, date: '2026-06-01', type: 'Advance', amount: 3000,
    remaining: 3000, status: 'Open', note: 'Advance for personal emergency', createdBy: admin._id,
  });

  console.log('Processing June 2026 payroll run (debits Main Bank Account)...');
  await processPayrollRun('2026-06', bank._id, admin._id);

  console.log('Seeding cheques (PDC)...');
  const arCoa = await requireCoaByCode(CODES.ACCOUNTS_RECEIVABLE);
  const apCoa = await requireCoaByCode(CODES.ACCOUNTS_PAYABLE);
  await Cheque.create({ no: '000123', date: '2026-06-01', dueDate: '2026-07-15', direction: 'Received', party: 'Livendo Properties', amount: 12000, account: bank._id, contraAccount: arCoa._id, status: 'Pending', note: 'Advance payment for annual contract', createdBy: admin._id });
  await Cheque.create({ no: '000456', date: '2026-06-05', dueDate: '2026-07-01', direction: 'Issued', party: 'Business Bay Landlord', amount: 18000, account: bank._id, contraAccount: apCoa._id, status: 'Deposited', note: 'July office rent', createdBy: admin._id });
  const clearedCheque = await Cheque.create({ no: '000789', date: '2026-05-01', dueDate: '2026-06-01', direction: 'Received', party: 'Sky & Sea Intl', amount: 9500, account: bank._id, contraAccount: arCoa._id, status: 'Cleared', note: 'Order settlement', createdBy: admin._id });
  await postJournalEntry({
    date: '2026-06-01', memo: `Cheque ${clearedCheque.no} (${clearedCheque.party}) cleared`, refType: 'Cheque', refId: clearedCheque._id,
    lines: [{ account: bankCoa._id, debit: 9500, credit: 0 }, { account: arCoa._id, debit: 0, credit: 9500 }],
    actor: admin,
  });
  await Cheque.create({ no: '000321', date: '2026-05-10', dueDate: '2026-06-10', direction: 'Issued', party: 'IT Vendor - Laptops', amount: 7200, account: cash._id, contraAccount: apCoa._id, status: 'Bounced', note: 'Insufficient funds - follow up required', createdBy: admin._id });

  console.log('Seeding a sample manual journal entry (Etisalat commission revenue, recorded by hand)...');
  const commissionRevenueCoa = await requireCoaByCode('4100');
  await postJournalEntry({
    date: '2026-06-20',
    memo: 'e& commission — June activations',
    refType: 'Manual',
    refId: null,
    lines: [{ account: arCoa._id, debit: 4200, credit: 0 }, { account: commissionRevenueCoa._id, debit: 0, credit: 4200 }],
    actor: admin,
  });

  console.log('Seeding product catalog...');
  const catalog = [
    { cat: 'FIXED', title: 'Business Pro New', base: 400 },
    { cat: 'FIXED', title: 'Business Pro Mig', base: 380 },
    { cat: 'FIXED', title: 'Business On New', base: 300 },
    { cat: 'FIXED', title: 'Business On Mig', base: 285 },
    { cat: 'FIXED', title: 'SOHO', base: 150 },
    { cat: 'FIXED', title: 'BQS', base: 220 },
    { cat: 'FIXED', title: 'Office Presence', base: 180 },
    { cat: 'FIXED', title: 'Dell / PABX', base: 950 },
    { cat: 'FIXED', title: 'Toll Free', base: 500 },
    { cat: 'FIXED', title: 'Digital Internet', base: 600 },
    { cat: 'FIXED', title: 'Digital Premium Internet', base: 1200 },
    { cat: 'FIXED', title: 'SIP Trunk', base: 450 },
    { cat: 'FIXED', title: 'PRI', base: 800 },
    { cat: 'FIXED', title: 'SD WAN', base: 1500 },
    { cat: 'FIXED', title: 'Business TV', base: 250 },
    { cat: 'FIXED', title: 'Business Flat Plus', base: 350 },
    { cat: 'FIXED', title: 'Business Super', base: 700 },
    { cat: 'FIXED', title: 'Add Lines', base: 90 },
    { cat: 'FIXED', title: 'Global MPLS', base: 2500 },
    { cat: 'GSM', title: 'ATL Plans', base: 125 },
    { cat: 'GSM', title: 'BTL Plans', base: 175 },
    { cat: 'GSM', title: 'Data Sims', base: 100 },
    { cat: 'WIRELESS', title: 'Wireless Broadband', base: 300 },
    { cat: 'WIRELESS', title: 'Fixed Wireless Access', base: 450 },
    { cat: 'DIGITAL', title: 'UTAP', base: 200 },
    { cat: 'DIGITAL', title: 'Office 365', base: 120 },
    { cat: 'DIGITAL', title: 'Online Marketing', base: 500 },
    { cat: 'DIGITAL', title: 'VSAAS', base: 350 },
    { cat: 'DIGITAL', title: 'DGTX', base: 400 },
    { cat: 'DIGITAL', title: 'M2M', base: 80 },
    { cat: 'DIGITAL', title: 'SVT', base: 260 },
    { cat: 'DIGITAL', title: 'APP 360', base: 600 },
    { cat: 'DIGITAL', title: 'Social eCommerce', base: 450 },
    { cat: 'DIGITAL', title: 'Cloud', base: 900 },
    { cat: 'DIGITAL', title: 'SMS', base: 60 },
  ];
  // Price presets per subscription type - what the Unit Price prefills to when that
  // Product + Subscription Type combination is picked on a deal (always still editable). Seeded
  // off each product's base price so the prefill is demonstrable end-to-end; real values are
  // maintained by admin in Products > Pricing.
  const PRESET_MULTIPLIER = { NEW: 1, MIG: 0.95, MNP: 0.9, FNP: 0.9, 'ADD ON': 0.5, P2P: 0.75 };
  await Product.insertMany(
    catalog.map((p) => {
      // Each product offers everything its category allows, and is priced for exactly those - a
      // product can be narrowed further in the UI, but seeding the full set is the useful default.
      const category = categoryByName[p.cat];
      const offered = categoryDefs.find((c) => c.name === p.cat).types;
      return {
        title: p.title,
        category: category._id,
        subscriptionTypes: offered.map((t) => srTypeByName[t]),
        pricing: offered.map((t) => ({ subscriptionType: srTypeByName[t], defaultPrice: Math.round(p.base * PRESET_MULTIPLIER[t]) })),
        active: true,
      };
    })
  );

  console.log('Seeding leave types...');
  const leaveTypes = await LeaveType.insertMany([
    { name: 'Annual Leave', annualDays: 30, accrualMethod: 'monthly', minServiceMonths: 6, paid: true, requiresDocument: false, isSystem: true, createdBy: admin._id },
    { name: 'Sick Leave', annualDays: 90, accrualMethod: 'lump-sum', minServiceMonths: 0, paid: true, requiresDocument: true, isSystem: true, createdBy: admin._id },
    { name: 'Emergency Leave', annualDays: 5, accrualMethod: 'lump-sum', minServiceMonths: 0, paid: true, requiresDocument: false, isSystem: true, createdBy: admin._id },
    { name: 'Unpaid Leave', annualDays: 365, accrualMethod: 'lump-sum', minServiceMonths: 0, paid: false, requiresDocument: false, isSystem: true, createdBy: admin._id },
  ]);
  const annualLeave = leaveTypes.find((t) => t.name === 'Annual Leave');
  const sickLeave = leaveTypes.find((t) => t.name === 'Sick Leave');

  console.log('Seeding 2026 UAE public holidays...');
  await Holiday.insertMany([
    { name: "New Year's Day", date: '2026-01-01', createdBy: admin._id },
    { name: 'Eid al-Fitr (est.)', date: '2026-03-20', createdBy: admin._id },
    { name: 'Eid al-Fitr Holiday', date: '2026-03-21', createdBy: admin._id },
    { name: 'Arafat Day (est.)', date: '2026-05-26', createdBy: admin._id },
    { name: 'Eid al-Adha (est.)', date: '2026-05-27', createdBy: admin._id },
    { name: 'Islamic New Year (est.)', date: '2026-06-16', createdBy: admin._id },
    { name: 'Commemoration Day', date: '2026-12-01', createdBy: admin._id },
    { name: 'UAE National Day', date: '2026-12-02', createdBy: admin._id },
    { name: 'UAE National Day Holiday', date: '2026-12-03', createdBy: admin._id },
  ]);

  console.log('Seeding sample leave requests...');
  // Samjith joined 2025-09-01 — well past the 6-month Annual Leave threshold by demo "today".
  const approvedReq = await createLeaveRequest(
    samjith._id,
    { leaveTypeId: annualLeave._id, startDate: '2026-06-08', endDate: '2026-06-10', reason: 'Family trip' },
    admin
  );
  await approveLeaveRequest(approvedReq._id, sana);

  // OB joined 2025-11-10 — also past the threshold; left pending so the Approvals queue demo has
  // something in it, and Sick Leave (no minServiceMonths gate) shows immediate eligibility.
  await createLeaveRequest(
    ob._id,
    { leaveTypeId: sickLeave._id, startDate: '2026-07-20', endDate: '2026-07-21', reason: 'Doctor follow-up', document: '' },
    ob
  );

  console.log(`Seed complete: ${agents.length + 6 + 3} users, ${total} DSR records, ${pipelines.length} pipeline deals, ${orderCount} orders, ${catalog.length} products.`);
  console.log('\nDemo logins (password = username@2026):');
  console.log('  admin / admin@2026');
  console.log('  amirqadri / amirqadri@2026 (Sales Head)');
  console.log('  sana / sana@2026 (Teams Head)');
  console.log('  joy / joy@2026 (Team Leader)');
  console.log('  hira / hira@2026, vani / vani@2026 (Agents under Joy)');
  console.log('  ansari / ansari@2026 (Back Office)');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
