import { Stack, Title, Tabs } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import CategoriesTab from './CategoriesTab';
import SubscriptionTypesTab from './SubscriptionTypesTab';
import ProductsTab from './ProductsTab';
import PricingTab from './PricingTab';

// Tabs are ordered the way the catalog is actually built, left to right:
//   Subscription Types -> the types that exist at all
//   Categories         -> which of those each category allows
//   Products           -> products in a category, offering some of its types
//   Pricing            -> the default price per product x type
// Same Tabs + ?tab= URL persistence pattern as AdminPage.
const TABS = ['subscription-types', 'categories', 'products', 'pricing'];

export default function ProductsPage() {
  const { user } = useAuth();
  const canEdit = user.editModules?.includes('products');
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'products';

  return (
    <Stack>
      <Title order={1} size="h3">Products</Title>

      <Tabs value={activeTab} onChange={(v) => setSearchParams({ tab: v }, { replace: true })}>
        <Tabs.List>
          <Tabs.Tab value="subscription-types">Subscription Types</Tabs.Tab>
          <Tabs.Tab value="categories">Categories</Tabs.Tab>
          <Tabs.Tab value="products">Products</Tabs.Tab>
          <Tabs.Tab value="pricing">Pricing</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="subscription-types" pt="md">
          <SubscriptionTypesTab canEdit={canEdit} />
        </Tabs.Panel>
        <Tabs.Panel value="categories" pt="md">
          <CategoriesTab canEdit={canEdit} />
        </Tabs.Panel>
        <Tabs.Panel value="products" pt="md">
          <ProductsTab canEdit={canEdit} />
        </Tabs.Panel>
        <Tabs.Panel value="pricing" pt="md">
          <PricingTab canEdit={canEdit} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
