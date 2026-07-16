const { nextSeq } = require('../models/Counter');

// JE-YYYYMM-001, restarting each calendar month — same mechanism as utils/orderNo.js. Numbered
// by when the entry is actually posted (now), not its effective `date`, since this is an audit
// sequence, not a period label.
async function generateEntryNo() {
  const now = new Date();
  const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
  const monthKey = `journal-${now.toISOString().slice(0, 7)}`;
  const seq = await nextSeq(monthKey);
  return `JE-${yyyymm}-${String(seq).padStart(3, '0')}`;
}

module.exports = { generateEntryNo };
