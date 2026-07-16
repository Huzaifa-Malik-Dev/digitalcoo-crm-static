import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Stack, Title, Text, Paper, Table, ActionIcon, Center, Loader, Divider, Group } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchComplianceSummary } from '../../api/hr';
import { employeeUrlId } from './employeeUrl';
import { formatDate } from '../../utils/date';
import PageToolbar from '../../components/PageToolbar';
import Tag from '../../components/Tag';

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

// "5 days overdue" / "in 12 days" - the actual number an HR admin needs to decide what to chase
// today, instead of two raw dates they'd have to subtract in their head.
function ExpirySub({ expiry, expired }) {
  const days = daysBetween(expiry);
  if (days === null) return null;
  const text = expired ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue` : `in ${days} day${days === 1 ? '' : 's'}`;
  return <Text size="xs" c={expired ? 'red' : 'yellow'}>{text}</Text>;
}

function EmployeeSection({ title, color, rows, navigate }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Divider label={<Tag color={color}>{title} ({rows.length})</Tag>} labelPosition="left" mb="sm" />
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">None</Text>
      ) : (
        <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': `${title}, scrollable` } }}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Employee</Table.Th>
                <Table.Th>Designation</Table.Th>
                <Table.Th>Document No.</Table.Th>
                <Table.Th>Issue Date</Table.Th>
                <Table.Th>Expiry Date</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((e) => (
                <Table.Tr
                  key={e._id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/hr/employees/${employeeUrlId(e.employeeId)}`)}
                >
                  <Table.Td>
                    <Text fw={600} size="sm">{e.name}</Text>
                    <Text size="xs" c="dimmed">{e.employeeId}{e.active === false ? ' · Inactive' : ''}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{e.desig || '—'}</Text>
                    <Text size="xs" c="dimmed">{e.dept}</Text>
                  </Table.Td>
                  <Table.Td>{e.docNo || '—'}</Table.Td>
                  <Table.Td>{formatDate(e.issueDate) || '—'}</Table.Td>
                  <Table.Td>{formatDate(e.expiry) || '—'}</Table.Td>
                  <Table.Td><ExpirySub expiry={e.expiry} expired={color === 'red'} /></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Paper>
  );
}

// The document-expiry detail page for one category (passport/visa/EID/labour card/insurance) -
// used to be a small popup Modal off the HR dashboard, which had no room to show anything beyond
// a name and a bare date. A real page can show the actual document number, issue date, and how
// overdue/soon each one is, which is the detail an HR admin actually needs to act on.
export default function ComplianceDetailPage() {
  const { category } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['hr', 'compliance-summary'], queryFn: fetchComplianceSummary });

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  const categories = data?.data?.categories || [];
  const cat = categories.find((c) => c.key === category);

  if (!cat) return <Text c="dimmed">Document category not found.</Text>;

  return (
    <Stack gap="md">
      <PageToolbar
        title={
          <Group>
            <ActionIcon variant="subtle" onClick={() => navigate('/hr')} aria-label="Back to HR">
              <ArrowLeft size={18} />
            </ActionIcon>
            <Title order={3}>{cat.label}</Title>
          </Group>
        }
        subtitle={`${cat.expiredCount} expired · ${cat.expiringCount} expiring within 30 days`}
      />

      <EmployeeSection title="Expired" color="red" rows={cat.expired} navigate={navigate} />
      <EmployeeSection title="Expiring within 30 days" color="yellow" rows={cat.expiring} navigate={navigate} />
    </Stack>
  );
}
