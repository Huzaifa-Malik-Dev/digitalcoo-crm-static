import { Stack, Title, Tabs } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import PermissionsPage from './PermissionsPage';
import ActivityTimelinePage from './ActivityTimelinePage';

// Account creation/roles/documents live in HR (one source of truth for "who exists and what can
// they do"). Admin/Settings is just the RBAC control panel plus the audit trail - keeping Users
// here too was a second, identical view of the same employee list with no distinct purpose.
export default function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = ['permissions', 'activity'].includes(searchParams.get('tab')) ? searchParams.get('tab') : 'permissions';

  return (
    <Stack>
      <Title order={1} size="h3">Admin / Settings</Title>

      <Tabs value={activeTab} onChange={(v) => setSearchParams({ tab: v }, { replace: true })}>
        <Tabs.List>
          <Tabs.Tab value="permissions">Permissions</Tabs.Tab>
          <Tabs.Tab value="activity">Activity Timeline</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="permissions" pt="md">
          <PermissionsPage />
        </Tabs.Panel>
        <Tabs.Panel value="activity" pt="md">
          <ActivityTimelinePage />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
