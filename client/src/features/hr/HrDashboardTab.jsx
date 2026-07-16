import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Stack, SimpleGrid, Paper, Text, Group, Badge, Loader, Center,
  UnstyledButton, ThemeIcon,
} from '@mantine/core';
import { IdCard, Plane, Fingerprint, Landmark, ShieldCheck, CircleCheck } from 'lucide-react';
import { fetchComplianceSummary } from '../../api/hr';

const CATEGORY_ICON = { passport: IdCard, visa: Plane, eid: Fingerprint, labourCard: Landmark, insurance: ShieldCheck };

export default function HrDashboardTab() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['hr', 'compliance-summary'], queryFn: fetchComplianceSummary });

  if (isLoading) return <Center py="xl"><Loader size="sm" /></Center>;

  const categories = data?.data?.categories || [];
  const totalExpired = data?.data?.totalExpired || 0;
  const totalExpiring = data?.data?.totalExpiring || 0;

  return (
    <Stack gap="md">
      <Group gap="md">
        <Paper withBorder p="md" radius="md" style={{ borderLeft: '3px solid var(--mantine-color-red-6)' }}>
          <Text size="sm" c="dimmed">Documents Expired</Text>
          <Text size="xl" fw={700}>{totalExpired}</Text>
        </Paper>
        <Paper withBorder p="md" radius="md" style={{ borderLeft: '3px solid var(--mantine-color-yellow-6)' }}>
          <Text size="sm" c="dimmed">Expiring in 30 Days</Text>
          <Text size="xl" fw={700}>{totalExpiring}</Text>
        </Paper>
      </Group>

      <Text size="sm" fw={600}>Document Expiry — click any card to see the affected employees</Text>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 5 }}>
        {categories.map((cat) => {
          const Icon = CATEGORY_ICON[cat.key] || IdCard;
          const flagged = cat.expiredCount + cat.expiringCount > 0;
          return (
            <Paper
              key={cat.key}
              withBorder
              p="md"
              radius="md"
              component={UnstyledButton}
              onClick={() => navigate(`/hr/compliance/${cat.key}`)}
              style={{ cursor: 'pointer' }}
            >
              <Group justify="space-between" mb="xs">
                <ThemeIcon variant="light" color={flagged ? 'red' : 'green'} size="lg" radius="md">
                  {flagged ? <Icon size={18} /> : <CircleCheck size={18} />}
                </ThemeIcon>
              </Group>
              <Text size="sm" fw={600}>{cat.label}</Text>
              <Group gap="xs" mt={4}>
                <Badge color="red" variant={cat.expiredCount ? 'filled' : 'light'} size="sm">{cat.expiredCount} expired</Badge>
                <Badge color="yellow" variant={cat.expiringCount ? 'filled' : 'light'} size="sm">{cat.expiringCount} expiring</Badge>
              </Group>
            </Paper>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}
