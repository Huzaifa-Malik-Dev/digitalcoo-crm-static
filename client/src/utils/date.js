// Every date in this app is stored/transmitted as a plain ISO string ('YYYY-MM-DD' for a date,
// 'YYYY-MM' for a month) so it sorts and compares correctly everywhere. These only convert it to
// a friendly display string at the point of rendering - never use these for stored/compared values.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM-DD' -> 'July 11, 2026'
export function formatDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

// 'YYYY-MM' -> 'July 2026'
export function formatMonth(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
