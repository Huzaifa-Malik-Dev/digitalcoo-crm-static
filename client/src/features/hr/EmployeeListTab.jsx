import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActionIcon, Group, Tooltip } from '@mantine/core';
import { Eye, Wallet, Pencil } from 'lucide-react';
import DataTable from '../../components/DataTable';
import Tag from '../../components/Tag';
import { usePagedList } from '../../hooks/usePagedList';
import { fetchEmployees } from '../../api/hr';
import { ROLE_LABELS } from '../../constants/nav';
import { overallHealth } from './docHealth';
import { employeeUrlId } from './employeeUrl';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/date';

const STATUS_COLOR = { Active: 'green', Inactive: 'gray', Frozen: 'blue', Absconding: 'red' };

function StatusBadge({ row }) {
  const status = row.status || (row.active !== false ? 'Active' : 'Inactive');
  return <Tag color={STATUS_COLOR[status] || 'gray'}>{status}</Tag>;
}

// Explicit icon-based row actions - View is always available, Edit/Ledger are gated the same
// way the old dropdown menu was.
function RowActions({ row, canEdit, canViewLedger, navigate }) {
  const id = employeeUrlId(row.employeeId);
  return (
    <Group gap="xs" wrap="nowrap">
      <Tooltip label="View employee">
        <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); navigate(`/hr/employees/${id}`); }} aria-label="View employee">
          <Eye size={18} />
        </ActionIcon>
      </Tooltip>
      {canEdit && (
        <Tooltip label="Edit employee">
          <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); navigate(`/hr/employees/${id}?edit=1`); }} aria-label="Edit employee">
            <Pencil size={18} />
          </ActionIcon>
        </Tooltip>
      )}
      {canViewLedger && (
        <Tooltip label="Employee ledger">
          <ActionIcon variant="filled" size="lg" radius="md" onClick={(e) => { e.stopPropagation(); navigate(`/hr/employees/${id}/ledger`); }} aria-label="Employee ledger">
            <Wallet size={18} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

export default function EmployeeListTab({ activeOnly = false, canEdit }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canViewLedger = user.modules?.includes('payroll');

  const list = usePagedList(['hr', 'employees', activeOnly], fetchEmployees, {
    filters: activeOnly ? { active: 'true' } : {},
  });

  const generalColumns = useMemo(
    () => [
      { accessorKey: 'employeeId', header: 'ID' },
      { accessorKey: 'name', header: 'Name' },
      { accessorKey: 'desig', header: 'Designation' },
      { accessorKey: 'dept', header: 'Department' },
      { accessorKey: 'role', header: 'Role', cell: (info) => ROLE_LABELS[info.getValue()] || info.getValue() },
      { accessorKey: 'join', header: 'Join Date', cell: (info) => formatDate(info.getValue()) },
      {
        id: 'compliance',
        header: 'Compliance',
        cell: (info) => {
          const level = overallHealth(info.row.original.compliance);
          const color = { good: 'green', expiring: 'yellow', expired: 'red', missing: 'gray' }[level];
          const label = { good: 'Good', expiring: 'Expiring', expired: 'Expired', missing: 'Incomplete' }[level];
          return <Tag color={color}>{label}</Tag>;
        },
      },
      {
        id: 'active',
        header: 'Status',
        cell: (info) => <StatusBadge row={info.row.original} />,
      },
      {
        id: 'action',
        header: 'Actions',
        cell: (info) => <RowActions row={info.row.original} canEdit={canEdit} canViewLedger={canViewLedger} navigate={navigate} />,
      },
    ],
    [canEdit, canViewLedger, navigate]
  );

  return (
    <DataTable
      columns={generalColumns}
      data={list.data}
      totalRowCount={list.totalRowCount}
      page={list.page}
      limit={list.limit}
      onPageChange={list.onPageChange}
      search={list.search}
      onSearchChange={list.onSearchChange}
      isLoading={list.isLoading}
      emptyLabel="No employees found"
      sorting={list.sorting}
      onSortingChange={list.onSortingChange}
    />
  );
}
