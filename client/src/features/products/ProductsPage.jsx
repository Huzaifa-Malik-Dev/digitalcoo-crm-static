import { Stack, Title } from '@mantine/core';
import { useAuth } from '../../context/AuthContext';
import ProductsTab from './ProductsTab';

export default function ProductsPage() {
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('products');

  return (
    <Stack>
      <Title order={1} size="h3">Products</Title>
      <ProductsTab canEdit={canEdit} />
    </Stack>
  );
}
