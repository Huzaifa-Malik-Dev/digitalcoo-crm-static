import { useState } from 'react';
import { Paper, Divider, Group, Text, Stack, Button, Modal, Radio, NumberInput, TextInput, Table, Loader, Center, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Pencil, Trash2 } from 'lucide-react';
import { notifications } from '../../utils/toast';
import { fetchLedger, createLedgerEntry, updateLedgerEntry, deleteLedgerEntry } from '../../api/payroll';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import MonthInput from '../../components/MonthInput';
import Tag from '../../components/Tag';

function AED(n) {
  return `AED ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// createdAt is the one thing about an entry that's never editable - it's when it was actually
// logged, set once by the database. `date` (always the 1st of whichever month it's assigned to,
// see the Month field below) is what's changeable and what buckets the entry into a given month.
function formatAdded(createdAt) {
  return createdAt ? new Date(createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
}

const TYPE_COLOR = { Advance: 'blue', Loan: 'violet', Deduction: 'gray', Salary: 'green', Bonus: 'teal', Reimbursement: 'cyan' };
// The Add Entry form only exposes two actions - Deduct maps to a Deduction (an open debit,
// auto-collected in full on this employee's next payroll run, same as Advance/Loan already
// behave); Add maps to a Bonus (a settled credit, recorded as already paid) with the reason typed
// into the note field. The full 6-type schema still exists server-side for payroll's own
// auto-generated Salary/Deduction rows - this form just doesn't need to expose all of it.
const ACTION_TO_TYPE = { deduct: 'Deduction', add: 'Bonus' };
// For editing an existing entry, any pre-existing type outside the simplified 2-action set (e.g.
// a legacy Advance/Loan/Reimbursement/Salary logged before this form existed) is treated as "Add"
// - saving without changing the action normalizes it to Bonus, same as a fresh entry would be.
const typeToAction = (type) => (type === 'Deduction' ? 'deduct' : 'add');

// From the employee's own balance perspective: Cash In = money given to them (a Salary/Bonus/
// Reimbursement payout, or an Advance/Loan handed to them). Cash Out = money taken back from them
// (a Deduction - either a manual one or the settlement rows payroll auto-creates when an Advance/
// Loan is repaid). Balance is a running cumulative total across the employee's ENTIRE history,
// same shape as a bank statement - the selected month just narrows which rows are shown, it
// doesn't reset the balance to zero each month.
const CASH_IN_TYPES = ['Salary', 'Bonus', 'Reimbursement', 'Advance', 'Loan'];
const CASH_OUT_TYPES = ['Deduction'];

// API returns newest-first; walking oldest-first lets the running balance accumulate correctly.
// Entries before the selected month roll into openingBalance without being shown; entries within
// it become monthRows, each carrying the running balance as of that entry. Opening/closing still
// show even with zero activity that month, since the balance itself didn't reset to zero.
function buildMonthLedger(entries, month) {
  const chronological = [...entries].reverse();
  let balance = 0;
  let openingBalance = 0;
  const monthRows = [];
  for (const e of chronological) {
    const cashIn = CASH_IN_TYPES.includes(e.type) ? e.amount : 0;
    const cashOut = CASH_OUT_TYPES.includes(e.type) ? e.amount : 0;
    const inMonth = e.date.startsWith(month);
    if (!inMonth && e.date >= month) continue; // a future month relative to what's selected
    balance += cashIn - cashOut;
    if (inMonth) monthRows.push({ ...e, cashIn, cashOut, balance });
    else openingBalance = balance;
  }
  const closingBalance = monthRows.length ? monthRows[monthRows.length - 1].balance : openingBalance;
  return { openingBalance, monthRows, closingBalance };
}

function exportCsv(employeeId, rows) {
  const csvRows = [
    ['Added', 'Month', 'Type', 'Status', 'Note', 'Cash In', 'Cash Out', 'Balance'],
    ...rows.map((r) => [formatAdded(r.createdAt), r.date.slice(0, 7), r.type, r.status, r.note || '', r.cashIn, r.cashOut, r.balance]),
  ];
  const csv = csvRows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${employeeId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Every employee's ledger lives right on their profile - all salary payouts (auto-recorded by
// payroll processing) plus any advance/loan/deduction/bonus/reimbursement, so there's one place
// that answers "what has this person been paid, and what do they still owe back". Reuses the
// same GET/POST /payroll/ledger endpoints as the flat Payroll > Employee Ledger tab, just
// pre-filtered to this one employee - and permitted users can add a record right from here too.
export default function EmployeeLedgerSection({ employeeId }) {
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('payroll.ledger');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [month, setMonth] = useState(currentMonth());

  const { data, isLoading } = useQuery({
    queryKey: ['payroll', 'ledger', 'employee', employeeId],
    queryFn: () => fetchLedger({ employee: employeeId, limit: 100 }),
  });
  const entries = data?.data || [];
  const { openingBalance, monthRows, closingBalance } = buildMonthLedger(entries, month);

  // amount starts blank rather than 0 so typing a real amount doesn't first require clearing a
  // pre-filled zero - but 0 itself is still a valid, submittable amount once explicitly typed.
  const validateFields = {
    amount: (v) => (v === '' || v === null ? 'Amount is required' : null),
    note: (v, values) => (values.action === 'add' && !v.trim() ? 'Reason is required' : null),
  };
  const form = useForm({
    initialValues: { month: currentMonth(), action: 'deduct', amount: '', note: '' },
    validate: validateFields,
  });
  const editForm = useForm({
    initialValues: { month: '', action: 'deduct', amount: '', note: '' },
    validate: validateFields,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['payroll', 'ledger'] });
  };

  const openCreate = () => {
    form.reset();
    // Adding while looking at a past/future month should land in that month, not the current one.
    form.setFieldValue('month', month);
    setCreateOpen(true);
  };

  const handleCreate = async (values) => {
    try {
      const type = ACTION_TO_TYPE[values.action];
      await createLedgerEntry({ date: `${values.month}-01`, amount: values.amount, note: values.note, type, employee: employeeId });
      notifications.show({ color: 'green', message: `${type} recorded` });
      setCreateOpen(false);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not save', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const openEdit = (row) => {
    editForm.setValues({ month: row.date.slice(0, 7), action: typeToAction(row.type), amount: row.amount, note: row.note || '' });
    setEditRow(row);
  };

  const handleEditSave = async (values) => {
    try {
      const type = ACTION_TO_TYPE[values.action];
      await updateLedgerEntry(editRow._id, { date: `${values.month}-01`, amount: values.amount, note: values.note, type });
      notifications.show({ color: 'green', message: 'Entry updated' });
      setEditRow(null);
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleDelete = async (row) => {
    const ok = await confirm({
      title: 'Delete this ledger entry?',
      message: `Removing the ${row.type} of ${AED(row.amount)} (added ${formatAdded(row.createdAt)}) cannot be undone.`,
      confirmLabel: 'Yes, delete it',
      color: 'red',
    });
    if (!ok) return;
    try {
      await deleteLedgerEntry(row._id);
      notifications.show({ color: 'green', message: 'Entry deleted' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not delete', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Divider label="Ledger" labelPosition="left" flex={1} mr="md" />
        <Group gap="xs" wrap="nowrap">
          <MonthInput size="xs" value={month} max={currentMonth()} onChange={setMonth} aria-label="Month" />
          {monthRows.length > 0 && (
            <Button size="xs" variant="light" color="gray" leftSection={<Upload size={14} />} onClick={() => exportCsv(employeeId, monthRows)}>
              Export CSV
            </Button>
          )}
          {canEdit && (
            <Button size="xs" variant="light" leftSection={<Plus size={14} />} onClick={openCreate}>
              Add Entry
            </Button>
          )}
        </Group>
      </Group>

      {isLoading ? (
        <Center py="md"><Loader size="sm" /></Center>
      ) : (
        <Stack gap="sm">
          <Table.ScrollContainer minWidth={600} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Ledger entries, scrollable' } }}>
            <Table striped verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Added</Table.Th>
                  <Table.Th>Detail</Table.Th>
                  <Table.Th>Cash In</Table.Th>
                  <Table.Th>Cash Out</Table.Th>
                  <Table.Th>Balance</Table.Th>
                  {canEdit && <Table.Th>Actions</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td colSpan={4}><Text fw={700} size="sm">Opening Balance</Text></Table.Td>
                  <Table.Td colSpan={canEdit ? 2 : 1}><Text fw={700} size="sm">{AED(openingBalance)}</Text></Table.Td>
                </Table.Tr>
                {monthRows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={canEdit ? 6 : 5}><Text size="sm" c="dimmed" ta="center" py="xs">No entries for this month.</Text></Table.Td>
                  </Table.Tr>
                )}
                {monthRows.map((r) => {
                  const locked = !!r.payrollRun;
                  return (
                    <Table.Tr key={r._id}>
                      <Table.Td>{formatAdded(r.createdAt)}</Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Tag size="xs" color={TYPE_COLOR[r.type] || 'gray'}>{r.type}</Tag>
                          {r.status === 'Open' && <Tag size="xs" color="yellow">Open</Tag>}
                          <Text size="xs" c="dimmed">{r.note || '—'}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td c={r.cashIn ? 'green' : 'dimmed'}>{r.cashIn ? AED(r.cashIn) : '-'}</Table.Td>
                      <Table.Td c={r.cashOut ? 'red' : 'dimmed'}>{r.cashOut ? AED(r.cashOut) : '-'}</Table.Td>
                      <Table.Td fw={600}>{AED(r.balance)}</Table.Td>
                      {canEdit && (
                        <Table.Td>
                          {locked ? (
                            <Tooltip label="Created by a payroll run - delete the run to change this">
                              <Text size="xs" c="dimmed">—</Text>
                            </Tooltip>
                          ) : (
                            <Group gap={4} wrap="nowrap">
                              <Tooltip label="Edit entry">
                                <ActionIcon variant="filled" size="sm" radius="md" onClick={() => openEdit(r)} aria-label="Edit entry">
                                  <Pencil size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Delete entry">
                                <ActionIcon variant="filled" color="red" size="sm" radius="md" onClick={() => handleDelete(r)} aria-label="Delete entry">
                                  <Trash2 size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                          )}
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
                <Table.Tr>
                  <Table.Td colSpan={4}><Text fw={700} size="sm">Closing Balance</Text></Table.Td>
                  <Table.Td colSpan={canEdit ? 2 : 1}><Text fw={700} size="sm">{AED(closingBalance)}</Text></Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Add Ledger Entry" size="sm">
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="sm">
            <Radio.Group label="Action" required {...form.getInputProps('action')}>
              <Group mt={4}>
                <Radio value="deduct" label="Deduct Amount" />
                <Radio value="add" label="Add Amount" />
              </Group>
            </Radio.Group>
            <Text size="xs" c="dimmed">
              {form.values.action === 'deduct'
                ? 'Deducted in full from this employee\'s next payroll run.'
                : 'Recorded as already paid to this employee.'}
            </Text>
            <MonthInput label="Month" required max={currentMonth()} {...form.getInputProps('month')} />
            <NumberInput label="Amount (AED)" min={0} required {...form.getInputProps('amount')} />
            <TextInput
              label={form.values.action === 'add' ? 'Reason' : 'Note (optional)'}
              placeholder={form.values.action === 'add' ? 'e.g. Bonus, Reimbursement...' : undefined}
              required={form.values.action === 'add'}
              {...form.getInputProps('note')}
            />
            <Button type="submit" mt="sm">Save</Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!editRow} onClose={() => setEditRow(null)} title="Edit Ledger Entry" size="sm">
        <form onSubmit={editForm.onSubmit(handleEditSave)}>
          <Stack gap="sm">
            <Text size="xs" c="dimmed">Added on {formatAdded(editRow?.createdAt)} — this can't be changed.</Text>
            <Radio.Group label="Action" required {...editForm.getInputProps('action')}>
              <Group mt={4}>
                <Radio value="deduct" label="Deduct Amount" />
                <Radio value="add" label="Add Amount" />
              </Group>
            </Radio.Group>
            <MonthInput label="Month" required max={currentMonth()} description="Move this entry to any previous month." {...editForm.getInputProps('month')} />
            <NumberInput label="Amount (AED)" min={0} required {...editForm.getInputProps('amount')} />
            <TextInput
              label={editForm.values.action === 'add' ? 'Reason' : 'Note (optional)'}
              required={editForm.values.action === 'add'}
              {...editForm.getInputProps('note')}
            />
            <Button type="submit" mt="sm">Save changes</Button>
          </Stack>
        </form>
      </Modal>
    </Paper>
  );
}
