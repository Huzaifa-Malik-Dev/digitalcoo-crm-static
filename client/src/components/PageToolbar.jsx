import { Group, Text } from '@mantine/core';

// Standard page-header row used across every list/report/detail page: a title block (plain
// Title, or a back-button+avatar+name cluster on detail pages) on the left, filters/actions on
// the right, with an optional dimmed subtitle line underneath. One shared layout so spacing and
// alignment changes apply everywhere at once instead of being hand-tuned per page.
export default function PageToolbar({ title, actions, subtitle }) {
  return (
    <>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        {title}
        {actions && <Group gap="sm">{actions}</Group>}
      </Group>
      {subtitle && <Text size="sm" c="dimmed">{subtitle}</Text>}
    </>
  );
}
