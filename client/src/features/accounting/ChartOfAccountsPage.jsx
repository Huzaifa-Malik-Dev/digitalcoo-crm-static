import { useState } from 'react';
import { Table, Button, Modal, Stack, TextInput, Select, Text, Title, Group, ActionIcon } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifications } from '../../utils/toast';
import { Plus, ArrowLeft } from 'lucide-react';
import { fetchChartOfAccounts, createChartOfAccount } from '../../api/journal';
import { useAuth } from '../../context/AuthContext';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';

const TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ChartOfAccountsPage() {
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('accounting.chartOfAccounts');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const coaQuery = useQuery({ queryKey: ['accounting', 'coa'], queryFn: () => fetchChartOfAccounts() });
  const accounts = [...(coaQuery.data?.data || [])].sort((a, b) => a.code.localeCompare(b.code));
  const groupAccounts = accounts.filter((a) => !a.postable);

  const form = useForm({ initialValues: { code: '', name: '', type: 'Asset', parent: '' } });

  const handleCreate = async (values) => {
    try {
      await createChartOfAccount({ ...values, parent: values.parent || undefined });
      notifications.show({ color: 'green', message: 'Account created' });
      setCreateOpen(false);
      form.reset();
      queryClient.invalidateQueries({ queryKey: ['accounting', 'coa'] });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  return (
    <Stack gap="md">
      <PageToolbar
        title={
          <Group gap="xs">
            <ActionIcon variant="subtle" onClick={() => navigate('/accounting')} aria-label="Back to Accounting">
              <ArrowLeft size={18} />
            </ActionIcon>
            <Title order={1} size="h3">Chart of Accounts</Title>
          </Group>
        }
        actions={canEdit && <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>New Account</Button>}
      />

      <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Balance</Table.Th>
              <Table.Th>Active</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.map((a) => (
              <Table.Tr
                key={a._id}
                style={a.postable ? { cursor: 'pointer' } : undefined}
                onClick={a.postable ? () => navigate(`/accounting/ledger/${a._id}`, { state: { from: 'coa' } }) : undefined}
              >
                <Table.Td>{a.code}</Table.Td>
                <Table.Td>{a.name}</Table.Td>
                <Table.Td><Tag>{a.type}</Tag></Table.Td>
                <Table.Td>{a.balance === null ? '-' : AED(a.balance)}</Table.Td>
                <Table.Td>
                  <Tag color={a.active ? 'green' : 'gray'}>{a.active ? 'Active' : 'Inactive'}</Tag>
                </Table.Td>
              </Table.Tr>
            ))}
            {accounts.length === 0 && (
              <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md">No accounts yet</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Account">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Code" required {...form.getInputProps('code')} />
            <TextInput label="Name" required {...form.getInputProps('name')} />
            <Select label="Type" data={TYPES} required {...form.getInputProps('type')} />
            <Select
              label="Parent"
              placeholder="None"
              clearable
              data={groupAccounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))}
              {...form.getInputProps('parent')}
            />
            <Button type="submit" mt="sm">Save Account</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
