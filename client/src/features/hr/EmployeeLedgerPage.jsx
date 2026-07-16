import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Stack, Group, ActionIcon, Title, Text, Badge, Loader, Center } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { fetchEmployeeByEmployeeId } from '../../api/hr';
import EmployeeLedgerSection from './EmployeeLedgerSection';

// A dedicated, full-page view of one employee's ledger - reached from the HR employee list's row
// menu, for when the embedded Ledger section on their profile isn't enough room. Reuses
// EmployeeLedgerSection as-is (same running-balance table, Add Entry, Export) rather than
// duplicating any of that logic - this page is just a header wrapper around it.
export default function EmployeeLedgerPage() {
  const { employeeId } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['hr', 'employee', employeeId],
    queryFn: () => fetchEmployeeByEmployeeId(employeeId),
  });
  const employee = data?.data;

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;
  if (!employee) return <Text c="dimmed">Employee not found</Text>;

  return (
    <Stack gap="md">
      <Group>
        <ActionIcon variant="subtle" onClick={() => navigate('/hr')} aria-label="Back to HR">
          <ArrowLeft size={18} />
        </ActionIcon>
        <div>
          <Title order={3}>{employee.name} — Ledger</Title>
          <Badge size="xs" variant="light">{employee.employeeId}</Badge>
        </div>
      </Group>

      <EmployeeLedgerSection employeeId={employee._id} />
    </Stack>
  );
}
