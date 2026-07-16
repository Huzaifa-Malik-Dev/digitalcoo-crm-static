const { z } = require('zod');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { postJournalEntry, reverseJournalEntry, coaBalance } = require('../services/journal');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');
const { regexOr, numericRegexOr } = require('../utils/search');

const COA_FIELD_LABELS = { name: 'Name', active: 'Active' };

// First day of `month` (YYYY-MM) and first day of the following month — an exclusive upper
// bound, since every date in this app is a plain 'YYYY-MM-DD' string and those sort correctly
// with plain lexicographic comparison.
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, end };
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ---- Chart of Accounts ----

async function listChartOfAccounts(req, res, next) {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.postable !== undefined) filter.postable = req.query.postable === 'true';
    const accounts = await ChartOfAccount.find(filter).sort({ code: 1 }).lean();
    const withBalance = await Promise.all(accounts.map(async (a) => ({ ...a, balance: a.postable ? await coaBalance(a._id) : null })));
    res.json({ data: withBalance });
  } catch (err) {
    next(err);
  }
}

const coaCreateSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.enum(['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']),
  parent: z.string().min(1).optional(),
});

async function createChartOfAccount(req, res, next) {
  try {
    const parsed = coaCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    if (await ChartOfAccount.exists({ code: parsed.data.code })) throw new AppError('An account with this code already exists', 400);
    if (parsed.data.parent && !(await ChartOfAccount.exists({ _id: parsed.data.parent }))) throw new AppError('Parent account not found', 404);
    const account = await ChartOfAccount.create({ ...parsed.data, isSystem: false, createdBy: req.user._id });
    logActivity(req.user, `created Chart of Accounts entry "${account.code} ${account.name}" (${account.type})`);
    res.status(201).json({ data: account });
  } catch (err) {
    next(err);
  }
}

const coaUpdateSchema = z.object({ name: z.string().trim().min(1).optional(), active: z.boolean().optional() });

async function updateChartOfAccount(req, res, next) {
  try {
    const parsed = coaUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const before = await ChartOfAccount.findById(req.params.id).lean();
    if (!before) throw new AppError('Account not found', 404);
    if (before.isSystem && parsed.data.active === false) throw new AppError('System accounts cannot be deactivated', 400);
    const account = await ChartOfAccount.findByIdAndUpdate(req.params.id, parsed.data, { new: true });

    const changes = diffFields(before, account.toObject(), COA_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited Chart of Accounts entry "${account.code} ${account.name}": ${changes.join(', ')}`);
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
}

// ---- Journal Entries ----

async function listJournalEntries(req, res, next) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (req.query.year && req.query.month && req.query.day) {
      const day = `${req.query.year}-${req.query.month}-${req.query.day}`;
      filter.date = day;
    } else if (req.query.year && req.query.month) {
      const { start, end } = monthRange(`${req.query.year}-${req.query.month}`);
      filter.date = { $gte: start, $lt: end };
    } else if (req.query.year) {
      filter.date = { $gte: `${req.query.year}-01-01`, $lt: `${Number(req.query.year) + 1}-01-01` };
    }
    if (req.query.refType) filter.refType = req.query.refType;
    if (req.query.account) filter['lines.account'] = req.query.account;
    if (req.query.search) {
      const term = req.query.search.trim();
      filter.$or = [...regexOr(term, ['entryNo', 'memo', 'refType']), ...numericRegexOr(term, ['totalDebit', 'totalCredit'])];
    }
    const [data, totalRowCount] = await Promise.all([
      JournalEntry.find(filter).populate('lines.account', 'code name').sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      JournalEntry.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function getJournalEntry(req, res, next) {
  try {
    const entry = await JournalEntry.findById(req.params.id)
      .populate('lines.account', 'code name type')
      .populate('postedBy', 'name employeeId')
      .populate('reversalOf', 'entryNo')
      .populate('reversedBy', 'entryNo')
      .lean();
    if (!entry) throw new AppError('Journal entry not found', 404);
    res.json({ data: entry });
  } catch (err) {
    next(err);
  }
}

const lineSchema = z.object({ account: z.string().min(1), debit: z.number().min(0).optional().default(0), credit: z.number().min(0).optional().default(0), note: z.string().optional().default('') });
const manualEntrySchema = z.object({
  date: z.string().min(1),
  memo: z.string().trim().min(1),
  lines: z.array(lineSchema).min(2),
});

async function createManualJournalEntry(req, res, next) {
  try {
    const parsed = manualEntrySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const entry = await postJournalEntry({ ...parsed.data, refType: 'Manual', refId: null, actor: req.user });
    logActivity(req.user, `posted manual journal entry ${entry.entryNo} — ${parsed.data.memo} (AED ${entry.totalDebit})`);
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
}

async function reverseJournalEntryHandler(req, res, next) {
  try {
    if (req.user.role !== 'admin') throw new AppError('Only an administrator can reverse a journal entry', 403);
    const original = await JournalEntry.findById(req.params.id).lean();
    if (!original) throw new AppError('Journal entry not found', 404);
    const reversal = await reverseJournalEntry(req.params.id, req.user, req.body?.memo);
    logActivity(req.user, `reversed journal entry ${original.entryNo} with ${reversal.entryNo}`);
    res.status(201).json({ data: reversal });
  } catch (err) {
    next(err);
  }
}

// ---- General Ledger ----

async function generalLedger(req, res, next) {
  try {
    const coa = await ChartOfAccount.findById(req.params.coaId).lean();
    if (!coa) throw new AppError('Account not found', 404);

    const filter = { 'lines.account': coa._id };
    let openingBalance = 0;
    if (req.params.year && req.params.month) {
      const { start, end } = monthRange(`${req.params.year}-${req.params.month}`);
      // asOf is inclusive in coaBalance, so use the day before `start` to get the balance as of
      // just before the period begins, excluding entries dated on the period's first day.
      const dayBefore = new Date(new Date(start).getTime() - 1).toISOString().slice(0, 10);
      openingBalance = await coaBalance(coa._id, { asOf: dayBefore });
      filter.date = { $gte: start, $lt: end };
    }

    const entries = await JournalEntry.find(filter).sort({ date: 1, createdAt: 1 }).lean();
    let running = openingBalance;
    const rows = entries.map((e) => {
      const line = e.lines.find((l) => String(l.account) === String(coa._id));
      const signed = coa.normalBalance === 'debit' ? line.debit - line.credit : line.credit - line.debit;
      running += signed;
      return { _id: e._id, entryNo: e.entryNo, date: e.date, memo: e.memo, refType: e.refType, debit: line.debit, credit: line.credit, runningBalance: running };
    });

    res.json({ data: { account: coa, openingBalance, rows, closingBalance: running } });
  } catch (err) {
    next(err);
  }
}

// ---- Reports ----

async function trialBalance(req, res, next) {
  try {
    const month = req.params.month || currentMonth();
    const { end } = monthRange(month);
    const asOf = new Date(new Date(end).getTime() - 1).toISOString().slice(0, 10);

    const accounts = await ChartOfAccount.find({ postable: true, active: true }).sort({ code: 1 }).lean();
    const rows = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const a of accounts) {
      const balance = await coaBalance(a._id, { asOf });
      if (Math.abs(balance) < 0.01) continue;
      const debit = a.normalBalance === 'debit' && balance > 0 ? balance : a.normalBalance === 'credit' && balance < 0 ? -balance : 0;
      const credit = a.normalBalance === 'credit' && balance > 0 ? balance : a.normalBalance === 'debit' && balance < 0 ? -balance : 0;
      totalDebit += debit;
      totalCredit += credit;
      rows.push({ code: a.code, name: a.name, type: a.type, debit, credit });
    }
    res.json({ data: { month, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 } });
  } catch (err) {
    next(err);
  }
}

async function profitAndLoss(req, res, next) {
  try {
    const month = req.params.month || currentMonth();
    const { start, end } = monthRange(month);
    const accounts = await ChartOfAccount.find({ postable: true, active: true, type: { $in: ['Revenue', 'Expense'] } }).sort({ code: 1 }).lean();

    const revenue = [];
    const expense = [];
    let totalRevenue = 0;
    let totalExpense = 0;
    for (const a of accounts) {
      const rows = await JournalEntry.aggregate([
        { $match: { 'lines.account': a._id, date: { $gte: start, $lt: end } } },
        { $unwind: '$lines' },
        { $match: { 'lines.account': a._id } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ]);
      const { debit = 0, credit = 0 } = rows[0] || {};
      const amount = a.normalBalance === 'debit' ? debit - credit : credit - debit;
      if (Math.abs(amount) < 0.01) continue;
      if (a.type === 'Revenue') {
        revenue.push({ code: a.code, name: a.name, amount });
        totalRevenue += amount;
      } else {
        expense.push({ code: a.code, name: a.name, amount });
        totalExpense += amount;
      }
    }
    res.json({ data: { month, revenue, expense, totalRevenue, totalExpense, netProfit: totalRevenue - totalExpense } });
  } catch (err) {
    next(err);
  }
}

async function balanceSheet(req, res, next) {
  try {
    const month = req.params.month || currentMonth();
    const { end } = monthRange(month);
    const asOf = new Date(new Date(end).getTime() - 1).toISOString().slice(0, 10);
    const accounts = await ChartOfAccount.find({ postable: true, active: true, type: { $in: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] } }).sort({ code: 1 }).lean();

    const assets = [];
    const liabilities = [];
    const equity = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    // Revenue/Expense accounts are never formally "closed" into Equity here — there's no
    // period-close step — so without this the accounting equation only holds in a system that
    // does. Their net (cumulative, not just this month) is folded into Equity as Retained
    // Earnings, same as any accrual system that reports a balance sheet without closing entries.
    let retainedEarnings = 0;
    for (const a of accounts) {
      const balance = await coaBalance(a._id, { asOf });
      if (Math.abs(balance) < 0.01) continue;
      if (a.type === 'Asset') {
        assets.push({ code: a.code, name: a.name, amount: balance });
        totalAssets += balance;
      } else if (a.type === 'Liability') {
        liabilities.push({ code: a.code, name: a.name, amount: balance });
        totalLiabilities += balance;
      } else if (a.type === 'Equity') {
        equity.push({ code: a.code, name: a.name, amount: balance });
        totalEquity += balance;
      } else if (a.type === 'Revenue') {
        retainedEarnings += balance;
      } else {
        retainedEarnings -= balance;
      }
    }
    if (Math.abs(retainedEarnings) >= 0.01) {
      equity.push({ code: '3900', name: 'Retained Earnings (current, unclosed)', amount: retainedEarnings, computed: true });
      totalEquity += retainedEarnings;
    }
    res.json({
      data: {
        month,
        assets,
        liabilities,
        equity,
        totalAssets,
        totalLiabilities,
        totalEquity,
        balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listChartOfAccounts,
  createChartOfAccount,
  updateChartOfAccount,
  listJournalEntries,
  getJournalEntry,
  createManualJournalEntry,
  reverseJournalEntryHandler,
  generalLedger,
  trialBalance,
  profitAndLoss,
  balanceSheet,
};
