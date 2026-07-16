import { useState, useEffect } from 'react';
import { Stack, Title, Text, Group, Table, Loader, Center, Paper, SimpleGrid } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { fetchAttendance, bulkUpsertAttendance, clearAttendance } from '../../api/attendance';
import { fetchHolidays } from '../../api/leave';
import { fetchEmployees } from '../../api/hr';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';

// Weekend is NOT a manually-cyclable status - it's a fixed rule (Sunday, always, per the 6-day
// UAE workweek this module was built around), computed automatically below, not something anyone
// picks. Holiday stays manual since company holidays vary and aren't reliably computable.
const STATUS_CYCLE = ['Present', 'Absent', 'Half Day', 'On Leave', 'Holiday'];
// Blank sits at both ends of the cycle - clicking a never-touched cell marks it Present first;
// clicking all the way through the last status (Holiday) wraps back to blank, i.e. "unmark this,
// same as if it was never touched" rather than looping straight back to Present.
const CYCLE_WITH_BLANK = ['', ...STATUS_CYCLE];
// Weekend kept here (colors/abbreviation only, not in STATUS_CYCLE) since Sunday cells still
// need to render it - just never as something a click can assign.
const STATUS_COLOR = { Present: 'green', Absent: 'red', 'Half Day': 'orange', 'On Leave': 'blue', Holiday: 'grape', Weekend: 'gray' };
const STATUS_ABBR = { Present: 'P', Absent: 'A', 'Half Day': 'HD', 'On Leave': 'L', Holiday: 'H', Weekend: 'W' };
const LEGEND = [...STATUS_CYCLE, 'Weekend'];

function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

function todayMonth() {
  return new Date().toISOString().slice(0, 7);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// The month grid for HR/Admin - only today's column is ever clickable. Attendance is a
// day-of-record fact: marking a future day pre-decides something that hasn't happened yet, and
// re-marking a past day would let a record be quietly rewritten after the fact (payroll/leave
// both read off this). A click saves immediately (one bulkWrite call, single-entry array - see
// server/controllers/attendanceController.js) - no separate "Save Changes" step to forget.
function AttendanceGrid({ year, month }) {
  const days = daysInMonth(year, month);
  const dayList = Array.from({ length: days }, (_, i) => String(i + 1).padStart(2, '0'));
  const today = todayDate();

  const employeesQuery = useQuery({ queryKey: ['hr', 'employees-for-select', 'attendance'], queryFn: () => fetchEmployees({ limit: 300, active: 'true', sort: 'name' }) });
  const holidaysQuery = useQuery({ queryKey: ['leave', 'holidays', year], queryFn: () => fetchHolidays({ year }) });
  const attendanceQuery = useQuery({ queryKey: ['attendance', year, month], queryFn: () => fetchAttendance({ year, month }) });

  const employees = employeesQuery.data?.data || [];
  const holidaySet = new Set((holidaysQuery.data?.data || []).map((h) => h.date));
  const [grid, setGrid] = useState({}); // { `${employeeId}_${date}`: status }
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    const next = {};
    for (const row of attendanceQuery.data?.data || []) {
      next[`${row.employee._id}_${row.date}`] = row.status;
    }
    setGrid(next);
  }, [attendanceQuery.data]);

  const cellStatus = (employeeId, day) => {
    const date = `${year}-${month}-${day}`;
    const key = `${employeeId}_${date}`;
    if (grid[key]) return grid[key];
    if (holidaySet.has(date)) return 'Holiday';
    if (new Date(date).getDay() === 0) return 'Weekend';
    return '';
  };

  const cycleCell = async (employeeId, day) => {
    const date = `${year}-${month}-${day}`;
    if (date !== today) return; // only today is ever editable - defense in depth, matches the server check
    if (new Date(date).getDay() === 0) return; // Sunday is always Weekend, never manually settable - even if today is a Sunday
    const key = `${employeeId}_${date}`;
    const current = cellStatus(employeeId, day);
    const idx = CYCLE_WITH_BLANK.indexOf(current);
    const next = CYCLE_WITH_BLANK[(idx + 1) % CYCLE_WITH_BLANK.length];
    const previous = grid[key];
    setGrid((g) => ({ ...g, [key]: next }));
    setSavingKey(key);
    try {
      // Landing back on blank clears the record entirely (see attendanceController.clearAttendance)
      // rather than saving an empty status - "never touched" has to mean the row is actually gone,
      // not a status value that happens to render as nothing.
      if (next) await bulkUpsertAttendance([{ employee: employeeId, date, status: next }]);
      else await clearAttendance(employeeId, date);
    } catch (err) {
      setGrid((g) => ({ ...g, [key]: previous }));
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    } finally {
      setSavingKey(null);
    }
  };

  if (employeesQuery.isLoading || attendanceQuery.isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  return (
    <Stack gap="sm">
      <Group gap="xs">
        {LEGEND.map((s) => (
          <Tag key={s} color={STATUS_COLOR[s]}>{STATUS_ABBR[s]} = {s}</Tag>
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        Click a cell in today's column ({formatDate(today)}) to cycle its status — saves immediately, and cycling past Holiday clears it back to unmarked. Past and future days are locked. Sundays are always Weekend and can't be changed.
      </Text>
      <Table.ScrollContainer minWidth={800}>
        <Table striped withColumnBorders verticalSpacing={2} horizontalSpacing={4} fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ position: 'sticky', left: 0, background: 'var(--panel-bg)', zIndex: 1 }}>Employee</Table.Th>
              {dayList.map((d) => (
                <Table.Th key={d} style={{ textAlign: 'center', color: `${year}-${month}-${d}` === today ? 'var(--mantine-color-red-6)' : undefined }}>
                  {d}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {employees.map((emp) => (
              <Table.Tr key={emp._id}>
                <Table.Td style={{ position: 'sticky', left: 0, background: 'var(--panel-bg)', zIndex: 1, whiteSpace: 'nowrap' }}>{emp.name}</Table.Td>
                {dayList.map((day) => {
                  const date = `${year}-${month}-${day}`;
                  const isToday = date === today;
                  const isSunday = new Date(date).getDay() === 0;
                  const isEditable = isToday && !isSunday;
                  const status = cellStatus(emp._id, day);
                  const key = `${emp._id}_${date}`;
                  return (
                    <Table.Td
                      key={day}
                      style={{
                        textAlign: 'center',
                        cursor: isEditable ? 'pointer' : 'not-allowed',
                        opacity: savingKey === key ? 0.5 : 1,
                        outline: isToday ? '1px solid var(--mantine-color-red-6)' : undefined,
                        outlineOffset: -1,
                        background: status ? `var(--mantine-color-${STATUS_COLOR[status]}-light)` : undefined,
                      }}
                      onClick={() => cycleCell(emp._id, day)}
                    >
                      {status ? STATUS_ABBR[status] : ''}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
            {employees.length === 0 && (
              <Table.Tr><Table.Td colSpan={days + 1}><Text c="dimmed" ta="center" py="md">No employees found</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

// Weekend is deliberately excluded - it's just a count of Sundays that passed, not anything
// meaningful about the employee's own attendance.
const SUMMARY_TILES = [
  { key: 'Present', color: 'green' },
  { key: 'Absent', color: 'red' },
  { key: 'Half Day', color: 'orange' },
  { key: 'On Leave', color: 'blue' },
  { key: 'Holiday', color: 'grape' },
];

// Read-only own-attendance view for everyone else - the /users roster endpoint (needed to build
// a team grid) is admin/hr-only, so a manager's "team view" isn't buildable from what exists
// today; showing your own month as a dashboard is the honest, buildable scope. Counts are computed
// client-side from the same day-by-day logic AttendanceGrid uses (explicit record, else
// auto-Holiday/Weekend) - there's no server-side rollup for this (see attendanceController.js),
// and a month's worth of rows is small enough that re-deriving it here is simpler than adding one.
function MyAttendanceList({ year, month, userId }) {
  const attendanceQuery = useQuery({ queryKey: ['attendance', year, month, userId], queryFn: () => fetchAttendance({ year, month, employee: userId }) });
  const holidaysQuery = useQuery({ queryKey: ['leave', 'holidays', year], queryFn: () => fetchHolidays({ year }) });
  const rows = attendanceQuery.data?.data || [];
  if (attendanceQuery.isLoading || holidaysQuery.isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  const holidaySet = new Set((holidaysQuery.data?.data || []).map((h) => h.date));
  const recordByDate = {};
  rows.forEach((r) => { recordByDate[r.date] = r; });

  const today = todayDate();
  const days = daysInMonth(year, month);
  const counts = { Present: 0, Absent: 0, 'Half Day': 0, 'On Leave': 0, Holiday: 0, Weekend: 0 };
  let workingDaysSoFar = 0;
  for (let d = 1; d <= days; d += 1) {
    const date = `${year}-${month}-${String(d).padStart(2, '0')}`;
    if (date > today) break; // don't count days that haven't happened yet
    let status = recordByDate[date]?.status;
    if (!status) {
      if (holidaySet.has(date)) status = 'Holiday';
      else if (new Date(date).getDay() === 0) status = 'Weekend';
    }
    if (status && counts[status] !== undefined) counts[status] += 1;
    if (status === 'Present' || status === 'Absent' || status === 'Half Day') workingDaysSoFar += 1;
  }
  const attendanceRate = workingDaysSoFar > 0 ? Math.round(((counts.Present + counts['Half Day'] * 0.5) / workingDaysSoFar) * 100) : null;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }}>
        {SUMMARY_TILES.map((t) => (
          <Paper key={t.key} withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">{t.key}</Text>
            <Text size="xl" fw={700} c={t.color}>{counts[t.key]}</Text>
          </Paper>
        ))}
      </SimpleGrid>
      {attendanceRate !== null && (
        <Paper withBorder p="md" radius="md">
          <Text size="sm" c="dimmed">Attendance rate this month</Text>
          <Text size="xl" fw={700}>{attendanceRate}%</Text>
          <Text size="xs" c="dimmed">Present (Half Day counts as half) over {workingDaysSoFar} working day(s) so far — Weekends and Holidays aren't counted against you</Text>
        </Paper>
      )}
      <Table.ScrollContainer minWidth={400}>
        <Table striped verticalSpacing="xs">
          <Table.Thead><Table.Tr><Table.Th>Date</Table.Th><Table.Th>Status</Table.Th><Table.Th>Notes</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r._id}>
                <Table.Td>{formatDate(r.date)}</Table.Td>
                <Table.Td><Tag color={STATUS_COLOR[r.status]}>{r.status}</Tag></Table.Td>
                <Table.Td c="dimmed">{r.notes}</Table.Td>
              </Table.Tr>
            ))}
            {rows.length === 0 && (
              <Table.Tr><Table.Td colSpan={3}><Text c="dimmed" ta="center" py="md">No attendance recorded for this month yet</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

export default function AttendanceRegisterPage() {
  const { user } = useAuth();
  const canView = user.modules?.includes('attendance');
  const canEdit = user.editModules?.includes('attendance.manage');
  const [monthValue, setMonthValue] = useState(todayMonth());
  const [year, month] = monthValue.split('-');

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Attendance</Title>
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <PageToolbar
        title={<Title order={1} size="h3">Attendance</Title>}
        actions={<MonthInput value={monthValue} onChange={setMonthValue} max={todayMonth()} w={180} />}
      />

      {canEdit ? <AttendanceGrid year={year} month={month} /> : <MyAttendanceList year={year} month={month} userId={user._id} />}
    </Stack>
  );
}
