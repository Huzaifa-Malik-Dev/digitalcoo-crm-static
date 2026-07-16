import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stack, Title, Text, Paper, SegmentedControl, Select, Group, Button, Loader, Center,
  SimpleGrid, NavLink, Tooltip, Switch, Divider, ActionIcon,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '../../utils/toast';
import { TriangleAlert, ChevronDown, ChevronRight } from 'lucide-react';
import Tag from '../../components/Tag';
import {
  fetchPermissions,
  updateRolePermission,
  resetRolePermission,
  updateUserOverride,
  clearUserOverride,
  updateRoleImportExport,
  updateUserImportExportOverride,
} from '../../api/admin';
import { fetchEmployees } from '../../api/hr';
import { NAV_ITEMS, ROLE_LABELS } from '../../constants/nav';
import { useAuth } from '../../context/AuthContext';

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
const LEVEL_RANK = { none: 0, view: 1, edit: 2 };

// What each module's Import/Export switch actually grants, in plain terms — shown as a caption
// under the toggle so an admin doesn't have to guess what turning it on lets someone do.
const IMPORT_EXPORT_HELP = {
  dsr: 'Bulk upload/download the DSR calling list as a spreadsheet (.xlsx).',
  pipeline: 'Bulk upload/download Sales Pipeline deals as a spreadsheet (.xlsx).',
  backoffice: 'Bulk upload/download Back Office orders as a spreadsheet (.xlsx).',
  hr: "Bulk upload/download every employee's data and their uploaded documents (passport, visa, etc.) as a ZIP file.",
};

// Every permission key, module and nested tab/action alike, flattened with a label and its
// parent's label - used for the over-provisioning check and generic lookups.
const ALL_ITEMS = NAV_ITEMS.flatMap((item) => [
  { key: item.key, label: item.label, parentLabel: null },
  ...(item.children || []).map((c) => ({ key: c.key, label: c.label, parentLabel: item.label })),
]);

function levelFor(view, edit, key) {
  if (edit?.includes(key)) return 'edit';
  if (view?.includes(key)) return 'view';
  return 'none';
}

// Anything in `list` that isn't in `roleDefault` - used to flag a person who has been granted
// more than their role normally gets, so an accidental over-grant doesn't go unnoticed.
function extras(list, roleDefault) {
  const roleSet = new Set(roleDefault || []);
  return (list || []).filter((k) => !roleSet.has(k));
}

export default function PermissionsPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState('role');
  const [role, setRole] = useState('admin');
  const [personSearch, setPersonSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(personSearch, 300);
  const [selectedUser, setSelectedUser] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpanded = (key) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const permsQuery = useQuery({ queryKey: ['admin', 'permissions'], queryFn: fetchPermissions });
  const perms = permsQuery.data?.data;

  const peopleQuery = useQuery({
    queryKey: ['hr', 'people-search', debouncedSearch],
    queryFn: () => fetchEmployees({ search: debouncedSearch || undefined, limit: 20 }),
    enabled: mode === 'person',
  });
  const people = peopleQuery.data?.data || [];

  const override = selectedUser ? perms?.userOverrides?.[selectedUser._id] : null;
  const effectiveView = mode === 'role' ? perms?.byRole?.[role] : (override?.view ?? perms?.byRole?.[selectedUser?.role]);
  const effectiveEdit = mode === 'role' ? perms?.editByRole?.[role] : (override?.edit ?? perms?.editByRole?.[selectedUser?.role]);
  const effectiveImportExport =
    mode === 'role' ? perms?.importExportByRole?.[role] : (override?.importExport ?? perms?.importExportByRole?.[selectedUser?.role]);

  // Over-provisioning check (person mode only): compare this person's override against what
  // their role would normally get, across every module AND nested tab/action key, so an
  // accidental extra grant (including a narrow one like "Delete Payroll Runs") is visible
  // instead of silently sitting there.
  const roleDefaultView = perms?.byRole?.[selectedUser?.role] || [];
  const roleDefaultEdit = perms?.editByRole?.[selectedUser?.role] || [];
  const roleDefaultIE = perms?.importExportByRole?.[selectedUser?.role] || [];
  const extraModuleAccess =
    mode === 'person' && override
      ? ALL_ITEMS.filter((item) => {
          const overrideLevel = levelFor(override.view, override.edit, item.key);
          const roleLevel = levelFor(roleDefaultView, roleDefaultEdit, item.key);
          return LEVEL_RANK[overrideLevel] > LEVEL_RANK[roleLevel];
        })
      : [];
  const extraImportExport = mode === 'person' && override ? extras(override.importExport, roleDefaultIE) : [];
  const extraKeySet = useMemo(() => new Set(extraModuleAccess.map((i) => i.key)), [extraModuleAccess]);
  const extraImportExportSet = useMemo(() => new Set(extraImportExport), [extraImportExport]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'permissions'] });

  const handleChange = async (moduleKey, level) => {
    const moduleLabel = NAV_ITEMS.find((i) => i.key === moduleKey)?.label || moduleKey;
    try {
      if (mode === 'role') {
        await updateRolePermission({ role, module: moduleKey, level });
        notifications.show({ color: 'green', message: `${ROLE_LABELS[role]} access to ${moduleLabel} set to "${level}"` });
      } else {
        if (!selectedUser) return;
        await updateUserOverride({ userId: selectedUser._id, module: moduleKey, level, role: selectedUser.role });
        notifications.show({ color: 'green', message: `${selectedUser.name}'s access to ${moduleLabel} set to "${level}"` });
      }
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleImportExportChange = async (moduleKey, enabled) => {
    const moduleLabel = NAV_ITEMS.find((i) => i.key === moduleKey)?.label || moduleKey;
    try {
      if (mode === 'role') {
        await updateRoleImportExport({ role, module: moduleKey, enabled });
        notifications.show({ color: 'green', message: `${ROLE_LABELS[role]} Import/Export for ${moduleLabel} ${enabled ? 'enabled' : 'disabled'}` });
      } else {
        if (!selectedUser) return;
        await updateUserImportExportOverride({ userId: selectedUser._id, module: moduleKey, enabled, role: selectedUser.role });
        notifications.show({ color: 'green', message: `${selectedUser.name}'s Import/Export for ${moduleLabel} ${enabled ? 'enabled' : 'disabled'}` });
      }
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not update', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleResetOverride = async () => {
    if (!selectedUser) return;
    try {
      await clearUserOverride(selectedUser._id);
      notifications.show({ color: 'green', message: `${selectedUser.name} reset to role default` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not reset', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const handleResetRole = async () => {
    try {
      await resetRolePermission(role);
      notifications.show({ color: 'green', message: `${ROLE_LABELS[role]} reset to system default` });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not reset', message: err.response?.data?.error || 'Something went wrong' });
    }
  };

  const actingHasOwnOverride = !!perms?.userOverrides?.[currentUser.id];
  const isOwnAdminRow =
    mode === 'role'
      ? role === currentUser.role && !actingHasOwnOverride
      : selectedUser?._id === currentUser.id;

  const previewNav = useMemo(
    () => NAV_ITEMS.filter((item) => effectiveView?.includes(item.key)),
    [effectiveView]
  );

  if (permsQuery.isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  return (
    <Stack gap="md">
      <div>
        <Title order={2} size="h4">Permissions <Tag ml="xs" color="red">EDITABLE</Tag></Title>
        <Text size="sm" c="dimmed">Pick a role to set the default for everyone in it, or a specific person to override just them. "Edit" always includes "View".</Text>
      </div>

      <Group align="flex-end">
        <SegmentedControl value={mode} onChange={setMode} data={[{ value: 'role', label: 'Role' }, { value: 'person', label: 'Person' }]} />
        {mode === 'role' ? (
          <Group align="flex-end">
            <Select data={ROLE_OPTIONS} value={role} onChange={setRole} w={240} aria-label="Select role" />
            <Tooltip label="Resets every module and nested permission for this role back to the shipped default" position="top">
              <Button size="xs" variant="light" color="gray" onClick={handleResetRole}>
                Reset to role default
              </Button>
            </Tooltip>
          </Group>
        ) : (
          <Group align="flex-end">
            <Select
              placeholder="Search by name or username..."
              data={people.map((p) => ({ value: p._id, label: `${p.employeeId} — ${p.name} (${ROLE_LABELS[p.role]})` }))}
              value={selectedUser?._id || null}
              onChange={(id) => setSelectedUser(people.find((p) => p._id === id) || null)}
              searchable
              searchValue={personSearch}
              onSearchChange={setPersonSearch}
              nothingFoundMessage={peopleQuery.isFetching ? 'Searching...' : 'No matches'}
              clearable
              w={340}
            />
            {selectedUser && override && (
              <Tooltip
                label="Resetting would remove your own admin edit access - ask another admin instead"
                disabled={!(selectedUser._id === currentUser.id && !(perms?.editByRole?.[selectedUser.role] || []).includes('admin'))}
              >
                <Button
                  size="xs"
                  variant="light"
                  color="gray"
                  onClick={handleResetOverride}
                  disabled={selectedUser._id === currentUser.id && !(perms?.editByRole?.[selectedUser.role] || []).includes('admin')}
                >
                  Reset to role default
                </Button>
              </Tooltip>
            )}
          </Group>
        )}
      </Group>

      {mode === 'person' && selectedUser && (
        <Text size="xs" c="dimmed">
          {override ? 'This person has a custom override.' : `Currently following the ${ROLE_LABELS[selectedUser.role]} role default.`}
        </Text>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Paper withBorder p="md" radius="md">
          <Stack gap="xs">
            {(mode === 'role' || selectedUser) &&
              NAV_ITEMS.map((item, idx) => {
                const locked = item.key === 'admin' && isOwnAdminRow;
                const hasChildren = (item.children || []).length > 0;
                const isOpen = expanded.has(item.key);
                const moduleLevel = levelFor(effectiveView, effectiveEdit, item.key);
                const itemHasExtra = mode === 'person' && extraKeySet.has(item.key);
                const control = (
                  <SegmentedControl
                    size="xs"
                    value={levelFor(effectiveView, effectiveEdit, item.key)}
                    onChange={(level) => handleChange(item.key, level)}
                    disabled={locked}
                    data={[
                      { value: 'none', label: 'None' },
                      { value: 'view', label: 'View' },
                      { value: 'edit', label: 'Edit' },
                    ]}
                  />
                );
                return (
                  <div key={item.key}>
                    {idx > 0 && <Divider my={6} />}
                    <Group justify="space-between">
                      <Group gap={4}>
                        {hasChildren ? (
                          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => toggleExpanded(item.key)} aria-label="Toggle sections">
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </ActionIcon>
                        ) : (
                          <div style={{ width: 28 }} />
                        )}
                        <item.icon size={16} />
                        <Text size="sm" fw={600}>{item.label}</Text>
                        {itemHasExtra && (
                          <Tooltip label={`${selectedUser.name} has MORE access here than the ${ROLE_LABELS[selectedUser.role]} default`}>
                            <TriangleAlert size={18} color="var(--mantine-color-yellow-6)" />
                          </Tooltip>
                        )}
                      </Group>
                      {locked ? (
                        <Tooltip label="You can't change your own admin access - ask another admin to change this for you">
                          <div>{control}</div>
                        </Tooltip>
                      ) : (
                        control
                      )}
                    </Group>
                    {hasChildren && isOpen && (
                      <Stack gap={6} mt={6} pl={32}>
                          {item.children.map((child) => {
                            const childHasExtra = mode === 'person' && extraKeySet.has(child.key);
                            // A child can never exceed its parent module's own level - "None" here
                            // is shown/forced whenever the module itself is None, and "Edit" is only
                            // selectable once the module is Edit, so the control can't display or
                            // create the contradictory "module: None, child: Edit" state.
                            const rawChildLevel = levelFor(effectiveView, effectiveEdit, child.key);
                            const childLevel = LEVEL_RANK[rawChildLevel] > LEVEL_RANK[moduleLevel] ? moduleLevel : rawChildLevel;
                            return (
                              <Group key={child.key} justify="space-between">
                                <Group gap={4}>
                                  <Text size="xs" c="dimmed">{child.label}</Text>
                                  {childHasExtra && (
                                    <Tooltip label={`${selectedUser.name} has MORE access here than the ${ROLE_LABELS[selectedUser.role]} default`}>
                                      <TriangleAlert size={18} color="var(--mantine-color-yellow-6)" />
                                    </Tooltip>
                                  )}
                                </Group>
                                <Tooltip label="Limited by this module's own access level above" disabled={moduleLevel === 'edit'}>
                                  <SegmentedControl
                                    size="xs"
                                    value={childLevel}
                                    onChange={(level) => handleChange(child.key, level)}
                                    disabled={moduleLevel === 'none'}
                                    data={[
                                      { value: 'none', label: 'None' },
                                      { value: 'view', label: 'View' },
                                      { value: 'edit', label: 'Edit', disabled: moduleLevel !== 'edit' },
                                    ]}
                                  />
                                </Tooltip>
                              </Group>
                            );
                          })}
                      </Stack>
                    )}
                  </div>
                );
              })}
            {mode === 'person' && !selectedUser && <Text size="sm" c="dimmed">Search and select a person above.</Text>}

            {(mode === 'role' || selectedUser) && perms?.importExportModules?.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" mt="sm">Bulk Import / Export</Text>
                <Text size="xs" c="dimmed" mb={4}>
                  Separate from View/Edit above — grants uploading/downloading spreadsheets of records, not just using the module.
                </Text>
                {NAV_ITEMS.filter((item) => perms.importExportModules.includes(item.key)).map((item) => (
                  <Group key={item.key} justify="space-between" align="flex-start" wrap="nowrap">
                    <div>
                      <Group gap="xs">
                        <item.icon size={16} />
                        <Text size="sm">{item.label}</Text>
                        {mode === 'person' && extraImportExportSet.has(item.key) && (
                          <Tooltip label={`${selectedUser.name} has MORE access here than the ${ROLE_LABELS[selectedUser.role]} default`}>
                            <TriangleAlert size={18} color="var(--mantine-color-yellow-6)" />
                          </Tooltip>
                        )}
                      </Group>
                      {IMPORT_EXPORT_HELP[item.key] && (
                        <Text size="xs" c="dimmed" ml={24}>{IMPORT_EXPORT_HELP[item.key]}</Text>
                      )}
                    </div>
                    <Switch
                      checked={!!effectiveImportExport?.includes(item.key)}
                      onChange={(e) => handleImportExportChange(item.key, e.currentTarget.checked)}
                      aria-label={`Toggle Import/Export access for ${item.label}`}
                    />
                  </Group>
                ))}
              </>
            )}
          </Stack>
        </Paper>

        <Paper withBorder p="md" radius="md">
          <Text size="sm" fw={600} mb="sm">Sidebar Preview</Text>
          <Stack gap={4}>
            {previewNav.length === 0 && <Text size="xs" c="dimmed">No modules visible.</Text>}
            {previewNav.map((item) => (
              <NavLink key={item.key} label={item.label} leftSection={<item.icon size={16} />} variant="light" active={item.key === 'dash'} />
            ))}
          </Stack>
        </Paper>
      </SimpleGrid>
    </Stack>
  );
}
