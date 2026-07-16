const { nextSeq } = require('../models/Counter');

// Internal, system-assigned order number - ORD-YYYYMMDD-001. The 3-digit counter is scoped to
// the calendar month (not the day): it keeps incrementing across every order in that month and
// only resets to 001 when the month changes, while the YYYYMMDD in the string always reflects
// the actual date the order was created.
async function generateOrderNo() {
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const monthKey = `order-${now.toISOString().slice(0, 7)}`;
  const seq = await nextSeq(monthKey);
  return `ORD-${yyyymmdd}-${String(seq).padStart(3, '0')}`;
}

module.exports = { generateOrderNo };
