const { z } = require('zod');
const PayrollRun = require('../models/PayrollRun');
const PayrollLine = require('../models/PayrollLine');
const LedgerEntry = require('../models/LedgerEntry');
const CommissionTier = require('../models/CommissionTier');
const User = require('../models/User');
const Account = require('../models/Account');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { regexOr } = require('../utils/search');
const { computePayrollLines, processPayrollRun, deletePayrollRun } = require('../services/payroll');
const { postJournalEntry, requireCoaByCode, CODES } = require('../services/journal');
const AppError = require('../utils/AppError');
const { logActivity, diffFields } = require('../utils/activityLog');

const LEDGER_FIELD_LABELS = { date: 'Date', type: 'Type', amount: 'Amount', note: 'Note', postToAccounts: 'Adjust in Accounts' };
const TIER_FIELD_LABELS = { minPct: 'Min %', maxPct: 'Max %', rate: 'Rate %' };

async function employeeLabel(id) {
  const emp = await User.findById(id).select('employeeId name').lean();
  return emp ? `${emp.employeeId} (${emp.name})` : id;
}

// Real calendar month (01-12), not just any two digits - "2026-13" shouldn't pass.
const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'month must be in YYYY-MM format')
  .refine((v) => {
    const month = Number(v.slice(5, 7));
    return month >= 1 && month <= 12;
  }, 'month must be a real calendar month (01-12)');

// A payroll run pays salary for a month that has already happened - can't process (or usefully
// preview) one for a month still in the future.
function assertNotFutureMonth(month) {
  const current = new Date().toISOString().slice(0, 7);
  if (month > current) throw new AppError(`${month} hasn't happened yet - you can't process payroll for a future month`, 400);
}

async function preview(req, res, next) {
  try {
    const parsed = monthSchema.safeParse(req.query.month);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    assertNotFutureMonth(parsed.data);
    const { lines, totals } = await computePayrollLines(parsed.data);
    res.json({ data: { lines, totals } });
  } catch (err) {
    next(err);
  }
}

const processSchema = z.object({
  month: monthSchema,
  account: z.string().min(1),
  skipEmployees: z.array(z.string()).optional().default([]),
});

async function process(req, res, next) {
  try {
    const parsed = processSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    assertNotFutureMonth(parsed.data.month);
    const run = await processPayrollRun(parsed.data.month, parsed.data.account, req.user._id, parsed.data.skipEmployees);
    logActivity(req.user, `processed payroll run for ${run.month}: total net AED ${run.totalNet}, ${parsed.data.skipEmployees.length} employee(s) skipped`);
    res.status(201).json({ data: run });
  } catch (err) {
    next(err);
  }
}

async function deleteRun(req, res, next) {
  try {
    const result = await deletePayrollRun(req.params.id);
    logActivity(req.user, `deleted payroll run for ${result.month} — reversed all associated ledger/expense entries`);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

async function listRuns(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};
    if (req.query.search) {
      const re = new RegExp(req.query.search.trim(), 'i');
      const matchingAccounts = await Account.find({ name: re }).select('_id').lean();
      filter.$or = [{ month: re }, { account: { $in: matchingAccounts.map((a) => a._id) } }];
    }
    const [data, totalRowCount] = await Promise.all([
      PayrollRun.find(filter).populate('account', 'name').sort(sort).skip(skip).limit(limit).lean(),
      PayrollRun.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function getRun(req, res, next) {
  try {
    const run = await PayrollRun.findById(req.params.id)
      .populate('account', 'name')
      .populate('skippedEmployees', 'name employeeId')
      .lean();
    if (!run) throw new AppError('Payroll run not found', 404);
    const lines = await PayrollLine.find({ payrollRun: run._id }).populate('employee', 'name employeeId desig').lean();
    res.json({ data: { run, lines } });
  } catch (err) {
    next(err);
  }
}

// ---- Employee Ledger ----

// Advance/Loan/Deduction reduce a future payroll run (money the employee owes back);
// Salary/Bonus/Reimbursement are money paid to the employee, always created already-Settled.
const DEBIT_TYPES = ['Advance', 'Loan', 'Deduction'];
const CREDIT_TYPES = ['Salary', 'Bonus', 'Reimbursement'];

async function listLedger(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};
    if (req.query.employee) filter.employee = req.query.employee;
    if (req.query.status) filter.status = req.query.status;
    // month is 'YYYY-MM' - date is stored as a plain 'YYYY-MM-DD' string, so a prefix match is
    // enough (same pattern as the month filters already used in services/payroll.js).
    if (req.query.month) filter.date = { $regex: '^' + req.query.month };
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      const matchingEmployees = await User.find({ name: re }).select('_id').lean();
      filter.$or = [...regexOr(term, ['note', 'type']), { employee: { $in: matchingEmployees.map((u) => u._id) } }];
    }
    const [data, totalRowCount] = await Promise.all([
      LedgerEntry.find(filter).populate('employee', 'name employeeId').sort(sort).skip(skip).limit(limit).lean(),
      LedgerEntry.countDocuments(filter),
    ]);
    const response = buildPageResponse(data, totalRowCount, page, limit);

    // Only meaningful scoped to one employee - a "total paid" across every employee mixed
    // together isn't a number anyone asked for.
    if (req.query.employee) {
      const [openDebits, credits] = await Promise.all([
        LedgerEntry.find({ employee: req.query.employee, type: { $in: DEBIT_TYPES }, status: 'Open' }).select('remaining').lean(),
        LedgerEntry.find({ employee: req.query.employee, type: { $in: CREDIT_TYPES } }).select('amount').lean(),
      ]);
      response.summary = {
        outstanding: openDebits.reduce((sum, e) => sum + e.remaining, 0),
        totalPaid: credits.reduce((sum, e) => sum + e.amount, 0),
      };
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
}

// Manually-creatable types. Advance/Loan/Deduction have no installment concept - the full
// amount is deducted in one shot on the employee's next payroll run (the system also
// auto-creates settled 'Deduction' rows when a run pays one of these off - those never come
// through here). Salary/Bonus/Reimbursement are recorded already-Settled since there's nothing
// left to deduct against - payroll processing creates 'Salary' rows automatically each run,
// but any of the three can also be logged by hand (off-cycle payment, correction, etc.).
const ledgerBaseSchema = z.object({
  employee: z.string().min(1),
  date: z.string().min(1),
  type: z.enum(['Advance', 'Loan', 'Deduction', 'Salary', 'Bonus', 'Reimbursement']),
  amount: z.number().min(0), // 0 is a valid, deliberately-recorded amount - not clamped up
  note: z.string().optional().default(''),
  // Off-cycle entries have no cash movement by default (see LedgerEntry.js). Checking this and
  // picking a funding account posts a real journal entry instead of leaving it a paperwork note.
  postToAccounts: z.boolean().optional().default(false),
  account: z.string().min(1).optional(),
});
const requiresAccountWhenPosting = (v) => !v.postToAccounts || v.account;
const requiresAccountMessage = { message: 'Pick a funding account, or leave "Adjust in Accounts" unchecked', path: ['account'] };
const ledgerSchema = ledgerBaseSchema.refine(requiresAccountWhenPosting, requiresAccountMessage);

// Posts (or, for a 0-amount entry, skips) the journal entry behind an "Adjust in Accounts"
// ledger row. Debit-type rows (Advance/Loan/Deduction) create a receivable — money paid out now
// that the employee owes back; credit-type rows (Salary/Bonus/Reimbursement) are an expense paid
// out, nothing owed back.
async function postLedgerJournalEntry(body, actor, refId) {
  if (!body.postToAccounts || !body.amount) return null;
  const accountDoc = await Account.findById(body.account).lean();
  if (!accountDoc) throw new AppError('Account not found', 404);
  const bankCoa = await ChartOfAccount.findOne({ linkedAccount: body.account }).lean();
  if (!bankCoa) throw new AppError('This account has no ledger entry — re-create it', 500);

  // Debit-type rows create a receivable (Employee Advances & Loans); credit-type rows are an
  // expense — either way the money leaves via the chosen account, so both post
  // Dr [receivable-or-expense] / Cr [funding account].
  const isCredit = CREDIT_TYPES.includes(body.type);
  const otherCoa = isCredit
    ? await requireCoaByCode(body.type === 'Salary' ? CODES.SALARIES_EXPENSE : CODES.BONUS_REIMBURSEMENT_EXPENSE)
    : await requireCoaByCode(CODES.EMPLOYEE_ADVANCES_RECEIVABLE);

  const lines = [
    { account: otherCoa._id, debit: body.amount, credit: 0, note: body.note },
    { account: bankCoa._id, debit: 0, credit: body.amount, note: body.note },
  ];

  return postJournalEntry({ date: body.date, memo: `${body.type} — ${body.note || 'employee ledger'}`, refType: 'LedgerEntry', refId, lines, actor });
}

async function createLedgerEntry(req, res, next) {
  try {
    const parsed = ledgerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const body = parsed.data;
    if (!(await User.exists({ _id: body.employee }))) throw new AppError('Employee not found', 404);
    if (body.account && !(await Account.exists({ _id: body.account }))) throw new AppError('Account not found', 404);

    const isCredit = CREDIT_TYPES.includes(body.type);
    const entry = await LedgerEntry.create({
      ...body,
      remaining: isCredit ? 0 : body.amount,
      status: isCredit ? 'Settled' : 'Open',
      createdBy: req.user._id,
    });

    try {
      const journalEntry = await postLedgerJournalEntry(body, req.user, entry._id);
      if (journalEntry) {
        entry.journalEntry = journalEntry._id;
        await entry.save();
      }
    } catch (err) {
      await LedgerEntry.deleteOne({ _id: entry._id });
      throw err;
    }

    logActivity(req.user, `added ${body.type} ledger entry of AED ${body.amount} for employee ${await employeeLabel(body.employee)}${body.postToAccounts ? ' (posted to Accounts)' : ''}${body.note ? ' — Note: ' + body.note : ''}`);
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
}

// An entry is locked once payroll has touched it either way: it was auto-created BY a run
// (payrollRun set - the run's own Salary payout / settlement Deduction rows), or it's an Advance/
// Loan that a later run has already settled (a settlement Deduction elsewhere points back at it
// via `parent`). Editing/deleting a locked entry could desync the run's own totals or leave a
// dangling parent reference - correcting those means deleting the whole run instead (which
// already reverses everything cleanly), not hand-editing one row.
async function assertLedgerEntryEditable(entry) {
  if (entry.payrollRun) throw new AppError("This entry was created by a payroll run and can't be changed here - delete the run instead.", 400);
  if (await LedgerEntry.exists({ parent: entry._id })) {
    throw new AppError('This entry has already been settled by a payroll run and can\'t be changed.', 400);
  }
}

const ledgerUpdateSchema = ledgerBaseSchema.omit({ employee: true }).refine(requiresAccountWhenPosting, requiresAccountMessage);

async function updateLedgerEntry(req, res, next) {
  try {
    const parsed = ledgerUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const body = parsed.data;

    const entry = await LedgerEntry.findById(req.params.id);
    if (!entry) throw new AppError('Ledger entry not found', 404);
    await assertLedgerEntryEditable(entry);
    if (body.account && !(await Account.exists({ _id: body.account }))) throw new AppError('Account not found', 404);

    const before = { date: entry.date, type: entry.type, amount: entry.amount, note: entry.note, postToAccounts: entry.postToAccounts };

    // Nothing partially adjusts an existing posting — drop it and re-post from scratch against
    // the entry's new values, same "delete and recreate" approach the rest of this ledger uses.
    if (entry.journalEntry) {
      await JournalEntry.deleteOne({ _id: entry.journalEntry });
      entry.journalEntry = null;
    }

    const isCredit = CREDIT_TYPES.includes(body.type);
    entry.date = body.date;
    entry.type = body.type;
    entry.amount = body.amount;
    entry.note = body.note;
    entry.postToAccounts = body.postToAccounts;
    entry.account = body.account || null;
    entry.remaining = isCredit ? 0 : body.amount;
    entry.status = isCredit ? 'Settled' : 'Open';

    const journalEntry = await postLedgerJournalEntry(body, req.user, entry._id);
    if (journalEntry) entry.journalEntry = journalEntry._id;
    await entry.save();

    const changes = diffFields(before, body, LEDGER_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited ledger entry for employee ${await employeeLabel(entry.employee)}: ${changes.join(', ')}`);
    res.json({ data: entry });
  } catch (err) {
    next(err);
  }
}

async function deleteLedgerEntry(req, res, next) {
  try {
    const entry = await LedgerEntry.findById(req.params.id);
    if (!entry) throw new AppError('Ledger entry not found', 404);
    await assertLedgerEntryEditable(entry);
    if (entry.journalEntry) await JournalEntry.deleteOne({ _id: entry.journalEntry });
    await LedgerEntry.deleteOne({ _id: entry._id });
    logActivity(req.user, `deleted ${entry.type} ledger entry of AED ${entry.amount} for employee ${await employeeLabel(entry.employee)}`);
    res.json({ data: { _id: entry._id } });
  } catch (err) {
    next(err);
  }
}

// ---- Commission Tiers ----
// Target-achievement bracket -> commission rate, scoped to one employee - each commission-
// eligible employee has their own independent tier set (see server/models/CommissionTier.js for
// why these rows are plain mutable CRUD with no versioning). A `null` maxPct means "no upper
// bound" - the open-ended top tier (e.g. "125%+").

const tierBodySchema = z.object({
  employee: z.string().min(1),
  minPct: z.number().min(0),
  maxPct: z.number().min(0).nullable().optional(),
  rate: z.number().min(0),
});

const tierUpdateSchema = tierBodySchema.omit({ employee: true });

// maxPct is exclusive (see resolveTier in services/payroll.js) - two ranges that only touch at a
// shared boundary (e.g. [100,125) and [125,null)) are adjacent, not overlapping, since HR
// naturally types ranges that way ("100-125" then "125+").
function rangesOverlap(aMin, aMax, bMin, bMax) {
  const aHigh = aMax == null ? Infinity : aMax;
  const bHigh = bMax == null ? Infinity : bMax;
  return aMin < bHigh && bMin < aHigh;
}

// Overlap only matters within the SAME employee's tier set - two different employees can have
// identical or overlapping ranges, since their tiers are entirely independent.
async function assertNoOverlap(employeeId, minPct, maxPct, excludeId) {
  const filter = { employee: employeeId, ...(excludeId ? { _id: { $ne: excludeId } } : {}) };
  const others = await CommissionTier.find(filter).lean();
  const clash = others.find((t) => rangesOverlap(minPct, maxPct ?? null, t.minPct, t.maxPct));
  if (clash) {
    const clashLabel = clash.maxPct == null ? `${clash.minPct}%+` : `${clash.minPct}%-${clash.maxPct}%`;
    throw new AppError(`This range overlaps an existing tier for this employee (${clashLabel})`, 400);
  }
}

async function listCommissionTiers(req, res, next) {
  try {
    if (!req.query.employee) throw new AppError('employee is required', 400);
    const tiers = await CommissionTier.find({ employee: req.query.employee }).sort({ minPct: 1 }).lean();
    res.json({ data: tiers });
  } catch (err) {
    next(err);
  }
}

async function createCommissionTier(req, res, next) {
  try {
    const parsed = tierBodySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { employee, minPct, maxPct, rate } = parsed.data;
    if (!(await User.exists({ _id: employee }))) throw new AppError('Employee not found', 404);
    if (maxPct != null && maxPct <= minPct) throw new AppError('Max % must be greater than Min %', 400);
    await assertNoOverlap(employee, minPct, maxPct ?? null, null);
    const tier = await CommissionTier.create({ employee, minPct, maxPct: maxPct ?? null, rate, createdBy: req.user._id });
    logActivity(req.user, `added commission tier for employee ${await employeeLabel(employee)}: ${minPct}%-${maxPct ?? '+'}% -> ${rate}%`);
    res.status(201).json({ data: tier });
  } catch (err) {
    next(err);
  }
}

async function updateCommissionTier(req, res, next) {
  try {
    const parsed = tierUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { minPct, maxPct, rate } = parsed.data;
    if (maxPct != null && maxPct <= minPct) throw new AppError('Max % must be greater than Min %', 400);
    const existing = await CommissionTier.findById(req.params.id);
    if (!existing) throw new AppError('Commission tier not found', 404);
    await assertNoOverlap(existing.employee, minPct, maxPct ?? null, req.params.id);
    const before = { minPct: existing.minPct, maxPct: existing.maxPct, rate: existing.rate };
    existing.minPct = minPct;
    existing.maxPct = maxPct ?? null;
    existing.rate = rate;
    await existing.save();

    const changes = diffFields(before, { minPct, maxPct: maxPct ?? null, rate }, TIER_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited commission tier for employee ${await employeeLabel(existing.employee)}: ${changes.join(', ')}`);
    res.json({ data: existing });
  } catch (err) {
    next(err);
  }
}

async function deleteCommissionTier(req, res, next) {
  try {
    const tier = await CommissionTier.findByIdAndDelete(req.params.id);
    if (!tier) throw new AppError('Commission tier not found', 404);
    logActivity(req.user, `deleted commission tier for employee ${await employeeLabel(tier.employee)}: ${tier.minPct}%-${tier.maxPct ?? '+'}% -> ${tier.rate}%`);
    res.json({ data: { _id: tier._id } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  preview,
  process,
  deleteRun,
  listRuns,
  getRun,
  listLedger,
  createLedgerEntry,
  updateLedgerEntry,
  deleteLedgerEntry,
  listCommissionTiers,
  createCommissionTier,
  updateCommissionTier,
  deleteCommissionTier,
};
