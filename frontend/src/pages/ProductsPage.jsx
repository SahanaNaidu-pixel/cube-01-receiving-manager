/*
 * ProductsPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Product catalogue (SKU, variant, units per carton, components).
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ProductsPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Products"
        subtitle="Product catalogue (SKU, variant, units per carton, components)."
      />
      <UnderConstruction endpoints={['GET /api/products', 'POST /api/products']} />
    </div>
  );
}
