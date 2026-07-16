import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Group, Modal, Stack, Title, Text, Table, Paper, TextInput, Center, Loader } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { ArrowLeft, Undo2 } from 'lucide-react';
import { fetchJournalEntry, reverseJournalEntry } from '../../api/journal';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';
import Tag from '../../components/Tag';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function JournalEntryDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canView = user.modules?.includes('accounting.journal');
  const queryClient = useQueryClient();

  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseMemo, setReverseMemo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['accounting', 'journal', id],
    queryFn: () => fetchJournalEntry(id),
    enabled: canView,
  });
  const entry = data?.data;

  const handleReverse = async () => {
    try {
      const res = await reverseJournalEntry(id, reverseMemo || undefined);
      notifications.show({ color: 'green', message: `Reversal entry ${res.data.entryNo} posted` });
      setReverseOpen(false);
      setReverseMemo('');
      queryClient.invalidateQueries({ queryKey: ['accounting', 'journal'] });
      navigate(`/accounting/journal/${res.data._id}`);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not reverse', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Journal Entry</Title>
        <Text c="dimmed" size="sm">You don't have access to this section.</Text>
      </Stack>
    );
  }

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;
  if (!entry) return <Text c="dimmed">Journal entry not found.</Text>;

  const canReverse = user.role === 'admin' && entry.refType === 'Manual' && !entry.reversedBy && !entry.reversalOf;

  return (
    <Stack>
      <Group justify="space-between">
        <Button variant="subtle" leftSection={<ArrowLeft size={16} />} onClick={() => navigate('/accounting/journal')}>
          Back to Journal
        </Button>
        {canReverse && (
          <Button color="red" variant="light" leftSection={<Undo2 size={16} />} onClick={() => setReverseOpen(true)}>
            Reverse Entry
          </Button>
        )}
      </Group>

      <Paper withBorder p="md" radius="md">
        <Group justify="space-between" mb="xs">
          <Title order={1} size="h3">{entry.entryNo}</Title>
          <Tag>{entry.refType}</Tag>
        </Group>
        <Text size="sm">{formatDate(entry.date)} · {entry.memo}</Text>
        <Text size="xs" c="dimmed" mt={4}>
          Posted by {entry.postedBy?.name || '-'}{entry.postedBy?.employeeId ? ` (${entry.postedBy.employeeId})` : ''} · Created {new Date(entry.createdAt).toLocaleString()}
        </Text>

        {entry.reversalOf && (
          <Text size="sm" mt="xs">
            Reverses entry{' '}
            <Text
              component="span"
              fw={600}
              c="blue"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/accounting/journal/${entry.reversalOf._id}`)}
            >
              {entry.reversalOf.entryNo}
            </Text>
          </Text>
        )}
        {entry.reversedBy && (
          <Text size="sm" mt="xs">
            Reversed by entry{' '}
            <Text
              component="span"
              fw={600}
              c="blue"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/accounting/journal/${entry.reversedBy._id}`)}
            >
              {entry.reversedBy.entryNo}
            </Text>
          </Text>
        )}
      </Paper>

      <Table.ScrollContainer minWidth={600} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Account</Table.Th>
              <Table.Th>Debit</Table.Th>
              <Table.Th>Credit</Table.Th>
              <Table.Th>Note</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entry.lines.map((line, idx) => (
              <Table.Tr key={idx}>
                <Table.Td>{line.account?.code} - {line.account?.name}</Table.Td>
                <Table.Td>{line.debit ? AED(line.debit) : ''}</Table.Td>
                <Table.Td>{line.credit ? AED(line.credit) : ''}</Table.Td>
                <Table.Td c="dimmed">{line.note}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr style={{ borderTop: '2px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-default-hover)' }}>
              <Table.Th>Total</Table.Th>
              <Table.Th>{AED(entry.totalDebit)}</Table.Th>
              <Table.Th>{AED(entry.totalCredit)}</Table.Th>
              <Table.Th></Table.Th>
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={reverseOpen} onClose={() => setReverseOpen(false)} title="Reverse Journal Entry">
        <Stack gap="sm">
          <Text size="sm" c="dimmed">This posts a new balancing entry that reverses {entry.entryNo}. This cannot be undone.</Text>
          <TextInput label="Memo (optional)" value={reverseMemo} onChange={(e) => setReverseMemo(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setReverseOpen(false)}>Cancel</Button>
            <Button color="red" onClick={handleReverse}>Confirm Reversal</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
