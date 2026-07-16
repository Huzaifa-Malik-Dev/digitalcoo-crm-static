import { Group, Button } from '@mantine/core';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Mirrors the cross-link pattern the three accounting report pages already use - the sidebar
// only links to /leave (My Leave), so anything else under this section needs an in-page way in.
export default function LeaveSubNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const canApprove = user.editModules?.includes('leave.approve');
  const canViewSettings = user.modules?.includes('leave.settings');
  const canManageSettings = user.editModules?.includes('leave.settings');

  const items = [
    { path: '/leave', label: 'My Leave' },
    canApprove && { path: '/leave/approvals', label: 'Approvals' },
    canViewSettings && { path: '/leave/calendar', label: 'Holiday Calendar' },
    canManageSettings && { path: '/leave/settings', label: 'Leave Types' },
  ].filter(Boolean);

  // A single-item bar has nowhere to navigate to - it's just the page's own title restated as a
  // button that does nothing when clicked. Only worth showing once there's an actual second place to go.
  if (items.length <= 1) return null;

  return (
    <Group gap="xs">
      {items.map((item) => (
        <Button
          key={item.path}
          size="xs"
          variant={location.pathname === item.path ? 'filled' : 'light'}
          onClick={() => navigate(item.path)}
        >
          {item.label}
        </Button>
      ))}
    </Group>
  );
}
