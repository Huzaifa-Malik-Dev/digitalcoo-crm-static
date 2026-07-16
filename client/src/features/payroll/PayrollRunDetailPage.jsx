import { Stack, Button, Table, Text, Alert, Tooltip, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { notifications } from '../../utils/toast';
import { fetchPayrollRun, deletePayrollRun } from '../../api/payroll';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import Tag from '../../components/Tag';
import PageToolbar from '../../components/PageToolbar';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PAY_TYPE_LABELS = { salary: 'Salary', commission: 'Commission', salary_commission: 'Salary+Comm.' };
const PAY_TYPE_COLORS = { salary: 'gray', commission: 'grape', salary_commission: 'indigo' };
const payTypeOf = (line) => line.payType || 'salary';

function CommissionCell({ line }) {
  const b = line.commissionBreakdown;
  if (!b || payTypeOf(line) === 'salary') return <Text size="sm">{AED(line.commission)}</Text>;
  return (
    <Tooltip
      multiline
      w={260}
      label={`Achieved AED ${AED(b.achievedMrc)} · ${b.achievementPct}% of target (AED ${AED(b.target)}) → ${b.tierRate ?? 0}% tier`}
    >
      <Text size="sm" style={{ cursor: 'help', borderBottom: '1px dashed currentColor', display: 'inline-block' }}>
        {AED(line.commission)}
      </Text>
    </Tooltip>
  );
}

export default function PayrollRunDetailPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const canDelete = user.editModules?.includes('payroll.delete');

  const runQuery = useQuery({ queryKey: ['payroll', 'runs', runId], queryFn: () => fetchPayrollRun(runId) });
  const run = runQuery.data?.data?.run;
  const lines = runQuery.data?.data?.lines || [];

  const exportCsv = () => {
    const rows = [
      ['Employee ID', 'Name', 'Pay Type', 'Basic', 'Allowance', 'Commission', 'Deductions', 'Net Pay', 'Currency'],
      ...lines.map((l) => [
        l.employee?.employeeId,
        l.employee?.name,
        PAY_TYPE_LABELS[payTypeOf(l)],
        l.basic,
        l.allowance,
        l.commission,
        l.deductions,
        l.netPay,
        'AED',
      ]),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${run.month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete this payroll run?',
      message: `This permanently deletes the ${run.month} payroll run, reverses its expense and account transaction, and restores any ledger advances/loans it settled. This cannot be undone.`,
      confirmLabel: 'Yes, delete it',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deletePayrollRun(run._id);
      notifications.show({ color: 'green', message: `Payroll run for ${run.month} deleted` });
      queryClient.invalidateQueries({ queryKey: ['payroll', 'runs'] });
      navigate('/payroll?tab=run');
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  if (runQuery.isLoading) return null;

  if (!run) {
    return (
      <Stack>
        <Button component={Link} to="/payroll?tab=run" variant="subtle" leftSection={<ArrowLeft size={16} />} w="fit-content">
          Back to Payroll
        </Button>
        <Text c="dimmed" size="sm">Payroll run not found.</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Button component={Link} to="/payroll?tab=run" variant="subtle" leftSection={<ArrowLeft size={16} />} w="fit-content">
        Back to Payroll
      </Button>

      <PageToolbar
        title={<Title order={1} size="h3">Payroll — {run.month}</Title>}
        actions={
          <>
            <Tag>{run.account?.name}</Tag>
            <Tag color="green">Total {AED(run.totalNet)}</Tag>
            <Button size="compact-sm" variant="light" onClick={exportCsv}>Export CSV</Button>
            {canDelete && (
              <Button size="compact-sm" variant="light" color="red" leftSection={<Trash2 size={14} />} onClick={handleDelete}>
                Delete Run
              </Button>
            )}
          </>
        }
      />

      {run.skippedEmployees?.length > 0 && (
        <Alert color="yellow" variant="light">
          Skipped from this run: {run.skippedEmployees.map((e) => e.name).join(', ')}
        </Alert>
      )}

      <Table.ScrollContainer minWidth={800} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Table, scrollable horizontally' } }}>
        <Table striped verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>ID</Table.Th><Table.Th>Name</Table.Th><Table.Th>Pay Type</Table.Th><Table.Th>Basic</Table.Th><Table.Th>Allowance</Table.Th>
              <Table.Th>Commission</Table.Th><Table.Th>Deductions</Table.Th><Table.Th>Net Pay</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((l) => (
              <Table.Tr key={l._id}>
                <Table.Td>{l.employee?.employeeId}</Table.Td>
                <Table.Td>{l.employee?.name}</Table.Td>
                <Table.Td><Tag color={PAY_TYPE_COLORS[payTypeOf(l)]}>{PAY_TYPE_LABELS[payTypeOf(l)]}</Tag></Table.Td>
                <Table.Td>{AED(l.basic)}</Table.Td>
                <Table.Td>{AED(l.allowance)}</Table.Td>
                <Table.Td><CommissionCell line={l} /></Table.Td>
                <Table.Td c={l.deductions ? 'red' : undefined}>{l.deductions ? `-${AED(l.deductions)}` : '-'}</Table.Td>
                <Table.Td fw={700}>{AED(l.netPay)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
