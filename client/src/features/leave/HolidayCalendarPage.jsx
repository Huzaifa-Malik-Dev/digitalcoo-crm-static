import { useState } from 'react';
import { Stack, Title, Text, Group, Button, Modal, TextInput, Table, ActionIcon, Select } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { notifications } from '../../utils/toast';
import { useConfirm } from '../../context/ConfirmContext';
import { fetchHolidays, createHoliday, deleteHoliday } from '../../api/leave';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';
import LeaveSubNav from './LeaveSubNav';

function currentYear() {
  return new Date().getFullYear();
}

export default function HolidayCalendarPage() {
  const { user } = useAuth();
  const canView = user.modules?.includes('leave.settings');
  const canEdit = user.editModules?.includes('leave.settings');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(String(currentYear()));
  const [createOpen, setCreateOpen] = useState(false);

  const holidaysQuery = useQuery({ queryKey: ['leave', 'holidays', year], queryFn: () => fetchHolidays({ year }), enabled: canView });
  const holidays = holidaysQuery.data?.data || [];

  const form = useForm({ initialValues: { name: '', date: '' } });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['leave', 'holidays'] });

  const handleCreate = async (values) => {
    try {
      await createHoliday(values);
      notifications.show({ color: 'green', message: 'Holiday added' });
      setCreateOpen(false);
      form.reset();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (holiday) => {
    const ok = await confirm({ title: `Remove ${holiday.name}?`, message: `This removes the ${formatDate(holiday.date)} holiday from the calendar.`, confirmLabel: 'Yes, remove' });
    if (!ok) return;
    try {
      await deleteHoliday(holiday._id);
      notifications.show({ color: 'green', message: 'Holiday removed' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not remove', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (!canView) {
    return (
      <Stack>
        <Title order={1} size="h3">Holiday Calendar</Title>
        <Text c="dimmed" size="sm">You don't have access to this page.</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <LeaveSubNav />
      <Group justify="space-between">
        <Title order={1} size="h3">Holiday Calendar</Title>
        <Group>
          <Select data={['2025', '2026', '2027']} value={year} onChange={setYear} w={110} />
          {canEdit && <Button leftSection={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add Holiday</Button>}
        </Group>
      </Group>

      <Table.ScrollContainer minWidth={400} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr><Table.Th>Date</Table.Th><Table.Th>Name</Table.Th>{canEdit && <Table.Th>Actions</Table.Th>}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {holidays.map((h) => (
              <Table.Tr key={h._id}>
                <Table.Td>{formatDate(h.date)}</Table.Td>
                <Table.Td>{h.name}</Table.Td>
                {canEdit && (
                  <Table.Td>
                    <ActionIcon color="red" variant="subtle" onClick={() => handleDelete(h)}><Trash2 size={16} /></ActionIcon>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
            {holidays.length === 0 && (
              <Table.Tr><Table.Td colSpan={canEdit ? 3 : 2}><Text c="dimmed" ta="center" py="md">No holidays set for {year}</Text></Table.Td></Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Holiday">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <TextInput label="Name" required {...form.getInputProps('name')} />
            <TextInput type="date" label="Date" required {...form.getInputProps('date')} />
            <Button type="submit" mt="sm">Save Holiday</Button>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
