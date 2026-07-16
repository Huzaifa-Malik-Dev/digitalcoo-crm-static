import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Stack, Title, Text, Group, Paper, SimpleGrid, ActionIcon, Avatar, RingProgress, Center,
  Loader, Table,
} from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchAgentPerformance } from '../../api/mis';
import { ROLE_LABELS } from '../../constants/nav';
import { STAGE_COLOR, APPROVAL_COLOR, APPROVAL_LABEL } from '../../constants/pipeline';
import { colorFor, initials } from '../../utils/avatar';
import { formatDate } from '../../utils/date';
import MonthInput from '../../components/MonthInput';
import PageToolbar from '../../components/PageToolbar';
import Tag from '../../components/Tag';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

function StatCard({ label, value, sub, color = 'blue' }) {
  return (
    <Paper withBorder p="md" radius="md" style={{ borderLeft: `3px solid var(--mantine-color-${color}-6)` }}>
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="xl" fw={700}>{value}</Text>
      {sub && <Text size="xs" c="dimmed">{sub}</Text>}
    </Paper>
  );
}

// The MIS drill-down: how much this specific person (or, for a manager, their whole team) has
// actually done - target vs achievement, submissions, pipeline, activations - not just their
// generic HR profile.
export default function AgentPerformancePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [month, setMonth] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['mis', 'agent', id, month],
    queryFn: () => fetchAgentPerformance(id, { month: month || undefined }),
  });

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  const d = data?.data;
  if (!d) return <Text c="dimmed">No performance data found.</Text>;

  const {
    person, rows, totals,
    pipelineRecords = [], pipelineTotal = 0, pipelineTruncated = false,
    dsrRecords = [], dsrTotal = 0, dsrTruncated = false,
  } = d;
  const isManager = person.role !== 'agent';
  const pctColor = totals.achievementPct >= 100 ? 'green' : totals.achievementPct >= 50 ? 'yellow' : 'red';

  return (
    <Stack gap="md">
      <PageToolbar
        title={
          <Group>
            <ActionIcon variant="subtle" onClick={() => navigate('/mis')} aria-label="Back to MIS">
              <ArrowLeft size={18} />
            </ActionIcon>
            <Avatar size={44} radius="xl" color={colorFor(person.name)}>{initials(person.name)}</Avatar>
            <div>
              <Title order={3}>{person.name}</Title>
              <Group gap="xs">
                <Text size="sm" c="dimmed">{person.employeeId} · {person.desig}</Text>
                <Tag size="xs">{ROLE_LABELS[person.role] || person.role}</Tag>
              </Group>
            </div>
          </Group>
        }
        subtitle={`${isManager ? 'Rolled up across everyone reporting up to them.' : 'Individual performance.'} ${month ? `Showing ${month}.` : 'Showing lifetime totals.'}`}
        actions={<MonthInput value={month} onChange={setMonth} placeholder="All time" w={160} />}
      />

      <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }}>
        <StatCard label="Target" value={AED(totals.target)} color="gray" />
        <StatCard label="MRC Achieved" value={AED(totals.achieved)} sub={`${totals.achievementPct}% of target`} color={pctColor} />
        <StatCard label="Submissions (90%)" value={totals.submissions} sub={`${totals.interested} interested`} color="blue" />
        <StatCard label="Activated Deals" value={totals.activatedCount} sub={`${totals.pipelineCount} in pipeline · ${AED(totals.pipelineValue)}`} color="teal" />
        <StatCard label="Corrections Requested" value={totals.corrections} sub="Times an order was sent back to Pipeline" color={totals.corrections > 0 ? 'orange' : 'gray'} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <Paper withBorder p="md" radius="md" style={{ gridColumn: 'span 1' }}>
          <Text fw={600} mb="sm" ta="center">Target vs Achievement</Text>
          <Center>
            <RingProgress
              size={150}
              thickness={15}
              roundCaps
              sections={[{ value: Math.min(100, totals.achievementPct), color: pctColor }]}
              label={<Text ta="center" fw={700} size="lg">{totals.achievementPct}%</Text>}
            />
          </Center>
          <Text ta="center" size="xs" c="dimmed" mt="xs">{AED(totals.achieved)} of {AED(totals.target)}</Text>
        </Paper>

        {isManager && (
          <Paper withBorder p="md" radius="md" style={{ gridColumn: 'span 2' }}>
            <Text fw={600} mb="sm">Team Breakdown</Text>
            <Table.ScrollContainer minWidth={500} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
              <Table striped highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Agent</Table.Th>
                    <Table.Th>Target</Table.Th>
                    <Table.Th>MRC Achieved</Table.Th>
                    <Table.Th>Achievement</Table.Th>
                    <Table.Th>Corrections</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.length === 0 ? (
                    <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" size="sm">No agents in scope</Text></Table.Td></Table.Tr>
                  ) : (
                    rows.map((r) => (
                      <Table.Tr key={r.agentId} onClick={() => navigate(`/mis/${r.agentId}`)} style={{ cursor: 'pointer' }}>
                        <Table.Td>{r.name}</Table.Td>
                        <Table.Td>{AED(r.target)}</Table.Td>
                        <Table.Td>{AED(r.achieved)}</Table.Td>
                        <Table.Td>{r.achievementPct}%</Table.Td>
                        <Table.Td>
                          <Text size="sm" c={r.corrections > 0 ? 'orange' : 'dimmed'}>{r.corrections}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        )}
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>Pipeline Deals ({pipelineTotal})</Text>
          {pipelineTruncated && <Text size="xs" c="dimmed">Showing the {pipelineRecords.length} most recent — {pipelineTotal} total</Text>}
        </Group>
        {pipelineRecords.length === 0 ? (
          <Text size="sm" c="dimmed">No deals in this period.</Text>
        ) : (
          <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Pipeline deals, scrollable horizontally' } }}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>DSR No.</Table.Th>
                  <Table.Th>Company</Table.Th>
                  <Table.Th>Product</Table.Th>
                  {isManager && <Table.Th>Agent</Table.Th>}
                  <Table.Th>MRC</Table.Th>
                  <Table.Th>Stage</Table.Th>
                  <Table.Th>Approval</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pipelineRecords.map((p) => (
                  <Table.Tr key={p.dsrNo}>
                    <Table.Td>{p.dsrNo}</Table.Td>
                    <Table.Td>{p.company}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{p.product || '—'}</Text>
                      {p.cat && <Text size="xs" c="dimmed">{p.cat}</Text>}
                    </Table.Td>
                    {isManager && <Table.Td>{p.agentName || '—'}</Table.Td>}
                    <Table.Td>{AED(p.mrc)}</Table.Td>
                    <Table.Td><Tag color={STAGE_COLOR[p.stage]}>{p.stage}</Tag></Table.Td>
                    <Table.Td>{APPROVAL_LABEL[p.approval] ? <Tag color={APPROVAL_COLOR[p.approval]}>{APPROVAL_LABEL[p.approval]}</Tag> : <Text size="xs" c="dimmed">—</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>Interested DSR Calls ({dsrTotal})</Text>
          {dsrTruncated && <Text size="xs" c="dimmed">Showing the {dsrRecords.length} most recent — {dsrTotal} total</Text>}
        </Group>
        {dsrRecords.length === 0 ? (
          <Text size="sm" c="dimmed">No interested calls in this period.</Text>
        ) : (
          <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Interested DSR calls, scrollable horizontally' } }}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>DSR No.</Table.Th>
                  <Table.Th>Company</Table.Th>
                  <Table.Th>Contact</Table.Th>
                  {isManager && <Table.Th>Agent</Table.Th>}
                  <Table.Th>Date</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {dsrRecords.map((r) => (
                  <Table.Tr key={r.dsrNo}>
                    <Table.Td>{r.dsrNo}</Table.Td>
                    <Table.Td>{r.company}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.customer || '—'}</Text>
                      <Text size="xs" c="dimmed">{r.contactNo}</Text>
                    </Table.Td>
                    {isManager && <Table.Td>{r.agentName || '—'}</Table.Td>}
                    <Table.Td>{formatDate(r.date)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>
    </Stack>
  );
}
