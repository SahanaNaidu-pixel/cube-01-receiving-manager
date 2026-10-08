/*
 * ProductDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Product master data and inspection history.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ProductDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Product ${id}`}
        subtitle="Product master data and inspection history."
        breadcrumbs={[{ label: 'Products', to: 'products' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/products/{sku}', 'PUT /api/products/{sku}']} />
    </div>
  );
}
