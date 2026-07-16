// Digitalcoo runs a 6-day work week - Sunday is the only weekend day (confirmed with the
// business, not a general UAE-wide assumption; some UAE employers use a Fri-Sat weekend instead).
function isWeekend(dateStr) {
  return new Date(dateStr).getDay() === 0;
}

// Inclusive day count between start/end, excluding Sundays and any date in holidayDateSet
// (a Set of 'YYYY-MM-DD' strings).
function countWorkDays(startDate, endDate, holidayDateSet = new Set()) {
  let count = 0;
  const cursor = new Date(startDate);
  const end = new Date(endDate);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (cursor.getDay() !== 0 && !holidayDateSet.has(iso)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

module.exports = { isWeekend, countWorkDays };
