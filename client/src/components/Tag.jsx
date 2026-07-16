import { Badge } from '@mantine/core';

// The one place every colored status/type badge in the app renders through - change the size,
// variant, or radius here and it updates everywhere at once instead of a find-and-replace across
// every feature page. Callers still own their own color/label mapping (a DSR call status and a
// Pipeline stage are unrelated domains), this only standardizes how the result is drawn.
// `color` deliberately has NO default here - Mantine's Badge falls back to the theme's
// primaryColor (this app's brand red, same as the "Add Employee" button) when color is
// undefined, and a plain, non-status tag (e.g. a role label) should inherit that, not a
// hardcoded gray that clashes with the rest of the app's red/dark theme.
export default function Tag({ color, children, size = 'sm', ...rest }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <Badge color={color} variant="light" size={size} {...rest}>
      {children}
    </Badge>
  );
}
