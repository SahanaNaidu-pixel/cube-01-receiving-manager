/*
 * PurchaseOrderDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Lines, received quantities, discrepancies and inspections.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function PurchaseOrderDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Purchase order ${id}`}
        subtitle="Lines, received quantities, discrepancies and inspections."
        breadcrumbs={[{ label: 'Purchase orders', to: 'purchase-orders' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/purchase-orders/{po_number}']} />
    </div>
  );
}
