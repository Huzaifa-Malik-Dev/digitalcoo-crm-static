import { useState } from 'react';
import { Stack, Timeline, Text, Paper, Select, TextInput, Group, Loader, Center, Pagination } from '@mantine/core';
import { Activity, Monitor, Globe, Search } from 'lucide-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { fetchActivityLog } from '../../api/admin';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';

// Same module keys middlewares/requestContext.js tags every action with (derived from the route
// mount points in server/app.js) - kept as a plain list here rather than a new API round-trip
// since route mount points essentially never change.
const MODULE_OPTIONS = [
  { value: 'dsr', label: 'DSR' }, { value: 'pipeline', label: 'Sales Pipeline' },
  { value: 'backoffice', label: 'Back Office / Orders' }, { value: 'hr', label: 'HR' },
  { value: 'payroll', label: 'Payroll' }, { value: 'accounting', label: 'Accounting' },
  { value: 'admin', label: 'Admin / Settings' }, { value: 'products', label: 'Products' },
  { value: 'leave', label: 'Leave' }, { value: 'attendance', label: 'Attendance' },
  { value: 'auth', label: 'Login / Auth' }, { value: 'other', label: 'Other' },
];

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// A short device summary from the raw User-Agent string - enough to tell "Chrome on Windows" vs
// "Safari on iPhone" apart at a glance without dumping the full UA string into every row.
function deviceSummary(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function ActivityTimelinePage() {
  const [page, setPage] = useState(1);
  const [module, setModule] = useState(null);
  const [month, setMonth] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'activity', page, module, month, debouncedSearch],
    queryFn: () => fetchActivityLog({
      page, limit: 25, module: module || undefined, month: month || undefined, search: debouncedSearch || undefined,
    }),
  });

  const rows = data?.data || [];
  const totalRowCount = data?.meta?.totalRowCount || 0;
  const totalPages = Math.max(1, Math.ceil(totalRowCount / 25));

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Every action taken across the app — who, what, when, and from where. Filter by section, month, or search the description.
      </Text>

      <Group gap="sm">
        <Select
          placeholder="All sections"
          data={MODULE_OPTIONS}
          value={module}
          onChange={(v) => { setModule(v); setPage(1); }}
          clearable
          w={200}
        />
        <MonthInput placeholder="All time" value={month} onChange={(v) => { setMonth(v); setPage(1); }} w={160} />
        <TextInput
          placeholder="Search actor or action..."
          leftSection={<Search size={14} />}
          value={search}
          onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }}
          w={280}
        />
        <Text size="sm" c="dimmed">{totalRowCount.toLocaleString()} entries</Text>
      </Group>

      <Paper withBorder p="md" radius="md">
        {isLoading ? (
          <Center py="xl"><Loader size="sm" /></Center>
        ) : rows.length === 0 ? (
          <Center py="xl"><Text c="dimmed">No activity recorded for this filter</Text></Center>
        ) : (
          <Timeline active={rows.length} bulletSize={26} lineWidth={2}>
            {rows.map((r) => (
              <Timeline.Item key={r._id} bullet={<Activity size={14} />} title={r.actorLabel}>
                <Text size="sm">{r.message}</Text>
                <Group gap="md" mt={4}>
                  <Text size="xs" c="dimmed">{timeAgo(r.createdAt)}</Text>
                  {r.module && <Tag size="xs">{MODULE_OPTIONS.find((m) => m.value === r.module)?.label || r.module}</Tag>}
                  {r.ip && (
                    <Group gap={4}>
                      <Globe size={12} />
                      <Text size="xs" c="dimmed">{r.ip}</Text>
                    </Group>
                  )}
                  {r.userAgent && (
                    <Group gap={4}>
                      <Monitor size={12} />
                      <Text size="xs" c="dimmed">{deviceSummary(r.userAgent)}</Text>
                    </Group>
                  )}
                </Group>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Paper>

      {totalPages > 1 && (
        <Group justify="center">
          <Pagination total={totalPages} value={page} onChange={setPage} withEdges size="sm" />
        </Group>
      )}
    </Stack>
  );
}
