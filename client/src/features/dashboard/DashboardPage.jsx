import { Stack, Title, SimpleGrid, Paper, Text, Group, RingProgress, Center, ScrollArea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { fetchDashboardSummary } from '../../api/dashboard';
import { useAuth } from '../../context/AuthContext';
import PageToolbar from '../../components/PageToolbar';
import Tag from '../../components/Tag';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

function StatCard({ label, value, sub, color }) {
  return (
    <Paper withBorder p="md" radius="md" style={{ borderLeft: `3px solid var(--mantine-color-${color}-6)` }}>
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="xl" fw={700}>{value}</Text>
      {sub && <Text size="xs" c="dimmed">{sub}</Text>}
    </Paper>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: fetchDashboardSummary });
  const s = data?.data;

  const pending = s?.pipeline?.pendingApproval;

  return (
    <Stack>
      <PageToolbar
        title={<Title order={1} size="h3">Dashboard</Title>}
        subtitle={`Welcome back, ${user.name} — here's what's happening in your scope.`}
      />

      {!isLoading && s && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
            <StatCard label="DSR Calls Logged" value={s.dsr.total} sub={`${s.dsr.today} today`} color="blue" />
            <StatCard label="Interested Leads" value={s.dsr.byStatus?.Interested || 0} color="green" />
            <StatCard label="Deals Pending TL Approval" value={pending?.count || 0} sub={pending ? AED(pending.value) : undefined} color="yellow" />
            <StatCard
              label="Orders Activated (This Month)"
              value={s.thisMonth.activatedCount}
              sub={`${AED(s.thisMonth.activatedMrc)} MRC · ${AED(s.thisMonth.commission)} commission`}
              color="teal"
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 3 }}>
            <Paper withBorder p="md" radius="md" style={{ gridColumn: 'span 2' }}>
              <Text fw={600} mb="sm">Pipeline by Stage</Text>
              <Stack gap="xs">
                {Object.keys(s.pipeline.byStage).length === 0 && <Text c="dimmed" size="sm">No deals yet</Text>}
                {Object.entries(s.pipeline.byStage).map(([stage, v]) => (
                  <Group key={stage} justify="space-between">
                    <Tag>{stage}</Tag>
                    <Text size="sm">{v.count} deal{v.count === 1 ? '' : 's'} · {AED(v.value)}</Text>
                  </Group>
                ))}
              </Stack>
              <Text size="xs" c="dimmed" mt="sm">Pending Team Leader approval: {pending?.count || 0} · Open pipeline value: {AED(s.pipeline.openValue)}</Text>
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">Target vs Achievement</Text>
              {s.target.applicable ? (
                <Center>
                  <RingProgress
                    size={140}
                    thickness={14}
                    roundCaps
                    sections={[{ value: Math.min(100, s.target.pct), color: s.target.pct >= 100 ? 'green' : s.target.pct >= 50 ? 'yellow' : 'red' }]}
                    label={<Text ta="center" fw={700} size="lg">{s.target.pct}%</Text>}
                  />
                </Center>
              ) : (
                <Text c="dimmed" size="sm">No sales target applies to this role</Text>
              )}
              {s.target.applicable && (
                <Text ta="center" size="xs" c="dimmed" mt="xs">
                  {AED(s.target.achievement)} of {AED(s.target.value)} (this month)
                </Text>
              )}
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">Orders by Status</Text>
              <Stack gap="xs">
                {Object.keys(s.orders.byStatus).length === 0 && <Text c="dimmed" size="sm">No orders yet</Text>}
                {Object.entries(s.orders.byStatus).map(([status, v]) => (
                  <Group key={status} justify="space-between">
                    <Tag>{status}</Tag>
                    <Text size="sm">{v.count} · {AED(v.value)}</Text>
                  </Group>
                ))}
              </Stack>
            </Paper>

            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">Recent Notifications</Text>
              <ScrollArea h={180} viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Recent notifications, scrollable' }}>
                <Stack gap="xs">
                  {(s.recentNotifications || []).length === 0 && <Text c="dimmed" size="sm">Nothing yet</Text>}
                  {(s.recentNotifications || []).map((n) => (
                    <Text key={n._id} size="sm" fw={n.read ? 400 : 600}>{n.text}</Text>
                  ))}
                </Stack>
              </ScrollArea>
            </Paper>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
