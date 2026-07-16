const User = require('../models/User');
const Order = require('../models/Order');
const LedgerEntry = require('../models/LedgerEntry');
const PayrollRun = require('../models/PayrollRun');
const PayrollLine = require('../models/PayrollLine');
const CommissionTier = require('../models/CommissionTier');
const Expense = require('../models/Expense');
const Account = require('../models/Account');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const { postJournalEntry, requireCoaByCode, CODES } = require('./journal');
const AppError = require('../utils/AppError');

// Same "achievement %" concept as MIS (server/controllers/misController.js's buildRollup), but
// role-aware so a Team Leader/Teams Head/Sales Head can also be put on commission against their
// team's performance, not just individual agents:
//   - agent: "achieved" is their own Activated-order MRC for the month.
//   - any manager role: "achieved" is the SUM of Activated-order MRC across every agent in their
//     reporting subtree (managerChain) - the same scope misController's agentsInScope resolves.
// Either way, "target" is always the employee's own User.target field (never derived by summing
// subordinates - HR sets that number directly on every sales-role profile, manager or not). A
// role that never appears in any agent's managerChain (admin/backoffice/accountant/hr) safely
// resolves to an empty scope, not an error.
async function computeAgentAchievement(employee, month) {
  const scopeIds =
    employee.role === 'agent'
      ? [employee._id]
      : (await User.find({ role: 'agent', active: true, managerChain: employee._id }).select('_id').lean()).map((a) => a._id);

  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  const agg = scopeIds.length
    ? await Order.aggregate([
        {
          $match: {
            agentId: { $in: scopeIds },
            status: 'Activated',
            actDate: { $gte: start.toISOString().slice(0, 10), $lt: end.toISOString().slice(0, 10) },
          },
        },
        { $group: { _id: null, mrc: { $sum: '$mrc' } } },
      ])
    : [];
  const achieved = agg[0]?.mrc || 0;
  const target = employee.target || 0;
  const achievementPct = target ? Math.round((achieved / target) * 100) : achieved > 0 ? 100 : 0;
  return { achieved, achievementPct };
}

// First tier whose [minPct, maxPct) bracket contains the achievement % - maxPct is exclusive so
// adjacent tiers can share a boundary (e.g. "100-125" then "125+") without gap or overlap, which
// is how HR naturally types ranges. null maxPct means no upper bound. Falling below every tier's
// minPct (or no tiers configured at all) means 0% commission, not an error.
function resolveTier(tiers, achievementPct) {
  return tiers.find((t) => achievementPct >= t.minPct && (t.maxPct == null || achievementPct < t.maxPct)) || null;
}

// Pure computation, no writes - used for both the preview endpoint and as the first
// step of processing a run. Basic/allowance split and gratuity accrual formula match
// the original prototype (simplified estimates, not a certified UAE gratuity calculation).
async function computePayrollLines(month, skipEmployeeIds = []) {
  const candidates = await User.find({ active: true, _id: { $nin: skipEmployeeIds } }).lean();
  // Pure-salary employees only get paid if HR actually gave them a salary figure (unchanged
  // behavior); commission-only employees are always eligible regardless of their unused salary
  // field. salary_commission employees need a salary figure too, same as pure-salary.
  const employees = candidates.filter((e) => e.payType === 'commission' || (e.salary || 0) > 0);

  const lines = [];
  for (const emp of employees) {
    const payType = emp.payType || 'salary';

    let basic = 0;
    let allowance = 0;
    if (payType !== 'commission' && emp.salary > 0) {
      basic = Math.round(emp.salary * 0.6);
      allowance = emp.salary - basic;
    }

    let commission = 0;
    let commissionBreakdown = { achievedMrc: 0, target: emp.target || 0, achievementPct: 0, tierMinPct: null, tierMaxPct: null, tierRate: null };
    if (payType !== 'salary') {
      const { achieved, achievementPct } = await computeAgentAchievement(emp, month);
      // Each employee has their own independent tier set, not a shared global table.
      const tiers = await CommissionTier.find({ employee: emp._id }).sort({ minPct: 1 }).lean();
      const tier = resolveTier(tiers, achievementPct);
      commission = tier ? Math.round((achieved * tier.rate) / 100) : 0;
      commissionBreakdown = {
        achievedMrc: achieved,
        target: emp.target || 0,
        achievementPct,
        tierMinPct: tier?.minPct ?? null,
        tierMaxPct: tier?.maxPct ?? null,
        tierRate: tier?.rate ?? null,
      };
    }

    const openLedger = await LedgerEntry.find({
      employee: emp._id,
      type: { $in: ['Advance', 'Loan', 'Deduction'] },
      status: 'Open',
    }).lean();
    let deductions = 0;
    const ledgerLines = [];
    for (const entry of openLedger) {
      const amount = entry.remaining;
      if (amount <= 0) continue;
      deductions += amount;
      // Carried through to the run's journal posting: only an advance that was itself posted to
      // Accounts (postToAccounts) has a receivable on the books to relieve when it's recovered
      // here — an off-books advance never debited Employee Advances Receivable in the first
      // place, so settling it can't credit that account either (see processPayrollRun).
      ledgerLines.push({ entryId: entry._id, amount, postToAccounts: entry.postToAccounts });
    }

    const gratuityAccrual = Math.round((basic / 30) * 21 / 12);
    const netPay = basic + allowance + commission - deductions;

    lines.push({
      employee: { _id: emp._id, name: emp.name, employeeId: emp.employeeId, desig: emp.desig },
      basic,
      allowance,
      commission,
      deductions,
      netPay,
      gratuityAccrual,
      payType,
      commissionBreakdown,
      ledgerLines,
    });
  }

  const totals = lines.reduce(
    (acc, l) => ({
      totalBasic: acc.totalBasic + l.basic,
      totalAllowance: acc.totalAllowance + l.allowance,
      totalCommission: acc.totalCommission + l.commission,
      totalDeductions: acc.totalDeductions + l.deductions,
      totalNet: acc.totalNet + l.netPay,
      totalGratuityAccrual: acc.totalGratuityAccrual + l.gratuityAccrual,
    }),
    { totalBasic: 0, totalAllowance: 0, totalCommission: 0, totalDeductions: 0, totalNet: 0, totalGratuityAccrual: 0 }
  );

  return { lines, totals };
}

// Commits a run: creates PayrollRun + PayrollLines, settles ledger deductions, and posts
// ONE Expense (category Salaries) debiting the chosen account - same "every expense
// including salaries comes from one account" rule the Accounting module already enforces.
async function processPayrollRun(month, accountId, userId, skipEmployeeIds = []) {
  if (!(await Account.exists({ _id: accountId }))) throw new AppError('Account not found', 404);

  const { lines, totals } = await computePayrollLines(month, skipEmployeeIds);
  if (!lines.length) throw new AppError('No active salaried employees to pay', 400);

  // Atomically claim this month BEFORE any side-effecting writes — the unique index on `month`
  // means only one concurrent request can create this doc, so a race can never produce
  // duplicate Expense/JournalEntry/PayrollLine rows for the same month.
  let run;
  try {
    run = await PayrollRun.create({ month, account: accountId, expense: null, ...totals, processedBy: userId, skippedEmployees: skipEmployeeIds });
  } catch (err) {
    if (err.code === 11000) throw new AppError(`Payroll for ${month} has already been processed`, 409);
    throw err;
  }

  try {
    const expense = await Expense.create({
      category: 'Salaries',
      amount: totals.totalNet,
      date: new Date().toISOString().slice(0, 10),
      account: accountId,
      note: `Payroll run - ${month}`,
      breakdown: lines.map((l) => ({ employee: l.employee._id, amount: l.netPay, note: `${month} salary` })),
      createdBy: userId,
    });

    const bankCoa = await ChartOfAccount.findOne({ linkedAccount: accountId }).lean();
    if (!bankCoa) throw new AppError('This account has no ledger entry — re-create it', 500);
    const [salariesCoa, commissionCoa, advancesCoa] = await Promise.all([
      requireCoaByCode(CODES.SALARIES_EXPENSE),
      requireCoaByCode(CODES.COMMISSION_EXPENSE),
      requireCoaByCode(CODES.EMPLOYEE_ADVANCES_RECEIVABLE),
    ]);
    const grossSalary = totals.totalBasic + totals.totalAllowance;

    // Only a deduction that itself posted to Accounts when the advance/loan was given has a real
    // Employee Advances Receivable balance to relieve here. An off-books advance (postToAccounts
    // false) never debited that account, so recovering it can't credit it either — that portion
    // instead just reduces the salary/commission expense actually incurred this run.
    let postedDeductions = 0;
    let unpostedDeductions = 0;
    for (const l of lines) {
      for (const ll of l.ledgerLines) {
        if (ll.postToAccounts) postedDeductions += ll.amount;
        else unpostedDeductions += ll.amount;
      }
    }
    let unpostedRemaining = unpostedDeductions;
    const salariesReduction = Math.min(unpostedRemaining, grossSalary);
    unpostedRemaining -= salariesReduction;
    const commissionReduction = Math.min(unpostedRemaining, totals.totalCommission);
    unpostedRemaining -= commissionReduction;
    if (unpostedRemaining > 0.01) {
      throw new AppError(`Off-books deductions (AED ${unpostedDeductions}) exceed this run's total salary + commission — cannot post a balanced journal entry`, 400);
    }
    const salariesDebit = grossSalary - salariesReduction;
    const commissionDebit = totals.totalCommission - commissionReduction;

    // One multi-line entry: gross salary + commission are the real cost, deductions recover part
    // of it from what employees already owed (not a reduction of the expense itself), and the
    // rest goes out in cash.
    const postingLines = [
      salariesDebit > 0 && { account: salariesCoa._id, debit: salariesDebit, credit: 0, note: `${month} salary` },
      commissionDebit > 0 && { account: commissionCoa._id, debit: commissionDebit, credit: 0, note: `${month} commission` },
      postedDeductions > 0 && { account: advancesCoa._id, debit: 0, credit: postedDeductions, note: `${month} advance/loan recovery` },
      totals.totalNet > 0 && { account: bankCoa._id, debit: 0, credit: totals.totalNet, note: `${month} net pay` },
    ].filter(Boolean);

    const entry = await postJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      memo: `Payroll run - ${month}`,
      refType: 'Payroll',
      refId: expense._id,
      lines: postingLines,
      actor: { _id: userId },
    });
    run.expense = expense._id;
    run.journalEntry = entry._id;
    await run.save();

    for (const l of lines) {
      const settledEntryIds = [];
      for (const ledgerLine of l.ledgerLines) {
        const entry = await LedgerEntry.findById(ledgerLine.entryId);
        if (!entry) continue;
        entry.remaining -= ledgerLine.amount;
        if (entry.remaining <= 0) {
          entry.remaining = 0;
          entry.status = 'Settled';
        }
        await entry.save();

        const deduction = await LedgerEntry.create({
          employee: l.employee._id,
          date: new Date().toISOString().slice(0, 10),
          type: 'Deduction',
          amount: ledgerLine.amount,
          status: 'Settled',
          note: `Payroll deduction - ${month}`,
          createdBy: userId,
          parent: entry._id,
          payrollRun: run._id,
        });
        settledEntryIds.push(deduction._id);
      }

      // The employee's own record that this run actually paid them - without this, "all
      // salaries" never show up anywhere in the ledger, only the advances/deductions against it.
      await LedgerEntry.create({
        employee: l.employee._id,
        date: new Date().toISOString().slice(0, 10),
        type: 'Salary',
        amount: l.netPay,
        remaining: 0,
        status: 'Settled',
        note: `${month} salary payout`,
        createdBy: userId,
        payrollRun: run._id,
      });

      await PayrollLine.create({
        payrollRun: run._id,
        employee: l.employee._id,
        basic: l.basic,
        allowance: l.allowance,
        commission: l.commission,
        deductions: l.deductions,
        netPay: l.netPay,
        gratuityAccrual: l.gratuityAccrual,
        payType: l.payType,
        commissionBreakdown: l.commissionBreakdown,
        ledgerEntries: settledEntryIds,
      });
    }

    return run;
  } catch (err) {
    // Something failed after the claim — release the month rather than leaving it permanently
    // locked by a run stuck in a half-finished state.
    await PayrollRun.deleteOne({ _id: run._id });
    throw err;
  }
}

// Fully undoes a processed run: restores every ledger entry it settled, deletes both the
// auto-created Deduction rows AND the Salary payout row it recorded (everything tagged with
// this run's id), deletes the Expense + the JournalEntry it posted (so every account balance
// goes back to what it was before), then deletes the run's lines and the run itself. Nothing is
// "reversed with an offsetting entry" here — the user asked to delete a mistaken run outright.
async function deletePayrollRun(runId) {
  const run = await PayrollRun.findById(runId);
  if (!run) throw new AppError('Payroll run not found', 404);

  const runLedgerEntries = await LedgerEntry.find({ payrollRun: run._id });
  for (const entry of runLedgerEntries) {
    if (entry.type !== 'Deduction' || !entry.parent) continue;
    const original = await LedgerEntry.findById(entry.parent);
    if (original) {
      original.remaining += entry.amount;
      original.status = 'Open';
      await original.save();
    }
  }
  await LedgerEntry.deleteMany({ payrollRun: run._id });
  await PayrollLine.deleteMany({ payrollRun: run._id });

  if (run.journalEntry) await JournalEntry.deleteOne({ _id: run.journalEntry });
  if (run.expense) await Expense.deleteOne({ _id: run.expense });

  await PayrollRun.deleteOne({ _id: run._id });
  return { month: run.month };
}

module.exports = { computePayrollLines, processPayrollRun, deletePayrollRun };
