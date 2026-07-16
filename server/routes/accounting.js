const express = require('express');
const requireAuth = require('../middlewares/auth');
const { requireModule, requireAction } = require('../middlewares/rbac');
const {
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
} = require('../controllers/accountingController');
const {
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
} = require('../controllers/journalController');

const router = express.Router();
router.use(requireAuth, requireModule('accounting'));

router.get('/summary', summary);

router.get('/accounts', listAccounts);
router.post('/accounts', requireAction('accounting.chartOfAccounts'), createAccount);
router.patch('/accounts/:id', requireAction('accounting.chartOfAccounts'), updateAccount);

router.post('/transactions', requireAction('accounting.chartOfAccounts'), recordTransaction);

router.get('/expenses', listExpenses);
router.post('/expenses', requireAction('accounting.expenses'), createExpense);

router.get('/cheques', listCheques);
router.post('/cheques', requireAction('accounting.cheques'), createCheque);
router.patch('/cheques/:id', requireAction('accounting.cheques'), updateCheque);
router.patch('/cheques/:id/status', requireAction('accounting.cheques'), updateChequeStatus);

router.get('/coa', listChartOfAccounts);
router.post('/coa', requireAction('accounting.chartOfAccounts'), createChartOfAccount);
router.patch('/coa/:id', requireAction('accounting.chartOfAccounts'), updateChartOfAccount);

router.get('/journal', listJournalEntries);
router.post('/journal', requireAction('accounting.journal'), createManualJournalEntry);
router.get('/journal/:id', getJournalEntry);
router.post('/journal/:id/reverse', requireAction('accounting.journal'), reverseJournalEntryHandler);

router.get('/ledger/:coaId', generalLedger);
router.get('/ledger/:coaId/:year/:month', generalLedger);

router.get('/reports/trial-balance/:month?', trialBalance);
router.get('/reports/profit-loss/:month?', profitAndLoss);
router.get('/reports/balance-sheet/:month?', balanceSheet);

module.exports = router;
