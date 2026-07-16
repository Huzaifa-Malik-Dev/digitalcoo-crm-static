import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stack, Title, Button, Paper, Table, Progress, Text, Loader, Center, Group } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { fetchMisRollup, misExportUrl } from '../../api/mis';
import MonthInput from '../../components/MonthInput';
import PageToolbar from '../../components/PageToolbar';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString()}`;
}

function pctColor(pct) {
  if (pct >= 100) return 'green';
  if (pct >= 50) return 'yellow';
  return 'red';
}

export default function MisPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['mis', 'rollup', month],
    queryFn: () => fetchMisRollup({ month: month || undefined }),
  });

  const rows = data?.data?.rows || [];
  const totals = data?.data?.totals;

  return (
    <Stack>
      <PageToolbar
        title={<Title order={1} size="h3">MIS & Targets</Title>}
        subtitle={`${month ? `Showing ${month}` : 'Showing lifetime totals — pick a month above to filter'} · Click a row to see their performance detail.`}
        actions={
          <>
            <MonthInput value={month} onChange={setMonth} placeholder="All time" w={160} />
            <Button leftSection={<Upload size={16} />} variant="light" component="a" href={misExportUrl(month)} target="_blank" rel="noreferrer">
              Export CSV
            </Button>
          </>
        }
      />

      <Paper withBorder p="md" radius="md">
        {isLoading ? (
          <Center py="xl"><Loader size="sm" /></Center>
        ) : (
          <Table.ScrollContainer minWidth={800} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Agent</Table.Th>
                  <Table.Th>Target</Table.Th>
                  <Table.Th>Submissions</Table.Th>
                  <Table.Th>Interested</Table.Th>
                  <Table.Th>Pipeline</Table.Th>
                  <Table.Th>Activated Deals</Table.Th>
                  <Table.Th>MRC Achieved</Table.Th>
                  <Table.Th>Achievement</Table.Th>
                  <Table.Th>Corrections</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={9}><Center py="xl"><Text c="dimmed">No agents in scope</Text></Center></Table.Td>
                  </Table.Tr>
                ) : (
                  rows.map((r) => (
                    <Table.Tr
                      key={r.agentId}
                      onClick={() => navigate(`/mis/${r.agentId}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Table.Td>
                        <Text fw={600} size="sm">{r.name}</Text>
                        <Text size="xs" c="dimmed">{r.desig}</Text>
                      </Table.Td>
                      <Table.Td>{AED(r.target)}</Table.Td>
                      <Table.Td>{r.submissions}</Table.Td>
                      <Table.Td>{r.interested}</Table.Td>
                      <Table.Td>{r.pipelineCount} · {AED(r.pipelineValue)}</Table.Td>
                      <Table.Td>{r.activatedCount}</Table.Td>
                      <Table.Td>{AED(r.achieved)}</Table.Td>
                      <Table.Td w={160}>
                        <Group gap="xs" wrap="nowrap">
                          <Progress value={Math.min(100, r.achievementPct)} color={pctColor(r.achievementPct)} size="sm" w={90} aria-label={`${r.achievementPct}% of target achieved`} />
                          <Text size="xs">{r.achievementPct}%</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={r.corrections > 0 ? 'orange' : 'dimmed'} fw={r.corrections > 0 ? 600 : 400}>
                          {r.corrections}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
              {totals && rows.length > 0 && (
                <Table.Tfoot>
                  <Table.Tr style={{ borderTop: '2px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default-hover)' }}>
                    <Table.Th>Total</Table.Th>
                    <Table.Th>{AED(totals.target)}</Table.Th>
                    <Table.Th>{totals.submissions}</Table.Th>
                    <Table.Th>{totals.interested}</Table.Th>
                    <Table.Th>{totals.pipelineCount} · {AED(totals.pipelineValue)}</Table.Th>
                    <Table.Th>{totals.activatedCount}</Table.Th>
                    <Table.Th>{AED(totals.achieved)}</Table.Th>
                    <Table.Th>{totals.achievementPct}%</Table.Th>
                    <Table.Th>{totals.corrections}</Table.Th>
                  </Table.Tr>
                </Table.Tfoot>
              )}
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>
    </Stack>
  );
}
