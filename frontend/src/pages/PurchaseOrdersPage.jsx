/*
 * PurchaseOrdersPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Expected vs received per PO line; catalogue import.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function PurchaseOrdersPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Purchase orders"
        subtitle="Expected vs received per PO line; catalogue import."
      />
      <UnderConstruction endpoints={['GET /api/purchase-orders', 'POST /api/catalogue/import']} />
    </div>
  );
}
