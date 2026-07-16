const { z } = require('zod');
const Account = require('../models/Account');
const ChartOfAccount = require('../models/ChartOfAccount');
const Expense = require('../models/Expense');
const Cheque = require('../models/Cheque');
const { parsePagination, buildPageResponse } = require('../utils/pagination');
const { accountBalance, postJournalEntry, ensureLinkedAccount, requireCoaByCode, CODES, EXPENSE_CATEGORY_TO_CODE } = require('../services/journal');
const AppError = require('../utils/AppError');
const { logActivity, diffFields, describeFields } = require('../utils/activityLog');
const { regexOr, numericRegexOr } = require('../utils/search');

const ACCOUNT_FIELD_LABELS = { name: 'Name', type: 'Type', opening: 'Opening Balance' };
const CHEQUE_FIELD_LABELS = { no: 'No.', date: 'Date', dueDate: 'Due Date', direction: 'Direction', party: 'Party', amount: 'Amount', note: 'Note' };

// First day of `month` (YYYY-MM) and first day of the following month — an exclusive upper
// bound, since dates in this app are plain 'YYYY-MM-DD' strings that sort lexicographically.
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { start, end };
}

async function coaLabel(id) {
  if (!id) return '(none)';
  const coa = await ChartOfAccount.findById(id).select('code name').lean();
  return coa ? `${coa.code} ${coa.name}` : String(id);
}

// Received cheques settle a customer/Etisalat receivable by default; issued cheques settle a
// payable — always overridable by the caller via an explicit contraAccount.
async function defaultContraForDirection(direction) {
  const code = direction === 'Received' ? CODES.ACCOUNTS_RECEIVABLE : CODES.ACCOUNTS_PAYABLE;
  const coa = await requireCoaByCode(code);
  return coa._id;
}

const accountSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['Bank', 'Cash']),
  opening: z.number().optional().default(0),
});

const txSchema = z.object({
  account: z.string().min(1),
  date: z.string().min(1),
  type: z.enum(['Deposit', 'Withdrawal']),
  amount: z.number().positive(),
  contraAccount: z.string().min(1),
  note: z.string().optional().default(''),
});

const expenseSchema = z.object({
  category: z.enum(['Rent', 'Utilities', 'Salaries', 'Commission', 'Other']),
  amount: z.number().positive(),
  date: z.string().min(1),
  account: z.string().min(1),
  note: z.string().optional().default(''),
  breakdown: z
    .array(z.object({ employee: z.string().min(1), amount: z.number().positive(), note: z.string().optional().default('') }))
    .optional()
    .default([]),
});

const chequeSchema = z.object({
  no: z.string().trim().min(1),
  date: z.string().min(1),
  dueDate: z.string().min(1),
  direction: z.enum(['Received', 'Issued']),
  party: z.string().trim().min(1),
  amount: z.number().positive(),
  account: z.string().min(1),
  contraAccount: z.string().min(1).optional(),
  note: z.string().optional().default(''),
});

// ---- Bank/Cash Accounts (operational — see journalController.js for the full Chart of Accounts) ----

async function listAccounts(req, res, next) {
  try {
    const accounts = await Account.find().sort({ createdAt: 1 }).lean();
    const withBalance = await Promise.all(
      accounts.map(async (a) => {
        const coa = await ChartOfAccount.findOne({ linkedAccount: a._id }).select('_id').lean();
        return { ...a, balance: await accountBalance(a._id), coaAccountId: coa?._id || null };
      })
    );
    res.json({ data: withBalance });
  } catch (err) {
    next(err);
  }
}

async function createAccount(req, res, next) {
  try {
    const parsed = accountSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const account = await Account.create({ ...parsed.data, createdBy: req.user._id });
    await ensureLinkedAccount(account, req.user);
    logActivity(req.user, `created account "${account.name}" — ${describeFields(account, ACCOUNT_FIELD_LABELS)}`);
    res.status(201).json({ data: account });
  } catch (err) {
    next(err);
  }
}

async function updateAccount(req, res, next) {
  try {
    const parsed = accountSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const before = await Account.findById(req.params.id).lean();
    if (!before) throw new AppError('Account not found', 404);
    // Opening balance is only ever set once, at creation (it's already posted as a journal
    // entry) — editing it here would silently desync the ledger from the field.
    const { opening, ...editable } = parsed.data;
    const account = await Account.findByIdAndUpdate(req.params.id, editable, { new: true });

    const changes = diffFields(before, account.toObject(), { name: 'Name', type: 'Type' });
    if (changes.length) logActivity(req.user, `edited account "${account.name}": ${changes.join(', ')}`);
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
}

async function recordTransaction(req, res, next) {
  try {
    const parsed = txSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const { account, date, type, amount, contraAccount, note } = parsed.data;
    const accountDoc = await Account.findById(account).lean();
    if (!accountDoc) throw new AppError('Account not found', 404);
    const coa = await ChartOfAccount.findOne({ linkedAccount: account }).lean();
    if (!coa) throw new AppError('This account has no ledger entry — re-create it', 500);

    const lines =
      type === 'Deposit'
        ? [
            { account: coa._id, debit: amount, credit: 0, note },
            { account: contraAccount, debit: 0, credit: amount, note },
          ]
        : [
            { account: contraAccount, debit: amount, credit: 0, note },
            { account: coa._id, debit: 0, credit: amount, note },
          ];

    const entry = await postJournalEntry({ date, memo: `${type}${note ? ' - ' + note : ''}`, refType: 'Account', refId: accountDoc._id, lines, actor: req.user });
    logActivity(req.user, `recorded ${type} of AED ${amount} on account "${accountDoc.name}" against ${await coaLabel(contraAccount)}${note ? ' — Note: ' + note : ''}`);
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
}

// ---- Company Expenses (every expense, including salaries, debits exactly one account) ----

async function listExpenses(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.account) filter.account = req.query.account;
    if (req.query.month) {
      const { start, end } = monthRange(req.query.month);
      filter.date = { $gte: start, $lt: end };
    }
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      const matchingAccounts = await Account.find({ name: re }).select('_id').lean();
      filter.$or = [
        ...regexOr(term, ['note', 'category']),
        ...numericRegexOr(term, ['amount']),
        { account: { $in: matchingAccounts.map((a) => a._id) } },
      ];
    }
    const [data, totalRowCount] = await Promise.all([
      Expense.find(filter).populate('account', 'name type').populate('breakdown.employee', 'name').sort(sort).skip(skip).limit(limit).lean(),
      Expense.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function createExpense(req, res, next) {
  try {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const body = parsed.data;

    const accountDoc = await Account.findById(body.account).lean();
    if (!accountDoc) throw new AppError('Account not found', 404);
    const bankCoa = await ChartOfAccount.findOne({ linkedAccount: body.account }).lean();
    if (!bankCoa) throw new AppError('This account has no ledger entry — re-create it', 500);
    if (body.breakdown.length) {
      const breakdownTotal = body.breakdown.reduce((sum, line) => sum + line.amount, 0);
      if (Math.abs(breakdownTotal - body.amount) > 0.01) {
        throw new AppError('Breakdown amounts must add up to the total expense amount', 400);
      }
    }

    const expense = await Expense.create({ ...body, createdBy: req.user._id });
    try {
      const expenseCoa = await requireCoaByCode(EXPENSE_CATEGORY_TO_CODE[body.category]);
      await postJournalEntry({
        date: body.date,
        memo: `${body.category}${body.note ? ' - ' + body.note : ''}`,
        refType: 'Expense',
        refId: expense._id,
        lines: [
          { account: expenseCoa._id, debit: body.amount, credit: 0 },
          { account: bankCoa._id, debit: 0, credit: body.amount },
        ],
        actor: req.user,
      });
    } catch (err) {
      // Ledger post failed — remove the expense so it's never left without its matching
      // journal entry (which would otherwise silently understate the account's true spend).
      await Expense.deleteOne({ _id: expense._id });
      throw err;
    }

    logActivity(req.user, `recorded ${body.category} expense of AED ${body.amount}${body.note ? ' — Note: ' + body.note : ''}${body.breakdown.length ? ` (${body.breakdown.length} employee breakdown line(s))` : ''}`);
    res.status(201).json({ data: expense });
  } catch (err) {
    next(err);
  }
}

// ---- Cheques (PDC) ----

async function listCheques(req, res, next) {
  try {
    const { page, limit, skip, sort } = parsePagination(req.query);
    const filter = {};
    if (req.query.account) filter.account = req.query.account;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.month) {
      const { start, end } = monthRange(req.query.month);
      filter.date = { $gte: start, $lt: end };
    }
    if (req.query.search) {
      const term = req.query.search.trim();
      const re = new RegExp(term, 'i');
      const [matchingAccounts, matchingContraAccounts] = await Promise.all([
        Account.find({ name: re }).select('_id').lean(),
        ChartOfAccount.find({ name: re }).select('_id').lean(),
      ]);
      filter.$or = [
        ...regexOr(term, ['no', 'party', 'note', 'direction', 'status']),
        ...numericRegexOr(term, ['amount']),
        { account: { $in: matchingAccounts.map((a) => a._id) } },
        { contraAccount: { $in: matchingContraAccounts.map((a) => a._id) } },
      ];
    }
    const [data, totalRowCount] = await Promise.all([
      Cheque.find(filter).populate('account', 'name type').populate('contraAccount', 'code name').sort(sort).skip(skip).limit(limit).lean(),
      Cheque.countDocuments(filter),
    ]);
    res.json(buildPageResponse(data, totalRowCount, page, limit));
  } catch (err) {
    next(err);
  }
}

async function createCheque(req, res, next) {
  try {
    const parsed = chequeSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    if (!(await Account.exists({ _id: parsed.data.account }))) throw new AppError('Account not found', 404);
    const contraAccount = parsed.data.contraAccount || (await defaultContraForDirection(parsed.data.direction));
    if (!(await ChartOfAccount.exists({ _id: contraAccount }))) throw new AppError('Contra account not found', 404);
    const cheque = await Cheque.create({ ...parsed.data, contraAccount, createdBy: req.user._id });
    logActivity(req.user, `added ${cheque.direction} cheque ${cheque.no} — Party: ${cheque.party}, Amount: AED ${cheque.amount}, Against: ${await coaLabel(contraAccount)}`);
    res.status(201).json({ data: cheque });
  } catch (err) {
    next(err);
  }
}

async function updateCheque(req, res, next) {
  try {
    const parsed = chequeSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) throw new AppError('Cheque not found', 404);
    if (['Cleared', 'Bounced'].includes(cheque.status)) throw new AppError('Cannot edit a cleared or bounced cheque', 400);
    if (parsed.data.contraAccount && !(await ChartOfAccount.exists({ _id: parsed.data.contraAccount }))) {
      throw new AppError('Contra account not found', 404);
    }
    const before = { no: cheque.no, date: cheque.date, dueDate: cheque.dueDate, direction: cheque.direction, party: cheque.party, amount: cheque.amount, note: cheque.note };
    Object.assign(cheque, parsed.data);
    await cheque.save();

    const changes = diffFields(before, cheque.toObject(), CHEQUE_FIELD_LABELS);
    if (changes.length) logActivity(req.user, `edited cheque ${cheque.no}: ${changes.join(', ')}`);
    res.json({ data: cheque });
  } catch (err) {
    next(err);
  }
}

const STATUS_TRANSITIONS = {
  Pending: ['Deposited', 'Bounced'],
  Deposited: ['Cleared', 'Bounced'],
  Cleared: [],
  Bounced: [],
};

async function updateChequeStatus(req, res, next) {
  try {
    const status = req.body.status;
    if (!['Pending', 'Deposited', 'Cleared', 'Bounced'].includes(status)) throw new AppError('Invalid status', 400);
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) throw new AppError('Cheque not found', 404);
    if (status === cheque.status) throw new AppError('Cheque already has this status', 400);
    // Admins can move a cheque to any status directly (e.g. correcting a mis-marked cheque or
    // reopening a Bounced one); everyone else stays on the guarded forward-only flow.
    if (req.user.role !== 'admin' && !STATUS_TRANSITIONS[cheque.status].includes(status)) {
      throw new AppError(`Cannot move a ${cheque.status} cheque to ${status}`, 400);
    }

    // Post the ledger entry BEFORE persisting the status change for 'Cleared' — otherwise a
    // failure here would leave the cheque marked Cleared with no corresponding journal entry.
    if (status === 'Cleared') {
      const bankCoa = await ChartOfAccount.findOne({ linkedAccount: cheque.account }).lean();
      if (!bankCoa) throw new AppError('This account has no ledger entry — re-create it', 500);
      const contraAccount = cheque.contraAccount || (await defaultContraForDirection(cheque.direction));
      const lines =
        cheque.direction === 'Received'
          ? [
              { account: bankCoa._id, debit: cheque.amount, credit: 0 },
              { account: contraAccount, debit: 0, credit: cheque.amount },
            ]
          : [
              { account: contraAccount, debit: cheque.amount, credit: 0 },
              { account: bankCoa._id, debit: 0, credit: cheque.amount },
            ];
      await postJournalEntry({
        date: new Date().toISOString().slice(0, 10),
        memo: `Cheque ${cheque.no} (${cheque.party}) cleared`,
        refType: 'Cheque',
        refId: cheque._id,
        lines,
        actor: req.user,
      });
    }

    const oldStatus = cheque.status;
    cheque.status = status;
    await cheque.save();

    logActivity(req.user, `changed cheque ${cheque.no} status: ${oldStatus} -> ${status}`);
    res.json({ data: cheque });
  } catch (err) {
    next(err);
  }
}

// ---- Summary KPIs ----

async function summary(req, res, next) {
  try {
    const accounts = await Account.find().lean();
    const totalCash = (
      await Promise.all(accounts.map((a) => accountBalance(a._id)))
    ).reduce((sum, b) => sum + b, 0);

    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().slice(0, 10);

    const expensesThisMonth = await Expense.find({ date: { $gte: monthStartStr } }).select('amount').lean();
    const totalExpensesThisMonth = expensesThisMonth.reduce((sum, e) => sum + e.amount, 0);

    const pendingCheques = await Cheque.countDocuments({ status: { $in: ['Pending', 'Deposited'] } });
    const bouncedCheques = await Cheque.countDocuments({ status: 'Bounced' });

    res.json({
      data: {
        totalCash,
        accountsCount: accounts.length,
        totalExpensesThisMonth,
        pendingCheques,
        bouncedCheques,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listAccounts,
  createAccount,
  updateAccount,
  recordTransaction,
  listExpenses,
  createExpense,
  listCheques,
  createCheque,
  updateCheque,
  updateChequeStatus,
  summary,
};
