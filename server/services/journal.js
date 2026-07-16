const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const { generateEntryNo } = require('../utils/journalNo');
const AppError = require('../utils/AppError');

// The standard tree every fresh install seeds. Group headers (postable: false) exist purely to
// organize the Chart of Accounts screen — journal lines can only ever target a leaf. Cash & Bank
// leaves (one per operational Account) are created dynamically by ensureLinkedAccount, not here.
const SEED_TREE = [
  { code: '1000', name: 'Assets', type: 'Asset', parent: null, postable: false },
  { code: '1010', name: 'Cash & Bank', type: 'Asset', parent: '1000', postable: false },
  { code: '1200', name: 'Accounts Receivable', type: 'Asset', parent: '1000', postable: true },
  // PDC (post-dated cheque) tracking, receivable side — a customer's cheque reclassifies out of
  // plain AR once it's physically in hand, then again once it's been taken to the bank, so the
  // balance sheet shows "secured by a cheque" vs "still just owed" instead of lumping both into
  // 1200. Not yet wired to any posting logic — these exist so the accounts are ready when that's built.
  { code: '1210', name: 'Cheques/PDC Receivable (in hand)', type: 'Asset', parent: '1000', postable: true },
  { code: '1220', name: 'Cheques Deposited (in clearing)', type: 'Asset', parent: '1000', postable: true },
  { code: '1300', name: 'Employee Advances & Loans Receivable', type: 'Asset', parent: '1000', postable: true },
  { code: '2000', name: 'Liabilities', type: 'Liability', parent: null, postable: false },
  { code: '2100', name: 'Accounts Payable', type: 'Liability', parent: '2000', postable: true },
  // Mirror of 1210/1220 on the payable side, for cheques we issue.
  { code: '2110', name: 'Cheques/PDC Payable (in hand)', type: 'Liability', parent: '2000', postable: true },
  { code: '2120', name: 'Cheques Issued (in clearing)', type: 'Liability', parent: '2000', postable: true },
  { code: '2400', name: 'Commission Payable', type: 'Liability', parent: '2000', postable: true },
  { code: '3000', name: 'Equity', type: 'Equity', parent: null, postable: false },
  { code: '3100', name: "Owner's Equity / Capital", type: 'Equity', parent: '3000', postable: true },
  { code: '3200', name: 'Opening Balance Equity', type: 'Equity', parent: '3000', postable: true },
  { code: '4000', name: 'Revenue', type: 'Revenue', parent: null, postable: false },
  { code: '4100', name: 'Commission Revenue', type: 'Revenue', parent: '4000', postable: true },
  { code: '4200', name: 'Other Income', type: 'Revenue', parent: '4000', postable: true },
  { code: '5000', name: 'Expenses', type: 'Expense', parent: null, postable: false },
  { code: '5100', name: 'Rent', type: 'Expense', parent: '5000', postable: true },
  { code: '5200', name: 'Utilities', type: 'Expense', parent: '5000', postable: true },
  { code: '5300', name: 'Salaries & Wages', type: 'Expense', parent: '5000', postable: true },
  { code: '5400', name: 'Commission Expense', type: 'Expense', parent: '5000', postable: true },
  { code: '5500', name: 'Bonus & Reimbursement Expense', type: 'Expense', parent: '5000', postable: true },
  { code: '5600', name: 'Other Expense', type: 'Expense', parent: '5000', postable: true },
];

// Fixed, well-known codes referenced by name throughout the posting logic below.
const CODES = {
  CASH_BANK_GROUP: '1010',
  ACCOUNTS_RECEIVABLE: '1200',
  EMPLOYEE_ADVANCES_RECEIVABLE: '1300',
  ACCOUNTS_PAYABLE: '2100',
  OPENING_BALANCE_EQUITY: '3200',
  SALARIES_EXPENSE: '5300',
  COMMISSION_EXPENSE: '5400',
  BONUS_REIMBURSEMENT_EXPENSE: '5500',
};

const EXPENSE_CATEGORY_TO_CODE = {
  Rent: '5100',
  Utilities: '5200',
  Salaries: '5300',
  Commission: '5400',
  Other: '5600',
};

// Idempotent — safe to call on every seed run. Two passes: create/update headers and leaves by
// code first, then wire up `parent` refs (needs every code to already exist as an ObjectId).
async function seedChartOfAccounts() {
  const byCode = {};
  for (const row of SEED_TREE) {
    const doc = await ChartOfAccount.findOneAndUpdate(
      { code: row.code },
      { code: row.code, name: row.name, type: row.type, postable: row.postable, isSystem: true },
      { new: true, upsert: true }
    );
    byCode[row.code] = doc;
  }
  for (const row of SEED_TREE) {
    if (!row.parent) continue;
    const parentId = byCode[row.parent]._id;
    if (String(byCode[row.code].parent) !== String(parentId)) {
      byCode[row.code].parent = parentId;
      await byCode[row.code].save();
    }
  }
}

async function requireCoaByCode(code) {
  const doc = await ChartOfAccount.findOne({ code }).lean();
  if (!doc) throw new AppError(`Chart of Accounts is missing required system account ${code} — re-run the seed script`, 500);
  return doc;
}

// Creates (or returns the existing) Cash & Bank leaf for one operational Account, and posts its
// opening-balance entry the first time. Called from accountingController.createAccount.
async function ensureLinkedAccount(account, actor) {
  const existing = await ChartOfAccount.findOne({ linkedAccount: account._id });
  if (existing) return existing;

  const group = await requireCoaByCode(CODES.CASH_BANK_GROUP);
  const siblingCount = await ChartOfAccount.countDocuments({ parent: group._id });
  const code = `${CODES.CASH_BANK_GROUP}-${String(siblingCount + 1).padStart(2, '0')}`;
  const leaf = await ChartOfAccount.create({
    code,
    name: account.name,
    type: 'Asset',
    parent: group._id,
    linkedAccount: account._id,
    postable: true,
    createdBy: actor._id,
  });

  if (account.opening) {
    const equity = await requireCoaByCode(CODES.OPENING_BALANCE_EQUITY);
    await postJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      memo: `Opening balance — ${account.name}`,
      refType: 'Account',
      refId: account._id,
      lines: [
        { account: leaf._id, debit: account.opening, credit: 0, note: 'Opening balance' },
        { account: equity._id, debit: 0, credit: account.opening, note: 'Opening balance' },
      ],
      actor,
    });
  }

  return leaf;
}

// The one place every journal entry gets created. `lines` is [{account, debit, credit, note?}] —
// account is a ChartOfAccount _id (ObjectId or string). Balance is also enforced by the model's
// own pre-validate hook; checking again here lets us throw a friendlier AppError before that.
async function postJournalEntry({ date, memo = '', refType, refId = null, lines, actor }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new AppError('A journal entry needs at least two lines', 400);

  const accountIds = lines.map((l) => String(l.account));
  const coaDocs = await ChartOfAccount.find({ _id: { $in: accountIds } }).lean();
  const coaById = new Map(coaDocs.map((d) => [String(d._id), d]));
  for (const line of lines) {
    const coa = coaById.get(String(line.account));
    if (!coa) throw new AppError('One of the selected accounts no longer exists', 400);
    if (!coa.postable) throw new AppError(`"${coa.name}" is a group heading — post to one of its accounts instead`, 400);
    if (!coa.active) throw new AppError(`"${coa.name}" is inactive`, 400);
    const hasDebit = (line.debit || 0) > 0;
    const hasCredit = (line.credit || 0) > 0;
    if (hasDebit === hasCredit) throw new AppError('Every journal line needs exactly one of debit or credit', 400);
  }

  const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new AppError(`Entry does not balance — debit ${totalDebit.toFixed(2)} vs credit ${totalCredit.toFixed(2)}`, 400);
  }

  const entryNo = await generateEntryNo();
  return JournalEntry.create({
    entryNo,
    date,
    memo,
    refType,
    refId,
    lines: lines.map((l) => ({ account: l.account, debit: l.debit || 0, credit: l.credit || 0, note: l.note || '' })),
    totalDebit,
    totalCredit,
    postedBy: actor._id,
  });
}

// Corrections to a posted entry never edit or delete it — they post a mirror entry (debit/credit
// swapped) and link the two together, so the full history stays intact. Restricted to entries
// posted from the Manual Journal Entry screen — every other refType is owned by its originating
// record (an Expense, a Cheque, a payroll run...) and gets corrected by editing/deleting that
// record instead, which already reverses its own postings.
async function reverseJournalEntry(entryId, actor, memo = '') {
  const original = await JournalEntry.findById(entryId);
  if (!original) throw new AppError('Journal entry not found', 404);
  if (original.refType !== 'Manual') {
    throw new AppError('Only manually-posted entries can be reversed here — correct this by editing or deleting the record that created it', 400);
  }
  if (original.reversedBy) throw new AppError('This entry has already been reversed', 400);
  if (original.reversalOf) throw new AppError('A reversal entry cannot itself be reversed', 400);

  const reversal = await postJournalEntry({
    date: new Date().toISOString().slice(0, 10),
    memo: memo || `Reversal of ${original.entryNo}`,
    refType: 'Manual',
    refId: original._id,
    lines: original.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, note: l.note })),
    actor,
  });

  reversal.reversalOf = original._id;
  await reversal.save();
  original.reversedBy = reversal._id;
  await original.save();
  return reversal;
}

// Signed by the account's own normal-balance side, so callers never have to remember which way
// is "up" for a given type — a positive number always means "more of what this account normally
// holds" (more cash in a Bank account, more owed on a Payable, more earned on Revenue...).
async function coaBalance(coaAccountId, { asOf } = {}) {
  const coa = await ChartOfAccount.findById(coaAccountId).lean();
  if (!coa) return 0;
  const match = { 'lines.account': coa._id };
  if (asOf) match.date = { $lte: asOf };
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account': coa._id } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const { debit = 0, credit = 0 } = rows[0] || {};
  return coa.normalBalance === 'debit' ? debit - credit : credit - debit;
}

// Kept as a drop-in for the pre-existing `accountBalance(accountId)` call sites (accountingController
// callers pass an operational Account _id, not a ChartOfAccount _id).
async function accountBalance(accountId) {
  const coa = await ChartOfAccount.findOne({ linkedAccount: accountId }).lean();
  if (!coa) return 0;
  return coaBalance(coa._id);
}

module.exports = {
  CODES,
  EXPENSE_CATEGORY_TO_CODE,
  seedChartOfAccounts,
  requireCoaByCode,
  ensureLinkedAccount,
  postJournalEntry,
  reverseJournalEntry,
  coaBalance,
  accountBalance,
};
