import { useState } from 'react';
import { Stack, Title, Text, Button, Modal, TextInput, NumberInput, Select, Checkbox, Table } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil } from 'lucide-react';
import { notifications } from '../../utils/toast';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';
import { fetchLeaveTypes, createLeaveType, updateLeaveType } from '../../api/leave';
import { useAuth } from '../../context/AuthContext';
import LeaveSubNav from './LeaveSubNav';

export default function LeaveTypesPage() {
  const { user } = useAuth();
  const canView = user.modules?.includes('leave.settings');
  const canEdit = user.editModules?.includes('leave.settings');
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const typesQuery = useQuery({ queryKey: ['leave', 'types', 'all'], queryFn: () => fetchLeaveTypes({}), enabled: canView });
  const types = typesQuery.data?.data || [];

  const createForm = useForm({
    initialValues: { name: '', annualDays: 0, accrualMethod: 'lump-sum', minServiceMonths: 0, paid: true, requiresDocument: false },
  });
  const editForm = useForm({ initialValues: { name: '', annualDays: 0, minServiceMonths: 0, paid: true, requiresDocument: false, active: true } });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['leave', 'types'] });

  const handleCreate = async (values) => {
    try {
      await createLeaveType(values);
      notifications.show({ color: 'green', message: 'Leave type created' });
      setCreateOpen(false);
      createForm.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const openEdit = (row) => {
    editForm.setValues({ name: row.name, annualDays: row.annualDays, minServiceMonths: row.minServiceMonths, paid: row.paid, requiresDocument: row.requiresDocument, active: row.active });
    setEditRow(row);
  };

  const handleEdit = async (values) => {
    try {
      await updateLeaveType(editRow._id, values);
      notifications.show({ color: 'green', message: 'Leave type updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Leave Types</Title>
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <LeaveSubNav />
      <PageToolbar
        title={<Title order={1} size="h3">Leave Types</Title>}
        actions={canEdit && <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>New Leave Type</Button>}
      />

      <Table.ScrollContainer minWidth={700} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th><Table.Th>Days/Year</Table.Th><Table.Th>Accrual</Table.Th>
              <Table.Th>Min. Service</Table.Th><Table.Th>Paid</Table.Th><Table.Th>Doc Required</Table.Th>
              <Table.Th>Status</Table.Th>{canEdit && <Table.Th>Actions</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {types.map((t) => (
              <Table.Tr key={t._id}>
                <Table.Td>{t.name}</Table.Td>
                <Table.Td>{t.annualDays}</Table.Td>
                <Table.Td><Tag>{t.accrualMethod}</Tag></Table.Td>
                <Table.Td>{t.minServiceMonths} mo</Table.Td>
                <Table.Td>{t.paid ? 'Yes' : 'No'}</Table.Td>
                <Table.Td>{t.requiresDocument ? 'Yes' : 'No'}</Table.Td>
                <Table.Td><Tag color={t.active ? 'green' : 'gray'}>{t.active ? 'Active' : 'Inactive'}</Tag></Table.Td>
                {canEdit && (
                  <Table.Td>
                    <Button size="compact-xs" variant="light" leftSection={<Pencil size={12} />} onClick={() => openEdit(t)}>Edit</Button>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Leave Type">
        <form onSubmit={createForm.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Name" required {...createForm.getInputProps('name')} />
            <NumberInput label="Days per Year" min={0} required {...createForm.getInputProps('annualDays')} />
            <Select label="Accrual Method" data={[{ value: 'monthly', label: 'Monthly accrual' }, { value: 'lump-sum', label: 'Full amount at eligibility' }]} required {...createForm.getInputProps('accrualMethod')} />
            <NumberInput label="Minimum Service (months)" min={0} {...createForm.getInputProps('minServiceMonths')} />
            <Checkbox label="Paid" {...createForm.getInputProps('paid', { type: 'checkbox' })} />
            <Checkbox label="Requires supporting document" {...createForm.getInputProps('requiresDocument', { type: 'checkbox' })} />
            <Button type="submit" mt="sm">Save Leave Type</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title={`Edit ${editRow?.name || ''}`}>
        <form onSubmit={editForm.onSubmit(handleEdit)}>
          <Stack gap="sm">
            <TextInput label="Name" required {...editForm.getInputProps('name')} />
            <NumberInput label="Days per Year" min={0} required {...editForm.getInputProps('annualDays')} />
            <NumberInput label="Minimum Service (months)" min={0} {...editForm.getInputProps('minServiceMonths')} />
            <Checkbox label="Paid" {...editForm.getInputProps('paid', { type: 'checkbox' })} />
            <Checkbox label="Requires supporting document" {...editForm.getInputProps('requiresDocument', { type: 'checkbox' })} />
            <Checkbox label="Active" {...editForm.getInputProps('active', { type: 'checkbox' })} />
            <Button type="submit" mt="sm">Save Changes</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
