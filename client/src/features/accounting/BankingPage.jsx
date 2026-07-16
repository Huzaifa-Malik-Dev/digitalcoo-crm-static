import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, Button, Modal, Stack, TextInput, Select, NumberInput, Text, Title, Group, ActionIcon } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '../../utils/toast';
import { Plus, ArrowLeftRight, ArrowLeft } from 'lucide-react';
import { fetchAccounts, createAccount, recordTransaction } from '../../api/accounting';
import { fetchChartOfAccounts } from '../../api/journal';
import { useAuth } from '../../context/AuthContext';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function BankingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canView = user.modules?.includes('accounting.chartOfAccounts');
  const canEdit = user.editModules?.includes('accounting.chartOfAccounts');

  const queryClient = useQueryClient();
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const [recordTxOpen, setRecordTxOpen] = useState(false);

  const accountsQuery = useQuery({ queryKey: ['accounting', 'accounts'], queryFn: fetchAccounts, enabled: canView });
  const accounts = accountsQuery.data?.data || [];

  const coaQuery = useQuery({
    queryKey: ['accounting', 'coa', { postable: true }],
    queryFn: () => fetchChartOfAccounts({ postable: true }),
    enabled: canEdit,
  });
  const coaAccounts = coaQuery.data?.data || [];

  const accountForm = useForm({ initialValues: { name: '', type: 'Bank', opening: '' } });
  const txForm = useForm({
    initialValues: { account: '', type: 'Deposit', date: new Date().toISOString().slice(0, 10), amount: '', contraAccount: '', note: '' },
  });

  const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: ['accounting', 'accounts'] });

  const handleCreateAccount = async (values) => {
    try {
      await createAccount({ ...values, opening: values.opening === '' ? 0 : values.opening });
      notifications.show({ color: 'green', message: 'Account created' });
      setNewAccountOpen(false);
      accountForm.reset();
      refreshAccounts();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleRecordTx = async (values) => {
    try {
      await recordTransaction(values);
      notifications.show({ color: 'green', message: 'Transaction recorded' });
      setRecordTxOpen(false);
      txForm.reset();
      refreshAccounts();
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
            <Title order={1} size="h3">Banking</Title>
          </Group>
        }
        actions={
          canView && canEdit && (
            <>
              <Button leftSection={<Plus size={16} />} onClick={() => setNewAccountOpen(true)}>New Account</Button>
              <Button variant="light" leftSection={<ArrowLeftRight size={16} />} onClick={() => setRecordTxOpen(true)}>Record Transaction</Button>
            </>
          )
        }
      />

      {!canView ? (
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      ) : (
        <>
          <Table.ScrollContainer minWidth={600} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Account</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Opening</Table.Th>
                  <Table.Th>Running Balance</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {accounts.map((a) => (
                  <Table.Tr key={a._id}>
                    <Table.Td>{a.name}</Table.Td>
                    <Table.Td><Tag>{a.type}</Tag></Table.Td>
                    <Table.Td>{AED(a.opening)}</Table.Td>
                    <Table.Td><Text fw={700}>{AED(a.balance)}</Text></Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="light"
                        disabled={!a.coaAccountId}
                        onClick={() => navigate(`/accounting/ledger/${a.coaAccountId}`, { state: { from: 'banking' } })}
                      >
                        Transactions
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {accounts.length === 0 && (
                  <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md">No accounts yet</Text></Table.Td></Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      )}

      <Modal opened={newAccountOpen} onClose={() => setNewAccountOpen(false)} title="New Account">
        <form onSubmit={accountForm.onSubmit(handleCreateAccount)}>
          <Stack gap="sm">
            <TextInput label="Account Name" placeholder="e.g. ADIB Current Account" required {...accountForm.getInputProps('name')} />
            <Select label="Type" data={['Bank', 'Cash']} required {...accountForm.getInputProps('type')} />
            <NumberInput label="Opening Balance (AED)" {...accountForm.getInputProps('opening')} />
            <Button type="submit" mt="sm">Save Account</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={recordTxOpen} onClose={() => setRecordTxOpen(false)} title="Record Transaction">
        <form onSubmit={txForm.onSubmit(handleRecordTx)}>
          <Stack gap="sm">
            <Select
              label="Account"
              data={accounts.map((a) => ({ value: a._id, label: a.name }))}
              required
              {...txForm.getInputProps('account')}
            />
            <Select label="Type" data={['Deposit', 'Withdrawal']} required {...txForm.getInputProps('type')} />
            <TextInput type="date" label="Date" required {...txForm.getInputProps('date')} />
            <NumberInput label="Amount (AED)" min={0.01} required {...txForm.getInputProps('amount')} />
            <Select
              label="Contra Account"
              description="The other side of this transaction in the Chart of Accounts"
              data={coaAccounts.map((a) => ({ value: a._id, label: `${a.code} ${a.name}` }))}
              required
              {...txForm.getInputProps('contraAccount')}
            />
            <TextInput label="Note" {...txForm.getInputProps('note')} />
            <Button type="submit" mt="sm">Save Transaction</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
