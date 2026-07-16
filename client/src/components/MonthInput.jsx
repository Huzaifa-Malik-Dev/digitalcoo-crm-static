import { MonthPickerInput } from '@mantine/dates';

const CURRENT_MONTH_DATE = `${new Date().toISOString().slice(0, 7)}-01`;

// Outlines the current month's cell in the dropdown grid (distinct from the blue "selected"
// fill) so it's always obvious at a glance which month you're actually in, same idea as a
// calendar app circling "today".
function getMonthControlProps(date) {
  return date === CURRENT_MONTH_DATE ? { 'data-current-month': true } : {};
}

// A proper click-anywhere-on-the-field month picker, replacing the native <input type="month">
// used across the app - browsers only open that one's calendar when you hit the tiny icon on
// the right, which reads as broken. Speaks the same 'YYYY-MM' string this app already uses for
// month values everywhere (URL segments, API params); Mantine's picker itself works in full
// 'YYYY-MM-DD' date strings under the hood, so this just converts at the edges.
export default function MonthInput({ value, onChange, max, ...rest }) {
  return (
    <MonthPickerInput
      value={value ? `${value}-01` : null}
      onChange={(v) => onChange(v ? v.slice(0, 7) : '')}
      maxDate={max ? `${max}-01` : undefined}
      valueFormat="MMMM YYYY"
      getMonthControlProps={getMonthControlProps}
      classNames={{ monthsListControl: 'month-input-control' }}
      {...rest}
    />
  );
}
